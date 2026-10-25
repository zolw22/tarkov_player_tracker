const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = 9999;
const VERSION = "3.5";
const AUTHOR = "ZOLW22";

// tarkov.dev wymaga teraz unikalnego, identyfikującego projekt User-Agenta przy każdym
// requeście (GraphQL i JSON API) - inaczej ryzyko zablokowania jako podejrzany ruch.
const PROJECT_UA = `TarkovPlayerTracker/${VERSION} (+https://github.com/zolw22/tarkov_player_tracker)`;

// --- MAPY (gdzie przedmiot się znajduje - loose loot) ---
// json.tarkov.dev zwraca warianty/duplikaty map (dzień/noc, poziomy GZ, tutorial) - scalamy
// je do jednej "prawdziwej" mapy. Mapy pominięte tu (tutorial/dark/event) nie liczą się
// w ogóle do wykrywania "dostępne wszędzie".
const MAP_CANONICALIZE = {
    'factory': 'Factory', 'night-factory': 'Factory',
    'customs': 'Customs', 'woods': 'Woods', 'lighthouse': 'Lighthouse', 'shoreline': 'Shoreline',
    'reserve': 'Reserve', 'interchange': 'Interchange', 'streets-of-tarkov': 'Streets of Tarkov',
    'the-lab': 'The Lab', 'the-lab-dark': 'The Lab',
    'ground-zero': 'Ground Zero', 'ground-zero-21': 'Ground Zero',
    'the-labyrinth': 'The Labyrinth'
};
// pełny zestaw "normalnych" map do porównania - jeśli item pokrywa je wszystkie, pokazujemy
// "dostępne wszędzie" zamiast wypisywać każdą z osobna
const STANDARD_MAPS = ['Customs', 'Factory', 'Woods', 'Lighthouse', 'Shoreline', 'Reserve', 'Interchange', 'Streets of Tarkov', 'Ground Zero', 'The Lab'];

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '2mb' })); // skrypt logów z PC wysyła JSON
app.use(express.static(path.join(__dirname, 'public')));

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

