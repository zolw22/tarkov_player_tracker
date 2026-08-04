// Plik: setup_db.js
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const db = new sqlite3.Database('./tarkov_tracker.db');

// Funkcje pomocnicze Promise
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); });
});

async function setupDatabase() {
    console.log("🚀 Rozpoczynam pobieranie danych z Tarkov.dev...");

    const query = `
    {
        tasks(lang: pl) {
            id
            name
            kappaRequired
            wikiLink
            trader { name }
            map { name }
            objectives {
                description
                maps { name }
            }
            taskRequirements {
                task { name }
            }
        }
    }`;

    try {
        const response = await axios.post('https://api.tarkov.dev/graphql', { query });
        const apiTasks = response.data.data.tasks;
        console.log(`📦 Pobrano ${apiTasks.length} zadań. Przetwarzanie...`);

        // 1. Zbieranie unikalnych Handlarzy i Map
        const tradersSet = new Set();
        const mapsSet = new Set();

        apiTasks.forEach(t => {
            if (t.trader && t.trader.name) tradersSet.add(t.trader.name);
            if (t.map && t.map.name) mapsSet.add(t.map.name);
            if (t.objectives) {
                t.objectives.forEach(o => {
                    if (o.maps && o.maps.length > 0) o.maps.forEach(m => mapsSet.add(m.name));
                });
            }
        });

        await dbRun("DROP TABLE IF EXISTS user_tasks");
        await dbRun("DROP TABLE IF EXISTS task_objectives");
        await dbRun("DROP TABLE IF EXISTS tasks");
        await dbRun("DROP TABLE IF EXISTS traders");
        await dbRun("DROP TABLE IF EXISTS maps");

        // Po usunięciu (jeśli istniały), musimy je stworzyć od nowa:
        await dbRun("CREATE TABLE IF NOT EXISTS traders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)");
        await dbRun("CREATE TABLE IF NOT EXISTS maps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)");
        await dbRun("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, mongo_id TEXT UNIQUE, name TEXT NOT NULL, trader_id INTEGER, map_id INTEGER, kappa_required TEXT DEFAULT 'No', wiki_link TEXT, previous_task_id INTEGER, FOREIGN KEY(trader_id) REFERENCES traders(id), FOREIGN KEY(map_id) REFERENCES maps(id), FOREIGN KEY(previous_task_id) REFERENCES tasks(id))");
        await dbRun("CREATE TABLE IF NOT EXISTS task_objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, description TEXT NOT NULL, map_id INTEGER, count INTEGER, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE, FOREIGN KEY(map_id) REFERENCES maps(id))");
        await dbRun("CREATE TABLE IF NOT EXISTS user_tasks (user_id INTEGER, task_id INTEGER, is_completed INTEGER DEFAULT 0, PRIMARY KEY (user_id, task_id), FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE)");
        
        // Reset liczników ID
        await dbRun("DELETE FROM sqlite_sequence WHERE name IN ('tasks', 'traders', 'maps', 'task_objectives')");

        console.log("🧹 Wyczyszczono stare dane.");

        // Handlarze
        for (const trader of tradersSet) {
            await dbRun("INSERT INTO traders (name) VALUES (?)", [trader]);
        }
        
        // Mapy
        for (const map of mapsSet) {
            if (map !== 'Any' && map !== 'All') { // Ignoruj ogólne
               await dbRun("INSERT INTO maps (name) VALUES (?)", [map]);
            }
        }

        // Cache ID dla Handlarzy i Map
        const traderRows = await new Promise((res) => db.all("SELECT id, name FROM traders", (e, r) => res(r)));
        const mapRows = await new Promise((res) => db.all("SELECT id, name FROM maps", (e, r) => res(r)));
        
        const traderMap = Object.fromEntries(traderRows.map(r => [r.name, r.id]));
        const mapMap = Object.fromEntries(mapRows.map(r => [r.name, r.id]));

        console.log("✅ Handlarze i Mapy zapisane.");

        // 3. Wstawianie Zadań
        const stmtTask = db.prepare(`
            INSERT INTO tasks (mongo_id, name, trader_id, map_id, kappa_required, wiki_link)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const t of apiTasks) {
            const trId = t.trader ? traderMap[t.trader.name] : null;
            const mpId = t.map ? mapMap[t.map.name] : null;
            const kappa = t.kappaRequired ? 'Yes' : 'No';
            
            await new Promise((resolve, reject) => {
                stmtTask.run([t.id, t.name, trId, mpId, kappa, t.wikiLink], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
        stmtTask.finalize();
        console.log("✅ Zadania zapisane.");

        // 4. Wstawianie Celów (Objectives) i Linkowanie Poprzednich Zadań
        // Pobierzemy zadania z bazy, żeby znać ich nowe ID
        const localTasks = await new Promise((res) => db.all("SELECT id, name, mongo_id FROM tasks", (e, r) => res(r)));
        const nameToId = Object.fromEntries(localTasks.map(t => [t.name.toLowerCase().replace(/[^a-z0-9]/g, ''), t.id]));
        const mongoToId = Object.fromEntries(localTasks.map(t => [t.mongo_id, t.id]));

        const stmtObj = db.prepare("INSERT INTO task_objectives (task_id, description, map_id, count) VALUES (?, ?, ?, ?)");
        const stmtUpdatePrev = db.prepare("UPDATE tasks SET previous_task_id = ? WHERE id = ?");

        let objectivesCount = 0;

        for (const t of apiTasks) {
            const localId = mongoToId[t.id];
            if (!localId) continue;

            // Objectives
            if (t.objectives) {
                t.objectives.forEach(obj => {
                    let objMapId = null;
                    if (obj.maps && obj.maps.length > 0) {
                        // Bierzemy pierwszą mapę z celu
                        objMapId = mapMap[obj.maps[0].name] || null;
                    }
                    
                    // Wyciąganie liczby (np. "Kill 5 Scavs" -> 5)
                    const countMatch = obj.description.match(/(\d+)/);
                    const count = countMatch ? parseInt(countMatch[0]) : null;

                    stmtObj.run([localId, obj.description, objMapId, count]);
                    objectivesCount++;
                });
            }

            // Previous Task (Chain)
            if (t.taskRequirements) {
                const reqTask = t.taskRequirements.find(r => r.task);
                if (reqTask) {
                    const reqNameClean = reqTask.task.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const prevId = nameToId[reqNameClean];
                    if (prevId) {
                        stmtUpdatePrev.run([prevId, localId]);
                    }
                }
            }
        }

        stmtObj.finalize();
        stmtUpdatePrev.finalize();

        console.log(`✅ Dodano ${objectivesCount} szczegółowych celów.`);
        console.log(`✅ Zaktualizowano powiązania zadań (Chain).`);
        console.log("🎉 BAZA GOTOWA! Możesz uruchomić serwer.");

    } catch (error) {
        console.error("❌ Błąd:", error);
    }
}

setupDatabase();