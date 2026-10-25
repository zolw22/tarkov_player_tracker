// Tarkov Tracker - skrypt logów (uruchamiany na PC z grą)
//
// Czyta WYŁĄCZNIE pliki tekstowe, które gra sama zapisuje w folderze Logs (push-notifications_*.log).
// Nie dotyka procesu gry, jej pamięci ani ruchu sieciowego. Z powiadomień wyłapuje "quest ukończony"
// (message.type 12), rozpoczęty (10) i nieudany (11) i zgłasza je do apki na serwerze - ta prowadzi
// stan wszystkich questów (strona Questy) i odhacza questy w Kappie.
//
// Pamięta, które pliki już przeczytał (logwatcher-state.json), więc po przerwie nadrabia zaległe logi.
// Co ~20 s wysyła "heartbeat" - na jego podstawie strony apki pokazują, czy skrypt działa.
//
// Ustawienia: domyślne poniżej, można je nadpisać w config.json obok tego pliku, np.
//   { "server": "http://192.168.1.209:9999", "logsDir": "T:\\TARCZYCE\\Tarkov\\Logs" }
// Flaga --once: jeden przebieg i koniec (do testów).

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const VERSION = '1.1';
const STATE_VERSION = 2; // 2 = wysyłamy też rozpoczęcia/porażki - starszy stan czytamy od nowa
const DEFAULTS = {
    server: 'http://192.168.1.209:9999',
    logsDir: 'T:\\TARCZYCE\\Tarkov\\Logs',
    intervalSec: 20,
    lockPort: 47917 // tylko do pilnowania, żeby nie chodziły dwie kopie naraz
};

const DIR = __dirname;
const CONFIG = (() => {
    let cfg = { ...DEFAULTS };
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')) }; } catch (e) { /* brak config.json = domyślne */ }
    if (process.env.LOGWATCHER_SERVER) cfg.server = process.env.LOGWATCHER_SERVER;
    if (process.env.LOGWATCHER_LOGS) cfg.logsDir = process.env.LOGWATCHER_LOGS;
    if (process.env.LOGWATCHER_LOCKPORT) cfg.lockPort = Number(process.env.LOGWATCHER_LOCKPORT);
    cfg.server = cfg.server.replace(/\/+$/, '');
    return cfg;
})();
const STATE_FILE = process.env.LOGWATCHER_STATE || path.join(DIR, 'logwatcher-state.json');
const LOG_FILE = process.env.LOGWATCHER_LOGFILE || path.join(DIR, 'logwatcher.log');
const ONCE = process.argv.includes('--once');

// --- log do konsoli + pliku (plik przycinany, gdy urośnie ponad 1 MB) ---
function log(msg) {
    const line = `[${new Date().toLocaleString('pl-PL')}] ${msg}`;
    console.log(line);
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) { /* log do pliku nie jest krytyczny */ }
}

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (s.version !== STATE_VERSION) { log('ℹ️ Nowa wersja skryptu - czytam logi od nowa (serwer pomija to, co już ma).'); return { version: STATE_VERSION, files: {} }; }
        return { version: STATE_VERSION, files: s.files || {} };
    }
    catch (e) { return { version: STATE_VERSION, files: {} }; }
}
function saveState(state) {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
}