// tarkov_tracker_backup_2026-10-24T22-32-54-518Z.db -> ms (najnowszy backup = ostatni wipe)
function latestWipeBackupTime() {
    try {
        const times = fs.readdirSync(process.cwd())
            .map(f => f.match(/^tarkov_tracker_backup_(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.db$/))
            .filter(Boolean)
            .map(m => Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`))
            .filter(t => !isNaN(t));
        return times.length ? Math.max(...times) : 0;
    } catch (e) { return 0; }
}

function initializeDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, quantity INTEGER, category TEXT, image TEXT, is_fir INTEGER DEFAULT 0)`);
        db.run(`CREATE TABLE IF NOT EXISTS tarkov_items_cache (
            id TEXT PRIMARY KEY, name TEXT, shortName TEXT, image TEXT,
            price_min INTEGER DEFAULT 0, price_avg INTEGER DEFAULT 0, price_max INTEGER DEFAULT 0
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS tarkov_tasks_cache (id TEXT PRIMARY KEY, name TEXT, trader TEXT)`);

        // --- HIDEOUT (stacje, poziomy, wymagane itemy - cache z tarkov.dev) ---
        db.run(`CREATE TABLE IF NOT EXISTS hideout_stations (id TEXT PRIMARY KEY, name TEXT, normalized_name TEXT, image TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS hideout_levels (
            id TEXT PRIMARY KEY, station_id TEXT, level INTEGER, construction_time INTEGER DEFAULT 0,
            station_reqs TEXT DEFAULT '[]', trader_reqs TEXT DEFAULT '[]', skill_reqs TEXT DEFAULT '[]'
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS hideout_level_items (level_id TEXT, item_id TEXT, count INTEGER, fir INTEGER DEFAULT 0, PRIMARY KEY (level_id, item_id))`);
        // postęp użytkownika: przypięte/zbudowane poziomy + ile sztuk danego itemu już ma
        db.run(`CREATE TABLE IF NOT EXISTS hideout_progress (level_id TEXT PRIMARY KEY, pinned INTEGER DEFAULT 0, built INTEGER DEFAULT 0)`);
        db.run(`CREATE TABLE IF NOT EXISTS hideout_have (item_id TEXT PRIMARY KEY, have INTEGER DEFAULT 0)`);

        // --- SKRYPT LOGÓW (PC) ---
        // app_settings: m.in. wipe_at (ms) - questy ukończone przed ostatnim wipe'em są ignorowane
        db.run(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
        // ukończone questy zgłoszone przez skrypt czytający logi gry (id questu = id z tarkov.dev/BSG)
        db.run(`CREATE TABLE IF NOT EXISTS quest_completions (quest_id TEXT PRIMARY KEY, name TEXT, completed_at INTEGER, received_at INTEGER)`);
        // stan KAŻDEGO questa (nie tylko Kappy): started / done / failed, z logów gry albo ustawiony ręcznie
        db.run(`CREATE TABLE IF NOT EXISTS quest_status (quest_id TEXT PRIMARY KEY, status TEXT, at INTEGER, source TEXT)`);
        // questy ukończone zanim istniała ta tabela (skrypt v1.0) - przenosimy jako "done"
        db.run(`INSERT OR IGNORE INTO quest_status (quest_id, status, at, source) SELECT quest_id, 'done', completed_at, 'log' FROM quest_completions`);
        // wipe zrobiony wersją bez wipe_at (albo baza sprzed tej funkcji): datę bierzemy z nazwy
        // najnowszego backupu, który /wipe zawsze tworzy - inaczej skrypt logów odhaczyłby questy sprzed wipe'a
        db.get("SELECT value FROM app_settings WHERE key = 'wipe_at'", [], (err, row) => {
            if (err || row) return;
            const t = latestWipeBackupTime();
            if (!t) return;
            db.run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('wipe_at', ?)", [String(t)],
                () => console.log(`🧨 [WIPE] Data ostatniego wipe'a odtworzona z backupu: ${new Date(t).toISOString()}`));
        });

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
                    // pełne dane questów do strony Questy
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN min_level INTEGER DEFAULT 0",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN map TEXT DEFAULT ''",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN kappa INTEGER DEFAULT 0",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN wiki TEXT DEFAULT ''",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN trader_image TEXT DEFAULT ''",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN faction TEXT DEFAULT 'Any'",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN req_ids TEXT DEFAULT '[]'",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN give_items TEXT DEFAULT '[]'",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN image TEXT DEFAULT ''",
                    "ALTER TABLE tarkov_tasks_cache ADD COLUMN objectives TEXT DEFAULT '[]'",
                    "ALTER TABLE items ADD COLUMN sort_order INTEGER DEFAULT 0",
                    "ALTER TABLE tarkov_items_cache ADD COLUMN maps TEXT DEFAULT '[]'",
                    "ALTER TABLE items ADD COLUMN item_id TEXT DEFAULT ''",
                    "ALTER TABLE kappa_tracker ADD COLUMN task_id TEXT DEFAULT ''"
                ];
                let done = 0;
                migrations.forEach(sql => db.run(sql, () => {
                    done++;
                    if (done === migrations.length) {
                        // uzupełnij item_id dla itemów dodanych przed tą funkcją (dopasowanie po nazwie,
                        // tylko tam gdzie jeszcze nie ustawione - nic nie nadpisuje)
                        db.run(`UPDATE items SET item_id = (SELECT id FROM tarkov_items_cache WHERE tarkov_items_cache.name = items.name LIMIT 1)
                                WHERE (item_id IS NULL OR item_id = '') AND EXISTS (SELECT 1 FROM tarkov_items_cache WHERE tarkov_items_cache.name = items.name)`,
                            () => startBackgroundTasks());
                    }
                }));
                
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

    // Mapy loose lootu - jeszcze rzadziej się zmieniają, więc też co SYNC_INTERVAL
    setTimeout(runMapSync, 6000);
    setInterval(runMapSync, SYNC_INTERVAL);

    // Hideout (stacje/poziomy/itemy) - zmienia się tylko z patchami, więc co SYNC_INTERVAL
    setTimeout(runHideoutSync, 9000);
    setInterval(runHideoutSync, SYNC_INTERVAL);
}

// Jak runMapSync - jeśli API padało, dobijamy się częściej aż do pierwszego sukcesu.
async function runHideoutSync() {
    const ok = await syncHideout();
    if (!ok) {
        console.log("⏳ [HIDEOUT] Nie udało się pobrać danych hideoutu, spróbuję ponownie za " + (PRICES_INTERVAL / 60000) + " min.");
        setTimeout(runHideoutSync, PRICES_INTERVAL);
    }
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

// Tak samo jak runKappaSync - jeśli się nie udało (np. API padało), próbuje częściej,
// dopóki się nie uda choć raz.
async function runMapSync() {
    const ok = await syncMapLootLocations();
    if (!ok) {
        console.log("⏳ [MAPY] Nie udało się pobrać danych o mapach, spróbuję ponownie za " + (PRICES_INTERVAL / 60000) + " min.");
        setTimeout(runMapSync, PRICES_INTERVAL);
    }
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
    // tasks_en = słownik tekstów (id celu -> opis po angielsku, jak w grze); bez niego cele zostają bez opisu
    const [tasksData, tradersData, mapsData, tasksText] = await Promise.all([
        fetchJsonApi('/regular/tasks'), fetchJsonApi('/regular/traders'),
        fetchJsonApi('/regular/maps').catch(() => ({})), fetchJsonApi('/regular/tasks_en').catch(() => ({}))
    ]);
    const objectiveText = id => (tasksText && typeof tasksText[id] === 'string') ? tasksText[id].trim() : '';
    const mapNameById = {};
    Object.values((mapsData && mapsData.maps) || {}).forEach(m => {
        if (m && m.id) mapNameById[m.id] = MAP_CANONICALIZE[m.normalizedName] || humanizeSlug(m.normalizedName) || '';
    });
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
                // kształt jak w GraphQL: item (pierwszy, dla Kappy/Collectora) + items/count/foundInRaid/type
                const objectives = (t.objectives || [])
                    .filter(o => (o.type === 'giveItem' || o.type === 'plantItem') && Array.isArray(o.items) && o.items.length > 0)
                    .map(o => {
                        const known = itemById[o.items[0]];
                        return {
                            type: o.type, count: o.count || 1, foundInRaid: !!o.foundInRaid, optional: !!o.optional,
                            items: o.items.map(id => ({ id })),
                            item: known ? { name: known.name, iconLink: known.iconLink } : null
                        };
                    });
                return {
                    id: t.id,
                    name: t.name,
                    kappaRequired: !!t.kappaRequired,
                    minPlayerLevel: t.minPlayerLevel || 0,
                    factionName: t.factionName || 'Any',
                    trader: traderById[t.trader] || null,
                    map: t.map && mapNameById[t.map] ? { name: mapNameById[t.map] } : null,
                    wikiLink: t.wikiLink || '',
                    taskImageLink: t.taskImageLink || '',
                    objectiveTexts: (t.objectives || []).map(o => ({ text: objectiveText(o.id), optional: !!o.optional })).filter(o => o.text),
                    objectives,
                    taskRequirements: (t.taskRequirements || []).map(r => ({ task: { id: r.task, name: taskNameById[r.task] || '?' } }))
                };
            }));
        });
    });
}

// --- MAPY (gdzie przedmiot się faktycznie znajduje - loose loot) ---
// Dostępne tylko dla ~kilkuset rzadkich/wartościowych przedmiotów (zegarki, monety,
// plakaty, przedmioty questowe itd.) - zwykłe materiały craftingowe tego nie mają w ogóle
// (spawnują w kontenerach, nie jako oznaczone punkty), więc dla nich po prostu nic nie
// pokażemy. Świeżo dodane do gry przedmioty też mogą jeszcze nie mieć danych - to nie błąd,
// tarkov.dev jeszcze ich nie skatalogował.
async function syncMapLootLocations() {
    console.log("🗺️ [MAPY] Sprawdzam lokalizacje przedmiotów (loose loot)...");
    try {
        const data = await fetchJsonApi('/regular/maps');
        const maps = Object.values(data.maps || {});
        if (maps.length === 0) throw new Error('json.tarkov.dev: pusta lista map');

        const index = {}; // itemId -> Set(nazwa kanoniczna mapy)
        maps.forEach(m => {
            const canonical = MAP_CANONICALIZE[m.normalizedName];
            if (!canonical) return; // pomijamy tutorial/event/duplikaty
            (m.lootLoose || []).forEach(spot => {
                (spot.items || []).forEach(itemId => {
                    if (!index[itemId]) index[itemId] = new Set();
                    index[itemId].add(canonical);
                });
            });
        });

        const ids = Object.keys(index);
        await new Promise((resolve) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare("UPDATE tarkov_items_cache SET maps = ? WHERE id = ?");
                ids.forEach(id => stmt.run(JSON.stringify([...index[id]].sort()), id));
                stmt.finalize();
                db.run("COMMIT", resolve);
            });
        });

        console.log(`✅ [MAPY] Zaktualizowano lokalizacje dla ${ids.length} przedmiotów.`);
        return true;
    } catch (e) {
        console.error("❌ [ERROR] Błąd pobierania map:", e.message);
        return false;
    }
}

