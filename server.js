const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = 9999;
const VERSION = "3.4";
const AUTHOR = "ZOLW22";

// tarkov.dev wymaga teraz unikalnego, identyfikującego projekt User-Agenta przy każdym
// requeście (GraphQL i JSON API) - inaczej ryzyko zablokowania jako podejrzany ruch.
const PROJECT_UA = `TarkovPlayerTracker/${VERSION} (+https://github.com/zolw22/tarkov_player_tracker)`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12h
const PRICES_INTERVAL = 10 * 60 * 1000;    // 10 min

// --- STATUS API (do wyświetlenia w UI, czy tarkov.dev żyje i za ile kolejna próba) ---
const apiStatus = {
    online: true,       // czy ostatnia próba połączenia z api.tarkov.dev się udała
    lastError: null,    // treść ostatniego błędu
    lastCheckedAt: null,// kiedy ostatnio odpytano API (epoch ms)
    nextRetryAt: null,  // epoch ms kolejnej próby w trakcie aktywnego retry (backoff), null gdy nieaktywny
    nextAutoSyncAt: Date.now() + PRICES_INTERVAL // epoch ms kolejnej automatycznej synchronizacji cen
};

const db = new sqlite3.Database('./tarkov_tracker.db', (err) => {
    if (err) console.error("❌ Błąd bazy:", err.message);
    else {
        // Startujemy inicjalizację
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, quantity INTEGER, category TEXT, image TEXT, is_fir INTEGER DEFAULT 0)`);
        db.run(`CREATE TABLE IF NOT EXISTS tarkov_items_cache (
            id TEXT PRIMARY KEY, name TEXT, shortName TEXT, image TEXT,
            price_min INTEGER DEFAULT 0, price_avg INTEGER DEFAULT 0, price_max INTEGER DEFAULT 0
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS tarkov_tasks_cache (id TEXT PRIMARY KEY, name TEXT, trader TEXT)`);
        
        db.run(`CREATE TABLE IF NOT EXISTS kappa_tracker (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, is_collected INTEGER DEFAULT 0, image TEXT, is_new INTEGER DEFAULT 0,
            type TEXT DEFAULT 'item', min_level INTEGER DEFAULT 0, trader TEXT DEFAULT '', 
            requirements TEXT DEFAULT '', faction TEXT DEFAULT 'Any', map TEXT DEFAULT 'Any', 
            wiki_link TEXT DEFAULT '', trader_image TEXT DEFAULT ''
        )`, (err) => {
            if (!err) {
                const migrations = [
                    "ALTER TABLE kappa_tracker ADD COLUMN is_new INTEGER DEFAULT 0",
                    "ALTER TABLE kappa_tracker ADD COLUMN type TEXT DEFAULT 'item'",
                    "ALTER TABLE kappa_tracker ADD COLUMN min_level INTEGER DEFAULT 0",
                    "ALTER TABLE kappa_tracker ADD COLUMN trader TEXT DEFAULT ''",
                    "ALTER TABLE kappa_tracker ADD COLUMN requirements TEXT DEFAULT ''",
                    "ALTER TABLE items ADD COLUMN is_fir INTEGER DEFAULT 0",
                    "ALTER TABLE kappa_tracker ADD COLUMN faction TEXT DEFAULT 'Any'",
                    "ALTER TABLE kappa_tracker ADD COLUMN map TEXT DEFAULT 'Any'",
                    "ALTER TABLE kappa_tracker ADD COLUMN wiki_link TEXT DEFAULT ''",
                    "ALTER TABLE kappa_tracker ADD COLUMN trader_image TEXT DEFAULT ''",
                    "ALTER TABLE tarkov_items_cache ADD COLUMN price_min INTEGER DEFAULT 0",
                    "ALTER TABLE tarkov_items_cache ADD COLUMN price_avg INTEGER DEFAULT 0",
                    "ALTER TABLE tarkov_items_cache ADD COLUMN price_max INTEGER DEFAULT 0",
                    "ALTER TABLE kappa_tracker ADD COLUMN requirement_names TEXT DEFAULT '[]'",
                    "ALTER TABLE items ADD COLUMN sort_order INTEGER DEFAULT 0"
                ];
                let done = 0;
                migrations.forEach(sql => db.run(sql, () => { done++; if (done === migrations.length) startBackgroundTasks(); }));
                
                db.get("SELECT count(*) as count FROM kappa_tracker WHERE is_collected = 2", [], (err, row) => {
                    if (row && row.count === 0) db.run("UPDATE kappa_tracker SET is_collected = 2 WHERE is_collected = 1");
                });
            }
        });
    });
}

function startBackgroundTasks() {
    console.log("🚀 [SYSTEM] Uruchamianie procesów w tle...");

    // Uruchom aktualizację cen
    updateItemCache();
    setInterval(updateItemCache, PRICES_INTERVAL);

    // Uruchom synchronizację Kappy z małym opóźnieniem, żeby logi się nie mieszały
    setTimeout(() => {
        runKappaSync().then(() => {
            console.log("\n✅ [SYSTEM] WSZYSTKIE SYSTEMY URUCHOMIONE W PEŁNI. MOŻNA KORZYSTAĆ DO WOLI!\n");
        });
    }, 3000);

    // Normalnie questy/Kappa odświeżają się co SYNC_INTERVAL (dane rzadko się zmieniają)
    setInterval(runKappaSync, SYNC_INTERVAL);
}

// Jeśli cache questów jest wciąż pusty po próbie synchronizacji (np. bo API padało
// przy starcie serwera), dobijamy się częściej (co PRICES_INTERVAL) zamiast czekać
// całe SYNC_INTERVAL - dzięki temu nazwy questów w wyszukiwarce pojawią się same,
// gdy tylko api.tarkov.dev wróci, bez potrzeby restartu czy ręcznego "Wymuś aktualizację".
async function runKappaSync() {
    await syncKappaWithAPI();
    db.get("SELECT count(*) as count FROM tarkov_tasks_cache", [], (err, row) => {
        if (!err && row.count === 0) {
            console.log("⏳ [KAPPA] Cache questów wciąż pusty, spróbuję ponownie za " + (PRICES_INTERVAL / 60000) + " min.");
            setTimeout(runKappaSync, PRICES_INTERVAL);
        }
    });
}

// api.tarkov.dev czasem zgłasza przejściową awarię jako 503, czasem jako 422 z body
// {"errors":["GraphQL server unavailable..."]} - traktujemy jako nie-retryable tylko
// jednoznacznie trwałe błędy klienta (zły request/auth/routing), wszystko inne ponawiamy.
const PERMANENT_ERROR_STATUSES = [400, 401, 403, 404];

// --- API HELPER (retry z backoffem, np. gdy api.tarkov.dev leży) ---
async function tarkovApiRequest(payload, { retries = 4, baseDelayMs = 3000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.post('https://api.tarkov.dev/graphql', payload, { headers: { 'User-Agent': PROJECT_UA }, timeout: 15000 });
            apiStatus.online = true;
            apiStatus.lastError = null;
            apiStatus.nextRetryAt = null;
            apiStatus.lastCheckedAt = Date.now();
            return response;
        } catch (e) {
            const status = e.response ? e.response.status : null;
            const isRetryable = !status || !PERMANENT_ERROR_STATUSES.includes(status);
            const bodyMsg = e.response && e.response.data && e.response.data.errors ? e.response.data.errors[0] : null;
            apiStatus.online = false;
            apiStatus.lastError = bodyMsg || `${status || e.code || e.message}`;
            apiStatus.lastCheckedAt = Date.now();

            if (attempt === retries || !isRetryable) { apiStatus.nextRetryAt = null; throw e; }

            const wait = baseDelayMs * attempt;
            apiStatus.nextRetryAt = Date.now() + wait;
            console.warn(`⚠️ [RETRY] api.tarkov.dev odpowiedziało błędem (${apiStatus.lastError}). Próba ${attempt}/${retries}, ponawiam za ${wait / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }
}

// --- JSON API (json.tarkov.dev) - zapasowe źródło, gdy GraphQL (api.tarkov.dev) pada ---
// UWAGA: tarkov.dev czasem serwuje pod tym adresem dane-placeholder w polach name/shortName
// (== "<id> Name"), kiedy ich backend danych gry jest wyłączony. Ceny, ikony i cała reszta
// pól zostają jednak prawdziwe - i co ważne, pole normalizedName (slug typu
// "colt-m4a1-556x45-assault-rifle") NIE jest placeholderem. W takiej sytuacji wyprowadzamy
// czytelną nazwę ze sluga zamiast odrzucać cały rekord - to dużo lepsze niż surowe id.
function looksLikePlaceholder(name, id) {
    return typeof name === 'string' && typeof id === 'string' && name.startsWith(id);
}
function humanizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return null;
    return slug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function resolveName(rawName, id, normalizedName) {
    if (!looksLikePlaceholder(rawName, id)) return rawName;
    return humanizeSlug(normalizedName) || rawName;
}

async function fetchJsonApi(path) {
    const res = await axios.get(`https://json.tarkov.dev${path}`, { headers: { 'User-Agent': PROJECT_UA }, timeout: 20000 });
    return res.data.data;
}

async function fetchItemsFromJsonApi() {
    const data = await fetchJsonApi('/regular/items');
    const rawList = Object.values(data.items || {});
    if (rawList.length === 0) throw new Error('json.tarkov.dev: pusta lista itemów');

    if (looksLikePlaceholder(rawList[0].name, rawList[0].id)) {
        console.warn("⚠️ [MARKET] tarkov.dev nie zwraca prawdziwych nazw (ich backend danych gry jest wyłączony) - używam nazw wyprowadzonych ze slugów (normalizedName). Ceny i obrazki są prawdziwe.");
    }
    return rawList.map(i => {
        const name = resolveName(i.name, i.id, i.normalizedName);
        return { ...i, name, shortName: looksLikePlaceholder(i.shortName, i.id) ? name : i.shortName };
    });
}

async function fetchTasksFromJsonApi() {
    const [tasksData, tradersData] = await Promise.all([fetchJsonApi('/regular/tasks'), fetchJsonApi('/regular/traders')]);
    const rawList = Object.values(tasksData.tasks || {});
    if (rawList.length === 0) throw new Error('json.tarkov.dev: pusta lista questów');

    if (looksLikePlaceholder(rawList[0].name, rawList[0].id)) {
        console.warn("⚠️ [KAPPA] tarkov.dev nie zwraca prawdziwych nazw questów - używam nazw wyprowadzonych ze slugów (normalizedName).");
    }
    const list = rawList.map(t => ({ ...t, name: resolveName(t.name, t.id, t.normalizedName) }));

    const traderById = {};
    Object.values(tradersData || {}).forEach(t => {
        if (t && t.id) traderById[t.id] = { name: resolveName(t.name, t.id, t.normalizedName), imageLink: t.imageLink || '' };
    });
    const taskNameById = {};
    list.forEach(t => { taskNameById[t.id] = t.name; });

    // nazwy/ikony itemów w objectives ("giveItem") rozwiązujemy przez lokalny cache -
    // JSON API zwraca tam tylko id itemu, nie jego nazwę
    return new Promise((resolve) => {
        db.all("SELECT id, name, image FROM tarkov_items_cache", [], (err, itemRows) => {
            const itemById = {};
            (itemRows || []).forEach(r => { itemById[r.id] = { name: r.name, iconLink: r.image }; });

            resolve(list.map(t => {
                const objectives = (t.objectives || [])
                    .filter(o => (o.type === 'giveItem' || o.type === 'plantItem') && Array.isArray(o.items) && o.items.length > 0)
                    .map(o => {
                        const known = itemById[o.items[0]];
                        return { item: known ? { name: known.name, iconLink: known.iconLink } : null };
                    });
                return {
                    id: t.id,
                    name: t.name,
                    kappaRequired: !!t.kappaRequired,
                    minPlayerLevel: t.minPlayerLevel || 0,
                    factionName: t.factionName || 'Any',
                    trader: traderById[t.trader] || null,
                    map: null,
                    wikiLink: t.wikiLink || '',
                    objectives,
                    taskRequirements: (t.taskRequirements || []).map(r => ({ task: { name: taskNameById[r.task] || '?' } }))
                };
            }));
        });
    });
}

// --- CACHE & CENY ---
async function updateItemCache() {
    console.log("💰 [MARKET] Sprawdzanie aktualnych cen (Flea Market)...");
    apiStatus.nextAutoSyncAt = Date.now() + PRICES_INTERVAL;

    let items;
    try {
        const response = await tarkovApiRequest({
            query: `{ items(lang: en) { id name shortName iconLink lastLowPrice avg24hPrice } }`
        });
        items = response.data.data ? response.data.data.items : null;
    } catch (graphqlErr) {
        console.warn("⚠️ [MARKET] GraphQL zawiódł, próbuję json.tarkov.dev...");
        try {
            items = await fetchItemsFromJsonApi();
        } catch (jsonErr) {
            console.error("❌ [ERROR] Błąd API Cen (GraphQL i JSON):", jsonErr.message);
            return;
        }
    }
    if (!items) return;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(`INSERT OR REPLACE INTO tarkov_items_cache (id, name, shortName, image, price_min, price_avg, price_max) VALUES (?, ?, ?, ?, ?, ?, ?)`);

        items.forEach(i => {
            const min = i.lastLowPrice || 0;
            const avg = i.avg24hPrice || 0;
            const max = Math.round(avg * 1.2);
            stmt.run(i.id, i.name, i.shortName, i.iconLink, min, avg, max);
        });

        stmt.finalize();
        db.run("COMMIT", () => {
            console.log(`✅ [MARKET] Ceny zaktualizowane pomyślnie (${items.length} przedmiotów).`);
        });
    });
}

