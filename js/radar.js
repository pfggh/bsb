// js/radar.js — the owner's review queue (the "Radar" tab of the Team panel).
// Every finished chat waits here, except chats the customer clearly thanked us for or confirmed (Disqualified).
// Keys match the desk: J/K move, V fine, C back to Unresolved, Z undo, O open the chat.
(function () {
  'use strict';
  const UNDO_MS = 5000, POLL_MS = 30000;
  let U, redraw, leave, getRoot;
  const st = { data: null, error: '', list: 'items', sel: null, pending: null, chats: new Map(), timer: null, active: false };
  const h = (...a) => U.h(...a);
  const keyOf = (c) => `${c.contact}|${c.basis_at}`;
  const nameOf = (c) => (c.name && /[\p{L}\p{N}]/u.test(c.name) ? c.name : c.handle ? '@' + c.handle : /^\d+$/.test(c.contact) ? '+' + c.contact : 'Instagram user');
  const when = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const rows = () => (st.data ? st.data[st.list] || [] : []).filter((c) => !st.pending || keyOf(c) !== keyOf(st.pending.c));
  const draw = () => { if (st.active) redraw(); };

  async function load() {
    try { st.data = await U.api.call('radar'); st.error = ''; } catch (e) { st.error = e.message || 'Could not load'; }
    draw();
  }
  function chatOf(c) {
    let e = st.chats.get(c.contact);
    if (e && e.key === c.basis_at) return e;
    e = { key: c.basis_at, loading: true };
    st.chats.set(c.contact, e);
    if (st.chats.size > 30) st.chats.delete(st.chats.keys().next().value);
    U.api.call('chat', { contact: c.contact, limit: 40 }).then((d) => { e.data = d; }, (err) => { e.error = err.message; })
      .finally(() => { e.loading = false; draw(); });
    return e;
  }
  function select(c) { st.sel = c ? keyOf(c) : null; draw(); }
  function move(dir) {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((c) => keyOf(c) === st.sel);
    select(list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + dir))]);
  }
  function flush() {
    const p = st.pending;
    if (!p) return;
    st.pending = null;
    clearTimeout(p.timer); p.bar.remove();
    U.api.call('radar_answer', { contact: p.c.contact, basis_at: p.c.basis_at, answer: p.value })
      .then((r) => { for (const k of ['items', 'disqualified']) if (st.data) st.data[k] = st.data[k].filter((c) => keyOf(c) !== keyOf(p.c)); draw(); return r; })
      .catch((e) => { U.toast(`Not saved: ${e.message}`, 'error'); load(); });
  }
  function undo() {
    const p = st.pending;
    if (!p) return;
    st.pending = null;
    clearTimeout(p.timer); p.bar.remove();
    select(p.c);
  }
  function answer(c, value) {
    if (!c) return;
    flush();
    const list = rows();
    const i = list.findIndex((x) => keyOf(x) === keyOf(c));
    const next = list[i + 1] || list[i - 1] || null;
    const text = value === 'back' ? [h('b', null, nameOf(c)), ' goes back to Unresolved'] : [h('b', null, nameOf(c)), ' is fine'];
    const bar = h('div', { class: 'undo tm-undo', role: 'status' },
      h('div', { class: 'undo-bar' }, h('div', { class: 'undo-text' }, h('div', null, text)), h('button', { class: 'btn sm', onclick: undo }, 'Undo', h('kbd', null, 'Z'))),
      h('div', { class: 'undo-progress' }, h('i', { style: `animation-duration:${UNDO_MS}ms` })));
    getRoot().append(bar);
    st.pending = { c, value, bar, timer: setTimeout(flush, UNDO_MS) };
    select(next);
  }
  function open(c) { if (!c) return; flush(); leave(); U.openChat(c.contact); }

  function bubble(m) {
    const mine = !/^in/i.test(String(m.dir || ''));
    const kids = [];
    const text = String(m.text || '').replace(/^🎤 \*Voice Message\*$|^📎 \*Media Received\*$/u, '').trim();
    const type = String(m.media_type || '').replace(/^instagram_/, '');
    const url = typeof m.media === 'string' && /^https:\/\//.test(m.media) ? m.media : null;
    const noType = !type || /^none$/i.test(type);
    if (mine && noType && (!text || text === '[Outgoing Message]')) kids.push(h('em', null, 'Reply sent from the BSB phone app (text not visible here)'));
    else if (text) kids.push(h('span', { dir: 'auto' }, text));
    if (/image/i.test(type) && url) kids.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: url, alt: 'Photo', loading: 'lazy' })));
    else if (/audio|voice/i.test(type)) kids.push(url ? h('audio', { src: url, controls: true, preload: 'none' }) : h('em', null, 'Voice note'));
    else if (!noType && !/^(text|reaction)$/i.test(type)) kids.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${type}`) : h('em', null, `[${type}]`));
    if (!kids.length) kids.push(h('em', null, '[empty]'));
    return h('div', { class: `tm-b ${mine ? 'out' : 'in'}` }, kids, h('span', { class: 'tm-b-t' }, `${mine ? (m.by || 'Staff') + ' · ' : ''}${when(m.ts)}`));
  }
  function row(c) {
    const done = st.list === 'disqualified';
    return h('li', { class: `tm-rv-row${keyOf(c) === st.sel ? ' on' : ''}`, dataset: { id: keyOf(c) }, onclick: () => select(c) },
      h('span', { class: `tm-dot ${done ? 'ok' : c.waiting ? 'bad' : 'warn'}` }),
      h('div', { class: 'tm-rv-main' },
        h('div', { class: 'tm-rv-top' }, h('b', null, nameOf(c)), h('span', { class: 'muted' }, when(c.solved_at || c.basis_at))),
        h('div', { class: 'tm-rv-sub' }, c.waiting && !done ? h('span', { class: 'tm-chip bad' }, 'Customer waiting') : null, c.actor ? h('span', { class: 'tm-rv-who' }, ` ${c.actor}`) : null, c.kind ? ` · ${c.kind}` : ''),
        h('div', { class: 'tm-rv-why' }, done ? `“${c.quote || 'Thanks'}”` : c.reason || 'Not checked yet')));
  }
  function detail(c) {
    if (!c) return h('div', { class: 'tm-rv-empty' }, h('div', { class: 'empty-big' }, '✓'), h('b', null, st.list === 'items' ? 'Nothing left to review' : 'No disqualified chats'));
    const e = chatOf(c);
    const sends = e.data && e.data.sends ? e.data.sends.map((s) => ({ dir: 'Outgoing', ts: s.at, text: s.body || s.text || '', by: s.by, media_type: s.media ? s.media.type : null, media: s.media ? s.media.url : null })) : [];
    const msgs = [...(e.data && e.data.messages ? e.data.messages : []), ...sends].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const done = st.list === 'disqualified';
    return h('div', { class: 'tm-rv-detail' },
      h('div', { class: 'tm-rv-head' }, h('div', null, h('h3', null, nameOf(c)), h('span', { class: 'muted' }, c.actor ? `Marked finished by ${c.actor} · ${when(c.solved_at)}` : `Last message ${when(c.basis_at)}`))),
      h('div', { class: 'tm-rv-scroll', dataset: { key: `${keyOf(c)}|${msgs.length}` } },
        h('div', { class: `tm-verdict ${done ? 'ok' : 'warn'}` }, h('p', { class: 'tm-sum' }, done ? 'Disqualified: the customer confirmed and nothing is open.' : `Kept for you: ${c.reason || 'not checked yet'}.`),
          c.quote ? h('blockquote', { class: 'tm-fc-q', dir: 'auto' }, h('span', null, 'The customer said'), c.quote) : null),
        h('div', { class: 'tm-thread' }, e.error ? h('div', { class: 'tm-markline quiet' }, h('span', null, `Could not load the conversation: ${e.error}`))
          : e.loading && !msgs.length ? h('div', { class: 'tm-markline quiet' }, h('span', null, 'Loading the conversation…')) : msgs.map(bubble))),
      h('div', { class: 'tm-rv-foot' },
        h('div', { class: 'tm-rv-nav' }, h('button', { class: 'btn sm ghost', onclick: () => open(c) }, h('kbd', null, 'O'), 'Open chat')),
        h('div', { class: 'tm-rv-act' },
          done ? null : h('button', { class: 'btn fine', onclick: () => answer(c, 'fine') }, h('kbd', null, 'V'), 'It’s fine'),
          h('button', { class: 'btn unsolve', onclick: () => answer(c, 'back') }, h('kbd', null, 'C'), 'Back to Unresolved'))));
  }
  function view() {
    if (!st.data) return h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load Radar.'), h('div', null, st.error), h('button', { class: 'btn', onclick: load }, 'Try again')] : 'Loading…');
    const list = rows();
    if (!list.some((c) => keyOf(c) === st.sel)) st.sel = list.length ? keyOf(list[0]) : null;
    const cur = list.find((c) => keyOf(c) === st.sel) || null;
    if (cur) { const n = list[list.indexOf(cur) + 1]; if (n) chatOf(n); }
    const tab = (k, label, n) => h('button', { class: `tm-tab${st.list === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.list === k), onclick: () => { st.list = k; st.sel = null; draw(); } }, label, h('span', null, String(n)));
    return h('div', { class: 'tm-review' },
      h('div', { class: 'tm-rv-bar' },
        h('div', { class: 'tm-filter', role: 'tablist' }, tab('items', 'To review', st.data.items.length), tab('disqualified', 'Disqualified', st.data.disqualified.length)),
        st.data.settling ? h('span', { class: 'muted' }, `${st.data.settling} still being checked`) : null),
      h('div', { class: 'tm-rv-cols' }, h('ul', { class: 'tm-rv-list', 'aria-label': 'Chats' }, list.length ? list.slice(0, 500).map(row) : h('li', { class: 'tm-rv-none' }, 'Nothing here.')), detail(cur)),
      h('div', { class: 'tm-rv-keys muted' }, h('kbd', null, 'J'), h('kbd', null, 'K'), ' move  ', h('kbd', null, 'V'), ' it’s fine  ', h('kbd', null, 'C'), ' back to Unresolved  ', h('kbd', null, 'Z'), ' undo  ', h('kbd', null, 'O'), ' open chat  ', h('kbd', null, 'Esc'), ' back to chats'));
  }
  function key(e) {
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const cur = rows().find((c) => keyOf(c) === st.sel);
    switch (e.key.toLowerCase()) {
      case 'j': case 'arrowdown': move(1); return true;
      case 'k': case 'arrowup': move(-1); return true;
      case 'v': if (st.list === 'items') answer(cur, 'fine'); return true;
      case 'c': answer(cur, 'back'); return true;
      case 'z': undo(); return true;
      case 'o': case 'enter': open(cur); return true;
      default: return false;
    }
  }
  function start(ctx) {
    U = ctx.U; redraw = ctx.draw; leave = ctx.close; getRoot = ctx.root; st.active = true;
    load();
    clearInterval(st.timer);
    st.timer = setInterval(() => { if (!document.hidden && !st.pending) load(); }, POLL_MS);
  }
  function stop() { st.active = false; clearInterval(st.timer); flush(); }
  const count = () => (st.data ? st.data.items.filter((c) => !st.pending || keyOf(c) !== keyOf(st.pending.c)).length : 0);
  window.DeskRadar = { start, stop, view, key, count };
})();