// --- HIDEOUT (stacje, poziomy, wymagane itemy) ---
// Źródło: GraphQL hideoutStations, a gdy pada - json.tarkov.dev/regular/hideout. Oba sprowadzamy
// do jednej postaci: { id, name, normalizedName, imageLink, levels: [{ id, level, constructionTime,
// stationReqs: [{stationId, level}], traderReqs: [{name, level}], skillReqs: [{name, level}],
// items: [{itemId, count, fir}] }] }. Nazwy itemów/ikony dociągamy z tarkov_items_cache przy renderze.
// json.tarkov.dev podaje nazwy stacji jako klucze lokalizacji ("hideout_area_13_name") - wtedy
// nazwę budujemy ze sluga (normalizedName), np. "water-collector" -> "Water Collector".
function resolveStationName(rawName, normalizedName) {
    if (!rawName || /^hideout_area_/i.test(rawName)) return humanizeSlug(normalizedName) || rawName || '?';
    return rawName;
}

async function fetchHideoutFromGraphql() {
    const query = `
    {
        hideoutStations(lang: en) {
            id name normalizedName imageLink
            levels {
                id level constructionTime
                itemRequirements { count item { id } attributes { name value } }
                stationLevelRequirements { level station { id } }
                traderRequirements { value trader { name } }
                skillRequirements { name level }
            }
        }
    }`;
    const response = await tarkovApiRequest({ query });
    const stations = response.data.data ? response.data.data.hideoutStations : null;
    if (!stations || stations.length === 0) throw new Error('GraphQL: pusta lista stacji hideoutu');
    return stations.map(s => ({
        id: s.id, name: resolveStationName(s.name, s.normalizedName), normalizedName: s.normalizedName || '', imageLink: s.imageLink || '',
        levels: (s.levels || []).map(l => ({
            id: l.id || `${s.id}-${l.level}`, level: l.level, constructionTime: l.constructionTime || 0,
            stationReqs: (l.stationLevelRequirements || []).filter(r => r.station).map(r => ({ stationId: r.station.id, level: r.level })),
            traderReqs: (l.traderRequirements || []).filter(r => r.trader).map(r => ({ name: r.trader.name, level: r.value })),
            skillReqs: (l.skillRequirements || []).map(r => ({ name: r.name, level: r.level })),
            items: (l.itemRequirements || []).filter(r => r.item).map(r => ({
                itemId: r.item.id, count: r.count || 1,
                fir: (r.attributes || []).some(a => a.name === 'foundInRaid' && String(a.value) === 'true') ? 1 : 0
            }))
        }))
    }));
}

async function fetchHideoutFromJsonApi() {
    const [data, tradersData] = await Promise.all([fetchJsonApi('/regular/hideout'), fetchJsonApi('/regular/traders').catch(() => ({}))]);
    const rawList = Object.values(data || {});
    if (rawList.length === 0) throw new Error('json.tarkov.dev: pusta lista stacji hideoutu');
    const traderNameById = {};
    Object.values(tradersData || {}).forEach(t => { if (t && t.id) traderNameById[t.id] = resolveName(t.name, t.id, t.normalizedName); });

    return rawList.map(s => ({
        id: s.id, name: resolveStationName(s.name, s.normalizedName), normalizedName: s.normalizedName || '', imageLink: s.imageLink || '',
        levels: (s.levels || []).map(l => ({
            id: l.id || `${s.id}-${l.level}`, level: l.level, constructionTime: l.constructionTime || 0,
            stationReqs: (l.stationLevelRequirements || []).map(r => ({ stationId: r.station, level: r.level })),
            traderReqs: (l.traderRequirements || []).map(r => ({ name: traderNameById[r.trader] || humanizeSlug(r.trader) || '?', level: r.value || r.level })),
            skillReqs: (l.skillRequirements || []).map(r => ({ name: r.skill || r.name, level: r.level })),
            items: (l.itemRequirements || []).filter(r => r.item).map(r => ({
                itemId: r.item, count: r.count || 1, fir: (r.attributes && r.attributes.foundInRaid) ? 1 : 0
            }))
        }))
    }));
}