// --- SYNCHRONIZACJA KAPPY ---
async function syncKappaWithAPI() {
    console.log("🔄 [API] Rozpoczynam synchronizację Questów i Kappy...");
    const query = `
    {
        tasks(lang: en) {
            id, name, kappaRequired, minPlayerLevel, factionName, trader { name imageLink }, map { name }, wikiLink,
            objectives { ... on TaskObjectiveItem { item { name iconLink } } },
            taskRequirements { task { name } }
        }
    }`;
    let allTasks;
    try {
        const response = await tarkovApiRequest({ query });
        allTasks = response.data.data ? response.data.data.tasks : null;
    } catch (graphqlErr) {
        console.warn("⚠️ [KAPPA] GraphQL zawiódł, próbuję json.tarkov.dev...");
        try {
            allTasks = await fetchTasksFromJsonApi();
        } catch (jsonErr) {
            console.error("❌ [API ERROR] (GraphQL i JSON):", jsonErr.message);
            return;
        }
    }
    if (!allTasks) return;

    try {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            const stmt = db.prepare("INSERT OR REPLACE INTO tarkov_tasks_cache (id, name, trader) VALUES (?, ?, ?)");
            allTasks.forEach(t => stmt.run(t.id, t.name, t.trader ? t.trader.name : 'Unknown'));
            stmt.finalize();
            db.run("COMMIT");
        });

        const collectorTask = allTasks.find(t => t.name === "Collector");
        const fenceImage = collectorTask && collectorTask.trader ? collectorTask.trader.imageLink : '';
        const collectorItems = collectorTask ? collectorTask.objectives.filter(obj => obj.item).map(obj => ({
            name: obj.item.name, image: obj.item.iconLink || '', type: 'item', min_level: 55, trader: 'Fence', trader_image: fenceImage, req: 'Quest: Collector', faction: 'Any', map: 'All', wiki_link: '', reqNames: '[]'
        })) : [];
        const requiredTasks = allTasks.filter(t => t.kappaRequired === true).map(t => {
            const reqNames = t.taskRequirements.map(r => r.task.name);
            return {
                name: t.name, image: '', type: 'quest', min_level: t.minPlayerLevel || 0, trader: t.trader ? t.trader.name : '?', trader_image: t.trader ? t.trader.imageLink : '', faction: t.factionName || 'Any', map: t.map ? t.map.name : 'Any', wiki_link: t.wikiLink || '', req: reqNames.length ? `Wymaga: ${reqNames.join(", ")}` : 'Startowy', reqNames: JSON.stringify(reqNames)
            };
        });
        
        console.log(`🔎 [KAPPA] Znaleziono: ${collectorItems.length} przedmiotów streamera i ${requiredTasks.length} wymaganych questów.`);
        
        const everything = [...collectorItems, ...requiredTasks];
        let newCount = 0;
        
        const upsert = (item) => new Promise((resolve) => {
            db.get("SELECT id FROM kappa_tracker WHERE name = ?", [item.name], (err, row) => {
                if (!row) {
                    db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements, faction, map, wiki_link, trader_image, requirement_names) VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [item.name, item.image, item.type, item.min_level, item.trader, item.req, item.faction, item.map, item.wiki_link, item.trader_image, item.reqNames], () => resolve(1));
                } else {
                    db.run(`UPDATE kappa_tracker SET min_level=?, trader=?, requirements=?, type=?, image=?, faction=?, map=?, wiki_link=?, trader_image=?, requirement_names=? WHERE id=?`, [item.min_level, item.trader, item.req, item.type, item.image || '', item.faction, item.map, item.wiki_link, item.trader_image, item.reqNames, row.id], () => resolve(0));
                }
            });
        });
        
        for (const e of everything) { newCount += await upsert(e); }
        
        if (newCount > 0) console.log(`✨ [UPDATE] Dodano ${newCount} nowych wpisów do bazy Kappy.`);
        else console.log("✅ [UPDATE] Baza Kappy jest w pełni aktualna.");

    } catch (error) { console.error("❌ [API ERROR]:", error.message); }
}

