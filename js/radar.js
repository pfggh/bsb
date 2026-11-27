// js/radar.js — Radar: finished chats of the last 24 hours, for everyone to look over (own page since 2026-11-27,
// sidebar "Radar"; before that it was an admin-only tab of Team & quality).
// The AI removes only chats the customer clearly thanked us for or confirmed (Disqualified). Everything else waits here.
// Support and Sales are kept apart (Tab switches). Keys: J/K move, V, C back to Unresolved, Z undo, O open, 1/2/3 lists.
//   V for an admin    = Good: gone from Radar for everyone, counts as reviewed in the quality numbers.
//   V for an employee = Checked: gone from THAT person's Radar only; nothing else changes.
//   C for anyone      = send back: the chat reopens in Unresolved and has to be answered before it can be solved.
(function () {
  'use strict';
  const UNDO_MS = 5000, POLL_MS = 30000, TZ = 'Asia/Beirut';
  const KINDS = [['support', 'Support'], ['sales', 'Sales']];
  const LISTS = [['review', 'To review'], ['waiting', 'Customer waiting'], ['disqualified', 'Disqualified']];
  const REASONS = {
    "We sent something after the customer's last message": 'We replied last, no confirmation',
    'No thanks or confirmation from the customer': 'Customer never confirmed',
    "The customer's last message includes media": 'Ended with a photo or voice note',
    "The customer's last message has no words": 'Ended with a photo or voice note',
    "The customer's last words are not a clear thanks": 'Unclear ending',
    'The thanks may not be about the result': 'Thanks may not mean solved',
    'The AI was not fully certain': 'AI was not certain',
    'Nobody on our side had replied before': 'We never replied',
    'The customer has not written': 'Customer never wrote',
    'The AI check found a possible problem': 'AI spotted a possible problem',
    'Something the customer needed may not be done': 'Something may be unfinished',
    'Something may still be pending': 'Something may be pending',
  };
  let U = null, root = null;
  const st = { data: null, error: '', kind: 'support', list: 'review', person: '', sel: null, pending: null, chats: new Map(), timer: null, loading: false };
  const h = (...a) => U.h(...a);
  const isAdmin = () => !!(U && U.me && U.me.role === 'admin');
  const keyOf = (c) => `${c.contact}|${c.basis_at}`;
  const kindOf = (c) => (c.kind === 'sales' ? 'sales' : 'support');   // chats with no mark (hidden from the team) count as support
  const nameOf = (c) => (c.name && /[\p{L}\p{N}]/u.test(c.name) ? c.name : c.handle ? '@' + c.handle : /^\d+$/.test(c.contact) ? '+' + c.contact : /^tt_/.test(c.contact) ? 'TikTok user' : 'Instagram user');
  const reasonOf = (c) => REASONS[c.reason] || c.reason || 'Not checked yet';
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  const since = (ts) => {
    const m = Math.max(0, Math.round((U.now() - Date.parse(ts)) / 60000));
    return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
  };
  const dayLabel = (ts) => {
    const d = fDay.format(new Date(ts));
    if (d === fDay.format(new Date(U.now()))) return 'Today';
    if (d === fDay.format(new Date(U.now() - 86400000))) return 'Yesterday';
    return fLong.format(new Date(ts));
  };
  const live = (c) => !st.pending || keyOf(c) !== keyOf(st.pending.c);
  const inList = (name, kind = st.kind) => {
    if (!st.data) return [];
    const all = (name === 'disqualified' ? st.data.disqualified : st.data.items).filter((c) => kindOf(c) === kind);
    return (name === 'waiting' ? all.filter((c) => c.waiting) : all).filter(live);
  };
  const rows = () => inList(st.list).filter((c) => !st.person || c.actor === st.person);
  // the sidebar number: everything still to review, both kinds
  const openCount = () => (st.data ? st.data.items.filter(live).length : null);
  const tellCount = () => { const n = openCount(); if (n != null && U && U.onCount) U.onCount(n); };

  async function load() {
    st.loading = true; draw();
    try { st.data = await U.api.call('radar'); st.error = ''; } catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    tellCount();
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
  function setList(name) { st.list = name; st.sel = null; draw(); }
  function setKind(kind) { st.kind = kind; st.person = ''; st.sel = null; draw(); }
  function flush() {
    const p = st.pending;
    if (!p) return;
    st.pending = null;
    clearTimeout(p.timer); p.bar.remove();
    U.api.call('radar_answer', { contact: p.c.contact, basis_at: p.c.basis_at, answer: p.value })
      .then(() => {
        if (st.data) {
          for (const k of ['items', 'disqualified']) st.data[k] = st.data[k].filter((c) => keyOf(c) !== keyOf(p.c));
          st.data.reviewed_today = (st.data.reviewed_today || 0) + 1;
        }
        tellCount();
        draw();
      })
      .catch((e) => { U.toast(`Not saved: ${e.message}`, 'error'); if (root) load(); });
  }
  function undo() {
    const p = st.pending;
    if (!p) return;
    st.pending = null;
    clearTimeout(p.timer); p.bar.remove();
    select(p.c);
  }
  function answer(c, value) {
    if (!c || !root) return;
    flush();
    const list = rows();
    const i = list.findIndex((x) => keyOf(x) === keyOf(c));
    const next = list[i + 1] || list[i - 1] || null;
    const text = value === 'back' ? [h('b', null, nameOf(c)), ' goes back to Unresolved']
      : value === 'checked' ? [h('b', null, nameOf(c)), ' checked: hidden from your Radar'] : [h('b', null, nameOf(c)), ' is good'];
    const bar = h('div', { class: 'undo tm-undo', role: 'status' },
      h('div', { class: 'undo-bar' }, h('div', { class: 'undo-text' }, h('div', null, text)), h('button', { class: 'btn sm', onclick: undo }, 'Undo', h('kbd', null, 'Z'))),
      h('div', { class: 'undo-progress' }, h('i', { style: `animation-duration:${UNDO_MS}ms` })));
    root.append(bar);
    st.pending = { c, value, bar, timer: setTimeout(flush, UNDO_MS) };
    select(next);
  }
  // V: an admin's V says the chat is good; an employee's V only marks it checked for themselves
  const vAnswer = () => (isAdmin() ? 'fine' : 'checked');
  const vAllowed = () => !(isAdmin() && st.list === 'disqualified');
  function openChat(c) { if (!c) return; flush(); close(); U.openChat(c.contact); }

  function bubble(m) {
    const mine = !/^in/i.test(String(m.dir || ''));
    const raw = String(m.text || '');
    const type = String(m.media_type || '').replace(/^(instagram|tiktok)_/, '');
    const reaction = /^reaction$/i.test(type) || /Reaction Received/.test(raw);
    if (reaction) return h('div', { class: `rd-react ${mine ? 'out' : 'in'}` }, `Reacted ${(raw.match(/Reaction Received\*:\s*(\S+)/) || [])[1] || ''}`, h('span', null, fTime.format(new Date(m.ts))));
    const kids = [];
    const text = raw.replace(/^🎤 \*Voice Message\*$|^📎 \*Media Received\*$/u, '').trim();
    const url = typeof m.media === 'string' && /^https:\/\//.test(m.media) ? m.media : null;
    const noType = !type || /^none$/i.test(type);
    if (mine && noType && (!text || text === '[Outgoing Message]')) kids.push(h('em', null, 'Sent from the BSB app (text not visible)'));
    else if (text) kids.push(h('span', { dir: 'auto' }, text));
    if (/image/i.test(type) && url) kids.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: url, alt: 'Photo sent in the chat', loading: 'lazy' })));
    else if (/audio|voice/i.test(type)) kids.push(url ? h('audio', { src: url, controls: true, preload: 'none' }) : h('em', null, 'Voice note'));
    else if (!noType && !/^text$/i.test(type)) kids.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${type}`) : h('em', null, `[${type}]`));
    if (!kids.length) kids.push(h('em', null, '[empty]'));
    return h('div', { class: `tm-b ${mine ? 'out' : 'in'}` }, kids, h('span', { class: 'tm-b-t' }, `${mine && m.by ? m.by + ' · ' : ''}${fTime.format(new Date(m.ts))}`));
  }
  function timeline(data) {
    const sends = (data.sends || []).map((s) => ({ dir: 'Outgoing', ts: s.at, text: s.body || s.text || '', by: s.by, media_type: s.media ? s.media.type : null, media: s.media ? s.media.url : null }));
    const msgs = [...(data.messages || []), ...sends];
    const first = msgs.reduce((t, m) => Math.min(t, Date.parse(m.ts)), Infinity);
    const items = msgs.map((m) => ({ ts: Date.parse(m.ts), el: bubble(m) }));
    for (const e of data.events || []) {
      const ts = Date.parse(e.at);
      if (!(ts >= first)) continue;
      const sales = e.detail && e.detail.kind === 'sales';
      if (e.kind === 'resolved') items.push({ ts, el: h('div', { class: 'tm-markline' }, `${e.actor} marked it ${sales ? 'complete' : 'solved'} · ${fTime.format(new Date(ts))}`) });
      else if (e.kind === 'reopened') items.push({ ts, el: h('div', { class: 'tm-markline quiet' }, `${e.actor === 'customer' ? 'The customer wrote again' : `${e.actor} reopened it`} · ${fTime.format(new Date(ts))}`) });
    }
    items.sort((a, b) => a.ts - b.ts);
    const out = [];
    let day = '';
    for (const it of items) {
      const d = dayLabel(it.ts);
      if (d !== day) { day = d; out.push(h('div', { class: 'rd-day' }, d)); }
      out.push(it.el);
    }
    return { nodes: out, count: items.length };
  }
  function row(c) {
    const removed = st.list === 'disqualified';
    const label = removed ? `“${c.quote || 'Thanks'}”` : c.waiting ? 'Customer waiting' : reasonOf(c);
    return h('li', { class: `tm-rv-row rd-row${keyOf(c) === st.sel ? ' on' : ''}`, dataset: { id: keyOf(c) }, onclick: () => select(c) },
      h('div', { class: 'tm-rv-main' },
        h('div', { class: 'tm-rv-top' }, h('b', null, nameOf(c)), h('span', { class: 'muted' }, since(c.basis_at))),
        h('div', { class: 'rd-sub' }, h('span', { class: `rd-why${!removed && c.waiting ? ' hot' : ''}`, dir: 'auto' }, label), c.actor ? h('span', { class: 'rd-who' }, c.actor) : null)));
  }
  function detail(c, list) {
    const kindName = st.kind === 'sales' ? 'sales' : 'support';
    if (!c) {
      const removed = inList('disqualified').length;
      return h('div', { class: 'tm-rv-empty' }, h('div', { class: 'empty-big' }, '✓'),
        h('b', null, st.list === 'disqualified' ? `No ${kindName} chat was disqualified` : `All ${kindName} chats looked over`),
        st.list !== 'disqualified' && removed ? h('div', { class: 'muted' }, `The AI cleared ${removed} confirmed ${kindName} ${removed === 1 ? 'chat' : 'chats'} in the last 24 hours.`) : null);
    }
    const e = chatOf(c);
    const tl = e.data ? timeline(e.data) : { nodes: [], count: 0 };
    const removed = st.list === 'disqualified';
    const finished = c.solved_at ? `${c.actor} finished it ${dayLabel(c.solved_at).toLowerCase()} at ${fTime.format(new Date(c.solved_at))}` : 'Hidden from the team';
    const vBtn = !vAllowed() ? null : isAdmin()
      ? h('button', { class: 'btn fine', onclick: () => answer(c, 'fine') }, h('kbd', null, 'V'), 'Good')
      : h('button', { class: 'btn fine', title: 'Hides this chat from your Radar only. Nothing changes for the customer or the team.', onclick: () => answer(c, 'checked') }, h('kbd', null, 'V'), 'Checked');
    return h('div', { class: 'tm-rv-detail' },
      h('div', { class: 'tm-rv-head rd-head' },
        h('div', { class: 'rd-title' }, h('h3', null, nameOf(c)), h('span', { class: 'muted' }, [c.kind === 'sales' ? 'Sales' : c.kind === 'support' ? 'Support' : null, finished].filter(Boolean).join(' · '))),
        h('span', { class: 'muted tm-rv-pos' }, `${list.indexOf(c) + 1} of ${list.length}`)),
      h('div', { class: 'tm-rv-scroll rd-scroll', dataset: { key: `${keyOf(c)}|${tl.count}` } },
        h('div', { class: 'tm-thread rd-thread' }, e.error ? h('div', { class: 'tm-markline quiet' }, `Could not load the conversation: ${e.error}`)
          : e.loading && !tl.count ? h('div', { class: 'tm-markline quiet' }, 'Loading the conversation…') : tl.nodes)),
      h('div', { class: 'rd-foot' },
        h('p', { class: `rd-reason${!removed && c.waiting ? ' hot' : ''}` }, removed ? h('span', { dir: 'auto' }, `Disqualified: the customer said “${c.quote || 'thanks'}”`)
          : c.waiting ? `Customer waiting for ${since(c.basis_at)}` : reasonOf(c)),
        h('div', { class: 'rd-actions' },
          h('button', { class: 'btn sm ghost', onclick: () => openChat(c) }, h('kbd', null, 'O'), 'Open chat'),
          h('button', { class: 'btn unsolve', onclick: () => answer(c, 'back') }, h('kbd', null, 'C'), 'Back to Unresolved'),
          vBtn)));
  }
  function view() {
    if (!st.data) return h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load Radar.'), h('div', null, st.error), h('button', { class: 'btn', onclick: load }, 'Try again')] : 'Loading…');
    const list = rows();
    if (!list.some((c) => keyOf(c) === st.sel)) st.sel = list.length ? keyOf(list[0]) : null;
    const cur = list.find((c) => keyOf(c) === st.sel) || null;
    if (cur) { const n = list[list.indexOf(cur) + 1]; if (n) chatOf(n); }
    const people = new Map();
    for (const c of inList(st.list)) if (c.actor) people.set(c.actor, (people.get(c.actor) || 0) + 1);
    const chip = (name, label, n) => h('button', { class: `rd-person${st.person === name ? ' on' : ''}`, onclick: () => { st.person = name; st.sel = null; draw(); } }, label, h('span', null, String(n)));
    const note = [st.data.reviewed_today ? `${st.data.reviewed_today} ${isAdmin() ? 'reviewed' : 'looked over by you'} today` : null, st.data.settling ? `${st.data.settling} being checked` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'tm-review rd' },
      h('div', { class: 'rd-bar' },
        h('div', { class: 'tm-filter rd-lists', role: 'tablist' }, LISTS.map(([k, label], i) => h('button', { class: `tm-tab${st.list === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.list === k), title: `Press ${i + 1}`, onclick: () => setList(k) }, label, h('span', null, String(inList(k).length))))),
        h('span', { class: 'muted rd-note' }, ['Last 24 hours', note].filter(Boolean).join(' · '))),
      people.size > 1 ? h('div', { class: 'rd-people' }, chip('', 'Everyone', inList(st.list).length), [...people].sort((a, b) => b[1] - a[1]).map(([name, n]) => chip(name, name, n))) : null,
      h('div', { class: 'tm-rv-cols rd-cols' },
        h('ul', { class: 'tm-rv-list', 'aria-label': 'Chats' }, list.length ? list.map(row) : h('li', { class: 'tm-rv-none' }, 'Nothing here.')),
        detail(cur, list)),
      h('div', { class: 'tm-rv-keys muted' }, h('kbd', null, 'J'), h('kbd', null, 'K'), ' move  ', h('kbd', null, 'V'), isAdmin() ? ' good  ' : ' checked (only for you)  ', h('kbd', null, 'C'), ' back to Unresolved  ',
        h('kbd', null, 'Tab'), ' support / sales  ', h('kbd', null, '1'), h('kbd', null, '2'), h('kbd', null, '3'), ' switch list  ', h('kbd', null, 'Z'), ' undo  ', h('kbd', null, 'Esc'), ' back to chats'));
  }

  function draw() {
    if (!root) return;
    const oldList = root.querySelector('.tm-rv-list'), oldConv = root.querySelector('.tm-rv-scroll');
    const listTop = oldList ? oldList.scrollTop : 0;
    const convKey = oldConv ? oldConv.dataset.key : '', convTop = oldConv ? oldConv.scrollTop : 0;
    const head = h('header', { class: 'tm-head' },
      h('div', { class: 'tm-head-1' },
        h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', h('kbd', null, 'Esc')),
        h('h2', null, 'Radar'),
        h('span', { class: 'muted rd-note' }, isAdmin() ? 'V = good for everyone · C = send back' : 'V = checked (hidden only for you) · C = send back to Unresolved'),
        h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: load }, U.icon('refresh'))),
      h('nav', { class: 'tm-tabs', role: 'tablist', 'aria-label': 'Support or sales' }, KINDS.map(([k, l]) => {
        const n = st.data ? inList('review', k).length : 0;
        return h('button', { class: `tm-maintab${st.kind === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.kind === k), title: 'Tab switches', onclick: () => setKind(k) },
          U.icon(k === 'sales' ? 'chart' : 'team', 'sm'), l, n ? h('span', { class: 'tm-badge' }, String(n)) : null);
      })));
    const body = h('div', { class: 'tm-body', dataset: { tab: 'ai' } }, h('div', { class: 'tm-wrap' }, view()));
    const undoBar = root.querySelector('.tm-undo');
    root.replaceChildren(head, body);
    if (undoBar) root.append(undoBar);
    root.classList.toggle('busy', st.loading);
    // keep the place: list position, and the conversation stays where it was read (a new chat opens on its latest messages)
    const list = root.querySelector('.tm-rv-list'), conv = root.querySelector('.tm-rv-scroll');
    if (list) {
      list.scrollTop = listTop;
      const on = list.querySelector('.tm-rv-row.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }
    if (conv) conv.scrollTop = conv.dataset.key === convKey ? convTop : conv.scrollHeight;
  }
  function onKey(e) {
    if (!root) return;
    // the desk's own shortcuts (J, K, V, Tab, arrows...) stay off while this screen is open
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = rows().find((c) => keyOf(c) === st.sel);
    let done = true;
    switch (e.key.toLowerCase()) {
      case 'j': case 'arrowdown': move(1); break;
      case 'k': case 'arrowup': move(-1); break;
      case 'v': if (vAllowed()) answer(cur, vAnswer()); break;
      case 'c': answer(cur, 'back'); break;
      case 'z': undo(); break;
      case 'o': case 'enter': openChat(cur); break;
      case 'tab': setKind(st.kind === 'support' ? 'sales' : 'support'); break;
      case '1': case '2': case '3': setList(LISTS[Number(e.key) - 1][0]); break;
      default: done = false;
    }
    if (done) e.preventDefault();
  }
  function open(helpers) {
    U = helpers;
    if (root) return;
    root = h('div', { class: 'team-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Radar' });
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    draw();
    load();
    clearInterval(st.timer);
    st.timer = setInterval(() => { if (root && !document.hidden && !st.pending) load(); }, POLL_MS);
  }
  function close() {
    if (!root) return;
    clearInterval(st.timer);
    flush();
    document.removeEventListener('keydown', onKey, true);
    const undoBar = root.querySelector('.tm-undo');
    if (undoBar) undoBar.remove();
    root.remove(); root = null;
  }
  window.DeskRadar = { open, close };
})();