async function syncHideout() {
    console.log("🏠 [HIDEOUT] Synchronizuję stacje hideoutu...");
    let stations;
    try {
        stations = await fetchHideoutFromGraphql();
    } catch (graphqlErr) {
        console.warn("⚠️ [HIDEOUT] GraphQL zawiódł, próbuję json.tarkov.dev...");
        try {
            stations = await fetchHideoutFromJsonApi();
        } catch (jsonErr) {
            console.error("❌ [HIDEOUT] Błąd pobierania (GraphQL i JSON):", jsonErr.message);
            return false;
        }
    }

    await new Promise((resolve) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            // pełne odświeżenie cache'u (postęp użytkownika jest w osobnych tabelach i zostaje)
            db.run("DELETE FROM hideout_level_items");
            db.run("DELETE FROM hideout_levels");
            db.run("DELETE FROM hideout_stations");
            const stStmt = db.prepare("INSERT INTO hideout_stations (id, name, normalized_name, image) VALUES (?, ?, ?, ?)");
            const lvStmt = db.prepare("INSERT INTO hideout_levels (id, station_id, level, construction_time, station_reqs, trader_reqs, skill_reqs) VALUES (?, ?, ?, ?, ?, ?, ?)");
            const itStmt = db.prepare("INSERT OR REPLACE INTO hideout_level_items (level_id, item_id, count, fir) VALUES (?, ?, ?, ?)");
            stations.forEach(s => {
                stStmt.run(s.id, s.name, s.normalizedName, s.imageLink);
                s.levels.forEach(l => {
                    lvStmt.run(l.id, s.id, l.level, l.constructionTime, JSON.stringify(l.stationReqs), JSON.stringify(l.traderReqs), JSON.stringify(l.skillReqs));
                    l.items.forEach(i => itStmt.run(l.id, i.itemId, i.count, i.fir));
                });
            });
            stStmt.finalize(); lvStmt.finalize(); itStmt.finalize();
            db.run("COMMIT", resolve);
        });
    });

    const levelCount = stations.reduce((n, s) => n + s.levels.length, 0);
    console.log(`✅ [HIDEOUT] Zapisano ${stations.length} stacji, ${levelCount} poziomów.`);
    return true;
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
        // UWAGA: celowo NIE "INSERT OR REPLACE" - to kasuje/wstawia wiersz na nowo w SQLite,
        // co resetowałoby kolumnę "maps" (ustawianą osobno przez syncMapLootLocations) do
        // wartości domyślnej przy każdym odświeżeniu cen co 10 min. ON CONFLICT DO UPDATE
        // dotyka tylko wymienionych kolumn.
        const stmt = db.prepare(`INSERT INTO tarkov_items_cache (id, name, shortName, image, price_min, price_avg, price_max) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, shortName=excluded.shortName, image=excluded.image,
                price_min=excluded.price_min, price_avg=excluded.price_avg, price_max=excluded.price_max`);

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
            id, name, kappaRequired, minPlayerLevel, factionName, trader { name imageLink }, map { name }, wikiLink, taskImageLink,
            objectives { id type description ... on TaskObjectiveItem { item { name iconLink } items { id } count foundInRaid } },
            taskRequirements { task { id name } }
        }
    }`;
    let allTasks;
    try {
        const response = await tarkovApiRequest({ query });
        allTasks = response.data.data ? response.data.data.tasks : null;
        // GraphQL potrafi odpowiedzieć 200 z błędem w body (np. zmiana schematu) - wtedy też idziemy w JSON
        if (!allTasks || allTasks.length === 0) throw new Error((response.data.errors && response.data.errors[0] && response.data.errors[0].message) || 'brak questów w odpowiedzi');
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
            // zapasowe źródło (json.tarkov.dev) gubi teraz wymagania/poziomy wielu questów - pustymi
            // danymi nie nadpisujemy wcześniej zapisanych pełnych (stąd CASE przy req_ids/min_level/map)
            const stmt = db.prepare(`INSERT INTO tarkov_tasks_cache
                (id, name, trader, min_level, map, kappa, wiki, trader_image, faction, req_ids, give_items, image, objectives)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, trader = excluded.trader, kappa = excluded.kappa, wiki = excluded.wiki,
                    trader_image = excluded.trader_image, faction = excluded.faction, give_items = excluded.give_items, image = excluded.image,
                    min_level = CASE WHEN excluded.min_level = 0 THEN tarkov_tasks_cache.min_level ELSE excluded.min_level END,
                    map = CASE WHEN excluded.map = '' THEN tarkov_tasks_cache.map ELSE excluded.map END,
                    req_ids = CASE WHEN excluded.req_ids = '[]' THEN tarkov_tasks_cache.req_ids ELSE excluded.req_ids END,
                    objectives = CASE WHEN excluded.objectives = '[]' THEN tarkov_tasks_cache.objectives ELSE excluded.objectives END`);
            allTasks.forEach(t => {
                // przedmioty do ODDANIA (giveItem); przy wielu zamiennikach trzymamy max 30 id
                const giveItems = (t.objectives || [])
                    .filter(o => o.type === 'giveItem' && Array.isArray(o.items) && o.items.length > 0)
                    .map(o => ({ ids: o.items.filter(Boolean).slice(0, 30).map(i => i.id), alternatives: o.items.length, count: o.count || 1, fir: o.foundInRaid ? 1 : 0, optional: o.optional ? 1 : 0 }));
                const reqIds = (t.taskRequirements || []).map(r => r.task && r.task.id).filter(Boolean);
                stmt.run(t.id, t.name, t.trader ? t.trader.name : 'Unknown', t.minPlayerLevel || 0, t.map ? t.map.name : '',
                    t.kappaRequired ? 1 : 0, t.wikiLink || '', t.trader ? (t.trader.imageLink || '') : '', t.factionName || 'Any',
                    JSON.stringify(reqIds), JSON.stringify(giveItems), t.taskImageLink || '',
                    // opisy celów: z JSON (objectiveTexts) albo z GraphQL (description w objectives)
                    JSON.stringify(t.objectiveTexts || (t.objectives || []).filter(o => o && o.description).map(o => ({ text: o.description, optional: !!o.optional }))));
            });
            // questy, których tarkov.dev już nie podaje (usunięte z gry / stare id) - inaczej wisiałyby na stronie Questy
            if (allTasks.length > 100) db.run(`DELETE FROM tarkov_tasks_cache WHERE id NOT IN (${allTasks.map(() => '?').join(',')})`, allTasks.map(t => t.id));
            stmt.finalize();
            db.run("COMMIT");
        });

        const collectorTask = allTasks.find(t => t.name === "Collector");
        const fenceImage = collectorTask && collectorTask.trader ? collectorTask.trader.imageLink : '';
        const collectorItems = collectorTask ? collectorTask.objectives.filter(obj => obj.item).map(obj => ({
            name: obj.item.name, image: obj.item.iconLink || '', type: 'item', min_level: 55, trader: 'Fence', trader_image: fenceImage, req: 'Quest: Collector', faction: 'Any', map: 'All', wiki_link: '', reqNames: '[]', task_id: ''
        })) : [];
        const requiredTasks = allTasks.filter(t => t.kappaRequired === true).map(t => {
            const reqNames = t.taskRequirements.map(r => r.task.name);
            return {
                name: t.name, image: '', type: 'quest', min_level: t.minPlayerLevel || 0, trader: t.trader ? t.trader.name : '?', trader_image: t.trader ? t.trader.imageLink : '', faction: t.factionName || 'Any', map: t.map ? t.map.name : 'Any', wiki_link: t.wikiLink || '', req: reqNames.length ? `Wymaga: ${reqNames.join(", ")}` : 'Startowy', reqNames: JSON.stringify(reqNames), task_id: t.id || ''
            };
        });
        
        console.log(`🔎 [KAPPA] Znaleziono: ${collectorItems.length} przedmiotów streamera i ${requiredTasks.length} wymaganych questów.`);
        
        const everything = [...collectorItems, ...requiredTasks];
        let newCount = 0;
        
        const upsert = (item) => new Promise((resolve) => {
            db.get("SELECT id FROM kappa_tracker WHERE name = ?", [item.name], (err, row) => {
                if (!row) {
                    db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements, faction, map, wiki_link, trader_image, requirement_names, task_id) VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [item.name, item.image, item.type, item.min_level, item.trader, item.req, item.faction, item.map, item.wiki_link, item.trader_image, item.reqNames, item.task_id], () => resolve(1));
                } else {
                    db.run(`UPDATE kappa_tracker SET min_level=?, trader=?, requirements=?, type=?, image=?, faction=?, map=?, wiki_link=?, trader_image=?, requirement_names=?, task_id=? WHERE id=?`, [item.min_level, item.trader, item.req, item.type, item.image || '', item.faction, item.map, item.wiki_link, item.trader_image, item.reqNames, item.task_id, row.id], () => resolve(0));
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
    db.all(`SELECT items.*, tarkov_items_cache.maps as cache_maps FROM items
            LEFT JOIN tarkov_items_cache ON items.item_id = tarkov_items_cache.id
            ORDER BY (quantity = 0), sort_order ASC, id DESC`, [], (err, rows) => {
        rows.forEach(r => {
            let maps = [];
            try { maps = JSON.parse(r.cache_maps || '[]'); } catch (e) { maps = []; }
            if (maps.length === 0) r.mapsInfo = null; // brak danych - nie wiemy / nie dotyczy
            else if (STANDARD_MAPS.every(m => maps.includes(m))) r.mapsInfo = 'ALL';
            else r.mapsInfo = maps;
        });
        const categories = { 'Hideout': rows.filter(r => r.category === 'Hideout'), 'Crafting': rows.filter(r => r.category === 'Crafting'), 'Misje': rows.filter(r => r.category === 'Misje') };
        loadPinnedHideoutNeeds()
            .then(hideoutNeeds => res.render('index', { categories, hideoutNeeds }))
            .catch(e => { console.error("❌ [LOOT] Błąd liczenia potrzeb hideoutu:", e.message); res.render('index', { categories, hideoutNeeds: [] }); });
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
// po zmianie questa w Kappie ten sam stan trafia na stronę Questy (mirrorKappaRowToQuestStatus)
const mirrorThenRedirect = (id, res) => mirrorKappaRowToQuestStatus(id).catch(e => console.error("❌ [KAPPA] mirror:", e.message)).finally(() => res.redirect('/kappa'));
app.post('/kappa/set_status/:id', (req, res) => { db.run("UPDATE kappa_tracker SET is_collected = ?, is_new = 0 WHERE id = ?", [parseInt(req.body.status), req.params.id], () => mirrorThenRedirect(req.params.id, res)); });
app.post('/kappa/toggle/:id', (req, res) => { db.get("SELECT is_collected FROM kappa_tracker WHERE id = ?", [req.params.id], (err, row) => { if(row) { const next = (row.is_collected >= 1) ? 0 : 2; db.run("UPDATE kappa_tracker SET is_collected = ?, is_new = 0 WHERE id = ?", [next, req.params.id], () => mirrorThenRedirect(req.params.id, res)); } else res.redirect('/kappa'); }); });
app.post('/kappa/add', (req, res) => { const { name, image } = req.body; db.get("SELECT id FROM kappa_tracker WHERE name = ?", [name], (err, row) => { if (!row) db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements) VALUES (?, ?, 0, 1, 'item', 0, 'Custom', 'Ręcznie')`, [name, image || ''], () => res.redirect('/kappa')); else res.redirect('/kappa'); }); });
app.post('/kappa/add_quest', (req, res) => { const { name, trader } = req.body; db.get("SELECT id FROM kappa_tracker WHERE name = ?", [name], (err, row) => { if (!row) db.run(`INSERT INTO kappa_tracker (name, image, is_collected, is_new, type, min_level, trader, requirements, map, trader_image) VALUES (?, '', 0, 1, 'quest', 0, ?, 'Ręcznie dodane', 'Any', '')`, [name, trader || 'Custom'], () => res.redirect('/kappa')); else res.redirect('/kappa'); }); });
app.post('/kappa/refresh', async (req, res) => { await syncKappaWithAPI(); res.redirect('/kappa'); });
app.get('/api/search', (req, res) => { const q = req.query.q; if (!q || q.length < 2) return res.json([]); db.all(`SELECT id, name, image FROM tarkov_items_cache WHERE name LIKE ? OR shortName LIKE ? LIMIT 10`, [`%${q}%`, `%${q}%`], (err, rows) => res.json(rows || [])); });
app.get('/api/search_tasks', (req, res) => { const q = req.query.q; if (!q || q.length < 2) return res.json([]); db.all(`SELECT name, trader FROM tarkov_tasks_cache WHERE name LIKE ? LIMIT 10`, [`%${q}%`], (err, rows) => res.json(rows || [])); });
app.post('/add', (req, res) => { const { name, quantity, category, image, fir, item_id } = req.body; const isFir = fir === 'on' ? 1 : 0; db.run(`INSERT INTO items (name, quantity, category, image, is_fir, item_id) VALUES (?, ?, ?, ?, ?, ?)`, [name, quantity, category, image || '', isFir, item_id || ''], () => res.redirect('/')); });

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