// --- ROUTY ---
app.get('/', (req, res) => {
    db.all("SELECT * FROM items ORDER BY (quantity = 0), sort_order ASC, id DESC", [], (err, rows) => {
        const categories = { 'Hideout': rows.filter(r => r.category === 'Hideout'), 'Crafting': rows.filter(r => r.category === 'Crafting'), 'Misje': rows.filter(r => r.category === 'Misje') };
        res.render('index', { categories });
    });
});

app.get('/kappa', (req, res) => {
    db.all(`SELECT * FROM kappa_tracker ORDER BY type ASC, is_collected ASC, min_level ASC`, [], (err, rows) => {
        const items = rows.filter(r => r.type === 'item');
        // questy oznaczone jako zrobione po nazwie - do sprawdzania, czy prerekwizyty questa są spełnione
        const doneNames = new Set(rows.filter(r => r.is_collected === 2).map(r => r.name));

        const quests = rows.filter(r => r.type === 'quest').map(q => {
            let reqNames = [];
            try { reqNames = JSON.parse(q.requirement_names || '[]'); } catch (e) { reqNames = []; }
            const locked = q.is_collected === 0 && reqNames.length > 0 && !reqNames.every(n => doneNames.has(n));
            return { ...q, locked };
        });

        const countLocked = quests.filter(q => q.locked).length;
        const stats = {
            itemsDone: items.filter(i => i.is_collected === 2).length, itemsTotal: items.length, itemsPercent: items.length > 0 ? Math.round((items.filter(i => i.is_collected === 2).length / items.length) * 100) : 0,
            questsDone: quests.filter(q => q.is_collected === 2).length, questsTotal: quests.length, questsPercent: quests.length > 0 ? Math.round((quests.filter(q => q.is_collected === 2).length / quests.length) * 100) : 0,
            totalPercent: rows.length > 0 ? Math.round((rows.filter(r => r.is_collected === 2).length / rows.length) * 100) : 0,
            countNew: rows.filter(r => r.is_new === 1 && r.is_collected !== 2).length, countTodo: items.filter(i => i.is_collected === 0).length + quests.filter(q => q.is_collected === 0 && !q.locked).length, countProgress: rows.filter(r => r.is_collected === 1).length, countDone: rows.filter(r => r.is_collected === 2).length, totalAll: rows.length,
            countLocked
        };
        res.render('kappa', { items, quests, stats });
    });
});

