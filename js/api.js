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

  // Activity for the admin's Team panel: when the keyboard, mouse or touch screen was last used on
  // this page. Every request carries {i: seconds since then, v: tab in front}; nothing else is recorded.
  let lastInput = 0;
  const touch = () => { lastInput = Date.now(); };
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) window.addEventListener(ev, touch, { passive: true, capture: true });
  let moveAt = 0;
  window.addEventListener('pointermove', () => { const n = Date.now(); if (n - moveAt > 2000) { moveAt = n; lastInput = n; } }, { passive: true, capture: true });
  const activity = () => ({ i: lastInput ? Math.min(86400, Math.round((Date.now() - lastInput) / 1000)) : 86400, v: !document.hidden });

  class ApiError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body || {}; }
  }

  async function call(op, body = {}, token = getToken()) {
    if (!TOKEN_RE.test(token)) throw new ApiError(401, 'Signed out');
    const url = C.demo ? '/api/desk' : `${C.supabaseUrl}/functions/v1/desk`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-desk-token': token },
        body: JSON.stringify({ op, ...body, _a: activity() }),
        credentials: 'omit',
      });
    } catch (e) {
      throw new ApiError(0, 'No connection');
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new ApiError(resp.status, data.error || `HTTP ${resp.status}`, data);
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

  window.DeskApi = { call, signIn, signOut, hasToken, ApiError, mediaSource };
})();