// --- HIDEOUT (strona + API) ---
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
const parseJson = (s, fallback) => { try { return JSON.parse(s || ''); } catch (e) { return fallback; } };

// Składa pełny obraz hideoutu: stacje -> poziomy -> itemy (z nazwą/ikoną/mapami z cache'u),
// plus stan użytkownika (przypięte/zbudowane poziomy, ile sztuk każdego itemu ma).
async function loadHideoutData() {
    const [stations, levels, levelItems, progress, haveRows] = await Promise.all([
        dbAll("SELECT * FROM hideout_stations ORDER BY name ASC"),
        dbAll("SELECT * FROM hideout_levels ORDER BY station_id, level ASC"),
        dbAll(`SELECT li.level_id, li.item_id, li.count, li.fir, c.name, c.shortName, c.image, c.maps, c.price_avg
               FROM hideout_level_items li LEFT JOIN tarkov_items_cache c ON c.id = li.item_id`),
        dbAll("SELECT * FROM hideout_progress"),
        dbAll("SELECT * FROM hideout_have")
    ]);
    const stationNameById = {}; stations.forEach(s => { stationNameById[s.id] = s.name; });
    const progressById = {}; progress.forEach(p => { progressById[p.level_id] = p; });
    const have = {}; haveRows.forEach(h => { have[h.item_id] = h.have; });
    const builtLevelByStation = {}; // stationId -> najwyższy zbudowany poziom
    levels.forEach(l => { const p = progressById[l.id]; if (p && p.built) builtLevelByStation[l.station_id] = Math.max(builtLevelByStation[l.station_id] || 0, l.level); });

    const itemsByLevel = {};
    levelItems.forEach(li => {
        if (!itemsByLevel[li.level_id]) itemsByLevel[li.level_id] = [];
        let maps = parseJson(li.maps, []);
        let mapsInfo = null;
        if (maps.length > 0) mapsInfo = STANDARD_MAPS.every(m => maps.includes(m)) ? 'ALL' : maps;
        itemsByLevel[li.level_id].push({
            itemId: li.item_id, count: li.count, fir: li.fir,
            name: li.name || `Nieznany przedmiot (${li.item_id})`, shortName: li.shortName || '', image: li.image || '',
            mapsInfo, priceAvg: li.price_avg || 0
        });
    });

    const levelsByStation = {};
    levels.forEach(l => {
        const p = progressById[l.id] || { pinned: 0, built: 0 };
        const stationReqs = parseJson(l.station_reqs, []).map(r => ({ ...r, stationName: stationNameById[r.stationId] || '?', met: (builtLevelByStation[r.stationId] || 0) >= r.level }));
        const lvl = {
            id: l.id, level: l.level, constructionTime: l.construction_time,
            stationReqs, traderReqs: parseJson(l.trader_reqs, []), skillReqs: parseJson(l.skill_reqs, []),
            items: (itemsByLevel[l.id] || []).sort((a, b) => b.count - a.count),
            pinned: !!p.pinned, built: !!p.built,
            locked: stationReqs.some(r => !r.met)
        };
        if (!levelsByStation[l.station_id]) levelsByStation[l.station_id] = [];
        levelsByStation[l.station_id].push(lvl);
    });

    return {
        stations: stations.map(s => ({ id: s.id, name: s.name, image: s.image, levels: levelsByStation[s.id] || [] })),
        have
    };
}