app.get('/api/status', (req, res) => res.json(apiStatus));

app.get('/api/prices', (req, res) => {
    db.all(`SELECT name, price_min, price_avg, price_max FROM tarkov_items_cache`, [], (err, rows) => {
        if(err) return res.json([]);
        const priceMap = {};
        rows.forEach(r => { priceMap[r.name] = { min: r.price_min, avg: r.price_avg, max: r.price_max }; });
        res.json(priceMap);
    });
});

app.post('/api/unnew/:id', (req, res) => { db.run("UPDATE kappa_tracker SET is_new = 0 WHERE id = ?", [req.params.id], () => res.sendStatus(200)); });
app.post('/kappa/set_status/:id', (req, res) => { db.run("UPDATE kappa_tracker SET is_collected = ?, is_new = 0 WHERE id = ?", [parseInt(req.body.status), req.params.id], () => res.redirect('/kappa')); });
app.post('/kappa/toggle/:id', (req, res) => { db.get("SELECT is_collected FROM kappa_tracker WHERE id = ?", [req.params.id], (err, row) => { if(row) { const next = (row.is_collected >= 1) ? 0 : 2; db.run("UPDATE kappa_tracker SET is_collected = ?, is_new = 0 WHERE id = ?", [next, req.params.id], () => res.redirect('/kappa')); } else res.redirect('/kappa'); }); });
app.post('/kappa/add', (req, res) => { const { name, image } = req.body; db.get("SELECT id FROM kappa_tracker WHERE name = ?", [name], (err, row) => { if (!row) db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements) VALUES (?, ?, 0, 1, 'item', 0, 'Custom', 'Ręcznie')`, [name, image || ''], () => res.redirect('/kappa')); else res.redirect('/kappa'); }); });
app.post('/kappa/add_quest', (req, res) => { const { name, trader } = req.body; db.get("SELECT id FROM kappa_tracker WHERE name = ?", [name], (err, row) => { if (!row) db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements, map, trader_image) VALUES (?, '', 0, 1, 'quest', 0, ?, 'Ręcznie dodane', 'Any', '')`, [name, trader || 'Custom'], () => res.redirect('/kappa')); else res.redirect('/kappa'); }); });
app.post('/kappa/refresh', async (req, res) => { await syncKappaWithAPI(); res.redirect('/kappa'); });
app.get('/api/search', (req, res) => { const q = req.query.q; if (!q || q.length < 2) return res.json([]); db.all(`SELECT name, image FROM tarkov_items_cache WHERE name LIKE ? OR shortName LIKE ? LIMIT 10`, [`%${q}%`, `%${q}%`], (err, rows) => res.json(rows || [])); });
app.get('/api/search_tasks', (req, res) => { const q = req.query.q; if (!q || q.length < 2) return res.json([]); db.all(`SELECT name, trader FROM tarkov_tasks_cache WHERE name LIKE ? LIMIT 10`, [`%${q}%`], (err, rows) => res.json(rows || [])); });
app.post('/add', (req, res) => { const { name, quantity, category, image, fir } = req.body; const isFir = fir === 'on' ? 1 : 0; db.run(`INSERT INTO items (name, quantity, category, image, is_fir) VALUES (?, ?, ?, ?, ?)`, [name, quantity, category, image || '', isFir], () => res.redirect('/')); });

