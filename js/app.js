/* Teshrij Desk — one inbox for WhatsApp + Instagram, one conversation per contact.
 *
 * Two kinds of labels, kept apart on purpose:
 *  - SYSTEM labels (set automatically, shown as square badges): every conversation episode is
 *    sales or support. Support stays open until someone resolves it with a fixed closing message
 *    (the server decides when that is allowed); sales carries a stage. Unsure ones wait in
 *    "Needs label". Staff can correct them.
 *  - MANUAL labels (the staff's own, colored pills): groups, "customer wrote again" rules, views.
 * Every staff member signs in with a personal access token; the server records who did what.
 * All rules live in SQL (schema desk); this file shows state and sends staff intent.
 */
(function () {
  'use strict';
  const C = window.DESK;
  const api = window.DeskApi;
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    unread: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
    all: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    nolabel: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" stroke-dasharray="3 3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-14.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    ig: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    life: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.3 4.3m5.6 5.6 4.3 4.3m0-14.2-4.3 4.3m-5.6 5.6-4.3 4.3"/>',
    dollar: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3 2 6m20 0-3-3"/>',
    hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    reply: '<path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
    clip: '<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
    team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    belloff: '<path d="M8.7 3A6 6 0 0 1 18 8a21 21 0 0 0 .6 5M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-2M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  };
  function icon(name, cls = '') {
    const span = document.createElement('span');
    span.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    return span.firstChild;
  }

  const TZ = 'Asia/Beirut';
  const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtWeekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
  const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
  const fmtDayLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtFull = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Formatters are built once: an Intl.DateTimeFormat costs far more than formatting with it.
  const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const dayKey = (d) => fmtDayKey.format(d);
  let dayRef = { min: -1, today: '', yday: '' };
  function todayKeys() {
    const m = Math.floor(now() / 60000);
    if (dayRef.min !== m) dayRef = { min: m, today: dayKey(new Date(now())), yday: dayKey(new Date(now() - 86400000)) };
    return dayRef;
  }
  const minute = () => Math.floor(now() / 60000);

  function listTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const k = dayKey(d), t = todayKeys();
    if (k === t.today) return fmtTime.format(d);
    if (k === t.yday) return 'Yesterday';
    if (now() - d.getTime() < 6 * 86400000) return fmtWeekday.format(d);
    return fmtDate.format(d);
  }
  function dayLabel(d, k = dayKey(d)) {
    const t = todayKeys();
    if (k === t.today) return 'Today';
    if (k === t.yday) return 'Yesterday';
    return fmtDayLong.format(d);
  }
  // Re-render guard: true when el already shows `key` (nothing to do).
  function same(el, key) {
    if (!el) return true;
    if (el._k === key) return true;
    el._k = key;
    return false;
  }
  // Puts `want` (an array of nodes) into `box` in that order with as few DOM moves as possible.
  // Nodes already in place are not touched, so media elements keep playing and focus/hover stay.
  function reconcile(box, want) {
    const keep = new Set(want);
    for (let n = box.firstChild; n;) { const nx = n.nextSibling; if (!keep.has(n)) n.remove(); n = nx; }
    let ref = box.firstChild;
    for (const el of want) {
      if (ref === el) { ref = el.nextSibling; continue; }
      box.insertBefore(el, ref);
    }
  }
  function inOrder(box, want) {
    if (box.childNodes.length !== want.length) return false;
    let n = box.firstChild;
    for (const el of want) { if (n !== el) return false; n = n.nextSibling; }
    return true;
  }
  function ago(ts) {
    const s = Math.max(0, (now() - Date.parse(ts)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return fmtDate.format(new Date(ts));
  }
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m}m`;
    const hh = Math.floor(m / 60);
    if (hh < 48) return `${hh}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(hh / 24)}d ${hh % 24}h`;
  }
  function phoneLabel(contact) {
    const d = String(contact);
    if (d.startsWith('961') && d.length >= 10) return `+961 ${d.slice(3, d.length - 6)} ${d.slice(-6, -3)} ${d.slice(-3)}`;
    return `+${d}`;
  }
  // Lebanese numbers as staff type them: 961 70 123 456 -> 70123456, 961 3 123 456 -> 03123456.
  function localNumber(contact) {
    const d = String(contact || '').replace(/\D/g, '');
    if (!d.startsWith('961')) return d;
    const rest = d.slice(3);
    return rest.length === 7 && rest[0] === '3' ? '0' + rest : rest;
  }
  function copyNumber() {
    const c = S.active && S.active.data ? S.active.data.conv : null;
    if (!c || isIg(c)) return toast('Instagram chats have no phone number');
    const n = localNumber(c.contact);
    const done = () => toast(`Copied ${n}`, 'ok');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(n).then(done, () => toast('Could not copy', 'error'));
    else { const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = n; document.body.append(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy', 'error'); } ta.remove(); }
  }
  const isIg = (c) => c && (c.channel === 'ig' || /^ig_/.test(c.contact || ''));
  const realName = (n) => n && /[\p{L}\p{N}]/u.test(n) ? n : null;
  const displayName = (c) => realName(c.name) || (isIg(c) ? (c.handle ? '@' + c.handle : 'Instagram user') : phoneLabel(c.contact));
  const subtitle = (c) => isIg(c) ? (c.handle ? '@' + c.handle : 'Instagram') : phoneLabel(c.contact);

  const AV_COLORS = ['#0ea5e9', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16', '#ef4444', '#06b6d4', '#a855f7', '#f59e0b', '#10b981'];
  function avColor(key) { let x = 0; for (const ch of String(key)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return AV_COLORS[x % AV_COLORS.length]; }
  function initials(c) {
    const n = (c.name || c.handle || '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (!n) return isIg(c) ? '@' : '#';
    const p = n.split(/\s+/).map((w) => Array.from(w));
    return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] || '' : '')).toUpperCase();
  }
  function avatar(c, size = '') {
    return h('div', { class: `av ${size}`, style: `background:${avColor(c.contact || c.name)}` }, initials(c),
      size === 'sm' ? null : h('span', { class: `ch ${isIg(c) ? 'ig' : 'wa'}`, title: isIg(c) ? 'Instagram' : 'WhatsApp' }, icon(isIg(c) ? 'ig' : 'phone')));
  }

  function toast(msg, kind = '') {
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 2600);
    setTimeout(() => el.remove(), kind === 'error' ? 6400 : 3000);
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
    return val;
  }

  // ------------------------------------------------------------------ state

  const S = {
    me: null,
    labels: [], labelById: new Map(), views: [],
    counts: { labels: {}, views: {}, views_unread: {}, sys: {} },
    view: store('desk_view3') || 'unresolved',
    line: store('desk_line') || '',
    channelNames: {},
    moreOpen: store('desk_more') === true,
    q: '',
    chats: [], more: false, loadingMore: false, listSeq: 0,
    active: null,       // { contact, data, pending: [], customer, draft }
    canned: [], closers: [],
    skew: 0,
    details: store('desk_details2') === true,
    notify: store('desk_notify') === true,
    lastLate: 0,
    metaVer: 0,         // bumps when labels / channel names change (rows and bars show them)
    listHover: false, listScrollAt: 0, listFrozen: false, listSig: null,
  };
  const now = () => Date.now() + S.skew;
  const sys = () => S.counts.sys || {};
  const slaMin = () => 10;

  function setMeta(meta) {
    S.labels = meta.labels || [];
    S.views = meta.views || [];
    S.labelById = new Map(S.labels.map((l) => [l.id, l]));
    S.channelNames = meta.channel_names || {};
    S.metaVer++;
  }
  function labelChip(id, xs = true) {
    const l = S.labelById.get(id);
    if (!l) return null;
    return h('span', { class: `chip${xs ? ' xs' : ''}`, style: `--c:${l.color}` }, l.name);
  }

  // Two views only: Unresolved (open support + everything unread, so sales only while unread) and All.
  // Labels and channels below them filter like in BSB. The number is the keyboard shortcut.
  const MAIN_VIEWS = [
    ['unresolved', 'inbox', 'Unresolved', () => S.counts.uncomplete, true, 'Unsolved support chats and everything unread. Press V to solve a chat.'],
    ['all', 'all', 'All chats', () => null, false, 'Every conversation'],
  ];
  const ALL_VIEWS = MAIN_VIEWS;
  function viewName(v = S.view) {
    if (v === 'unlabelled') return 'No label';
    const sv = ALL_VIEWS.find((x) => x[0] === v);
    if (sv) return sv[2];
    if (/^v\d+$/.test(v)) return (S.views.find((x) => 'v' + x.id === v) || {}).name || 'View';
    if (/^l\d+$/.test(v)) return (S.labelById.get(Number(v.slice(1))) || {}).name || 'Label';
    return 'Inbox';
  }
  function viewCount(v = S.view) {
    const c = S.counts;
    if (v === 'unlabelled') return c.unlabelled;
    const sv = ALL_VIEWS.find((x) => x[0] === v);
    if (sv) return sv[3]();
    if (/^v\d+$/.test(v)) return (c.views || {})[v.slice(1)];
    if (/^l\d+$/.test(v)) return (c.labels || {})[v.slice(1)];
    return null;
  }
  const validView = (v) => ALL_VIEWS.some((x) => x[0] === v) || (/^l\d+$/.test(v) && S.labelById.has(Number(v.slice(1))));

  // Channels = the lines (WhatsApp numbers / BSB channels, Instagram @teshrij), like BSB.
  function lineName(l) {
    const n = (S.channelNames || {})[l];
    if (n) return n;
    if (/^@/.test(l)) return `Instagram ${l}`;
    if (/^\d{8,}$/.test(l)) return phoneLabel(l);
    return l;
  }
  // Short form for the chat rows: 71 083 892 / @teshrij
  function lineShort(l) {
    const n = (S.channelNames || {})[l];
    if (n) return n.slice(0, 16);
    if (/^@/.test(l)) return l;
    if (/^961\d{7,8}$/.test(l)) { const r = l.slice(3); return r.length === 8 ? `${r.slice(0, 2)} ${r.slice(2, 5)} ${r.slice(5)}` : `0${r.slice(0, 1)} ${r.slice(1, 4)} ${r.slice(4)}`; }
    return l;
  }
  const lineIcon = (l) => icon(/^@/.test(l) ? 'ig' : 'phone');

  // System label vocabulary
  const PRODUCTS = { gpt: 'ChatGPT', gpt_private: 'ChatGPT private', anghami: 'Anghami', netflix: 'Netflix', shahid: 'Shahid', spotify: 'Spotify', gemini: 'Gemini', capcut: 'CapCut', canva: 'Canva', other: 'Other' };
  const STAGES = { unanswered: 'Unanswered', got_price: 'Got price', waiting_payment: 'Waiting payment', needs_followup: 'Needs follow-up', bought: 'Bought', lost: 'Lost' };
  const GATE_TEXT = {
    not_support: 'Only support episodes are resolved.',
    not_open: 'This episode is already closed.',
    never_replied: 'Nobody has replied to the customer yet.',
    customer_waiting: "The customer is waiting for an answer: reply first.",
    window_closed: 'The reply window is closed, so no closing message can be sent.',
    customer_quiet: 'The customer has not written in the last 4h (1h at night): V resolves without a message.',
  };
  function waitMs(t) { return t && t.waiting && t.waiting_since ? now() - Date.parse(t.waiting_since) : 0; }
  // System tag: Support (Unsolved / Solved) or Sales. Nothing else.
  function sysBadge(t, big = false) {
    if (!t) return null;
    const cls = big ? 'sys big' : 'sys';
    if (t.kind === 'pending') return h('span', { class: `${cls} k-label`, title: 'The system is labelling this chat' }, icon('help', 'xs'), 'labelling…');
    if (t.kind === 'unsure') return h('span', { class: `${cls} k-label`, title: t.kind_reason || '' }, icon('help', 'xs'), 'Needs label');
    if (t.kind === 'ignore') return h('span', { class: `${cls} k-ignore`, title: t.kind_reason || '' }, 'Ignored');
    if (t.kind === 'support') {
      return t.status === 'open'
        ? h('span', { class: `${cls} k-support`, title: 'Support · unsolved: press V to solve' }, icon('life', 'xs'), 'Support · Unsolved')
        : h('span', { class: `${cls} k-done`, title: t.resolved_by ? `Solved by ${t.resolved_by}` : 'Solved' }, icon('check', 'xs'), 'Support · Solved');
    }
    if (t.kind === 'sales') return h('span', { class: `${cls} k-sales` }, icon('dollar', 'xs'), 'Sales');
    return null;
  }

  // ------------------------------------------------------------------ boot

  async function start() {
    applyTheme(store('desk_theme'));
    if (C.demo) $('#demoBadge').hidden = false;
    if (!api.hasToken()) return showLogin();
    $('#login').hidden = true;
    $('#app').hidden = false;
    bindUi();
    try {
      const b = await api.call('boot', { view: /^(all|unresolved|l\d+)$/.test(S.view) ? S.view : 'unresolved', line: S.line || null });
      S.me = b.me;
      setMeta(b.meta);
      S.canned = b.canned || [];
      S.closers = b.closers || [];
      S.skew = b.now ? Date.parse(b.now) - Date.now() : 0;
      renderStaff();
      if (!validView(S.view)) {
        S.view = 'unresolved';
        S.counts = b.counts;
        renderNav();
        await refreshList(true);
      } else {
        applyList(b, true);
      }
    } catch (e) {
      if (e.status === 401) { api.signOut(); return showLogin(e.message); }
      toast(`Could not load: ${e.message}`, 'error');
    }
    const m = location.hash.match(/^#c=([0-9a-z_]+)$/i);
    if (m) openChat(m[1]);
    loopList();
    loopChat();
  }

  function showLogin(err) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginError').textContent = err && err !== 'Signed out' ? err : '';
    $('#loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      $('#loginError').textContent = '';
      try {
        await api.signIn($('#loginToken').value);
        location.reload();
      } catch (e) { $('#loginError').textContent = e.status === 401 ? 'This token is not valid or was revoked.' : e.message; }
    };
  }

  function applyTheme(t) {
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const dark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
    const b = $('#themeBtn');
    if (b) b.replaceChildren(icon(dark ? 'sun' : 'moon'));
  }

  // ------------------------------------------------------------------ me / team

  function renderStaff() {
    const b = $('#staffBtn');
    const n = S.me ? S.me.name : '…';
    b.replaceChildren(h('div', { class: 'av sm', style: `background:${avColor(n)}` }, initials({ name: n })),
      h('span', null, n), S.me && S.me.role === 'admin' ? h('span', { class: 'role' }, 'admin') : null);
    $('#bellBtn').replaceChildren(icon(S.notify ? 'bell' : 'belloff'));
    $('#bellBtn').title = S.notify ? 'Alerts on: sound + notification when a support customer waits more than 10 min' : 'Alerts off';
  }
  function openAccount() {
    const isAdmin = S.me && S.me.role === 'admin';
    openModal(h('div', { class: 'sheet narrow' },
      h('div', { class: 'sheet-head' }, h('h3', null, S.me ? S.me.name : 'Account'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' }, `Signed in with your personal access token${S.me ? ` (${S.me.role})` : ''}. Everything you do is saved under your name.`),
        h('div', { class: 'menu-list' },
          isAdmin ? h('button', { class: 'btn block', onclick: openTeam }, icon('team', 'sm'), 'Team & access tokens') : null,
          isAdmin ? h('button', { class: 'btn block', onclick: () => { closeModal(); openManage(); } }, icon('sliders', 'sm'), 'Labels & views') : null,
          isAdmin ? h('button', { class: 'btn block', onclick: () => { closeModal(); openQuickManage(); } }, icon('zap', 'sm'), 'Quick replies') : null,
          h('button', { class: 'btn block', onclick: () => { if (confirm('Sign out of the desk on this device?')) { api.signOut(); location.reload(); } } }, icon('logout', 'sm'), 'Sign out')))));
  }
  async function openTeam() {
    let list = [];
    const body = h('div', { class: 'sheet-body' });
    const signLink = (t) => `${location.origin}${location.pathname}#token=${t}`;
    const showToken = (name, token) => openModal(h('div', { class: 'sheet narrow' },
      h('div', { class: 'sheet-head' }, h('h3', null, `Access for ${name}`)),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' }, 'Send this link to them privately (it signs them in on that device). It is shown only once; if it is lost, make a new one.'),
        h('div', { class: 'token-box' }, h('code', null, signLink(token))),
        h('div', { class: 'menu-list' },
          h('button', { class: 'btn', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(signLink(token)); toast('Sign-in link copied'); } }, icon('copy', 'sm'), 'Copy sign-in link'),
          h('button', { class: 'btn', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(token); toast('Token copied'); } }, icon('key', 'sm'), 'Copy token only'))),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', onclick: openTeam }, 'Done'))), false);
    const save = async (payload, label) => {
      try {
        const r = await api.call('staff_save', payload);
        list = r.staff;
        if (r.token) return showToken(label, r.token);
        draw();
      } catch (e) { toast(e.message, 'error'); }
    };
    const draw = () => {
      const name = h('input', { type: 'text', placeholder: 'Name, e.g. Jeanpaul', maxlength: 40 });
      const role = h('select', null, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'admin' }, 'Admin'));
      body.replaceChildren(
        h('p', { class: 'hint' }, 'Each person signs in with their own token. Revoke a token and that person is signed out everywhere at their next click.'),
        h('div', { class: 'team' }, list.map((s) => h('div', { class: `team-row${s.active ? '' : ' off'}` },
          h('div', { class: 'av sm', style: `background:${avColor(s.name)}` }, initials({ name: s.name })),
          h('div', { class: 'team-main' }, h('b', null, s.name), h('span', { class: 'muted' },
            `${s.role} · token …${s.token_hint}${s.last_seen_at ? ' · seen ' + ago(s.last_seen_at) : ' · never used'}${s.active ? '' : ' · revoked'}`)),
          s.active ? [
            h('button', { class: 'btn sm', title: 'Make a new token (the old one stops working)', onclick: () => { if (confirm(`Make a new token for ${s.name}? The old one stops working.`)) save({ id: s.id, new_token: true }, s.name); } }, icon('key', 'sm'), 'New token'),
            h('button', { class: 'btn sm danger', disabled: S.me && s.id === S.me.id, onclick: () => { if (confirm(`Revoke ${s.name}'s access?`)) save({ id: s.id, active: false }); } }, 'Revoke'),
          ] : h('button', { class: 'btn sm', onclick: () => save({ id: s.id, active: true, new_token: true }, s.name) }, 'Restore'))),
        ),
        h('h5', null, 'Add someone'),
        h('div', { class: 'team-add' }, name, role, h('button', { class: 'btn primary', onclick: () => { if (name.value.trim()) save({ name: name.value, role: role.value }, name.value.trim()); } }, icon('plus', 'sm'), 'Create access')));
    };
    openModal(h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', null, 'Team & access tokens'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      body, h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', onclick: closeModal }, 'Done'))), true);
    body.replaceChildren(h('p', { class: 'hint' }, 'Loading…'));
    try { list = await api.call('staff_list'); draw(); } catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message)); }
  }

  // ------------------------------------------------------------------ sidebar

  function navItem(key, ic, name, n, hot, title, keyHint) {
    return h('button', { class: `nav-item${S.view === key ? ' on' : ''}`, onclick: () => setView(key), title: title ? `${title}${keyHint ? ` (key ${keyHint})` : ''}` : null },
      typeof ic === 'string' ? icon(ic) : ic, h('span', { class: 'lbl' }, name),
      n ? h('span', { class: `n${hot ? ' hot' : ''}` }, n > 999 ? '999+' : n) : null,
      keyHint ? h('kbd', { class: 'nav-key' }, keyHint) : null);
  }
  function renderNav() {
    const c = S.counts;
    const isAdmin = S.me && S.me.role === 'admin';
    if (S.line && c.lines && !c.lines[S.line]) { S.line = ''; store('desk_line', ''); }
    // the sidebar is rebuilt only when something it shows changed (not on every 8 s poll)
    if (same($('#navMain'), JSON.stringify([c.uncomplete, c.labels, c.lines, S.view, S.line, S.metaVer, isAdmin]))) return;
    $('#navMain').replaceChildren(...MAIN_VIEWS.map(([key, ic, name, n, hot, title], i) => navItem(key, ic, name, n(), hot && n() > 0, title, String(i + 1))));
    // labels: BSB lists every custom label as a filter
    const out = S.labels.map((l) => navItem('l' + l.id, h('span', { class: 'dot', style: `background:${l.color}` }), l.name, (c.labels || {})[l.id], false, `Chats labelled ${l.name}`));
    if (!S.labels.length) out.push(h('p', { class: 'hint', style: 'padding:0 10px' }, isAdmin ? 'No labels yet: add some with the ⚙ button.' : 'No labels yet.'));
    $('#navLabels').replaceChildren(...out);
    // channels (one entry per WhatsApp number / Instagram account)
    const lines = Object.entries(c.lines || {}).sort((x, y) => (y[1].recent - x[1].recent) || (y[1].uncomplete - x[1].uncomplete));
    const chItem = (line, name, n, ic) => {
      const b = h('button', { class: `nav-item${S.line === line ? ' on' : ''}`, title: line ? `Only chats on ${name}` : 'Chats on every channel', onclick: () => setLine(line) },
        ic, h('span', { class: 'lbl' }, name), n ? h('span', { class: 'n' }, n > 999 ? '999+' : n) : null);
      if (line && isAdmin) b.append(h('span', { class: 'nav-edit', role: 'button', title: 'Rename this channel', onclick: (e) => { e.stopPropagation(); renameLine(line); } }, '✎'));
      return b;
    };
    $('#navChannels').replaceChildren(chItem('', 'All channels', null, icon('all')),
      ...lines.map(([line, v]) => chItem(line, lineName(line), v.uncomplete, lineIcon(line))));
    const todo = c.uncomplete || 0;
    document.title = todo ? `(${todo}) Teshrij Desk` : 'Teshrij Desk';
    $('#manageBtn').hidden = !isAdmin;
  }
  function closeSide() { $('#app').classList.remove('side-open'); $('#scrim').hidden = true; }
  function setView(key) {
    S.view = key;
    store('desk_view3', key);
    closeSide();
    renderNav();
    S.chats = [];
    renderList();
    refreshList(true);
  }
  function setLine(line) {
    S.line = line;
    store('desk_line', line);
    closeSide();
    renderNav();
    S.chats = [];
    renderList();
    refreshList(true);
  }
  async function renameLine(line) {
    const name = prompt(`Name for ${lineName(line)} (empty = default name):`, (S.channelNames || {})[line] || '');
    if (name === null) return;
    try { setMeta(await api.call('channel_name', { line, name })); renderNav(); renderList(); } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------------ list

  function listArgs(extra = {}) { return { view: S.view, line: S.line || null, q: S.q, ...extra }; }
  // The user is "on" the list while the pointer is over it or it was scrolled in the last 4 s.
  const listBusyUser = () => S.listHover || Date.now() - S.listScrollAt < 4000;
  // Stable order: a poll does not shuffle rows the user is looking at. Rows keep their place
  // unless the customer wrote again (then they float up to their time slot, like a new chat);
  // the open chat never moves while it is open; new chats slot in by time. The plain server
  // order (last message first) comes back when nobody is working the list (no chat open,
  // pointer elsewhere).
  function mergeOrder(old, rows) {
    S.listFrozen = false;
    if (!old.length) return rows;
    const act = S.active ? S.active.contact : null;
    if (!act && !listBusyUser()) return rows;
    const fresh = new Map(rows.map((x) => [x.contact, x]));
    const out = [];
    const float = [];
    for (const o of old) {
      const n = fresh.get(o.contact);
      if (!n) { if (o.contact === act) out.push(o); continue; }
      fresh.delete(o.contact);
      if (o.contact !== act && n.last_in_at && n.last_in_at !== o.last_in_at) float.push(n);
      else out.push(n);
    }
    for (const n of rows) if (fresh.has(n.contact)) float.push(n);
    // keep the server's relative order among the floating rows
    const rank = new Map(rows.map((x, i) => [x.contact, i]));
    float.sort((x, y) => rank.get(x.contact) - rank.get(y.contact));
    for (const f of float) {
      const i = out.findIndex((x) => x.contact !== act && x.last_at < f.last_at);
      out.splice(i < 0 ? out.length : i, 0, f);
    }
    S.listFrozen = out.length !== rows.length || out.some((x, i) => x !== rows[i]);
    return out;
  }
  function applyList(b, replace, reset = false) {
    if (b.counts) S.counts = b.counts;
    if (b.now) S.skew = Date.parse(b.now) - Date.now();
    // a chat being completed (undo bar showing) is already gone from the list
    const rows = (b.chats || []).filter((x) => !(pending && pending.contact === x.contact));
    if (replace) {
      const keep = S.active ? S.chats.find((x) => x.contact === S.active.contact) : null;
      S.chats = reset ? rows : mergeOrder(S.chats, rows);
      if (reset) S.listFrozen = false;
      if (keep && !S.chats.some((x) => x.contact === keep.contact)) {
        const i = S.chats.findIndex((x) => x.last_at < keep.last_at);
        S.chats.splice(i < 0 ? S.chats.length : i, 0, keep);
      }
      S.more = !S.view.startsWith('sys_') && rows.length >= (b._limit || 60);
    }
    renderNav();
    renderList();
    alertIfLate();
  }
  // One inbox request at a time: calls made while one is running are folded into one follow-up.
  // poll = a timer refresh: it sends the signature of the list it has, and the server answers
  // "unchanged" (counts only) when the list is the same. Anything the user did asks for the
  // full list (no signature), so it never waits for the next change to show.
  let listBusy = false, listAgain = null;
  async function refreshList(reset = false, poll = false) {
    if (listBusy && !reset) { listAgain = listAgain === false ? false : poll; return; }
    const seq = ++S.listSeq;
    listBusy = true;
    const limit = reset ? 60 : Math.min(200, Math.max(60, S.chats.length));
    // (no signature either when our order was held for the user and could now go back to the server's)
    const thaw = S.listFrozen && !S.active && !listBusyUser();
    const sentSig = poll && !reset && !thaw && S.listSig && S.listSig.limit === limit ? S.listSig.sig : null;
    try {
      const b = await api.call('inbox', listArgs({ limit, ...(sentSig ? { sig: sentSig } : {}) }));
      if (seq !== S.listSeq) return;
      b._limit = limit;
      const same = !!(b.unchanged && sentSig && b.chats == null);
      S.listSig = b.sig ? { sig: b.sig, limit } : null;
      applyList(b, !same, reset);
      if (S.active && S.active.data) {
        const row = S.chats.find((x) => x.contact === S.active.contact);
        if (row && row.last_at !== S.active.data.conv.last_at) pollChat();
      }
    } catch (e) {
      if (e.status === 401) { api.signOut(); return showLogin('Your access was revoked or expired'); }
      if (seq === S.listSeq) $('#viewCount').title = `offline: ${e.message}`;
    } finally {
      if (seq === S.listSeq) {
        listBusy = false;
        if (listAgain !== null) { const p = listAgain; listAgain = null; refreshList(false, p); }
      }
    }
  }
  async function loadMore() {
    if (!S.more || S.loadingMore || !S.chats.length) return;
    S.loadingMore = true;
    const seq = S.listSeq;
    try {
      const b = await api.call('inbox', listArgs({ before: S.chats[S.chats.length - 1].last_at, limit: 60, counts: false }));
      if (seq !== S.listSeq) return;
      const have = new Set(S.chats.map((x) => x.contact));
      S.chats.push(...(b.chats || []).filter((x) => !have.has(x.contact)));
      S.more = (b.chats || []).length >= 60;
      renderList();
    } catch (e) { toast(e.message, 'error'); } finally { S.loadingMore = false; }
  }
  let listTimer = null;
  function loopList() {
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => { await refreshList(false, true); loopList(); }, document.hidden ? C.pollHiddenMs : C.pollMs);
  }

  function preview(c) {
    const out = c.last_dir === 'Outgoing';
    const text = cleanPreview(c.last_text);
    return h('span', { class: 'row-prev' },
      out ? h('span', { class: 'you' }, c.last_by && S.me && c.last_by !== S.me.name ? `${String(c.last_by).split(' ')[0]}: ` : 'You: ') : null,
      text || h('em', null, 'message'));
  }
  function cleanPreview(t) {
    return String(t || '')
      .replace(/^\[Outgoing Message\]$/, 'sent from BSB')
      .replace(/^👍 \*Reaction Received\*: (\S+)[\s\S]*/u, 'Reacted $1')
      .replace(/^↩️ \*Reply\*[\s\S]*?📝 \*Reply\*:\s*([\s\S]*?)\s*🔗[\s\S]*$/u, '↩ $1')
      .replace(/\*([^*\n]+)\*/g, '$1').replace(/\s+/g, ' ');
  }
  // List markers: Sales gets its tag; support gets no tag, only a dot while unsolved (green,
  // red once the customer has been waiting more than an hour). Unread keeps its number.
  const LATE_MS = 60 * 60 * 1000;
  function rowDot(c) {
    const unsolved = c.sys && c.sys.kind === 'support' && c.sys.status === 'open';
    const late = unsolved && c.last_in_at && now() - Date.parse(c.last_in_at) > LATE_MS;
    const why = unsolved ? (late ? `Unsolved · customer last wrote ${dur(now() - Date.parse(c.last_in_at))} ago` : 'Unsolved support chat') : '';
    if (c.unread) return h('span', { class: `badge-n${late ? ' late' : ''}`, title: why || 'Unread' }, c.unread_n > 99 ? '99+' : c.unread_n || '');
    if (unsolved) return h('span', { class: `badge-n dot${late ? ' late' : ''}`, title: why, 'aria-label': why });
    return null;
  }
  // Everything a row shows, as one string: a row is rebuilt only when this changes.
  function rowKey(c) {
    const unsolved = c.sys && c.sys.kind === 'support' && c.sys.status === 'open';
    const late = unsolved && c.last_in_at && now() - Date.parse(c.last_in_at) > LATE_MS;
    return JSON.stringify([c.name, c.handle, c.channel, c.line, c.last_at, c.last_dir, c.last_by, c.last_text, c.unread, c.unread_n,
      c.sys && c.sys.kind, c.sys && c.sys.status, c.labels, c.last_in_at, listTime(c.last_at), !!late, S.metaVer, S.me && S.me.name]);
  }
  function row(c) {
    const on = S.active && S.active.contact === c.contact;
    const sb = c.sys && c.sys.kind === 'sales' ? sysBadge(c.sys) : null;
    return h('li', { class: `row${c.unread ? ' unread' : ''}${on ? ' on' : ''}`, dataset: { contact: c.contact } },
      avatar(c),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, displayName(c)),
          c.line ? h('span', { class: 'row-line', title: `Channel: ${lineName(c.line)}` }, lineIcon(c.line), rowLine(c.line)) : null,
          h('span', { class: 'row-time', title: fmtFull.format(new Date(c.last_at)) }, listTime(c.last_at))),
        h('div', { class: 'row-mid' }, preview(c), rowDot(c)),
        sb || (c.labels && c.labels.length) ? h('div', { class: 'row-chips' }, sb, (c.labels || []).map((id) => labelChip(id))) : null));
  }
  function rowLine(l) { return lineShort(l); }
  function shortLine(l) { const n = (S.channelNames || {})[l]; return n ? n.slice(0, 12) : /^\d{8,}$/.test(l) ? '…' + l.slice(-3) : l.replace(/^Channel /, ''); }
  // Row nodes by contact. The list is patched, never rebuilt: unchanged rows are not touched,
  // changed rows are swapped in place, and the row under the user's eyes stays where it is.
  const rowEls = new Map();
  let moreEl = null;
  function rowEl(c) {
    const k = rowKey(c);
    let el = rowEls.get(c.contact);
    if (el && el._k === k) return el;
    const n = row(c);
    n._k = k;
    if (el && el.isConnected) el.replaceWith(n);
    rowEls.set(c.contact, n);
    return n;
  }
  // The row to hold still: the open chat if it is on screen, else the first row on screen
  // (only once the list is scrolled; at the very top new chats simply appear above).
  function listAnchor(list, stays) {
    const lt = list.getBoundingClientRect().top, lb = lt + list.clientHeight;
    const act = S.active && rowEls.get(S.active.contact);
    if (act && act.isConnected && stays.has(S.active.contact)) {
      const r = act.getBoundingClientRect();
      if (r.bottom > lt && r.top < lb) return { contact: S.active.contact, top: r.top };
    }
    if (list.scrollTop <= 0) return null;
    for (const el of list.children) {
      const ct = el.dataset.contact;
      if (!ct || !stays.has(ct)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > lt) return { contact: ct, top: r.top };
    }
    return null;
  }
  function renderListHead() {
    const n = viewCount();
    const title = viewName();
    if (same($('#viewTitle'), JSON.stringify([title, n]))) return;
    $('#viewTitle').textContent = title;
    $('#viewCount').textContent = n == null ? '' : n;
    $('#viewCount').hidden = n == null;
  }
  // noAnchor: the change is the user's own (V / undo): rows above stay, rows below slide.
  function renderList(noAnchor = false) {
    renderListHead();
    // BSB-style context: which channel and which view this list is
    if (!same($('#ctxBar'), `${S.line}|${S.metaVer}`)) {
      $('#ctxBar').replaceChildren(
        h('span', { class: 'ctx-part' }, h('span', { class: 'muted' }, 'Channel'), h('b', null, S.line ? lineName(S.line) : 'All channels'),
          S.line ? h('button', { class: 'ctx-x', title: 'Show every channel', 'aria-label': 'Show every channel', onclick: () => setLine('') }, '×') : null));
    }
    const list = $('#list');
    if (!S.chats.length) {
      const done = S.view === 'unresolved' && !S.q;
      rowEls.clear();
      if (same(list, `empty|${done}|${!!S.q}`)) return;
      list.replaceChildren(h('li', { class: 'list-empty' }, done ? [h('div', { class: 'empty-big' }, '🎉'), h('b', null, 'All resolved'), h('div', { class: 'muted' }, 'No open support and nothing unread.')]
        : S.q ? 'Nothing matches your search.' : 'No chats here.'));
      return;
    }
    list._k = null;
    const stays = new Set();
    for (const c of S.chats) if (rowEls.get(c.contact)?.isConnected) stays.add(c.contact);
    // nothing to do? (same rows, same order, same content) -> no DOM writes, no layout reads
    const fresh = S.chats.every((c) => { const el = rowEls.get(c.contact); return el && el._k === rowKey(c); });
    if (S.more && !moreEl) moreEl = h('li', { class: 'list-more' }, 'Scroll for more…');
    const tail = S.more ? [moreEl] : [];
    if (fresh) {
      const want = [...S.chats.map((c) => rowEls.get(c.contact)), ...tail];
      if (inOrder(list, want)) return;
    }
    const anchor = noAnchor ? null : listAnchor(list, stays);
    const want = [...S.chats.map(rowEl), ...tail];
    reconcile(list, want);
    // forget rows that left the list
    if (rowEls.size > want.length + 50) { const live = new Set(S.chats.map((c) => c.contact)); for (const k of rowEls.keys()) if (!live.has(k)) rowEls.delete(k); }
    if (anchor) {
      const el = rowEls.get(anchor.contact);
      if (el && el.isConnected) {
        const d = el.getBoundingClientRect().top - anchor.top;
        if (Math.abs(d) >= 1) list.scrollTop += d;
      }
    }
  }
  function markActiveRow(contact) {
    for (const el of $('#list').querySelectorAll('.row.on')) if (el.dataset.contact !== contact) el.classList.remove('on');
    const el = contact && rowEls.get(contact);
    if (el) el.classList.add('on');
  }

  // ------------------------------------------------------------------ alerts

  let audioCtx = null;
  function alertIfLate() {
    const late = sys().support_late || 0;
    if (S.notify && late > S.lastLate) {
      try {
        audioCtx = audioCtx || new AudioContext();
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.frequency.value = 880; g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + 0.18);
      } catch (e) { /* no sound */ }
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        new Notification('Teshrij Desk', { body: `${late} support customer${late > 1 ? 's' : ''} waiting more than ${slaMin()} min`, icon: 'img/logo.png', tag: 'desk-late' });
      }
    }
    S.lastLate = late;
  }

  // ------------------------------------------------------------------ chat

  async function openChat(contact) {
    if (!/^([0-9]{6,20}|ig_[0-9]{5,30})$/.test(contact)) return;
    if (S.active && S.active.contact === contact) { showChatPane(); return; }
    voiceDiscard();
    S.detailsNarrow = false;
    const a = S.active = { contact, data: null, pending: [], customer: null, draft: (store('desk_drafts') || {})[contact] || '',
      nodes: new Map(), media: new Map(), sig: '', srvSig: null };
    history.replaceState(null, '', `#c=${contact}`);
    markActiveRow(contact);
    renderChatSkeleton(S.chats.find((x) => x.contact === contact));
    showChatPane();
    // A chat seen (or prefetched) in the last minute shows at once; the poll below refreshes it.
    const hit = chatCache.get(contact);
    if (hit && Date.now() - hit.at < 60000) { a.data = hit.d; a.sig = hit.sig; a.srvSig = hit.srvSig; a.loaded = hit.d.messages.length; renderChat(true); }
    await pollChat(true);
    if (S.active !== a) return;
    if (a.data && a.data.conv.unread) markRead(contact);
    loadCustomer(contact);
    // V and J usually go to the next row: fetch it now so it opens instantly too.
    const i = S.chats.findIndex((x) => x.contact === contact);
    const next = i >= 0 ? S.chats[i + 1] : null;
    if (next) setTimeout(() => { if (S.active === a) prefetchChat(next.contact); }, 600);
  }
  // Recently loaded chats (last payload per contact), for instant J/K/V.
  const chatCache = new Map();
  function cachePut(contact, d, sigv, srvSig = null) {
    chatCache.delete(contact);
    chatCache.set(contact, { d, sig: sigv, srvSig, at: Date.now() });
    if (chatCache.size > 12) chatCache.delete(chatCache.keys().next().value);
  }
  const prefetching = new Set();
  async function prefetchChat(contact) {
    const hit = chatCache.get(contact);
    if (prefetching.has(contact) || (hit && Date.now() - hit.at < 30000) || document.hidden) return;
    prefetching.add(contact);
    try { const d = await api.call('chat', { contact, limit: 80 }); if (!d.unchanged) cachePut(contact, d, sig(d), d.sig ? { sig: d.sig, limit: 80 } : null); } catch (e) { /* only a head start */ }
    finally { prefetching.delete(contact); }
  }
  function showChatPane() { $('#app').classList.add('chat-open'); }
  function closeChat() {
    voiceDiscard();
    S.active = null;
    history.replaceState(null, '', location.pathname + location.search);
    $('#app').classList.remove('chat-open');
    const chat = $('#chat');
    chat.className = 'chat-pane empty';
    chat.replaceChildren(...emptyChat());
    $('#details').hidden = true;
    $('#details')._k = null;
    markActiveRow(null);
  }
  function emptyChat() {
    const k = (key, what) => h('div', { class: 'ek' }, h('kbd', null, key), h('span', null, what));
    return [h('div', { class: 'chat-empty' },
      h('div', { class: 'chat-empty-ic' }, icon('chat')),
      h('h3', null, 'Open a chat to start'),
      h('p', { class: 'muted' }, 'Work down ', h('b', null, 'Unresolved'), ': open support chats and everything unread. Reply, then press ', h('kbd', null, 'V'), ' to solve. If the customer wrote recently, the AI sends a fitting closing message.'),
      h('div', { class: 'empty-keys' }, k('J', 'next chat'), k('K', 'previous'), k('V', 'solve'), k('R', 'reply'), k('L', 'labels'), k('U', 'unread'), k('/', 'search'), k('?', 'all shortcuts')),
      h('button', { class: 'btn', onclick: () => { if (S.chats[0]) openChat(S.chats[0].contact); } }, 'Open the first chat', h('kbd', null, 'J')))];
  }

  async function markRead(contact, unread = false) {
    try {
      await api.call('read', { contact, unread });
      const r = S.chats.find((x) => x.contact === contact);
      if (r) { r.unread = unread; r.unread_n = unread ? 1 : 0; }
      if (!unread && S.active && S.active.data && S.active.contact === contact) S.active.data.conv.unread = false;
      refreshList();
    } catch (e) { /* next poll retries */ }
  }

  let chatTimer = null;
  function loopChat() {
    clearTimeout(chatTimer);
    chatTimer = setTimeout(async () => { if (S.active && !document.hidden) await pollChat(); loopChat(); }, C.threadPollMs);
  }
  // Signature of a chat payload without the media links: signed links change on every request,
  // which must not count as "the chat changed".
  // (`now` and the server's `sig` differ per response too.)
  const sig = (d) => JSON.stringify(d, (k, v) => (k === 'now' || k === 'sig' ? undefined
    : typeof v === 'string' && (k === 'media' || k === 'media_raw' || k === 'url') ? 1 : v));
  async function pollChat(first = false) {
    const a = S.active;
    if (!a || a.busy) return; // busy is per chat: a slow poll of the previous chat never blocks the next one
    a.busy = true;
    try {
      const limit = Math.max(80, a.loaded || 0);
      // the server's signature of what we show: it answers {unchanged} when nothing changed
      const sent = a.data && a.srvSig && a.srvSig.limit === limit ? a.srvSig.sig : null;
      const d = await api.call('chat', { contact: a.contact, limit, ...(sent ? { sig: sent } : {}) });
      if (S.active !== a) return;
      if (d.now) S.skew = Date.parse(d.now) - Date.now();
      if (d.unchanged) {
        if (sent && a.data) { const hit = chatCache.get(a.contact); if (hit) hit.at = Date.now(); return; }
        a.srvSig = null; return; // unexpected: ask for the full chat next time
      }
      a.srvSig = d.sig ? { sig: d.sig, limit } : null;
      const s = sig(d);
      const prev = a.data;
      const changed = !prev || s !== a.sig;
      a.data = d;
      a.sig = s;
      a.loaded = d.messages.length;
      cachePut(a.contact, d, s, a.srvSig);
      const row0 = S.chats.find((x) => x.contact === a.contact);
      if (row0) { row0.sys = d.thread; row0.labels = d.conv.labels; }
      if (!prev) renderChat(true);
      else if (changed) {
        const newIn = d.messages.length && d.messages.at(-1).id !== prev.messages.at(-1)?.id && d.messages.at(-1).dir === 'Incoming';
        renderHead(); renderSysbar(); renderLabelbar(); renderMessages(false); renderComposerState(); renderDetails();
        if (newIn && !document.hidden) markRead(a.contact);
      } else noteMedia(d);
    } catch (e) {
      if (e.status === 404 && first) { toast('Chat not found', 'error'); closeChat(); }
    } finally { a.busy = false; }
  }

  function renderChatSkeleton(c) {
    const chat = $('#chat');
    chat.className = 'chat-pane';
    chat.replaceChildren(
      h('header', { class: 'chat-head', id: 'chatHead' }),
      h('div', { class: 'sysbar', id: 'sysbar', 'aria-label': 'System label' }),
      h('div', { class: 'labelbar', id: 'labelbar', role: 'toolbar', 'aria-label': 'Your labels' }),
      h('div', { class: 'msgs', id: 'msgs' }),
      h('div', { class: 'composer-wrap', id: 'composerWrap' }));
    const box = $('#msgs');
    box._stick = true;
    box.addEventListener('scroll', () => { box._stick = nearBottom(box); }, { passive: true });
    $('#details')._k = null;
    if (c) { S.active.data = null; renderHead(c); renderLabelbar(c); }
    renderComposer();
  }
  function renderChat(scroll) {
    renderHead(); renderSysbar(); renderLabelbar(); renderMessages(scroll); renderComposerState(); renderDetails();
  }

  function windowInfo(c) {
    const ends = c.window_ends ? Date.parse(c.window_ends) : NaN;
    const left = Number.isFinite(ends) ? ends - now() : -1;
    return { open: left > 30000, left };
  }
  function renderHead(c0) {
    const c = c0 || S.active.data.conv;
    const w = windowInfo(c);
    if (same($('#chatHead'), JSON.stringify([c.contact, c.name, c.handle, c.channel, c.line, c.last_in_at, w.open, w.open ? dur(w.left) : 0, detailsOn(), S.metaVer]))) return;
    let win;
    if (!c.last_in_at) win = h('span', { class: 'win closed', title: 'The customer has never written' }, icon('lock'), h('span', { class: 'wtxt' }, 'No window'));
    else if (!w.open) win = h('span', { class: 'win closed', title: isIg(c) ? 'Instagram allows replies up to 7 days after the last customer message' : 'WhatsApp allows free replies up to 24h after the last customer message' }, icon('lock'), h('span', { class: 'wtxt' }, 'Window closed'));
    else win = h('span', { class: `win${w.left < 4 * 3600000 ? ' warn' : ''}`, title: 'Time left to reply' }, icon('clock'), h('span', { class: 'wtxt' }, `${dur(w.left)} left`));
    $('#chatHead').replaceChildren(
      h('button', { class: 'icon-btn back-btn', 'aria-label': 'Back to chats', onclick: closeChat }, icon('back')),
      avatar(c),
      h('div', { class: 'chat-who' },
        h('div', { class: 'chat-name' }, displayName(c)),
        h('div', { class: 'chat-sub' }, h('span', null, subtitle(c)),
          !isIg(c) ? h('button', { class: 'copy-num', title: `Copy ${localNumber(c.contact)} (N)`, 'aria-label': 'Copy number', onclick: copyNumber }, icon('copy', 'xs'), 'Copy', h('kbd', { class: 'mini' }, 'N')) : null,
          c.line ? h('span', { class: 'chan-badge', title: 'Channel this chat is on' }, lineIcon(c.line), lineName(c.line)) : null)),
      win,
      h('div', { class: 'chat-actions' },
        h('button', { class: 'icon-btn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: openHelp }, icon('help')),
        h('button', { class: `icon-btn${detailsOn() ? ' on' : ''}`, title: 'Contact details (C)', 'aria-label': 'Contact details', onclick: toggleDetails }, icon('panel'))));
  }
  // The one big action, like BSB's "Mark complete": V = resolve.
  function completeButton() {
    const t = S.active && S.active.data ? S.active.data.thread : null;
    if (t && t.kind === 'support' && t.status === 'resolved') {
      return h('button', { class: 'btn sm', title: 'Solved. Reopen it?', onclick: () => reopen(t) }, icon('check', 'sm'), 'Reopen');
    }
    const support = t && t.kind === 'support' && t.status === 'open';
    return h('button', { class: `btn sm ${support ? 'primary' : ''}`, id: 'completeBtn',
      title: support ? 'Solve (V). Sends an AI-picked closing message only if the customer wrote in the last 4h (1h from 11pm to 7am).' : 'Mark done: it leaves Unresolved (V)',
      onclick: completeChat }, icon('check', 'sm'), support ? 'Solve' : 'Done', h('kbd', null, 'V'));
  }
  function markUnreadAndLeave() {
    if (!S.active) return;
    const ct = S.active.contact;
    markRead(ct, true); closeChat(); toast('Marked as unread');
  }

  // ---- system label bar (episode)

  function renderSysbar() {
    const bar = $('#sysbar');
    if (!bar || !S.active || !S.active.data) return;
    const d = S.active.data;
    const t = d.thread;
    // Rebuilt only when the episode / gate changed, or once a minute for the "x min ago" texts
    // (but not while the product menu is open: rebuilding would close it).
    const dataKey = JSON.stringify([t, d.gate, S.closers.length]);
    if (bar._k === `${dataKey}|${minute()}`) return;
    if (bar._k && bar._k.startsWith(dataKey + '|') && bar.contains(document.activeElement)) return;
    bar._k = `${dataKey}|${minute()}`;
    if (!t || (t.status === 'closed' && t.kind !== 'support')) {
      bar.className = 'sysbar quiet';
      bar.replaceChildren(h('span', { class: 'sys-title' }, 'System'), h('span', { class: 'muted' }, t ? 'Earlier episode closed; a new customer message starts a new one.' : 'No episode in the last days.'));
      return;
    }
    const src = t.kind_source === 'staff' ? `set by ${t.kind_by || 'staff'}` : t.kind_source === 'ai' ? `AI ${Math.round((t.kind_confidence || 0) * 100)}%` : t.kind_source === 'rule' ? 'rule' : '';
    const kindSeg = h('div', { class: 'seg-kind', role: 'group', 'aria-label': 'Sales or support' }, ['sales', 'support', 'ignore'].map((k) =>
      h('button', { class: `k-${k}${t.kind === k ? ' on' : ''}`, title: k === 'ignore' ? 'Nothing to do (spam, wrong number, only a sticker)' : `This episode is ${k}`, onclick: () => setKind(t, k) },
        k === 'sales' ? icon('dollar', 'xs') : k === 'support' ? icon('life', 'xs') : null, k[0].toUpperCase() + k.slice(1),
        h('kbd', { class: 'mini' }, k === 'sales' ? 'S' : k === 'support' ? 'H' : 'X'))));
    const prod = h('select', { class: 'prod', title: 'Product', onchange: (e) => setKind(t, ['sales', 'support', 'ignore'].includes(t.kind) ? t.kind : null, e.target.value) },
      h('option', { value: '' }, 'Product…'), Object.entries(PRODUCTS).map(([k, l]) => h('option', { value: k, selected: t.product === k }, l)));
    const left = [h('span', { class: 'sys-title', title: 'Set automatically for this conversation episode; you can correct it' }, 'System'), kindSeg, prod,
      src ? h('span', { class: `src${t.kind === 'unsure' ? ' unsure' : ''}`, title: t.kind_reason || '' }, src) : null];
    const right = [];
    bar.className = `sysbar k-${t.kind === 'pending' || t.kind === 'unsure' ? 'label' : t.kind}`;

    if (t.kind === 'pending' || t.kind === 'unsure') {
      right.push(h('span', { class: 'hint-strong' }, t.kind === 'pending' ? 'Labelling…' : `Not sure${t.kind_reason ? ': ' + t.kind_reason.slice(0, 90) : ''}`));
    } else if (t.kind === 'sales') {
      right.push(h('span', { class: 'muted' }, 'Sales'));
    } else if (t.kind === 'support') {
      const g = d.gate || {};
      if (t.status !== 'open') {
        const c = S.closers.find((x) => x.key === t.resolution);
        right.push(h('span', { class: 'ok-strong' }, icon('check', 'xs'), ` Solved${t.resolved_by ? ' by ' + t.resolved_by : ''}`),
          h('span', { class: 'muted' }, `${c ? '“' + c.title + '” sent' : 'no message'} · ${ago(t.status_at)}`),
          h('button', { class: 'btn sm', onclick: () => reopen(t) }, 'Reopen'));
      } else {
        right.push(h('span', { class: 'unsolved' }, 'Unsolved'), resolveHint(g),
          g.can_send ? h('button', { class: 'link', title: 'Choose the closing message yourself instead of the AI', onclick: openResolve }, 'Pick message myself') : null);
      }
    } else if (t.kind === 'ignore') {
      right.push(h('span', { class: 'muted' }, t.kind_reason || 'Nothing to do.'));
    }
    bar.replaceChildren(h('div', { class: 'sys-left' }, left), h('div', { class: 'sys-right' }, right));
  }
  // What V will do on this support chat.
  function resolveHint(g) {
    if (g.can_send) return h('span', { class: 'v-hint ok' }, h('kbd', null, 'V'), ' solves and sends a closing message');
    if (g.closer_sent) return h('span', { class: 'v-hint' }, h('kbd', null, 'V'), ' solves without a message · closing message already sent');
    const since = !g.window_open && g.last_in_at ? 'reply window closed' : g.last_in_at ? `customer last wrote ${dur(now() - Date.parse(g.last_in_at))} ago` : 'the customer never wrote';
    return h('span', { class: 'v-hint', title: `A closing message is only sent if the customer wrote in the last ${g.recent_hours || 4}h (1h from 11pm to 7am).` },
      h('kbd', null, 'V'), ` solves without a message · ${since}`);
  }
  function salesHint(t) {
    if (t.stage === 'bought') return t.bought_product ? `${PRODUCTS[t.bought_product] || t.bought_product}${t.bought_at ? ' · ' + ago(t.bought_at) : ''}` : '';
    if (t.stage === 'unanswered') return t.waiting_since ? `waiting ${dur(waitMs(t))}` : '';
    if (t.followup_due) return `quiet ${dur(now() - Date.parse(t.last_msg_at))} · follow up`;
    return '';
  }
  async function setKind(t, kind, product) {
    if (!kind) { toast('Pick Sales, Support or Ignore first'); return; }
    if (t.kind === 'support' && kind !== 'support' && t.status === 'open' && !confirm('Move this open support episode out of Support?')) return;
    try {
      await api.call('set_kind', { thread_id: t.id, kind, product: product ?? t.product ?? null });
      toast(`System label: ${kind}${product ? ' · ' + (PRODUCTS[product] || product) : ''}`);
      await pollChat(); refreshList();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function setStage(t, stage) {
    try { await api.call('set_stage', { thread_id: t.id, stage }); await pollChat(); refreshList(); } catch (e) { toast(e.message, 'error'); }
  }
  async function reopen(t) {
    try { await api.call('reopen', { thread_id: t.id }); toast('Reopened'); await pollChat(); refreshList(); } catch (e) { toast(e.message, 'error'); }
  }
  async function closeNoReply(t) {
    if (!confirm('Close this support episode without sending anything? (The reply window is closed.)')) return;
    try {
      const r = await api.call('close_no_reply', { thread_id: t.id });
      if (r && r.ok === false) throw new Error(r.error);
      toast('Closed'); await pollChat(); refreshList();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- resolve with a closing message

  function openResolve() {
    const d = S.active && S.active.data;
    if (!d || !d.thread || !d.gate) return;
    const g = d.gate;
    let chosen = g.suggested || null;
    const go = h('button', { class: 'btn primary', disabled: true }, icon('send', 'sm'), 'Send & resolve');
    const update = () => { go.disabled = !(g.can_resolve && chosen && (g.closers || []).some((c) => c.key === chosen && c.allowed)); };
    const list = (g.closers || []).map((c) => {
      const input = h('input', { type: 'radio', name: 'closer', value: c.key, disabled: !c.allowed || !g.can_resolve, checked: c.key === chosen });
      input.addEventListener('change', () => { chosen = c.key; update(); });
      return h('label', { class: `closer${c.allowed ? '' : ' off'}`, title: c.allowed ? (c.when || '') : (c.why || '') }, input,
        h('div', { class: 'closer-main' },
          h('div', { class: 'closer-title' }, c.title, c.key === g.suggested ? h('span', { class: 'tag ok' }, 'suggested') : null,
            c.expects_reply ? h('span', { class: 'tag', title: 'The customer will probably answer; a problem reopens the chat' }, 'asks') : null),
          h('div', { class: 'closer-body' }, c.body),
          h('div', { class: 'closer-when' }, c.allowed ? c.when : c.why)));
    });
    go.addEventListener('click', () => { const c = (g.closers || []).find((x) => x.key === chosen); closeModal(); if (c) startResolve(d.thread, c); });
    update();
    openModal(h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', null, 'Resolve this support chat'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' }, 'The message you pick is sent to the customer and the episode is closed. If they write again within 48h with anything other than a thanks, it reopens by itself.'),
        !g.can_resolve ? h('div', { class: 'block-box' }, h('b', null, 'Not yet: '), (g.reasons || []).map((r) => GATE_TEXT[r] || r).join(' ')) : null,
        h('div', { class: 'closers' }, list)),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), go)), true);
  }
  // ---- complete (V) and the undo bar
  // One pending action at a time: a new one sends the previous one straight away.
  let pending = null;
  let lastRemoved = null; // the row goNext took out, so Undo can put it back in the same place
  function flushPending() { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.box.remove(); p.run(); } }
  function cancelPending(msg = 'Undone, nothing was sent') {
    if (!pending) return false;
    clearTimeout(pending.timer); pending.box.remove();
    const back = pending.contact, restore = pending.restore; pending = null;
    toast(msg);
    if (restore && !S.chats.some((x) => x.contact === restore.row.contact)) {
      S.chats.splice(Math.min(restore.index, S.chats.length), 0, restore.row);
      renderList(true);
    }
    if (back) openChat(back);
    return true;
  }
  function startPending({ text, sub, ms, run, contact }) {
    flushPending();
    const box = h('div', { class: 'undo', role: 'status' },
      h('div', { class: 'undo-bar' },
        h('div', { class: 'undo-text' }, h('div', null, text), sub ? h('div', { class: 'undo-sub' }, sub) : null),
        h('button', { class: 'btn sm', title: 'Undo (Z)', onclick: () => cancelPending() }, 'Undo', h('kbd', null, 'Z')),
        h('button', { class: 'btn sm primary', title: 'Do it now (Enter)', onclick: flushPending }, 'Now', h('kbd', null, '↵'))),
      h('div', { class: 'undo-progress' }, h('i', { style: `animation-duration:${ms}ms` })));
    document.querySelectorAll('.undo').forEach((x) => x.remove());
    document.body.append(box);
    const restore = lastRemoved && lastRemoved.row.contact === contact ? lastRemoved : null;
    lastRemoved = null;
    pending = { box, run, contact, restore, timer: setTimeout(flushPending, ms) };
  }
  function neighbour(contact) {
    const i = S.chats.findIndex((x) => x.contact === contact);
    if (i < 0) return S.chats[0] || null;
    return S.chats[i + 1] || S.chats[i - 1] || null;
  }
  // Takes the solved chat out of the list (rows above it do not move; the ones below slide up
  // by one) and opens the row that took its place.
  function goNext(contact) {
    const i = S.chats.findIndex((x) => x.contact === contact);
    lastRemoved = i >= 0 ? { row: S.chats[i], index: i } : null;
    if (!S.active || S.active.contact !== contact) { S.chats = S.chats.filter((x) => x.contact !== contact); renderList(true); return; }
    const n = neighbour(contact);
    S.chats = S.chats.filter((x) => x.contact !== contact);
    renderList(true);
    if (n && n.contact !== contact) { openChat(n.contact); scrollRowIntoView(n.contact); }
    else closeChat();
  }
  function scrollRowIntoView(contact) {
    const el = rowEls.get(contact);
    if (!el || !el.isConnected) return;
    const list = $('#list');
    const r = el.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop += r.top - l.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }
  function hComplete() { return S.labels.find((l) => /^h-?complete$/i.test(l.name)); }
  async function labelComplete(contact) {
    const l = hComplete();
    if (!l) return;
    try { await api.call('label', { contact, label_id: l.id, on: true }); } catch (e) { /* the label is a convenience */ }
  }
  let planning = false;
  async function completeChat() {
    const a = S.active;
    if (!a || !a.data || planning) return;
    flushPending();
    const contact = a.contact;
    const name = displayName(a.data.conv);
    const btn = $('#completeBtn');
    planning = true;
    if (btn) { btn.disabled = true; btn.replaceChildren(icon('check', 'sm'), 'Solving…'); }
    let plan;
    try { plan = await api.call('complete_plan', { contact }); } catch (e) { toast(`Not solved: ${e.message}`, 'error'); return; } finally { planning = false; if (btn && btn.isConnected && S.active && S.active.data) renderLabelbar(null, true); }
    if (plan.action === 'blocked') {
      toast(`Can't solve ${name}: ${(plan.reasons || []).map((r) => GATE_TEXT[r] || r).join(' ')}`, 'error');
      return;
    }
    const after = () => { if (S.active && S.active.contact === contact) pollChat(); refreshList(); };
    if (plan.action === 'resolve' && plan.solved === false) {
      unsolvedWarning(plan, contact, name, after);
    } else if (plan.action === 'resolve') {
      sendCloserPending(plan, contact, name, after);
    } else if (plan.action === 'resolve_silent' && plan.solved === false) {
      unsolvedSilentWarning(plan, contact, name);
    } else if (plan.action === 'resolve_silent') {
      const quiet = plan.why === 'customer_quiet';
      if (plan.why === 'closer_sent') { silentPending(contact, name, plan.thread_id, 'no message: a closing message was already sent in this chat'); return; }
      silentPending(contact, name, plan.thread_id, quiet
        ? `no message: the customer last wrote ${plan.last_in_at ? dur(now() - Date.parse(plan.last_in_at)) + ' ago' : 'long ago'} (more than ${plan.recent_hours}h)`
        : 'no message: the reply window is closed');
    } else {
      goNext(contact);
      startPending({
        contact, ms: 1800, text: [h('b', null, `${name}`), ' marked done'],
        run: async () => { try { await api.call('read', { contact }); } catch (e) { /* next poll */ } after(); },
      });
    }
  }
  // The AI thinks the issue is still open: stop and ask before any closing message goes out.
  function unsolvedWarning(plan, contact, name, after) {
    const c = plan.closer;
    const cancel = h('button', { class: 'btn', onclick: () => { closeModal(); toast('Nothing sent, the chat stays unsolved'); } }, 'Cancel', h('kbd', null, 'Esc'));
    const silent = h('button', { class: 'btn', onclick: () => { closeModal(); silentPending(contact, name, plan.thread_id, 'no message (issue not solved)'); } }, 'Solve without a message', h('kbd', null, 'N'));
    const send = h('button', { class: 'btn danger', onclick: () => { closeModal(); sendCloserPending(plan, contact, name, after); } }, 'Send anyway', h('kbd', null, 'Y'));
    const box = h('div', { class: 'sheet narrow unsolved-warn', role: 'alertdialog', 'aria-labelledby': 'uwTitle' },
      h('div', { class: 'uw-head' }, h('div', { class: 'uw-icon' }, '!'), h('h3', { id: 'uwTitle' }, 'Issue doesn’t seem solved')),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'uw-q' }, `Are you sure you want to send ${name} a closing message?`),
        plan.unsolved_reason ? h('p', { class: 'uw-why' }, h('b', null, 'AI: '), plan.unsolved_reason) : null,
        h('div', { class: 'uw-msg' }, h('small', null, `Would send “${c.title}”`), c.body)),
      h('div', { class: 'sheet-foot' }, cancel, silent, send));
    const keys = (e) => {
      if (!document.body.contains(box)) { document.removeEventListener('keydown', keys, true); return; }
      const k = e.key.toLowerCase();
      if (k === 'y') { e.preventDefault(); e.stopPropagation(); send.click(); }
      else if (k === 'n') { e.preventDefault(); e.stopPropagation(); silent.click(); }
    };
    document.addEventListener('keydown', keys, true);
    openModal(box, true);
    setTimeout(() => cancel.focus(), 40);
  }
  // Same warning when nothing would be sent: support is only solved when the issue sounds solved.
  function unsolvedSilentWarning(plan, contact, name) {
    const cancel = h('button', { class: 'btn', onclick: () => { closeModal(); toast('Not solved, the chat stays open'); } }, 'Cancel', h('kbd', null, 'Esc'));
    const anyway = h('button', { class: 'btn danger', onclick: () => { closeModal(); silentPending(contact, name, plan.thread_id, 'no message (marked solved anyway)'); } }, 'Solve anyway', h('kbd', null, 'Y'));
    const box = h('div', { class: 'sheet narrow unsolved-warn', role: 'alertdialog', 'aria-labelledby': 'uwTitle' },
      h('div', { class: 'uw-head' }, h('div', { class: 'uw-icon' }, '!'), h('h3', { id: 'uwTitle' }, 'Issue doesn’t seem solved')),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'uw-q' }, `Are you sure you want to mark ${name} as solved?`),
        plan.unsolved_reason ? h('p', { class: 'uw-why' }, h('b', null, 'AI: '), plan.unsolved_reason) : null,
        h('p', { class: 'hint', style: 'margin-top:8px' }, 'No message would be sent to the customer.')),
      h('div', { class: 'sheet-foot' }, cancel, anyway));
    const keys = (e) => {
      if (!document.body.contains(box)) { document.removeEventListener('keydown', keys, true); return; }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); anyway.click(); }
    };
    document.addEventListener('keydown', keys, true);
    openModal(box, true);
    setTimeout(() => cancel.focus(), 40);
  }
  function sendCloserPending(plan, contact, name, after) {
    {
      const c = plan.closer;
      const request_id = uuid();
      goNext(contact);
      startPending({
        contact, ms: C.undoMs,
        text: [h('b', null, `Solving ${name}`), ' · sending “', c.body, '”'],
        sub: plan.source === 'ai' ? `AI picked “${c.title}”: ${plan.reason}` : `Picked “${c.title}” (${plan.reason})`,
        run: async () => {
          try {
            await api.call('resolve', { thread_id: plan.thread_id, closer: c.key, request_id });
            await labelComplete(contact);
            toast(`${name}: solved · “${c.title}” sent`, 'ok');
          } catch (e) { toast(`${name} not solved: ${e.message}`, 'error'); }
          after();
        },
      });
    }
  }
  function silentPending(contact, name, threadId, why) {
    goNext(contact);
    startPending({
      contact, ms: 3000, text: [h('b', null, `Solving ${name}`), ` · ${why}`],
      run: async () => {
        try { await api.call('resolve_silent', { thread_id: threadId }); await labelComplete(contact); toast(`${name}: solved (no message)`, 'ok'); }
        catch (e) { toast(`${name} not solved: ${e.message}`, 'error'); }
        if (S.active && S.active.contact === contact) pollChat();
        refreshList();
      },
    });
  }
  // Manual choice from the "Pick message myself" dialog uses the same undo bar.
  function startResolve(t, c) {
    const contact = S.active && S.active.contact;
    const name = S.active && S.active.data ? displayName(S.active.data.conv) : 'chat';
    const request_id = uuid();
    if (contact) goNext(contact);
    startPending({
      contact, ms: C.undoMs, text: [h('b', null, `Solving ${name}`), ' · sending “', c.body, '”'],
      run: async () => {
        try { await api.call('resolve', { thread_id: t.id, closer: c.key, request_id }); if (contact) await labelComplete(contact); toast(`${name}: solved · “${c.title}” sent`, 'ok'); }
        catch (e) { toast(`${name} not solved: ${e.message}`, 'error'); }
        refreshList();
      },
    });
  }

  // ---- keyboard shortcuts sheet (the ? / info button)
  const SHORTCUTS = [
    ['Move', [
      ['J', '↓', 'Next chat', 'Tab · Alt+↓'],
      ['K', '↑', 'Previous chat', 'Shift+Tab · Alt+↑'],
      ['Esc', null, 'Leave the message box, then close the chat', ''],
      ['1', '2', 'Views: 1 Unresolved · 2 All chats', ''],
      ['/', 'F', 'Search', 'Ctrl+K'],
    ]],
    ['Act on the open chat', [
      ['V', null, 'Solve. Support: if the customer wrote in the last 4h (1h from 11pm to 7am) the AI picks a closing message and sends it (5 s to undo); otherwise it is solved without a message. Other chats: mark done', 'Ctrl+Shift+E'],
      ['R', 'Enter', 'Reply: jump into the message box', 'Ctrl+M'],
      ['U', null, 'Mark unread and leave', 'Ctrl+Shift+U'],
      ['L', null, 'Labels: add or remove (then 1…9)', 'Ctrl+Shift+L'],
      ['Alt+1', '9', 'Toggle label 1…9 directly', ''],
      ['S', null, 'This is Sales', ''],
      ['H', null, 'This is Support (help)', ''],
      ['X', null, 'System label: ignore (spam, wrong number)', ''],
      ['Q', null, 'Quick replies (or type / in the message box)', ''],
      ['N', null, 'Copy the customer’s number, local format (e.g. 70123456)', ''],
      ['C', null, 'Contact details panel', ''],
    ]],
    ['While “Solving…” shows', [
      ['Z', null, 'Undo: nothing is sent', ''],
      ['Enter', null, 'Send it now', ''],
    ]],
    ['Message box', [
      ['Enter', null, 'Send', ''],
      ['Shift+Enter', null, 'New line', ''],
      ['/', null, 'Quick replies (at the start of the box)', 'Tab after /'],
    ]],
  ];
  function openHelp() {
    openModal(h('div', { class: 'sheet help-sheet' },
      h('div', { class: 'sheet-head' }, h('h3', null, 'Keyboard shortcuts'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' }, 'Single letters work whenever you are not typing. The BSB shortcuts in grey work too.'),
        SHORTCUTS.map(([title, rows]) => h('div', { class: 'help-group' }, h('h5', null, title),
          rows.map(([k1, k2, what, bsb]) => h('div', { class: 'help-row' },
            h('span', { class: 'help-keys' }, h('kbd', null, k1), k2 ? [h('span', { class: 'muted' }, k1 === '1' || k1 === 'Alt+1' ? '…' : ' or '), h('kbd', null, k2)] : null),
            h('span', { class: 'help-what' }, what),
            h('span', { class: 'help-bsb' }, bsb)))))),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', onclick: closeModal }, 'Got it'))), true);
  }

  // ---- manual labels

  function renderLabelbar(c0, force = false) {
    const c = c0 || S.active.data.conv;
    const t = S.active && S.active.data ? S.active.data.thread : null;
    const bar = $('#labelbar');
    if (force && bar) bar._k = null;
    if (same(bar, JSON.stringify([c.labels, t && t.kind, t && t.status, t && t.id, S.metaVer]))) return;
    const on = S.labels.filter((l) => (c.labels || []).includes(l.id));
    bar.replaceChildren(
      completeButton(),
      h('button', { class: 'btn ghost sm', title: 'Mark as unread and leave the chat (U)', onclick: markUnreadAndLeave }, icon('mail', 'sm'), 'Unread', h('kbd', null, 'U')),
      h('span', { class: 'act-sep' }),
      ...on.map((l) => h('span', { class: 'lchip', style: `--c:${l.color}` }, h('span', { class: 'dot', style: `background:${l.color}` }), l.name,
        h('button', { class: 'lchip-x', title: `Remove ${l.name}`, 'aria-label': `Remove ${l.name}`, onclick: () => toggleLabel(l.id) }, '×'))),
      h('button', { class: 'lchip add', title: 'Add or remove labels (L)', onclick: (e) => openLabelPicker(e.currentTarget) }, '+ Label', h('kbd', { class: 'mini' }, 'L')));
  }
  // Label picker (BSB-style): every label with a number key; type to filter.
  function openLabelPicker(anchor) {
    if (!S.active || !S.active.data) return;
    document.querySelectorAll('.pop').forEach((p) => p.remove());
    const anchorEl = anchor || document.querySelector('#labelbar .lchip.add') || $('#chatHead');
    const r = anchorEl.getBoundingClientRect();
    const input = h('input', { type: 'search', placeholder: 'Find a label…', 'aria-label': 'Find a label' });
    const ul = h('div', { class: 'lp-list' });
    let sel = 0, items = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const conv = S.active && S.active.data ? S.active.data.conv : { labels: [] };
      items = S.labels.map((l, i) => ({ l, i })).filter((x) => !q || x.l.name.toLowerCase().includes(q));
      sel = Math.min(sel, Math.max(0, items.length - 1));
      ul.replaceChildren(...items.map((x, j) => {
        const isOn = conv.labels.includes(x.l.id);
        return h('button', { class: `lp-item${j === sel ? ' sel' : ''}${isOn ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); pick(x.l); } },
          h('span', { class: 'lp-check' }, isOn ? '✓' : ''), h('span', { class: 'dot', style: `background:${x.l.color}` }),
          h('span', { class: 'lp-name' }, x.l.name), x.i < 9 ? h('kbd', null, String(x.i + 1)) : null);
      }), items.length ? null : h('p', { class: 'hint', style: 'padding:8px' }, 'No label matches.'));
    };
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside); };
    const pick = async (l) => { await toggleLabel(l.id); draw(); };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (items[sel]) pick(items[sel].l); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
      else if (/^[1-9]$/.test(e.key) && !input.value) { const l = S.labels[Number(e.key) - 1]; if (l) pick(l); e.preventDefault(); }
    });
    const pop = h('div', { class: 'pop label-pop', style: `left:${Math.max(8, Math.min(r.left, innerWidth - 280))}px;top:${Math.min(r.bottom + 6, innerHeight - 340)}px` },
      input, ul, h('div', { class: 'lp-foot' }, h('span', { class: 'muted' }, h('kbd', null, '1'), '…', h('kbd', null, '9'), ' toggle · ', h('kbd', null, 'Esc'), ' close'),
        S.me && S.me.role === 'admin' ? h('button', { class: 'link', onmousedown: (e) => { e.preventDefault(); close(); openManage(); } }, 'Manage labels') : null));
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    document.body.append(pop);
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    draw();
    input.focus();
  }
  async function toggleLabel(id) {
    const a = S.active;
    if (!a || !a.data) return;
    const l = S.labelById.get(id);
    const conv = a.data.conv;
    const was = new Set(conv.labels);
    const turnOn = !was.has(id);
    let next = conv.labels.filter((x) => x !== id && !(turnOn && l.grp && (S.labelById.get(x) || {}).grp === l.grp));
    if (turnOn) next.push(id);
    next = S.labels.map((x) => x.id).filter((x) => next.includes(x));
    conv.labels = next;
    const r = S.chats.find((x) => x.contact === a.contact);
    if (r) r.labels = next;
    renderLabelbar(); renderList();
    try {
      const fresh = await api.call('label', { contact: a.contact, label_id: id, on: turnOn });
      if (S.active === a && a.data) { a.data.conv = { ...a.data.conv, ...fresh }; renderLabelbar(); }
      pollChat(); refreshList();
    } catch (e) {
      toast(`Label not saved: ${e.message}`, 'error');
      conv.labels = [...was];
      if (r) r.labels = [...was];
      renderLabelbar(); renderList();
    }
  }

  // ---- messages

  const REACTION_RE = /^👍 \*Reaction Received\*: *(\S+)/u;
  const BSB_REPLY_RE = /^↩️ \*Reply\*\s*💬 \*Original Message\*:\s*([\s\S]*?)\s*📝 \*Reply\*:\s*([\s\S]*?)\s*🔗 \*Original Message ID\*:\s*\S+\s*$/u;
  const isReaction = (m) => /reaction/i.test(m.media_type || '') || REACTION_RE.test(m.text || '');
  const reactionEmoji = (m) => ((m.text || '').match(REACTION_RE) || [])[1] || ((m.text || '').length <= 4 ? m.text : '👍');

  function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }
  function renderMessages(scroll) {
    const box = $('#msgs');
    if (!box || !S.active || !S.active.data) return;
    const d = S.active.data;
    const stick = scroll || nearBottom(box);
    const prevH = box.scrollHeight, prevTop = box.scrollTop;
    // reactions go onto the message they react to (when it is loaded)
    const byMid = new Map(d.messages.filter((m) => m.message_id).map((m) => [m.message_id, m]));
    const reactions = new Map();
    const attached = new Set();
    for (const m of d.messages) {
      if (isReaction(m) && m.ref && byMid.has(m.ref)) {
        const target = byMid.get(m.ref).id;
        if (!reactions.has(target)) reactions.set(target, []);
        reactions.get(target).push({ emoji: reactionEmoji(m), out: m.dir === 'Outgoing' });
        attached.add(m.id);
      }
    }
    const items = [];
    for (const m of d.messages) if (!attached.has(m.id)) items.push({ ts: Date.parse(m.ts), kind: 'm', m });
    for (const e of d.events) items.push({ ts: Date.parse(e.at), kind: 'e', e });
    const sentIds = new Set();
    for (const s of d.sends) { sentIds.add(s.request_id); items.push({ ts: Date.parse(s.at), kind: 's', s }); }
    for (const p of S.active.pending) if (!sentIds.has(p.request_id)) items.push({ ts: p.at, kind: 'p', p });
    items.sort((x, y) => x.ts - y.ts);
    const threads = new Map((d.threads || []).map((t) => [t.id, t]));

    // Keyed rendering: every line has a key (message id, send request id, day, …) and a
    // signature of what it shows. Unchanged lines keep their node; only new or changed ones are
    // built. Media elements live in a.media by message id, so a voice note that is playing (or
    // a photo that loaded) is never recreated by a poll, even when its signed link changes.
    const a = S.active;
    const used = new Set();
    const want = [];
    let dirty = false;
    const put = (key, sigv, build) => {
      while (used.has(key)) key += '+';
      used.add(key);
      let el = a.nodes.get(key);
      if (!el || el._s !== sigv) {
        const n = build();
        n._s = sigv;
        dirty = true;
        if (el && el.isConnected) el.replaceWith(n);
        a.nodes.set(key, n);
        el = n;
      }
      want.push(el);
    };
    if (d.more) put('older', '', () => h('button', { class: 'btn load-older', onclick: loadOlder }, 'Load earlier messages'));
    let lastDay = '', lastDir = '', lastTs = 0, lastThread = null;
    for (const it of items) {
      const dt = new Date(it.ts);
      const dk = dayKey(dt);
      if (dk !== lastDay) { const lbl = dayLabel(dt, dk); put(`d:${dk}`, lbl, () => h('div', { class: 'day' }, lbl)); lastDay = dk; lastDir = ''; }
      if (it.kind === 'm' && it.m.thread_id && it.m.thread_id !== lastThread) {
        const t = threads.get(it.m.thread_id);
        if (t) {
          const txt = `${t.kind === 'pending' || t.kind === 'unsure' ? 'Unlabelled' : t.kind[0].toUpperCase() + t.kind.slice(1)} episode${t.product ? ' · ' + (PRODUCTS[t.product] || t.product) : ''} · started ${fmtTime.format(new Date(t.opened_at))}`;
          put(`t:${t.id}`, `${t.kind}|${txt}`, () => h('div', { class: `episode k-${t.kind}` }, h('span', null, txt)));
          lastDir = '';
        }
        lastThread = it.m.thread_id;
      }
      if (it.kind === 'e') {
        if (EVENT_KINDS.has(it.e.kind)) { put(`e:${it.e.at}|${it.e.kind}|${it.e.label}`, JSON.stringify(it.e), () => eventLine(it.e)); lastDir = ''; }
        continue;
      }
      const dir = it.kind === 'm' ? (it.m.dir === 'Outgoing' ? 'out' : 'in') : 'out';
      const first = dir !== lastDir || it.ts - lastTs > 10 * 60000;
      lastDir = dir; lastTs = it.ts;
      if (it.kind === 'm') {
        const m = it.m, rx = reactions.get(m.id);
        const src = api.mediaSource(m);
        put(`m:${m.id}`, JSON.stringify([m.text, m.status, m.dir, m.ts, m.by, m.media_type, src ? (src.ours ? 'o' : 'r') : '', m.quoted, m.ad, m.ref, first, rx]),
          () => bubble(m, first, rx));
        if (src) noteSrc(`m:${m.id}`, src.url);
      } else if (it.kind === 's') {
        const s = it.s;
        put(`s:${s.request_id}`, sig([s, first]), () => sendBubble(s, first));
        if (s.media && s.media.url) noteSrc(`s:${s.request_id}`, s.media.url);
      } else {
        const p = it.p;
        put(`p:${p.request_id}`, JSON.stringify([p.status, p.error, p.text, first]), () => pendingBubble(p, first));
      }
    }
    // forget nodes and media of lines that are gone
    for (const k of a.nodes.keys()) if (!used.has(k)) a.nodes.delete(k);
    for (const k of a.media.keys()) if (!used.has(k)) a.media.delete(k);
    const placed = inOrder(box, want);
    if (!dirty && placed) {
      if (scroll) box.scrollTop = box.scrollHeight;
      return;
    }
    if (!placed) reconcile(box, want);
    if (stick) box.scrollTop = box.scrollHeight;
    else if (a.keepScroll) { box.scrollTop = box.scrollHeight - prevH + prevTop; a.keepScroll = false; }
  }
  const EVENT_KINDS = new Set(['relabel', 'label_add', 'label_remove', 'sys_label', 'stage', 'resolved', 'reopened']);

  // ---- media that survives polls
  // a.media: line key -> { el (what the bubble shows), media (img/audio/video), kind, url, latest }
  function keepMedia(key, kind, url, build) {
    const a = S.active;
    const hit = a && a.media.get(key);
    // same kind, or (BSB link -> our copy) an element that already plays / loaded: keep it
    if (hit && (hit.kind === kind || inUse(hit.media))) { hit.latest = url; return hit.el; }
    const ent = { kind, url, latest: url, el: null, media: null };
    build(ent);
    if (a) a.media.set(key, ent);
    return ent.el;
  }
  function inUse(el) {
    if (!el) return false;
    if (el.tagName === 'IMG') return el.complete && el.naturalWidth > 0;
    return !el.paused || el.currentTime > 0 || el.readyState > 0;
  }
  // A new signed link for a media element we already have: keep the element and its link (so
  // nothing reloads or restarts); remember the new link for when the old one fails or expires.
  function noteSrc(key, url) {
    const ent = S.active && S.active.media.get(key);
    if (!ent || !url) return;
    ent.latest = url;
    // a voice note / video whose link had failed for good gets the new link (nothing plays)
    const el = ent.media;
    if (ent.failed && el && el.tagName !== 'IMG' && el.getAttribute('src') !== url) {
      ent.failed = false; ent.retries = 0; ent.url = url; el.src = url;
    }
  }
  function noteMedia(d) {
    for (const m of d.messages) { const src = api.mediaSource(m); if (src) noteSrc(`m:${m.id}`, src.url); }
    for (const s of d.sends) if (s.media && s.media.url) noteSrc(`s:${s.request_id}`, s.media.url);
  }
  // On a load error, try the newest link once (an expired signed URL), keeping the position.
  function retryMedia(ent, onGiveUp) {
    const el = ent.media;
    el.addEventListener('play', () => { ent.wantPlay = true; });
    el.addEventListener('error', () => {
      const cur = el.getAttribute('src');
      if (ent.latest && ent.latest !== cur && (ent.retries || 0) < 3) {
        ent.retries = (ent.retries || 0) + 1; ent.url = ent.latest;
        const t = el.currentTime || 0, play = ent.wantPlay;
        el.src = ent.latest;
        if (el.tagName !== 'IMG') {
          if (t) el.addEventListener('loadedmetadata', () => { try { el.currentTime = t; } catch (e) { /* not seekable */ } }, { once: true });
          if (play) el.play().catch(() => {});
        }
        return;
      }
      ent.failed = true;
      if (onGiveUp) onGiveUp();
    });
  }
  async function loadOlder() {
    const a = S.active;
    if (!a || !a.data) return;
    try {
      const d = await api.call('chat', { contact: a.contact, limit: 120, before: a.data.messages[0].ts });
      if (S.active !== a) return;
      a.data.messages = [...d.messages, ...a.data.messages];
      a.data.events = mergeEvents(d.events, a.data.events);
      a.data.more = d.more;
      a.loaded = a.data.messages.length;
      a.srvSig = null;
      a.keepScroll = true;
      renderMessages(false);
    } catch (e) { toast(e.message, 'error'); }
  }
  function mergeEvents(a, b) {
    const seen = new Set();
    return [...a, ...b].filter((e) => { const k = e.at + e.kind + e.label; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function jumpTo(id) {
    const el = document.querySelector(`.msg[data-id="${id}"]`);
    if (!el) { toast('That message is further up: load earlier messages'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }

  function eventLine(e) {
    const t = h('span', { class: 't' }, fmtTime.format(new Date(e.at)));
    const dd = e.detail || {};
    const who = e.actor === 'ai' ? 'AI' : e.actor === 'rule' ? 'Rule' : e.actor === 'system' ? 'System' : e.actor;
    switch (e.kind) {
      case 'relabel':
        return h('div', { class: 'ev' }, 'Customer wrote · ', h('b', null, e.label), dd.to ? [' → ', h('b', null, dd.to)] : ' removed', ' ', t);
      case 'label_add': {
        const was = dd.replaced && dd.replaced.length ? dd.replaced.join(', ') : null;
        if (was) return h('div', { class: 'ev' }, h('b', null, e.actor), ' · ', was, ' → ', h('b', null, e.label), ' ', t);
        return h('div', { class: 'ev' }, h('b', null, e.actor), ' added ', h('b', null, e.label), ' ', t);
      }
      case 'label_remove':
        return h('div', { class: 'ev' }, h('b', null, e.actor), ' removed ', h('b', null, e.label), ' ', t);
      case 'sys_label':
        return h('div', { class: 'ev sys-ev' }, icon('zap', 'xs'), ' ', h('b', null, who), ` set the system label ${dd.to}${dd.product ? ' · ' + (PRODUCTS[dd.product] || dd.product) : ''}${dd.confidence && e.actor === 'ai' ? ` (${Math.round(dd.confidence * 100)}%)` : ''}`, ' ', t);
      case 'stage':
        return h('div', { class: 'ev sys-ev' }, h('b', null, who), dd.to ? ` set the stage to ${STAGES[dd.to] || dd.to}` : ' put the stage back to automatic', ' ', t);
      case 'resolved':
        return h('div', { class: 'ev ok-ev' }, icon('check', 'xs'), ' Resolved by ', h('b', null, who), dd.title ? ` · ${dd.title}` : '', ' ', t);
      case 'reopened':
        return h('div', { class: 'ev warn-ev' }, e.actor === 'customer' ? '↺ Reopened: the customer wrote again' : ['↺ Reopened by ', h('b', null, who)], ' ', t);
      default:
        return null;
    }
  }

  function bubble(m, first, reacts) {
    const out = m.dir === 'Outgoing';
    const media = String(m.media_type || '').toLowerCase();
    let text = m.text || '';
    const cls = `msg ${out ? 'out' : 'in'}${first ? ' first' : ''}`;
    if (isReaction(m)) {
      return h('div', { class: `msg ${out ? 'out' : 'in'} reaction`, dataset: { id: m.id } }, `${out ? 'You' : 'Customer'} reacted ${reactionEmoji(m)}`,
        m.quoted ? h('button', { class: 'link', onclick: () => jumpTo(m.quoted.id) }, ` to “${String(m.quoted.text || '').slice(0, 40)}”`) : null);
    }
    // replies: the quoted message (from the database, or from BSB's text block)
    let quote = null;
    const bsb = text.match(BSB_REPLY_RE);
    if (bsb) text = bsb[2];
    if (m.quoted || bsb) {
      const q = m.quoted;
      let qText = q ? q.text : cleanPreview(bsb[1]);
      if (/^\[Outgoing Message\]$/.test(String(qText).trim())) qText = 'a message sent from BSB';
      quote = h('button', { class: `quote ${q && q.dir === 'Outgoing' ? 'q-out' : 'q-in'}`, title: q ? 'Go to that message' : '', onclick: q ? () => jumpTo(q.id) : null },
        h('b', null, q ? (q.dir === 'Outgoing' ? 'You' : 'Customer') : 'Reply to'), h('span', null, String(qText || '').slice(0, 160)));
    }
    let body;
    if (text === '[Outgoing Message]') body = h('em', { class: 'muted' }, 'Sent from BSB (text not available)');
    else if (media === 'call') body = h('em', null, /missed/i.test(text) ? '📞 Missed call' : '📞 Call');
    else {
      const clean = text.replace(/^(🎤 \*Voice Message\*|🎵 \*Audio Message\*|📎 \*Media Received\*|📷 Image|🎉 \*Sticker Received\*|🎥 Video|🎵 Audio|📎 Attachment[^\n]*)\s*/u, '');
      body = clean ? richText(clean) : null;
    }
    const mediaEl = mediaNode(m, media);
    const ad = m.ad && (m.ad.headline || m.ad.link)
      ? h(m.ad.link && /^https?:/.test(m.ad.link) ? 'a' : 'div', { class: 'ad', href: m.ad.link && /^https?:/.test(m.ad.link) ? m.ad.link : null, target: '_blank', rel: 'noopener noreferrer' },
        h('small', null, 'From an ad'), m.ad.headline || m.ad.link, m.ad.description ? h('span', { class: 'muted' }, m.ad.description) : null)
      : null;
    const rx = reacts && reacts.length ? h('div', { class: 'reacts', title: reacts.map((r) => `${r.out ? 'You' : 'Customer'} ${r.emoji}`).join(', ') }, reacts.map((r) => r.emoji).join('')) : null;
    return h('div', { class: `${cls}${rx ? ' has-react' : ''}`, dataset: { id: m.id } }, ad, quote, mediaEl,
      body || (!mediaEl ? h('em', { class: 'muted' }, media || 'message') : null), meta(m), rx);
  }
  function meta(m) {
    const out = m.dir === 'Outgoing';
    const st = out ? ({ Read: '✓✓', Played: '✓✓', Delivered: '✓✓', Sent: '✓', Failed: '⚠ failed' }[m.status] || '') : '';
    return h('span', { class: 'meta', title: fmtFull.format(new Date(m.ts)) },
      out && m.by ? h('span', { class: 'by' }, m.by) : null,
      fmtTime.format(new Date(m.ts)),
      st ? h('span', { class: `st${m.status === 'Read' || m.status === 'Played' ? ' read' : ''}${m.status === 'Failed' ? ' failed' : ''}` }, st) : null);
  }
  function sendBubble(s, first) {
    const failed = s.status === 'failed';
    const md = s.media;
    const mediaEl = md && md.url ? keepMedia(`s:${s.request_id}`, md.type, md.url, (ent) => {
      if (md.type === 'image') {
        ent.el = ent.media = h('img', { src: md.url, class: 'media-img', alt: 'photo', referrerpolicy: 'no-referrer', onclick: () => lightbox(ent.media.getAttribute('src')) });
        retryMedia(ent, null);
      } else if (md.type === 'voice') {
        ent.el = ent.media = h('audio', { src: md.url, controls: true, preload: 'none' });
        retryMedia(ent, null);
      } else ent.el = h('a', { class: 'doc', href: md.url, target: '_blank', rel: 'noopener noreferrer' }, icon('file', 'sm'), md.name || 'file');
    }) : null;
    return h('div', { class: `msg out pending${failed ? ' failed' : ''}${first ? ' first' : ''}` }, mediaEl, s.body ? richText(s.body) : null,
      h('span', { class: 'meta' }, h('span', { class: 'by' }, s.actor), fmtTime.format(new Date(s.at)),
        failed ? h('span', { class: 'bad' }, ` not sent: ${s.error || 'error'}`) : s.status === 'sending' ? ' sending…' : h('span', { class: 'st', title: 'Sent; waiting for BSB to confirm' }, '✓')));
  }
  function pendingBubble(p, first) {
    return h('div', { class: `msg out pending ${p.status}${first ? ' first' : ''}` }, p.preview || null, p.text ? richText(p.text) : null,
      h('span', { class: 'meta' }, p.status === 'failed'
        ? [h('span', { class: 'bad' }, `not sent: ${p.error || 'error'} `), h('button', { class: 'link', onclick: () => retry(p) }, 'retry'), ' · ', h('button', { class: 'link', onclick: () => dropPending(p) }, 'discard')]
        : 'sending…'));
  }
  function richText(text) {
    const el = h('div', { class: 'text' });
    for (const part of String(text).split(/(https?:\/\/[^\s<>"']+)/g)) {
      if (/^https?:\/\//.test(part)) {
        el.append(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer nofollow' }, part.length > 60 ? part.slice(0, 57) + '…' : part));
      } else {
        for (const b of part.split(/(\*[^*\n]{1,200}\*)/g)) el.append(/^\*[^*\n]+\*$/.test(b) ? h('strong', null, b.slice(1, -1)) : document.createTextNode(b));
      }
    }
    return el;
  }
  function mediaNode(m, media) {
    if (!/(image|audio|video|sticker|voice|ptt|reel|document|file)/.test(media)) return null;
    const src = api.mediaSource(m);
    const isImg = /image|sticker/.test(media);
    const isVid = /video|reel/.test(media);
    const isDoc = /document|file/.test(media);
    if (!src) {
      return h('div', { class: 'media-missing', title: 'Not copied into our storage yet; the media job copies it within a few minutes' },
        isImg ? '🖼 Photo' : isVid ? '🎬 Video' : isDoc ? '📄 Document' : '🎤 Voice note', h('span', { class: 'muted' }, ' · copying…'));
    }
    const kind = `${isImg ? 'img' : isVid ? 'vid' : isDoc ? 'doc' : 'aud'}|${src.ours ? 'o' : 'r'}|${media}`;
    // the same element for this message id across polls (see keepMedia)
    return keepMedia(`m:${m.id}`, kind, src.url, (ent) => {
      const badge = src.ours ? null : h('span', { class: 'media-src', title: 'Shown from the BSB / Instagram link until our copy is ready' }, 'BSB link');
      if (isImg) {
        const img = h('img', { src: src.url, loading: 'lazy', decoding: 'async', alt: 'photo', class: `media-img${/sticker/.test(media) ? ' sticker' : ''}`, referrerpolicy: 'no-referrer', onclick: () => lightbox(img.getAttribute('src')) });
        ent.media = img;
        retryMedia(ent, () => img.replaceWith(h('div', { class: 'media-missing' }, '🖼 Photo unavailable')));
        // a photo that finishes loading while the chat is at the bottom keeps it at the bottom
        img.addEventListener('load', () => { const box = img.closest('.msgs'); if (box && box._stick) box.scrollTop = box.scrollHeight; }, { once: true });
        ent.el = h('div', { class: 'media' }, img, badge);
      } else if (isVid) {
        ent.media = h('video', { src: src.url, controls: true, preload: 'metadata', class: 'media-video' });
        retryMedia(ent, null);
        ent.el = h('div', { class: 'media' }, ent.media, badge);
      } else if (isDoc) {
        ent.el = h('a', { class: 'doc', href: src.url, target: '_blank', rel: 'noopener noreferrer' }, icon('file', 'sm'), (m.text || '').replace(/^📎\s*/, '').slice(0, 60) || 'Document');
        ent.el.addEventListener('click', () => { if (ent.latest) ent.el.href = ent.latest; });
      } else {
        ent.media = h('audio', { src: src.url, controls: true, preload: 'none' });
        retryMedia(ent, null);
        ent.el = h('div', { class: 'media voice' }, ent.media, badge);
      }
    });
  }
  function lightbox(src) {
    const el = h('div', { class: 'lightbox', onclick: () => el.remove() }, h('img', { src, alt: '' }));
    document.body.append(el);
  }

  // ---- composer

  function renderComposer() {
    const ta = h('textarea', { id: 'reply', rows: 1, placeholder: 'Write a reply…  (/ for quick replies)', value: S.active.draft || '' });
    ta.addEventListener('input', () => { autosize(ta); updateSend(); saveDraft(ta.value); if (ta.value === '/') { ta.value = ''; openQuick(); } });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); }
    });
    ta.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData || {}).files || []].find((x) => /^image\//.test(x.type));
      if (f) { e.preventDefault(); sendFile(f); }
    });
    const file = h('input', { type: 'file', id: 'fileIn', hidden: true, accept: 'image/jpeg,image/png,image/webp,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.txt' });
    file.addEventListener('change', () => { if (file.files[0]) sendFile(file.files[0]); file.value = ''; });
    $('#composerWrap').replaceChildren(h('div', { class: 'composer', id: 'composer' },
      h('div', { class: 'voicebar', id: 'voicebar', hidden: true }),
      h('div', { class: 'composer-box' },
        h('button', { class: 'icon-btn', title: 'Quick replies (/)', 'aria-label': 'Quick replies', onclick: openQuick }, icon('zap')),
        h('button', { class: 'icon-btn', id: 'attachBtn', title: 'Send a photo or a file (WhatsApp)', 'aria-label': 'Attach', onclick: () => file.click() }, icon('clip')),
        file, ta,
        h('button', { class: 'icon-btn', id: 'micBtn', title: 'Record a voice note (WhatsApp)', 'aria-label': 'Record a voice note', onclick: voiceStart }, icon('mic')),
        h('button', { class: 'send-btn', id: 'sendBtn', title: 'Send (Enter)', 'aria-label': 'Send', onclick: sendReply }, icon('send'))),
      h('div', { class: 'composer-foot' }, h('span', { id: 'composerNote' }), h('span', { id: 'charCount' }))));
    autosize(ta);
    renderComposerState();
  }
  function renderComposerState() {
    const comp = $('#composer');
    if (!comp || !S.active) return;
    const c = S.active.data ? S.active.data.conv : S.chats.find((x) => x.contact === S.active.contact);
    let closed = $('#composerClosed');
    const w = c ? windowInfo(c) : { open: true };
    if (c && !w.open) {
      comp.querySelector('.composer-box').hidden = true;
      comp.querySelector('.composer-foot').hidden = true;
      if (!closed) {
        closed = h('div', { class: 'composer-closed', id: 'composerClosed' }, icon('lock'),
          h('span', null, isIg(c) ? 'Instagram only allows replies within 7 days of the customer’s last message.' : 'The 24h WhatsApp window is closed. Only an approved template can be sent now (from BSB).'));
        comp.prepend(closed);
      }
      return;
    }
    if (closed) closed.remove();
    comp.querySelector('.composer-box').hidden = false;
    comp.querySelector('.composer-foot').hidden = false;
    const ig = c && isIg(c);
    $('#attachBtn').hidden = !!ig;
    $('#micBtn').hidden = !!ig;
    const note = $('#composerNote');
    if (ig && w.left < 6 * 86400000) note.textContent = 'Over 24h: Instagram sends this with the human-agent tag';
    else note.textContent = 'Enter to send · Shift+Enter new line · paste a photo to send it';
    updateSend();
  }
  function maxLen() { const c = S.active && (S.active.data ? S.active.data.conv : null); return c && isIg(c) ? 1000 : 4096; }
  function updateSend() {
    const ta = $('#reply');
    if (!ta) return;
    const n = ta.value.trim().length;
    const max = maxLen();
    const cc = $('#charCount');
    cc.textContent = n > max * 0.8 ? `${n}/${max}` : '';
    cc.className = n > max ? 'over' : '';
    $('#sendBtn').disabled = !n || n > max;
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(180, ta.scrollHeight) + 'px'; }
  let draftTimer;
  function saveDraft(v) {
    if (!S.active) return;
    S.active.draft = v;
    const contact = S.active.contact;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const all = store('desk_drafts') || {};
      if (v.trim()) all[contact] = v; else delete all[contact];
      store('desk_drafts', all);
    }, 300);
  }

  async function sendReply() {
    const ta = $('#reply');
    if (!ta || !S.active || !S.active.data) return;
    const text = ta.value.trim();
    if (!text || text.length > maxLen()) return;
    const p = { request_id: uuid(), text, status: 'sending', at: now() };
    S.active.pending.push(p);
    ta.value = ''; autosize(ta); saveDraft(''); updateSend();
    renderMessages(true);
    deliver(p, S.active);
  }
  async function deliver(p, a) {
    try {
      if (p.media) await api.call('send_media', { contact: a.contact, request_id: p.request_id, ...p.media });
      else await api.call('send', { contact: a.contact, text: p.text, request_id: p.request_id });
      a.pending = a.pending.filter((x) => x !== p);
      if (S.active === a) await pollChat();
      refreshList();
    } catch (e) {
      p.status = 'failed'; p.error = e.message;
      if (S.active === a) renderMessages(false);
      toast(`Not sent: ${e.message}`, 'error');
    }
  }
  function retry(p) { p.status = 'sending'; p.request_id = uuid(); p.at = now(); renderMessages(true); deliver(p, S.active); }
  function dropPending(p) { S.active.pending = S.active.pending.filter((x) => x !== p); renderMessages(false); }

  // ---- photos, files, voice notes (WhatsApp)

  const MEDIA_MAX = 15 * 1024 * 1024;
  function toB64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function sendFile(f) {
    if (!S.active || !S.active.data) return;
    if (isIg(S.active.data.conv)) return toast('Photos and files can only be sent on WhatsApp', 'error');
    if (f.size > MEDIA_MAX) return toast('Files must be under 15 MB', 'error');
    const isImg = /^image\/(jpeg|png|webp)$/.test(f.type);
    if (!confirm(`Send ${isImg ? 'this photo' : `“${f.name}”`} to ${displayName(S.active.data.conv)}?`)) return;
    const url = URL.createObjectURL(f);
    const p = { request_id: uuid(), text: '', status: 'sending', at: now(),
      preview: isImg ? h('img', { src: url, class: 'media-img', alt: '' }) : h('span', { class: 'doc' }, icon('file', 'sm'), f.name),
      media: { kind: isImg ? 'image' : 'document', mime: f.type || 'application/octet-stream', filename: f.name, base64: await toB64(f) } };
    S.active.pending.push(p);
    renderMessages(true);
    deliver(p, S.active);
  }

  // Voice notes: OGG/Opus mono (what WhatsApp needs), recorded with opus-recorder.
  const OPUS = 'https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/';
  const voice = { phase: 'idle', rec: null, stream: null, ctx: null, blob: null, url: null, started: 0, tick: null, max: null };
  function loadRecorder() {
    if (window.Recorder) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = OPUS + 'recorder.min.js'; s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = () => rej(new Error('recorder could not load'));
      document.head.append(s);
    });
  }
  function encoderPath() {
    const u = OPUS + 'encoderWorker.min.js';
    if (typeof BaseAudioContext !== 'undefined' && 'audioWorklet' in BaseAudioContext.prototype) return u;
    return URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(u)});`], { type: 'application/javascript' }));
  }
  function voiceUi() {
    const bar = $('#voicebar');
    if (!bar) return;
    const p = voice.phase;
    bar.hidden = p === 'idle';
    $('#composer .composer-box').classList.toggle('dim', p !== 'idle');
    if (p === 'idle') return bar.replaceChildren();
    const secs = Math.floor(((p === 'recording' ? Date.now() : voice.stopped) - voice.started) / 1000);
    bar.replaceChildren(
      h('span', { class: `rec-dot${p === 'recording' ? ' on' : ''}` }),
      h('span', { class: 'rec-time' }, `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`),
      p === 'ready' && voice.url ? h('audio', { src: voice.url, controls: true }) : h('span', { class: 'muted' }, p === 'recording' ? 'Recording…' : 'Finishing…'),
      h('button', { class: 'btn sm ghost', onclick: voiceDiscard }, 'Discard'),
      p === 'recording' ? h('button', { class: 'btn sm', onclick: voiceStop }, icon('stop', 'sm'), 'Stop')
        : h('button', { class: 'btn sm primary', disabled: p !== 'ready', onclick: voiceSend }, icon('send', 'sm'), 'Send'));
  }
  async function voiceStart() {
    if (voice.phase !== 'idle' || !S.active || !S.active.data) return;
    if (isIg(S.active.data.conv)) return toast('Voice notes can only be sent on WhatsApp', 'error');
    if (!window.isSecureContext || !navigator.mediaDevices) return toast('The microphone needs https', 'error');
    voice.phase = 'starting'; voice.started = Date.now(); voiceUi();
    try {
      await loadRecorder();
      if (!window.Recorder.isRecordingSupported()) throw new Error('voice recording is not supported in this browser');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (voice.phase !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return; }
      voice.stream = stream;
      voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const rec = new window.Recorder({ sourceNode: voice.ctx.createMediaStreamSource(stream), encoderPath: encoderPath(), numberOfChannels: 1,
        encoderSampleRate: 48000, encoderBitRate: 32000, encoderApplication: 2048, streamPages: false, monitorGain: 0 });
      rec.ondataavailable = (arr) => {
        voice.blob = new Blob([arr], { type: 'audio/ogg' });
        voice.url = URL.createObjectURL(voice.blob);
        voice.phase = 'ready'; voiceUi();
      };
      voice.rec = rec;
      await rec.start();
      voice.phase = 'recording'; voice.started = Date.now();
      voice.tick = setInterval(voiceUi, 250);
      voice.max = setTimeout(voiceStop, 5 * 60 * 1000);
      voiceUi();
    } catch (e) {
      voiceDiscard();
      toast(e.name === 'NotAllowedError' ? 'Microphone permission was refused' : `Cannot record: ${e.message}`, 'error');
    }
  }
  function voiceRelease() {
    clearInterval(voice.tick); clearTimeout(voice.max);
    if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
    if (voice.ctx) voice.ctx.close().catch(() => {});
    voice.stream = null; voice.ctx = null; voice.tick = null; voice.max = null;
  }
  async function voiceStop() {
    if (voice.phase !== 'recording') return;
    voice.phase = 'stopping'; voice.stopped = Date.now();
    voiceRelease(); voiceUi();
    if (voice.stopped - voice.started < 1000) { voiceDiscard(); return toast('Too short'); }
    try { await voice.rec.stop(); } catch (e) { voiceDiscard(); toast('Recording failed', 'error'); }
  }
  function voiceDiscard() {
    voiceRelease();
    if (voice.rec) { try { voice.rec.ondataavailable = null; voice.rec.close(); } catch (e) { /* gone */ } }
    voice.rec = null; voice.blob = null; voice.phase = 'idle';
    voiceUi();
  }
  async function voiceSend() {
    if (voice.phase !== 'ready' || !voice.blob || !S.active) return;
    const blob = voice.blob, url = voice.url;
    voice.url = null;
    voiceDiscard();
    const p = { request_id: uuid(), text: '', status: 'sending', at: now(), preview: h('audio', { src: url, controls: true }),
      media: { kind: 'voice', mime: 'audio/ogg', filename: 'voice.ogg', base64: await toB64(blob) } };
    S.active.pending.push(p);
    renderMessages(true);
    deliver(p, S.active);
  }

  // ---- quick replies (the staff's own, desk.quick_replies)

  const isAdmin = () => !!(S.me && S.me.role === 'admin');
  function openQuick() {
    if (!S.active || $('#qr')) return;
    const input = h('input', { type: 'search', placeholder: 'Search quick replies…' });
    const ul = h('ul');
    let sel = 0, items = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      items = S.canned.filter((c) => !q || `${c.title} ${c.body}`.toLowerCase().includes(q)).slice(0, 80);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      if (!S.canned.length) {
        ul.replaceChildren(h('li', { class: 'qr-empty' }, h('span', { class: 'muted' }, 'No quick replies yet.'),
          isAdmin() ? h('button', { class: 'btn sm primary', onmousedown: (e) => { e.preventDefault(); close(); openQuickManage(); } }, icon('plus', 'sm'), 'Add your own') : h('span', { class: 'muted' }, ' Ask an admin to add some.')));
        return;
      }
      ul.replaceChildren(...(items.length ? items.map((c, i) => h('li', { class: i === sel ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(c); } },
        h('b', null, c.title), h('span', null, c.body))) : [h('li', null, h('span', { class: 'muted' }, 'No quick replies match.'))]));
      const on = ul.children[sel]; if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    };
    const close = () => { box.remove(); const ta = $('#reply'); if (ta) ta.focus(); };
    const pick = (c) => {
      const ta = $('#reply');
      if (ta) { ta.value = ta.value ? ta.value.replace(/\s*$/, '\n') + c.body : c.body; autosize(ta); updateSend(); saveDraft(ta.value); }
      close();
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (items[sel]) pick(items[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.stopPropagation(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (box.isConnected) box.remove(); }, 150));
    const foot = isAdmin() && S.canned.length ? h('div', { class: 'qr-foot' }, h('button', { class: 'link', onmousedown: (e) => { e.preventDefault(); close(); openQuickManage(); } }, 'Edit quick replies')) : null;
    const box = h('div', { class: 'qr', id: 'qr' }, input, ul, foot);
    $('#composerWrap').append(box);
    draw();
    input.focus();
  }

  // Editor: add, change and delete quick replies (admins).
  function openQuickManage() {
    if (!isAdmin()) return toast('Only an admin can edit quick replies');
    const body = h('div', { class: 'sheet-body' });
    const save = async (payload, msg) => {
      try { S.canned = await api.call('quick_reply_save', payload); draw(); if (msg) toast(msg, 'ok'); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    };
    const row = (q) => {
      const isNew = !q.id;
      const title = h('input', { type: 'text', value: q.title || '', maxlength: 60, placeholder: isNew ? 'Title, e.g. ChatGPT price' : '' });
      const text = h('textarea', { rows: 3, maxlength: 4096, placeholder: isNew ? 'The message that gets inserted' : '' });
      text.value = q.body || '';
      const commit = () => {
        if (!title.value.trim() || !text.value.trim()) return toast('Write a title and a message', 'error');
        save({ id: q.id || null, title: title.value, body: text.value }, isNew ? 'Quick reply added' : 'Saved');
      };
      const changed = () => title.value !== (q.title || '') || text.value !== (q.body || '');
      const btn = h('button', { class: `btn sm ${isNew ? 'primary' : ''}`, onclick: commit }, isNew ? [icon('plus', 'sm'), 'Add'] : 'Save');
      if (!isNew) {
        btn.disabled = true;
        const upd = () => { btn.disabled = !changed(); };
        title.addEventListener('input', upd); text.addEventListener('input', upd);
      }
      return h('div', { class: `qr-row${isNew ? ' new' : ''}` }, h('div', { class: 'qr-fields' }, title, text),
        h('div', { class: 'qr-actions' }, btn,
          isNew ? null : h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete quick reply', onclick: () => { if (confirm(`Delete “${q.title}”?`)) save({ id: q.id, delete: true }, 'Deleted'); } }, icon('trash'))));
    };
    const draw = () => body.replaceChildren(
      h('p', { class: 'hint' }, 'Staff insert these with Q or by typing / in the message box. Only admins can change them.'),
      row({}),
      S.canned.length ? h('h5', null, `Your quick replies (${S.canned.length})`) : h('p', { class: 'hint' }, 'None yet: add the first one above.'),
      ...S.canned.map(row));
    draw();
    openModal(h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', null, 'Quick replies'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      body, h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', onclick: closeModal }, 'Done'))), true);
  }

  // ------------------------------------------------------------------ details

  const wide = () => innerWidth > 1180;
  const detailsOn = () => (wide() ? S.details : S.detailsNarrow);
  function toggleDetails() {
    if (wide()) { S.details = !S.details; store('desk_details2', S.details); } else S.detailsNarrow = !S.detailsNarrow;
    renderHead();
    renderDetails();
  }
  async function loadCustomer(contact) {
    if (/^ig_/.test(contact)) return;
    try {
      const ctx = await api.call('customer', { contact });
      if (S.active && S.active.contact === contact) { S.active.customer = ctx; renderDetails(); }
    } catch (e) { /* optional panel */ }
  }
  const SERVICES = { chatgpt: 'ChatGPT', chatgpt_private: 'ChatGPT private', anghami: 'Anghami', spotify: 'Spotify', canva: 'Canva', capcut: 'CapCut', gemini: 'Gemini', netflix_legacy: 'Netflix' };
  function renderDetails() {
    const pane = $('#details');
    if (!S.active || !S.active.data || !detailsOn()) { pane.hidden = true; pane._k = null; return; }
    pane.hidden = false;
    const d = S.active.data;
    const c = d.conv;
    if (same(pane, JSON.stringify([c, d.thread, d.threads, d.events.length, d.events.slice(-10), S.active.customer, S.metaVer, minute()]))) return;
    const link = isIg(c) ? (c.handle ? `https://instagram.com/${encodeURIComponent(c.handle)}` : null) : `https://wa.me/${c.contact}`;
    const head = h('div', { class: 'd-head' },
      h('button', { class: 'icon-btn d-close', 'aria-label': 'Close details', onclick: toggleDetails }, icon('x')),
      avatar(c, 'lg'), h('h3', null, displayName(c)), h('div', { class: 'muted' }, subtitle(c)),
      h('div', { class: 'd-links' },
        !isIg(c) ? h('button', { class: 'btn', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(c.contact); toast('Number copied'); } }, icon('copy', 'sm'), 'Copy') : null,
        link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('ext', 'sm'), isIg(c) ? 'Profile' : 'WhatsApp') : null));
    const secs = [head];

    const t = d.thread;
    if (t) {
      secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'System label'), h('div', null, sysBadge(t, true)),
        t.kind_reason ? h('p', { class: 'hint', style: 'margin-top:6px' }, `${t.kind_source === 'staff' ? 'Set by ' + (t.kind_by || 'staff') : t.kind_source === 'ai' ? 'AI' : 'Rule'}: ${t.kind_reason}`) : null));
    }
    const setBy = new Map();
    for (const e of d.events) if (e.kind === 'label_add' || (e.kind === 'relabel' && e.detail && e.detail.to)) setBy.set(e.kind === 'relabel' ? e.detail.to : e.label, e);
    secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'Your labels'),
      c.labels.length ? h('div', { class: 'd-labels' }, c.labels.map((id) => {
        const l = S.labelById.get(id); const e = l && setBy.get(l.name);
        return h('div', { class: 'd-label' }, labelChip(id, false), e ? h('span', { class: 'muted' }, `${e.kind === 'relabel' ? 'auto' : e.actor} · ${ago(e.at)}`) : null);
      })) : h('p', { class: 'hint' }, 'None. Use the Labels bar above the chat.')));

    const ctx = S.active.customer;
    if (ctx && !ctx.none) {
      const subs = [];
      for (const [k, name] of Object.entries(SERVICES)) {
        for (const s of ctx[k] || []) subs.push({ name, active: s.active, expiry: s.expiry, extra: s.username || s.product_name || '', bad: s.account_status && s.account_status !== 'active' ? s.account_status : null });
      }
      subs.sort((a, b) => (b.active - a.active) || (Date.parse(b.expiry || 0) - Date.parse(a.expiry || 0)));
      secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'Subscriptions'),
        subs.length ? h('div', { class: 'd-subs' }, subs.slice(0, 8).map((s) => h('div', { class: 'd-sub' },
          h('span', null, h('b', null, s.name), s.extra ? h('span', { class: 'muted' }, ` · ${s.extra}`) : null, s.bad ? h('span', { class: 'bad' }, ` · account ${s.bad}`) : null),
          h('span', { class: s.active ? 'ok' : 'old' }, s.expiry ? `${s.active ? 'until' : 'ended'} ${fmtDate.format(new Date(String(s.expiry).replace(' ', 'T') + (/[zZ+]/.test(String(s.expiry).slice(10)) ? '' : 'Z')))}` : (s.active ? 'active' : 'ended')))))
          : h('p', { class: 'hint' }, 'No subscriptions on this number.'),
        ctx.renewals_pending ? h('p', { class: 'hint', style: 'margin-top:8px' }, `${ctx.renewals_pending} unpaid renewal${ctx.renewals_pending > 1 ? 's' : ''}`) : null));
    } else if (isIg(c)) {
      secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'Subscriptions'), h('p', { class: 'hint' }, 'Instagram chats have no phone number: ask for their WhatsApp number to see subscriptions.')));
    }
    if ((d.threads || []).length) {
      secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'Episodes'), h('div', { class: 'd-act' }, d.threads.map((x) => h('div', null,
        h('span', null, h('span', { class: `dotk k-${x.kind}` }), `${x.kind === 'pending' || x.kind === 'unsure' ? 'unlabelled' : x.kind}${x.product ? ' · ' + (PRODUCTS[x.product] || x.product) : ''}${x.status === 'resolved' ? ` · resolved${x.resolved_by ? ' by ' + x.resolved_by : ''}` : x.status === 'open' ? ' · open' : ''}`),
        h('span', { class: 't' }, fmtDate.format(new Date(x.opened_at))))))));
    }
    const evs = d.events.slice(-10).reverse();
    secs.push(h('div', { class: 'd-sec' }, h('h4', null, 'Activity'),
      evs.length ? h('div', { class: 'd-act' }, evs.map((e) => { const l = eventLine(e); return l ? h('div', null, h('span', null, l.textContent.replace(/\s\d\d:\d\d$/, '')), h('span', { class: 't' }, ago(e.at))) : null; }))
        : h('p', { class: 'hint' }, 'Nothing yet.')));
    pane.replaceChildren(...secs);
  }

  // ------------------------------------------------------------------ manage labels & views (admin)

  const PALETTE = ['#e11d48', '#f97316', '#d97706', '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#c026d3', '#db2777', '#64748b', '#334155'];
  function openManage() {
    const body = h('div', { class: 'sheet-body' });
    const draw = () => {
      const rows = S.labels.map((l) => labelRow(l));
      const newRow = labelRow({ id: null, name: '', color: PALETTE[(S.labels.length * 3) % PALETTE.length], grp: '', on_new_msg: 'keep', switch_to: null });
      body.replaceChildren(
        h('h5', null, 'Your labels'),
        h('p', { class: 'hint' }, 'These are set by hand. (Sales / support are system labels, set automatically, and are not managed here.) Labels in the same group replace each other (h-complete ↔ h-uncomplete). “When the customer writes” runs on every new customer message after the label was set.'),
        h('div', { class: 'col-heads' }, h('span', null, ''), h('span', null, 'Name'), h('span', null, 'Group'), h('span', null, 'When the customer writes'), h('span', null, ''), h('span', null, '')),
        ...rows, newRow,
        h('h5', null, 'Views'),
        h('p', { class: 'hint' }, 'A view shows every chat that has one of its labels, plus unread chats if you tick it.'),
        ...S.views.map((v) => viewRow(v)),
        viewRow({ id: null, name: '', label_ids: [], include_unread: false }));
    };
    async function save(op, payload, okMsg) {
      try {
        const meta = await api.call(op, payload);
        setMeta(meta);
        draw(); renderNav();
        if (S.active && S.active.data) renderLabelbar();
        refreshList();
        if (okMsg) toast(okMsg);
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
    function labelRow(l) {
      const isNew = !l.id;
      const st = { color: l.color };
      const name = h('input', { type: 'text', value: l.name, placeholder: isNew ? 'New label, e.g. $-paid' : '', maxlength: 40 });
      const grp = h('input', { type: 'text', value: l.grp || '', placeholder: 'none', maxlength: 20, title: 'Labels with the same group replace each other' });
      const rule = h('select', null,
        h('option', { value: 'keep', selected: l.on_new_msg === 'keep' }, 'Keep the label'),
        h('option', { value: 'remove', selected: l.on_new_msg === 'remove' }, 'Remove it'),
        h('option', { value: 'switch', selected: l.on_new_msg === 'switch' }, 'Switch to…'));
      const to = h('select', { hidden: l.on_new_msg !== 'switch' }, S.labels.filter((x) => x.id !== l.id).map((x) => h('option', { value: x.id, selected: x.id === l.switch_to }, x.name)));
      const sw = h('button', { type: 'button', class: 'swatch-btn', style: `background:${st.color}`, title: 'Color', onclick: (e) => pickColor(e.currentTarget, (c) => { st.color = c; sw.style.background = c; if (!isNew) commit(); }) });
      const payload = () => ({ id: l.id, name: name.value, color: st.color, grp: grp.value, on_new_msg: rule.value, switch_to: rule.value === 'switch' ? Number(to.value) : null });
      const commit = () => { if (name.value.trim()) save('save_label', payload(), isNew ? 'Label added' : null); };
      name.addEventListener('input', () => { if (isNew && !grp.dataset.touched) { const m = name.value.match(/^\s*([^-\s]{1,6})-/); grp.value = m ? m[1] : ''; } });
      grp.addEventListener('input', () => { grp.dataset.touched = '1'; });
      if (!isNew) { name.addEventListener('change', commit); grp.addEventListener('change', commit); to.addEventListener('change', commit); }
      rule.addEventListener('change', () => { to.hidden = rule.value !== 'switch'; if (!isNew && (rule.value !== 'switch' || to.value)) commit(); });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      return h('div', { class: 'lab-row' }, sw, name, grp, h('div', { class: 'rule' }, rule, to),
        isNew ? null : h('button', { class: 'icon-btn del', title: 'Remove this label from every chat (the label stays)', 'aria-label': 'Remove from every chat', onclick: async () => {
          const n = (S.counts.labels || {})[l.id] || 0;
          if (!n) return toast(`No chat has ${l.name}`);
          if (!confirm(`Remove “${l.name}” from all ${n} chat${n > 1 ? 's' : ''}? The label itself stays.`)) return;
          try { const r = await api.call('label_clear', { label_id: l.id }); toast(`Removed from ${r.removed} chats`); refreshList(); if (S.active) pollChat(); } catch (e) { toast(e.message, 'error'); }
        } }, '⌫'),
        isNew ? h('button', { class: 'icon-btn del', title: 'Add label', 'aria-label': 'Add label', onclick: commit }, icon('plus'))
          : h('button', { class: 'icon-btn del', title: 'Delete label', 'aria-label': 'Delete label', onclick: () => {
            const n = (S.counts.labels || {})[l.id] || 0;
            if (confirm(`Delete “${l.name}”?${n ? ` It is on ${n} chat${n > 1 ? 's' : ''}; they lose it.` : ''}`)) save('save_label', { id: l.id, delete: true }, 'Label deleted');
          } }, icon('trash')));
    }
    function viewRow(v) {
      const isNew = !v.id;
      const ids = new Set(v.label_ids);
      const name = h('input', { type: 'text', value: v.name, placeholder: isNew ? 'New view name' : '', maxlength: 30 });
      const unread = h('input', { type: 'checkbox', checked: v.include_unread });
      const payload = () => ({ id: v.id, name: name.value, label_ids: [...ids], include_unread: unread.checked });
      const commit = () => { if (name.value.trim()) save('save_view', payload(), isNew ? 'View added' : null); };
      const pick = h('div', { class: 'pick' }, S.labels.map((l) => {
        const b = h('button', { type: 'button', class: `lt${ids.has(l.id) ? ' on' : ''}`, style: `--c:${l.color}`, onclick: () => {
          if (ids.has(l.id)) ids.delete(l.id); else ids.add(l.id);
          b.classList.toggle('on', ids.has(l.id));
          if (!isNew) commit();
        } }, l.name);
        return b;
      }));
      if (!isNew) { name.addEventListener('change', commit); unread.addEventListener('change', commit); }
      return h('div', { class: 'view-row' },
        h('div', { class: 'view-row-top' }, name, h('label', { class: 'toggle' }, unread, '+ all unread'),
          isNew ? h('button', { class: 'btn', onclick: commit }, icon('plus', 'sm'), 'Add')
            : h('button', { class: 'icon-btn', title: 'Delete view', 'aria-label': 'Delete view', onclick: () => { if (confirm(`Delete the view “${v.name}”?`)) save('save_view', { id: v.id, delete: true }, 'View deleted'); } }, icon('trash'))),
        pick);
    }
    draw();
    openModal(h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', null, 'Labels & views'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      body,
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', onclick: closeModal }, 'Done'))), true);
  }
  function pickColor(anchor, done) {
    document.querySelectorAll('.pop').forEach((p) => p.remove());
    const r = anchor.getBoundingClientRect();
    const pop = h('div', { class: 'pop', style: `left:${Math.min(r.left, innerWidth - 200)}px;top:${r.bottom + 6}px` },
      h('div', { class: 'palette' }, PALETTE.map((c) => h('button', { type: 'button', style: `background:${c}`, 'aria-label': c, onclick: () => { done(c); pop.remove(); } }))));
    document.body.append(pop);
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); } }), 0);
  }

  // ------------------------------------------------------------------ modal

  let modalClosable = true;
  function openModal(content, closable = true) {
    modalClosable = closable;
    const m = $('#modal');
    m.replaceChildren(content);
    m.hidden = false;
    m.onclick = (e) => { if (e.target === m && modalClosable) closeModal(); };
    const f = content.querySelector('input:not([type=radio]),button');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal() { $('#modal').hidden = true; $('#modal').replaceChildren(); document.querySelectorAll('.pop').forEach((p) => p.remove()); }

  // ------------------------------------------------------------------ wiring

  function bindUi() {
    $('#manageBtn').replaceChildren(icon('sliders', 'sm'));
    $('#manageBtn').onclick = openManage;
    $('#menuBtn').replaceChildren(icon('menu'));
    $('#menuBtn').onclick = () => { $('#app').classList.add('side-open'); $('#scrim').hidden = false; };
    $('#scrim').onclick = () => { $('#app').classList.remove('side-open'); $('#scrim').hidden = true; };
    $('.search-ic').replaceChildren(icon('search', 'sm'));
    $('#staffBtn').onclick = openAccount;
    $('#bellBtn').onclick = async () => {
      S.notify = !S.notify;
      if (S.notify && window.Notification && Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
      store('desk_notify', S.notify); renderStaff();
      toast(S.notify ? 'Alerts on' : 'Alerts off');
    };
    $('#themeBtn').onclick = () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      store('desk_theme', next);
      applyTheme(next);
    };
    applyTheme(store('desk_theme'));
    renderStaff();
    $('#helpBtn').replaceChildren(icon('help'));
    $('#helpBtn').onclick = openHelp;
    let qTimer;
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && S.chats[0]) { e.preventDefault(); e.target.blur(); openChat(S.chats[0].contact); }
    });
    $('#search').addEventListener('input', (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { S.q = e.target.value.trim(); refreshList(true); }, 250);
    });
    const list = $('#list');
    // one listener for every row (rows are reused across polls)
    list.addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r && r.dataset.contact) openChat(r.dataset.contact); });
    // the "waiting for 2h 10m" tooltip of a red dot is refreshed when hovered (rows are not
    // rebuilt every minute just for that text)
    list.addEventListener('pointerover', (e) => {
      const dot = e.target.closest && e.target.closest('.badge-n.late');
      const r = dot && dot.closest('.row');
      const c = r && S.chats.find((x) => x.contact === r.dataset.contact);
      if (c && c.last_in_at) dot.title = `Unsolved · customer last wrote ${dur(now() - Date.parse(c.last_in_at))} ago`;
    });
    list.addEventListener('pointerenter', () => { S.listHover = true; });
    list.addEventListener('pointerleave', () => { S.listHover = false; });
    let moreQueued = false;
    list.addEventListener('scroll', () => {
      S.listScrollAt = Date.now();
      if (moreQueued) return;
      moreQueued = true;
      requestAnimationFrame(() => { moreQueued = false; if (list.scrollHeight - list.scrollTop - list.clientHeight < 300) loadMore(); });
    }, { passive: true });
    $('#chat').replaceChildren(...emptyChat());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshList(false, true); loopList();
        if (S.active && S.active.data) { pollChat(); if (S.active.data.conv.unread) markRead(S.active.contact); }
      }
    });
    // waiting timers / "x min left" (both re-render only when their minute changed)
    setInterval(() => { if (S.active && S.active.data && !document.hidden) { renderHead(); renderSysbar(); } }, 30000);
    document.addEventListener('keydown', onKey);
  }

  function moveChat(dir) {
    if (!S.chats.length) return;
    const i = S.active ? S.chats.findIndex((x) => x.contact === S.active.contact) : -1;
    const next = S.chats[Math.max(0, Math.min(S.chats.length - 1, i < 0 ? 0 : i + dir))];
    if (next) { openChat(next.contact); scrollRowIntoView(next.contact); }
  }
  function focusSearch() { const el = $('#search'); el.focus(); el.select(); }
  function focusReply() { const ta = $('#reply'); if (ta && !ta.closest('[hidden]')) ta.focus(); else if (S.active) toast('The reply window is closed for this chat'); }
  function setKindKey(kind) {
    const t = S.active && S.active.data && S.active.data.thread;
    if (!t) return toast('No conversation episode to label');
    if (t.kind === kind) return toast(`Already ${kind}`);
    setKind(t, kind);
  }
  function onKey(e) {
    const el = document.activeElement;
    const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const modalOpen = !$('#modal').hidden;
    const popOpen = document.querySelector('.label-pop');

    // undo bar first
    if (pending && !typing && !modalOpen) {
      if (k === 'z' || k === 'Z') { e.preventDefault(); cancelPending(); return; } // only Z undoes (Esc just closes)
      if (k === 'Enter' && !S.active) { e.preventDefault(); flushPending(); return; }
    }
    if (k === 'Escape') {
      if (modalOpen) { if (modalClosable) closeModal(); return; }
      if (document.querySelector('.lightbox')) { document.querySelector('.lightbox').remove(); return; }
      if (popOpen) { popOpen.remove(); return; }
      if (typing) { el.blur(); return; }
      if (S.active) closeChat();
      return;
    }
    if (modalOpen) return;

    // BSB combinations (work even while typing)
    if (ctrl && !e.shiftKey && (k === 'k' || k === 'K')) { e.preventDefault(); focusSearch(); return; }
    if (ctrl && !e.shiftKey && (k === 'm' || k === 'M')) { e.preventDefault(); focusReply(); return; }
    if (ctrl && e.shiftKey && (k === 'E' || k === 'e')) { e.preventDefault(); completeChat(); return; }
    if (ctrl && e.shiftKey && (k === 'U' || k === 'u')) { e.preventDefault(); markUnreadAndLeave(); return; }
    if (ctrl && e.shiftKey && (k === 'L' || k === 'l')) { e.preventDefault(); openLabelPicker(); return; }
    if (ctrl && e.shiftKey && (k === '[' || k === '{')) { e.preventDefault(); moveChat(-1); return; }
    if (ctrl && e.shiftKey && (k === ']' || k === '}')) { e.preventDefault(); moveChat(1); return; }
    if (e.altKey && (k === 'ArrowDown' || k === 'ArrowUp')) { e.preventDefault(); moveChat(k === 'ArrowDown' ? 1 : -1); return; }
    if (e.altKey && /^[1-9]$/.test(k) && S.active) {
      const l = S.labels[Number(k) - 1];
      if (l) { e.preventDefault(); toggleLabel(l.id); }
      return;
    }
    if (typing || ctrl || e.altKey) return;
    if (popOpen) return;

    switch (k) {
      case 'j': case 'ArrowDown': e.preventDefault(); moveChat(1); return;
      case 'k': case 'ArrowUp': e.preventDefault(); moveChat(-1); return;
      case 'Tab': e.preventDefault(); moveChat(e.shiftKey ? -1 : 1); return;
      case 'Enter': if (pending) { e.preventDefault(); flushPending(); return; } if (S.active) { e.preventDefault(); focusReply(); } return;
      case 'r': case 'R': if (S.active) { e.preventDefault(); focusReply(); } return;
      case 'v': if (S.active) { e.preventDefault(); completeChat(); } return;
      case 'V': if (S.active) { e.preventDefault(); completeChat(); } return;
      case 'u': case 'U': if (S.active) { e.preventDefault(); markUnreadAndLeave(); } return;
      case 'l': case 'L': if (S.active) { e.preventDefault(); openLabelPicker(); } return;
      case 's': case 'S': if (S.active) { e.preventDefault(); setKindKey('sales'); } return;
      case 'h': case 'H': if (S.active) { e.preventDefault(); setKindKey('support'); } return;
      case 'x': case 'X': if (S.active) { e.preventDefault(); setKindKey('ignore'); } return;
      case 'q': case 'Q': if (S.active) { e.preventDefault(); openQuick(); } return;
      case 'c': case 'C': if (S.active) { e.preventDefault(); toggleDetails(); } return;
      case 'n': case 'N': if (S.active) { e.preventDefault(); copyNumber(); } return;
      case '/': case 'f': case 'F': e.preventDefault(); focusSearch(); return;
      case '?': case 'i': case 'I': e.preventDefault(); openHelp(); return;
      default:
        if (/^[1-9]$/.test(k) && MAIN_VIEWS[Number(k) - 1]) { e.preventDefault(); setView(MAIN_VIEWS[Number(k) - 1][0]); }
    }
  }

  start();
})();