// Brakujące itemy do przypiętych (niezbudowanych) poziomów hideoutu - pokazywane automatycznie
// w kategorii Hideout na stronie Loot. Ten sam licznik "mam" (hideout_have) co strona Hideout.
// Waluty pomijamy - to nie loot do szukania.
const CURRENCY_IDS = ['5449016a4bdc2d6f028b456f', '5696686a4bdc2da3298b456a', '569668774bdc2da2298b4568']; // ₽ $ €
async function loadPinnedHideoutNeeds() {
    const [rows, haveRows] = await Promise.all([
        dbAll(`SELECT li.item_id, li.count, li.fir, s.name AS station, l.level, c.name, c.image, c.maps
               FROM hideout_progress p
               JOIN hideout_levels l ON l.id = p.level_id
               JOIN hideout_stations s ON s.id = l.station_id
               JOIN hideout_level_items li ON li.level_id = l.id
               LEFT JOIN tarkov_items_cache c ON c.id = li.item_id
               WHERE p.pinned = 1 AND p.built = 0
               ORDER BY s.name, l.level`),
        dbAll("SELECT item_id, have FROM hideout_have")
    ]);
    const have = {}; haveRows.forEach(h => { have[h.item_id] = h.have; });
    const agg = {};
    rows.forEach(r => {
        if (CURRENCY_IDS.includes(r.item_id)) return;
        if (!agg[r.item_id]) {
            const maps = parseJson(r.maps, []);
            agg[r.item_id] = {
                itemId: r.item_id, name: r.name || `Nieznany przedmiot (${r.item_id})`, image: r.image || '',
                mapsInfo: maps.length === 0 ? null : (STANDARD_MAPS.every(m => maps.includes(m)) ? 'ALL' : maps),
                total: 0, fir: 0, goals: []
            };
        }
        const a = agg[r.item_id];
        a.total += r.count;
        if (r.fir) a.fir = 1;
        a.goals.push(`${r.station} ${r.level}`);
    });
    return Object.values(agg)
        .map(a => ({ ...a, have: have[a.itemId] || 0, missing: Math.max(0, a.total - (have[a.itemId] || 0)) }))
        .filter(a => a.missing > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/hideout', async (req, res) => {
    try {
        const data = await loadHideoutData();
        res.render('hideout', { data });
    } catch (e) {
        console.error("❌ [HIDEOUT] Błąd renderowania:", e.message);
        res.status(500).send('Błąd ładowania hideoutu: ' + e.message);
    }
});

app.post('/hideout/refresh', async (req, res) => { await syncHideout(); res.redirect('/hideout'); });