// --- ITEMY (kontrolki karty - AJAX, bez przeładowania strony) ---
app.post('/api/items/:id/fir', (req, res) => {
    db.get("SELECT is_fir FROM items WHERE id = ?", [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'not found' });
        const next = row.is_fir ? 0 : 1;
        db.run("UPDATE items SET is_fir = ? WHERE id = ?", [next, req.params.id], () => res.json({ id: Number(req.params.id), is_fir: next }));
    });
});
app.post('/api/items/:id/quantity', (req, res) => {
    db.get("SELECT quantity FROM items WHERE id = ?", [req.params.id], (err, row) => {
        if (!row) return res.status(404).json({ error: 'not found' });
        let next = req.body.value !== undefined ? parseInt(req.body.value) : row.quantity + parseInt(req.body.delta);
        if (isNaN(next) || next < 0) next = 0;
        db.run("UPDATE items SET quantity = ? WHERE id = ?", [next, req.params.id], () => res.json({ id: Number(req.params.id), quantity: next }));
    });
});
app.post('/api/items/:id/category', (req, res) => {
    const { category } = req.body;
    if (!['Hideout', 'Crafting', 'Misje'].includes(category)) return res.status(400).json({ error: 'invalid category' });
    db.run("UPDATE items SET category = ? WHERE id = ?", [category, req.params.id], () => res.json({ id: Number(req.params.id), category }));
});
app.post('/api/items/:id/delete', (req, res) => {
    db.run("DELETE FROM items WHERE id = ?", [req.params.id], () => res.json({ ok: true }));
});

