/* Teshrij Desk — API client. One endpoint: POST {op, ...}, signed with the staff member's own
 * access token (x-desk-token). A sign-in link (…/bsb/#token=dsk_…) stores the token on this device. */
(function () {
  'use strict';
  const C = window.DESK;
  const KEY = 'desk_token';
  const TOKEN_RE = /^dsk_[A-Za-z0-9]{32}$/;

  function getToken() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  // Token from a sign-in link: keep it, then remove it from the address bar and history.
  function takeLinkToken() {
    const m = location.hash.match(/(?:^#|&)token=(dsk_[A-Za-z0-9]{32})/);
    if (!m) return false;
    setToken(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }
  takeLinkToken();
  // A sign-in link opened in a tab that already shows the desk only changes the hash.
  window.addEventListener('hashchange', () => { if (takeLinkToken()) location.reload(); });

  // Activity for the admin's Team panel. The page notes in which minutes (on the SERVER's clock) the
  // keyboard, mouse or touch screen was used here, and every request carries the minutes not yet
  // delivered: {v: tab in front, m: [epoch minutes]}. A minute is dropped only after a request that
  // carried it succeeded, so a failed request or a short network drop loses nothing. The server accepts
  // only the last 10 minutes. Nothing else is recorded: no keys, no positions, no screen content.
  let skew = 0;                       // server clock - this clock, learned from every answer
  const pendingMinutes = new Set();
  const serverMinute = () => Math.floor((Date.now() + skew) / 60000);
  function noteInput() {
    const m = serverMinute();
    pendingMinutes.add(m);
    if (pendingMinutes.size > 12) for (const x of pendingMinutes) if (x < m - 10) pendingMinutes.delete(x);
  }
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) window.addEventListener(ev, noteInput, { passive: true, capture: true });
  let moveAt = 0;
  for (const ev of ['pointermove', 'scroll']) {
    window.addEventListener(ev, () => { const n = Date.now(); if (n - moveAt > 1500) { moveAt = n; noteInput(); } }, { passive: true, capture: true });
  }
  let chatOnScreen = null;            // for the admin's live board: which chat this desk is showing
  // Presence for colleagues ("Charbel is replying…"): t = 1 while this person typed in the message box of
  // the chat on screen during the last 6 seconds. Only that fact is sent, never what was typed.
  const TYPING_MS = 6000;
  let typedAt = 0;
  function setChat(c) { if ((c || null) !== chatOnScreen) typedAt = 0; chatOnScreen = c || null; }
  function noteTyping(on = true) { typedAt = on ? Date.now() : 0; }
  const isTyping = () => !!chatOnScreen && !document.hidden && Date.now() - typedAt < TYPING_MS;
  function activity() {
    const now = serverMinute();
    const m = [...pendingMinutes].filter((x) => x >= now - 10 && x <= now);
    const a = { v: !document.hidden, m, c: document.hidden ? null : chatOnScreen };
    if (isTyping()) a.t = 1;
    return a;
  }
  // Thank-yous: the id of the last one this page has seen goes out with every inbox request (_k), so the
  // server answers only with newer ones. null = not known yet (nothing is sent).
  let kudosSeen = null;
  function setKudos(id) { const n = Number(id); kudosSeen = Number.isFinite(n) && n >= 0 ? n : null; }
  // The page can listen to every answer (presence and thank-yous ride on boot / inbox / chat answers).
  let onAnswer = null;
  function listen(fn) { onAnswer = typeof fn === 'function' ? fn : null; }

  // ---- what goes wrong on this device (desk.client_log, read by the admin's helper, never shown to staff).
  // Short technical notes only: script errors, a page that stopped answering, slow or failed requests,
  // the steps of a voice recording, the "new version" bar. Never message text, never audio.
  const POLL_OPS = new Set(['inbox', 'chat']);
  const POLL_TIMEOUT_MS = 25000;
  const SLOW_MS = 4000;
  const DIAG_PER_PAGE = 400;
  const diagQ = [];
  let diagCount = 0, diagBusy = false;
  const seenMsgs = new Map();
  function report(kind, msg, detail) {
    try {
      if (diagCount >= DIAG_PER_PAGE) return;
      const m = String(msg == null ? '' : msg).slice(0, 300);
      if (kind === 'error') { const n = (seenMsgs.get(m) || 0) + 1; seenMsgs.set(m, n); if (n > 3) return; }
      diagCount++;
      diagQ.push({ k: String(kind).slice(0, 24), m, d: detail && typeof detail === 'object' ? detail : undefined, t: Date.now() + skew });
      if (diagQ.length >= 20) flushDiag();
    } catch (e) { /* reporting never breaks the page */ }
  }
  async function flushDiag() {
    if (diagBusy || !diagQ.length || !TOKEN_RE.test(getToken())) return;
    diagBusy = true;
    const items = diagQ.splice(0, 20);
    try {
      await call('client_log', { items, page: C.version || 0, ua: String(navigator.userAgent || '').slice(0, 300) });
    } catch (e) {
      if (e && e.status === 0 && diagQ.length < 80) diagQ.unshift(...items); // offline: try again later
    } finally { diagBusy = false; }
  }
  setInterval(flushDiag, 20000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushDiag(); });
  window.addEventListener('pagehide', flushDiag);
  const short = (u) => String(u || '').replace(/^.*\//, '').replace(/[?#].*$/, '').slice(0, 60);
  window.addEventListener('error', (e) => {
    const t = e && e.target;
    if (t && t !== window && t.tagName) { // a script, stylesheet, image or sound that did not load
      if (/^(SCRIPT|LINK)$/.test(t.tagName)) report('error', `${t.tagName.toLowerCase()} did not load: ${short(t.src || t.href)}`);
      return;
    }
    report('error', (e && e.message) || 'error', { at: `${short(e && e.filename)}:${(e && e.lineno) || 0}:${(e && e.colno) || 0}`,
      stack: e && e.error && e.error.stack ? String(e.error.stack).replace(/https?:\/\/[^\s)]*\//g, '').slice(0, 600) : undefined });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (r instanceof ApiError) return; // already counted as a request
    report('error', `promise: ${(r && r.message) || r}`, { stack: r && r.stack ? String(r.stack).replace(/https?:\/\/[^\s)]*\//g, '').slice(0, 600) : undefined });
  });
  // The page stopped answering (clicks and keys wait): a one-second timer that fires late while the tab is
  // in front. Plus, where the browser tells us, a count of every block over a quarter second.
  let beatAt = Date.now(), beatFront = !document.hidden, stallAt = 0;
  setInterval(() => {
    const n = Date.now(), late = n - beatAt - 1000, front = !document.hidden;
    if (front && beatFront && late > 1500 && late < 120000 && n - stallAt > 10000) { stallAt = n; report('stall', 'page did not answer', { ms: late, chat: !!chatOnScreen }); }
    beatAt = n; beatFront = front;
  }, 1000);
  try {
    let n = 0, max = 0, total = 0;
    new PerformanceObserver((list) => {
      for (const x of list.getEntries()) if (x.duration >= 250) { n++; total += x.duration; if (x.duration > max) max = x.duration; }
    }).observe({ entryTypes: ['longtask'] });
    setInterval(() => { if (n) { report('stall', 'blocks in 5 min', { n, max: Math.round(max), total: Math.round(total) }); n = 0; max = 0; total = 0; } }, 300000);
  } catch (e) { /* not in this browser */ }

  class ApiError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body || {}; }
  }

  async function call(op, body = {}, token = getToken()) {
    if (!TOKEN_RE.test(token)) throw new ApiError(401, 'Signed out');
    const url = C.demo ? '/api/desk' : `${C.supabaseUrl}/functions/v1/desk`;
    const act = activity();
    // The two polls give up after POLL_TIMEOUT_MS: a request that never answers used to hold the list
    // and the open chat still for good (each waits for its previous poll). Nothing that changes
    // data is ever cut off: a slow send must not look like a failed one.
    const ctl = POLL_OPS.has(op) && typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), POLL_TIMEOUT_MS) : null;
    const t0 = Date.now();
    let resp, data;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-desk-token': token },
        body: JSON.stringify({ op, ...body, _a: act, ...(op === 'inbox' && kudosSeen !== null ? { _k: kudosSeen } : {}) }),
        credentials: 'omit',
        ...(ctl ? { signal: ctl.signal } : {}),
        ...(op === 'client_log' ? { keepalive: true } : {}),
      });
      data = await resp.json().catch(() => ({}));
    } catch (e) {
      const timedOut = !!(ctl && ctl.signal.aborted);
      if (op !== 'client_log') report('api', op, { ms: Date.now() - t0, status: 0, why: timedOut ? 'timeout' : String((e && e.message) || e).slice(0, 80), online: navigator.onLine !== false });
      throw new ApiError(0, timedOut ? 'The server took too long to answer' : 'No connection');
    } finally { clearTimeout(timer); }
    const ms = Date.now() - t0;
    if (op !== 'client_log' && (ms > SLOW_MS || resp.status >= 500)) report('api', op, { ms, status: resp.status });
    if (!resp.ok) throw new ApiError(resp.status, data.error || `HTTP ${resp.status}`, data);
    // delivered: these minutes need not be sent again (the current minute is re-added by the next input)
    for (const x of act.m) pendingMinutes.delete(x);
    if (data && typeof data.now === 'string') { const t = Date.parse(data.now); if (Number.isFinite(t)) skew = t - Date.now(); }
    if (onAnswer && data) { try { onAnswer(op, data); } catch (e) { /* a listener never breaks a request */ } }
    return data;
  }

  async function signIn(token) {
    token = String(token || '').trim();
    if (!TOKEN_RE.test(token)) throw new ApiError(400, 'That is not a desk access token (it starts with dsk_)');
    const r = await call('me', {}, token);
    setToken(token);
    return r.me;
  }
  function signOut() { setToken(''); }
  const hasToken = () => TOKEN_RE.test(getToken());

  // Media: our own copy (Supabase storage, or /media/ in the demo) first, then the link BSB /
  // Instagram gave (may expire). Only http(s) or same-origin /media/ URLs are used as src.
  function mediaSource(m) {
    const ok = (u) => typeof u === 'string' && (/^https:\/\/[^\s"'<>]+$/.test(u) || /^\/media\/[\w.-]+$/.test(u));
    if (ok(m.media)) return { url: m.media, ours: true };
    if (ok(m.media_raw)) return { url: m.media_raw, ours: false };
    return null;
  }

  window.DeskApi = { call, signIn, signOut, hasToken, ApiError, mediaSource, setChat, noteTyping, isTyping, setKudos, listen, report, flushDiag };
})();