app.post('/api/hideout/levels/:id/pin', async (req, res) => {
    try {
        const row = await dbGet("SELECT pinned FROM hideout_progress WHERE level_id = ?", [req.params.id]);
        const next = row && row.pinned ? 0 : 1;
        await dbRun("INSERT INTO hideout_progress (level_id, pinned, built) VALUES (?, ?, 0) ON CONFLICT(level_id) DO UPDATE SET pinned = excluded.pinned", [req.params.id, next]);
        res.json({ id: req.params.id, pinned: !!next });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Oznaczenie poziomu N jako zbudowany: wszystkie poziomy <= N tej stacji stają się zbudowane
// (i tracą przypięcie), a itemy świeżo "zbudowanych" poziomów odejmujemy z licznika "mam"
// (bo właśnie poszły na budowę). Odznaczenie: poziomy >= N wracają do "niezbudowane".
app.post('/api/hideout/levels/:id/built', async (req, res) => {
    try {
        const target = await dbGet("SELECT id, station_id, level FROM hideout_levels WHERE id = ?", [req.params.id]);
        if (!target) return res.status(404).json({ error: 'not found' });
        const current = await dbGet("SELECT built FROM hideout_progress WHERE level_id = ?", [target.id]);
        const makeBuilt = !(current && current.built);

        const stationLevels = await dbAll("SELECT l.id, l.level, COALESCE(p.built, 0) AS built FROM hideout_levels l LEFT JOIN hideout_progress p ON p.level_id = l.id WHERE l.station_id = ?", [target.station_id]);
        const affected = stationLevels.filter(l => makeBuilt ? l.level <= target.level : l.level >= target.level);
        const changedIds = [];
        for (const l of affected) {
            if (makeBuilt && !l.built) changedIds.push(l.id);
            await dbRun("INSERT INTO hideout_progress (level_id, pinned, built) VALUES (?, 0, ?) ON CONFLICT(level_id) DO UPDATE SET built = excluded.built, pinned = CASE WHEN excluded.built = 1 THEN 0 ELSE pinned END", [l.id, makeBuilt ? 1 : 0]);
        }

        const haveChanges = {};
        if (changedIds.length > 0) {
            const placeholders = changedIds.map(() => '?').join(',');
            const consumed = await dbAll(`SELECT item_id, SUM(count) AS total FROM hideout_level_items WHERE level_id IN (${placeholders}) GROUP BY item_id`, changedIds);
            for (const c of consumed) {
                const h = await dbGet("SELECT have FROM hideout_have WHERE item_id = ?", [c.item_id]);
                if (!h || h.have <= 0) continue;
                const next = Math.max(0, h.have - c.total);
                await dbRun("UPDATE hideout_have SET have = ? WHERE item_id = ?", [next, c.item_id]);
                haveChanges[c.item_id] = next;
            }
        }

        const levelsOut = await dbAll("SELECT l.id, COALESCE(p.pinned, 0) AS pinned, COALESCE(p.built, 0) AS built FROM hideout_levels l LEFT JOIN hideout_progress p ON p.level_id = l.id WHERE l.station_id = ?", [target.station_id]);
        res.json({ levels: levelsOut.map(l => ({ id: l.id, pinned: !!l.pinned, built: !!l.built })), have: haveChanges });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/hideout/have/:itemId', async (req, res) => {
    try {
        const row = await dbGet("SELECT have FROM hideout_have WHERE item_id = ?", [req.params.itemId]);
        const currentHave = row ? row.have : 0;
        let next = req.body.value !== undefined ? parseInt(req.body.value) : currentHave + parseInt(req.body.delta);
        if (isNaN(next) || next < 0) next = 0;
        await dbRun("INSERT INTO hideout_have (item_id, have) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET have = excluded.have", [req.params.itemId, next]);
        res.json({ itemId: req.params.itemId, have: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SKRYPT LOGÓW (logwatcher na PC) ---
// Skrypt na PC czyta logi powiadomień gry (tylko pliki tekstowe, nic w pamięci gry) i zgłasza tu
// ukończone questy. Heartbeat co ~20s - na jego podstawie strony pokazują, czy skrypt działa.
const LOGWATCHER_TIMEOUT = 90 * 1000; // brak sygnału dłużej niż tyle = "rozłączony"
const logwatcher = { lastSeen: null, version: null, host: null };

async function getWipeAt() {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'wipe_at'");
    return row ? Number(row.value) || 0 : 0;
}

app.post('/api/logwatcher/heartbeat', async (req, res) => {
    logwatcher.lastSeen = Date.now();
    logwatcher.version = (req.body && req.body.version) || null;
    logwatcher.host = (req.body && req.body.host) || req.ip;
    try { res.json({ ok: true, wipeAt: await getWipeAt() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STAN QUESTÓW (wszystkie questy, nie tylko Kappa) ---
// Typy wiadomości w logach gry: 10 = quest rozpoczęty, 11 = nieudany, 12 = ukończony.
const QUEST_EVENT_STATUS = { 10: 'started', 11: 'failed', 12: 'done' };
const KAPPA_LEVEL = { todo: 0, started: 1, done: 2 }; // kappa_tracker.is_collected

// wiersz questa w Kappie: po id questu, a gdy go nie ma (wpis sprzed tej wersji) - po nazwie
async function findKappaQuestRow(questId, name) {
    return dbGet("SELECT id, name, is_collected FROM kappa_tracker WHERE type = 'quest' AND (task_id = ? OR (? <> '' AND name = ?)) ORDER BY (task_id = ?) DESC LIMIT 1", [questId, name || '', name || '', questId]);
}

// Zdarzenie z logów: "ukończony" jest ostateczny (nie cofa go późniejszy start/porażka), poza tym
// wygrywa nowsze zdarzenie. Zwraca { status, name, kappa } gdy coś się zmieniło, inaczej null.
async function applyQuestLogEvent(questId, status, at) {
    const existing = await dbGet("SELECT status, at FROM quest_status WHERE quest_id = ?", [questId]);
    if (existing) {
        if (existing.status === status) return null;
        if (existing.status === 'done') return null;
        if (status !== 'done' && at < existing.at) return null;
    }
    const task = await dbGet("SELECT name FROM tarkov_tasks_cache WHERE id = ?", [questId]);
    const name = task ? task.name : '';
    await dbRun("INSERT INTO quest_status (quest_id, status, at, source) VALUES (?, ?, ?, 'log') ON CONFLICT(quest_id) DO UPDATE SET status = excluded.status, at = excluded.at, source = 'log'", [questId, status, at]);
    if (status === 'done') await dbRun("INSERT OR IGNORE INTO quest_completions (quest_id, name, completed_at, received_at) VALUES (?, ?, ?, ?)", [questId, name, at, Date.now()]);

    let kappa = null;
    const row = await findKappaQuestRow(questId, name);
    if (row) {
        if (status === 'done' && row.is_collected !== 2) { await dbRun("UPDATE kappa_tracker SET is_collected = 2, is_new = 0 WHERE id = ?", [row.id]); kappa = row.name; }
        if (status === 'started' && row.is_collected === 0) await dbRun("UPDATE kappa_tracker SET is_collected = 1, is_new = 0 WHERE id = ?", [row.id]);
    }
    return { status, name, kappa };
}

// Ręczna zmiana stanu (strona Questy albo Kappa): todo / started / done.
async function setQuestStatusManual(questId, status, { syncKappa = true } = {}) {
    const task = await dbGet("SELECT name FROM tarkov_tasks_cache WHERE id = ?", [questId]);
    const name = task ? task.name : '';
    if (status === 'todo') {
        await dbRun("DELETE FROM quest_status WHERE quest_id = ?", [questId]);
    } else {
        await dbRun("INSERT INTO quest_status (quest_id, status, at, source) VALUES (?, ?, ?, 'manual') ON CONFLICT(quest_id) DO UPDATE SET status = excluded.status, at = excluded.at, source = 'manual'", [questId, status, Date.now()]);
    }
    if (status === 'done') await dbRun("INSERT OR IGNORE INTO quest_completions (quest_id, name, completed_at, received_at) VALUES (?, ?, ?, ?)", [questId, name, Date.now(), Date.now()]);
    else await dbRun("DELETE FROM quest_completions WHERE quest_id = ?", [questId]);
    if (syncKappa) {
        const row = await findKappaQuestRow(questId, name);
        if (row) await dbRun("UPDATE kappa_tracker SET is_collected = ?, is_new = 0 WHERE id = ?", [KAPPA_LEVEL[status], row.id]);
    }
}

// Zmiana na stronie Kappa -> ten sam stan na stronie Questy (dla wierszy-questów)
async function mirrorKappaRowToQuestStatus(kappaRowId) {
    const row = await dbGet("SELECT name, type, task_id, is_collected FROM kappa_tracker WHERE id = ?", [kappaRowId]);
    if (!row || row.type !== 'quest') return;
    let questId = row.task_id;
    if (!questId) { const t = await dbGet("SELECT id FROM tarkov_tasks_cache WHERE name = ?", [row.name]); questId = t ? t.id : null; }
    if (!questId) return;
    const status = row.is_collected === 2 ? 'done' : row.is_collected === 1 ? 'started' : 'todo';
    await setQuestStatusManual(questId, status, { syncKappa: false });
}

// body: { events: [{ questId, at, type }] } - at = ms (czas z serwera BSG), type 10/11/12 (brak = 12, skrypt v1.0)
app.post('/api/logwatcher/quests', async (req, res) => {
    logwatcher.lastSeen = Date.now();
    try {
        const wipeAt = await getWipeAt();
        const events = (Array.isArray(req.body && req.body.events) ? req.body.events : [])
            .map(ev => ({ questId: String(ev.questId || ''), at: Number(ev.at) || 0, status: QUEST_EVENT_STATUS[ev.type === undefined ? 12 : Number(ev.type)] }))
            .filter(ev => /^[0-9a-f]{24}$/i.test(ev.questId) && ev.status)
            .sort((a, b) => a.at - b.at);
        let accepted = 0, started = 0, old = 0;
        const kappaMarked = [];
        for (const ev of events) {
            if (ev.at < wipeAt) { old++; continue; }
            const r = await applyQuestLogEvent(ev.questId, ev.status, ev.at);
            if (!r) continue;
            if (r.status === 'done') accepted++;
            if (r.status === 'started') started++;
            if (r.kappa) kappaMarked.push(r.kappa);
        }
        if (accepted > 0 || started > 0) console.log(`📜 [LOGI] Skrypt: ukończone ${accepted}, rozpoczęte ${started} (Kappa odhaczone: ${kappaMarked.length}${kappaMarked.length ? ' - ' + kappaMarked.slice(0, 5).join(', ') + (kappaMarked.length > 5 ? '...' : '') : ''}).`);
        res.json({ ok: true, accepted, started, ignoredBeforeWipe: old, kappaMarked });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STRONA QUESTY ---
app.get('/quests', async (req, res) => {
    try {
        const [tasks, statuses, kappaRows] = await Promise.all([
            dbAll("SELECT * FROM tarkov_tasks_cache ORDER BY trader, min_level, name"),
            dbAll("SELECT * FROM quest_status"),
            dbAll("SELECT name, task_id, min_level, requirement_names FROM kappa_tracker WHERE type = 'quest'")
        ]);
        // starsze, pełniejsze dane z listy Kappy (z czasów działającego GraphQL) jako uzupełnienie braków
        const kappaByName = {}; kappaRows.forEach(k => { kappaByName[k.name] = k; });
        const idByName = {}; tasks.forEach(t => { idByName[t.name] = t.id; });
        const statusById = {}; statuses.forEach(s => { statusById[s.quest_id] = s; });
        // tarkov.dev ma teraz niepełną flagę kappaRequired - za Kappę uznajemy też to, co jest na liście Kappy
        const kappaIds = new Set(kappaRows.map(k => k.task_id).filter(Boolean));
        const kappaNames = new Set(kappaRows.map(k => k.name));

        const itemIds = new Set();
        const parsed = tasks.map(t => {
            const give = parseJson(t.give_items, []);
            give.forEach(g => g.ids.slice(0, 3).forEach(id => itemIds.add(id)));
            let reqIds = parseJson(t.req_ids, []);
            let minLevel = t.min_level || 0;
            const k = kappaByName[t.name];
            if (k) {
                if (reqIds.length === 0) reqIds = parseJson(k.requirement_names, []).map(n => idByName[n]).filter(Boolean);
                if (!minLevel) minLevel = k.min_level || 0;
            }
            return { t, give, reqIds, minLevel, objectives: parseJson(t.objectives, []) };
        });
        const items = itemIds.size ? await dbAll(`SELECT id, name, shortName, image FROM tarkov_items_cache WHERE id IN (${[...itemIds].map(() => '?').join(',')})`, [...itemIds]) : [];
        const itemById = {}; items.forEach(i => { itemById[i.id] = i; });

        const quests = parsed.map(({ t, give, reqIds, minLevel, objectives }) => {
            const st = statusById[t.id];
            return {
                id: t.id, name: t.name, trader: t.trader, traderImage: t.trader_image || '', minLevel,
                map: t.map || '', wiki: t.wiki || '', faction: t.faction || 'Any', image: t.image || '',
                kappa: !!t.kappa || kappaIds.has(t.id) || kappaNames.has(t.name),
                reqIds, objectives, status: st ? st.status : 'todo', statusAt: st ? st.at : null, source: st ? st.source : null,
                give: give.map(g => ({
                    count: g.count, fir: g.fir, optional: g.optional, alternatives: g.alternatives,
                    items: g.ids.slice(0, 3).map(id => itemById[id] ? { name: itemById[id].name, shortName: itemById[id].shortName, image: itemById[id].image } : { name: '?', shortName: '?', image: '' })
                }))
            };
        });
        res.render('quests', { quests });
    } catch (e) {
        console.error("❌ [QUESTY] Błąd renderowania:", e.message);
        res.status(500).send('Błąd ładowania questów: ' + e.message);
    }
});

app.post('/api/quests/:id/status', async (req, res) => {
    const status = String(req.body.status || '');
    if (!['todo', 'started', 'done'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    try {
        await setQuestStatusManual(req.params.id, status);
        res.json({ id: req.params.id, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// aktualne stany questów - strona Questy dociąga je sama, gdy skrypt logów coś zgłosi
app.get('/api/quests/status', async (req, res) => {
    try { res.json(await dbAll("SELECT quest_id AS id, status, at, source FROM quest_status")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logwatcher/status', async (req, res) => {
    try {
        const last = await dbGet("SELECT name, completed_at FROM quest_completions WHERE name <> '' ORDER BY completed_at DESC LIMIT 1");
        const count = await dbGet("SELECT count(*) AS c FROM quest_completions");
        // "odcisk" stanu questów - zmienia się przy każdym nowym starcie/ukończeniu/zmianie ręcznej
        const stamp = await dbGet("SELECT count(*) AS c, COALESCE(max(at), 0) AS m, COALESCE(sum(length(status)), 0) AS s FROM quest_status");
        res.json({
            questStamp: stamp ? `${stamp.c}:${stamp.m}:${stamp.s}` : '',
            connected: !!logwatcher.lastSeen && (Date.now() - logwatcher.lastSeen) < LOGWATCHER_TIMEOUT,
            lastSeen: logwatcher.lastSeen, version: logwatcher.version,
            lastQuest: last ? { name: last.name, at: last.completed_at } : null,
            questsSinceWipe: count ? count.c : 0,
            wipeAt: await getWipeAt()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            db.run("DELETE FROM hideout_progress");
            db.run("DELETE FROM hideout_have");
            // od teraz skrypt logów liczy tylko questy ukończone po tym momencie
            db.run("DELETE FROM quest_completions");
            db.run("DELETE FROM quest_status");
            db.run("INSERT INTO app_settings (key, value) VALUES ('wipe_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(Date.now())]);
            db.run("COMMIT", () => {
                console.log("🧨 [WIPE] Reset postępu wykonany (Kappa Tracker + lista lootu + hideout + questy ze skryptu logów).");
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