// zapisuje ręczną kolejność itemów po przeciągnięciu (drag&drop) - "order" to lista id
// przecinkami, w kolejności w jakiej mają się teraz wyświetlać
app.post('/api/items/reorder', (req, res) => {
    const ids = String(req.body.order || '').split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length === 0) return res.status(400).json({ error: 'invalid order' });
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare("UPDATE items SET sort_order = ? WHERE id = ?");
        ids.forEach((id, idx) => stmt.run(idx, id));
        stmt.finalize();
        db.run("COMMIT", () => res.json({ ok: true }));
    });
});

// --- WIPE (reset postępu, jak przy wipe'ie serwera w grze) ---
app.post('/wipe', (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `./tarkov_tracker_backup_${timestamp}.db`;

    fs.copyFile('./tarkov_tracker.db', backupPath, (err) => {
        if (err) console.error("❌ [WIPE] Błąd backupu bazy, przerywam reset:", err.message);
        if (err) return res.redirect('/kappa');

        console.log(`💾 [WIPE] Backup zapisany: ${backupPath}`);

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("UPDATE kappa_tracker SET is_collected = 0, is_new = 0");
            db.run("DELETE FROM items");
            db.run("COMMIT", () => {
                console.log("🧨 [WIPE] Reset postępu wykonany (Kappa Tracker + lista lootu).");
                res.redirect('/kappa');
            });
        });
    });
});

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) { for (const iface of interfaces[name]) { if ('IPv4' !== iface.family || iface.internal) continue; return iface.address; } }
    return 'localhost';
}

app.listen(PORT, () => { 
    const ip = getLocalIp();
    console.log(`
    =======================================================
       TARKOV TRACKER v${VERSION}
       Autor: ${AUTHOR}
    =======================================================
       ✅ Server aktywny!
       👉 Lokalny: http://localhost:${PORT}
       👉 Sieciowy: http://${ip}:${PORT}
    =======================================================
    `);
});