async function post(urlPath, body) {
    const res = await fetch(CONFIG.server + urlPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${urlPath})${res.status === 404 ? ' - serwer ma starą wersję apki? (pm2 restart)' : ''}`);
    return res.json();
}

// Plik powiadomień = wpisy "data|wersja|Info|push-notifications|Got notification | ..." + blok JSON pod spodem.
const ENTRY_SPLIT = /^(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\|)/m;
function parseQuestEvents(text) {
    const events = [];
    for (const entry of text.split(ENTRY_SPLIT)) {
        const nl = entry.indexOf('\n');
        if (nl < 0) continue;
        const body = entry.slice(nl + 1).trim();
        if (!body.startsWith('{')) continue;
        let o;
        try { o = JSON.parse(body); } catch (e) { continue; } // niedokończony wpis (gra jeszcze pisze) - wróci przy kolejnym przebiegu
        const m = o && o.message;
        if (o.type !== 'new_message' || !m || ![10, 11, 12].includes(m.type) || typeof m.templateId !== 'string') continue;
        const questId = m.templateId.split(' ')[0];
        if (!/^[0-9a-f]{24}$/i.test(questId)) continue;
        events.push({ questId, type: m.type, at: (Number(m.dt) || 0) * 1000 });
    }
    return events;
}

function listNotificationFiles(wipeAt) {
    const out = [];
    let dirs;
    try { dirs = fs.readdirSync(CONFIG.logsDir, { withFileTypes: true }).filter(d => d.isDirectory()); }
    catch (e) { throw new Error(`Nie mogę otworzyć folderu logów "${CONFIG.logsDir}": ${e.message}`); }
    for (const d of dirs) {
        const dirPath = path.join(CONFIG.logsDir, d.name);
        let st;
        try { st = fs.statSync(dirPath); } catch (e) { continue; }
        // sesje zakończone grubo przed ostatnim wipe'em pomijamy (zapas 2 dni na długie sesje)
        if (wipeAt && st.mtimeMs < wipeAt - 2 * 86400 * 1000) continue;
        let files;
        try { files = fs.readdirSync(dirPath); } catch (e) { continue; }
        for (const f of files) {
            if (!f.includes('push-notifications') || !f.endsWith('.log')) continue;
            const full = path.join(dirPath, f);
            try { out.push({ key: `${d.name}/${f}`, full, size: fs.statSync(full).size }); } catch (e) { /* plik zniknął */ }
        }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

let lastProblem = null; // żeby nie spamować logu tym samym błędem co 20 s
async function tick(state) {
    const hb = await post('/api/logwatcher/heartbeat', { version: VERSION, host: os.hostname() });
    const wipeAt = Number(hb.wipeAt) || 0;

    let sentFiles = 0, totalAccepted = 0, totalStarted = 0;
    const kappaMarked = [];
    for (const f of listNotificationFiles(wipeAt)) {
        if (state.files[f.key] === f.size) continue; // bez zmian od ostatniego czytania
        const events = parseQuestEvents(fs.readFileSync(f.full, 'utf8'));
        for (let i = 0; i < events.length; i += 200) {
            const r = await post('/api/logwatcher/quests', { events: events.slice(i, i + 200) });
            totalAccepted += r.accepted || 0;
            totalStarted += r.started || 0;
            (r.kappaMarked || []).forEach(n => kappaMarked.push(n));
        }
        state.files[f.key] = f.size; // zapisujemy dopiero po potwierdzeniu przez serwer
        saveState(state);
        sentFiles++;
    }

    if (lastProblem) { log('✅ Połączenie z apką wróciło.'); lastProblem = null; }
    if (totalAccepted > 0 || totalStarted > 0) {
        log(`📜 Questy - ukończone: ${totalAccepted}, rozpoczęte: ${totalStarted}${kappaMarked.length ? ` · odhaczone w Kappie: ${kappaMarked.join(', ')}` : ''}`);
    } else if (sentFiles > 0 && ONCE) {
        log(`Przeczytano ${sentFiles} plików, nic nowego.`);
    }
}

async function loop() {
    const state = loadState();
    log(`🚀 Skrypt logów v${VERSION} · logi: ${CONFIG.logsDir} · apka: ${CONFIG.server}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try { await tick(state); }
        catch (e) {
            const msg = e.cause && e.cause.code ? `${e.message} (${e.cause.code})` : e.message;
            if (msg !== lastProblem) { log(`⚠️ ${msg} - spróbuję ponownie za ${CONFIG.intervalSec} s.`); lastProblem = msg; }
            if (ONCE) process.exitCode = 1;
        }
        if (ONCE) return;
        await new Promise(r => setTimeout(r, CONFIG.intervalSec * 1000));
    }
}

// pilnujemy jednej kopii: druga próbuje zająć ten sam port lokalny i od razu kończy
const lock = net.createServer();
lock.once('error', (e) => {
    if (e.code === 'EADDRINUSE') { log('ℹ️ Skrypt logów już działa w tle - ta kopia się zamyka.'); process.exit(0); }
    log(`⚠️ Blokada pojedynczej kopii nie zadziałała (${e.message}) - działam dalej.`);
    loop();
});
lock.listen(CONFIG.lockPort, '127.0.0.1', () => {
    if (ONCE) lock.close();
    loop().then(() => { if (ONCE) process.exit(process.exitCode || 0); });
});
