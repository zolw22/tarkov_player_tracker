// Wskaźnik stanu skryptu logów (logwatcher na PC) - doklejany do .nav-bar na każdej stronie.
// Zielony = skrypt nadaje (questy odhaczają się same), czerwony = brak sygnału (trzeba go uruchomić).
(function () {
    const css = `
        .lw-pill { position: relative; display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px;
            font-weight: 700; font-size: 0.75em; letter-spacing: 0.3px; text-transform: uppercase; cursor: pointer; user-select: none;
            border: 1px solid #383838; background: #161616; color: #888; transition: all 0.15s; font-family: inherit; }
        .lw-pill .lw-dot { width: 9px; height: 9px; border-radius: 50%; background: #666; flex-shrink: 0; }
        .lw-pill.on { border-color: rgba(76,175,80,0.45); background: rgba(76,175,80,0.12); color: #8fdc92; }
        .lw-pill.on .lw-dot { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
        .lw-pill.off { border-color: rgba(224,82,82,0.5); background: rgba(224,82,82,0.14); color: #ff8a80; animation: lw-pulse 2s ease-in-out infinite; }
        .lw-pill.off .lw-dot { background: #e05252; }
        @keyframes lw-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(224,82,82,0.0); } 50% { box-shadow: 0 0 0 4px rgba(224,82,82,0.18); } }
        .lw-pop { position: absolute; top: calc(100% + 8px); right: 0; z-index: 3000; width: 300px; padding: 12px 14px; border-radius: 10px;
            background: #141414; border: 1px solid #3a3a3a; box-shadow: 0 6px 18px rgba(0,0,0,0.5); color: #ccc; font-size: 1.15em;
            text-transform: none; letter-spacing: 0; font-weight: 400; line-height: 1.45; display: none; cursor: default; text-align: left; }
        .lw-pill.open .lw-pop { display: block; }
        .lw-pop b { color: #fff; }
        .lw-pop code { background: #0a0a0a; border: 1px solid #2c2c2c; border-radius: 5px; padding: 1px 5px; font-size: 0.9em; color: #e0c98a; }
        .lw-pop .lw-row { margin-top: 6px; color: #999; font-size: 0.92em; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const pill = document.createElement('div');
    pill.className = 'lw-pill';
    pill.innerHTML = '<span class="lw-dot"></span><span class="lw-label">Skrypt logów…</span><div class="lw-pop"></div>';
    pill.addEventListener('click', (e) => { if (!e.target.closest('.lw-pop')) pill.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!pill.contains(e.target)) pill.classList.remove('open'); });

    function mount() {
        const nav = document.querySelector('.nav-bar');
        if (nav) nav.appendChild(pill); else { pill.style.cssText = 'position:fixed;top:10px;right:10px;z-index:3000'; document.body.appendChild(pill); }
    }

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function ago(ms) {
        const s = Math.round((Date.now() - ms) / 1000);
        if (s < 60) return `${s} s temu`;
        if (s < 3600) return `${Math.round(s / 60)} min temu`;
        if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
        return `${Math.round(s / 86400)} dni temu`;
    }
    const fmtDate = ms => new Date(ms).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    function render(st) {
        const pop = pill.querySelector('.lw-pop');
        const label = pill.querySelector('.lw-label');
        pill.classList.remove('on', 'off');
        if (!st) { label.textContent = 'Skrypt logów: ?'; pop.innerHTML = 'Nie udało się sprawdzić stanu skryptu.'; return; }

        const lastQuest = st.lastQuest ? `<div class="lw-row">Ostatni quest: <b>${esc(st.lastQuest.name)}</b> (${fmtDate(st.lastQuest.at)})</div>` : '';
        const count = `<div class="lw-row">Questów od ostatniego wipe'a: <b>${st.questsSinceWipe}</b>${st.wipeAt ? ` · wipe: ${fmtDate(st.wipeAt)}` : ''}</div>`;
        if (st.connected) {
            pill.classList.add('on');
            label.textContent = 'Skrypt logów';
            pop.innerHTML = `<b>✅ Skrypt działa.</b> Ukończone questy odhaczają się same.<div class="lw-row">Ostatni sygnał: ${ago(st.lastSeen)}${st.version ? ` · wersja ${esc(st.version)}` : ''}</div>${lastQuest}${count}`;
        } else {
            pill.classList.add('off');
            label.textContent = 'Skrypt logów wyłączony';
            pop.innerHTML = `<b>⚠️ Skrypt na PC nie działa.</b> Questy nie odhaczają się teraz automatycznie, ale nic nie przepada. Po uruchomieniu skrypt nadrobi zaległe logi.
                <div class="lw-row">Uruchom na PC: <code>logwatcher\\start-logwatcher.bat</code></div>
                <div class="lw-row">${st.lastSeen ? `Ostatni sygnał: ${ago(st.lastSeen)}` : 'Brak sygnału od restartu serwera.'}</div>${lastQuest}${count}`;
        }
    }

    // Zmiana stanu questów (nowe z logów albo z innej karty/urządzenia): wysyłamy zdarzenie
    // "tracker:quests-changed". Strona, która umie się odświeżyć sama (Questy), woła preventDefault();
    // na stronie Kappa (renderowanej po stronie serwera) pokazujemy dymek z przyciskiem "Odśwież".
    let lastStamp = null;
    function onStamp(st) {
        if (!st || typeof st.questStamp !== 'string') return;
        const prev = lastStamp;
        lastStamp = st.questStamp;
        if (prev === null || prev === st.questStamp) return;
        const ev = new CustomEvent('tracker:quests-changed', { detail: st, cancelable: true });
        const handled = !window.dispatchEvent(ev);
        if (!handled && location.pathname.startsWith('/kappa')) showRefreshToast(st);
    }
    function showRefreshToast(st) {
        if (document.getElementById('lw-toast')) return;
        const t = document.createElement('div');
        t.id = 'lw-toast';
        t.style.cssText = 'position:fixed;right:16px;bottom:56px;z-index:3000;background:#141414;border:1px solid rgba(76,175,80,0.5);color:#ddd;padding:12px 14px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.5);font-size:0.9em;display:flex;gap:12px;align-items:center;max-width:calc(100vw - 32px);font-family:inherit;';
        t.innerHTML = `<span>📜 Skrypt logów zmienił stan questów${st.lastQuest ? ` (ostatnio: <b>${esc(st.lastQuest.name)}</b>)` : ''}.</span>
            <button style="background:#4caf50;color:#000;border:none;border-radius:999px;padding:6px 14px;font-weight:800;cursor:pointer;font-family:inherit;">Odśwież</button>`;
        t.querySelector('button').addEventListener('click', () => location.reload());
        document.body.appendChild(t);
    }

    async function poll() {
        try { const st = await (await fetch('/api/logwatcher/status')).json(); render(st); onStamp(st); }
        catch (e) { render(null); }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); poll(); });
    else { mount(); poll(); }
    setInterval(poll, 10000);
})();
