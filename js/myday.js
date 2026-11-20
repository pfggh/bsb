/* Teshrij Desk — My day (everyone).
 *
 * One calm screen with a person's OWN numbers: today, this week next to their own last week, their
 * personal bests, what customers said when they thanked them, and the stars the owner left on their
 * chats. Nobody else's numbers are shown and there is no ranking. Everything comes from the server
 * (op my_day); this file only draws it. Times are Beirut time.
 */
(function () {
  'use strict';
  let U = null;            // helpers handed over by app.js
  let root = null, timer = null;
  const st = { data: null, error: '', loading: false };
  const h = (...a) => U.h(...a);
  const TZ = 'Asia/Beirut';
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
  const fLong = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const n0 = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const num = (v) => n0(v).toLocaleString('en-US');
  const plural = (n, one, many) => `${num(n)} ${n0(n) === 1 ? one : many || one + 's'}`;
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  const custName = (x) => (x.name && /[\p{L}\p{N}]/u.test(x.name) ? x.name : /^\d+$/.test(String(x.contact || '')) ? '+' + x.contact : 'Instagram user');
  function when(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const k = fDay.format(d), now = U.now();
    if (k === fDay.format(new Date(now))) return `Today, ${fTime.format(d)}`;
    if (k === fDay.format(new Date(now - 86400000))) return `Yesterday, ${fTime.format(d)}`;
    return `${fDate.format(d)}, ${fTime.format(d)}`;
  }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    if (root) root.classList.add('busy');
    try { const d = await U.api.call('my_day', {}); st.data = obj(d); st.error = ''; }
    catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    draw();
  }

  // ---------------------------------------------------------------- pieces

  // the numbers a period is made of, in the order they are shown
  function figures(p) {
    p = obj(p);
    const turns = n0(p.turns), fast = Math.min(n0(p.fast), turns), solves = n0(p.solves);
    return {
      replies: n0(p.replies), turns, fast, fastPct: turns > 0 ? Math.round((fast / turns) * 100) : null,
      solves, stayed: Math.max(0, solves - n0(p.comeback)), sales: n0(p.sales), thanks: n0(p.thanks), stars: n0(p.stars),
    };
  }
  function tile(label, value, sub, best) {
    return h('div', { class: `md-tile${best ? ' best' : ''}` },
      h('span', { class: 'md-tile-l' }, label),
      h('b', { class: 'md-tile-v' }, value),
      sub ? h('span', { class: 'md-tile-s' }, sub) : null,
      best ? h('span', { class: 'md-best', title: best }, 'Personal best') : null);
  }
  // today equals or beats the best single day of the last 30 days
  function bestNote(d, key) {
    const b = obj(obj(d.best)[key]);
    const v = n0(obj(d.today)[key]);
    if (!(v >= 3) || !(v >= n0(b.n))) return ''; // a "best" of 1 or 2 is not worth a badge
    return b.day && b.day !== d.day && n0(b.n) === v ? `Equals your best day of the last 30 days (${dayName(b.day)})` : 'Your best day of the last 30 days';
  }
  const dayName = (day) => { const t = Date.parse(day + 'T00:00:00Z'); return Number.isFinite(t) ? fDate.format(new Date(t + 12 * 3600000)) : day; };
  function todayTiles(d) {
    const t = figures(d.today);
    return h('div', { class: 'md-tiles' },
      tile('Replies', num(t.replies), t.replies ? 'messages you sent' : 'none yet today', bestNote(d, 'replies')),
      tile('Answered within 5 min', t.fastPct === null ? '–' : `${t.fastPct}%`, t.turns ? `${num(t.fast)} of ${plural(t.turns, 'customer message')} you answered first` : 'no customer answered first yet'),
      tile('Solved', num(t.solves), t.solves ? `${num(t.stayed)} stayed solved` : 'support chats', bestNote(d, 'solves')),
      tile('Sales', num(t.sales), null, bestNote(d, 'sales')),
      tile('Thank-yous', num(t.thanks), t.thanks ? 'from customers' : 'No thank-yous yet today', bestNote(d, 'thanks')),
      tile('Stars', num(t.stars), t.stars ? 'from the owner' : null));
  }
  // small up / down mark next to this week's number: up is green, down is plain grey (no alarm)
  function mark(cur, prev, unit = '') {
    if (cur === null || prev === null || (!cur && !prev)) return h('span', { class: 'md-mark flat' }, '');
    const diff = cur - prev;
    if (!diff) return h('span', { class: 'md-mark flat', title: 'Same as last week' }, 'same');
    return h('span', { class: `md-mark ${diff > 0 ? 'up' : 'down'}`, title: `${diff > 0 ? 'Up' : 'Down'} from ${prev}${unit} last week` },
      h('span', { 'aria-hidden': 'true' }, diff > 0 ? '▲' : '▼'), ` ${Math.abs(diff)}${unit}`);
  }
  function weekTable(d) {
    const w = figures(d.week), p = figures(d.prev_week);
    const rows = [
      ['Replies', w.replies, p.replies],
      ['Answered within 5 min', w.fastPct, p.fastPct, '%'],
      ['Solved', w.solves, p.solves],
      ['Stayed solved', w.stayed, p.stayed],
      ['Sales', w.sales, p.sales],
      ['Thank-yous', w.thanks, p.thanks],
      ['Stars', w.stars, p.stars],
    ];
    // No last week on record yet (new on the desk): no "up from zero" marks, the column stays blank.
    const hasPrev = !!(p.replies || p.solves || p.sales || p.thanks);
    const show = (v, unit) => (v === null ? '–' : `${num(v)}${unit || ''}`);
    return h('div', { class: 'md-week', role: 'table', 'aria-label': 'This week next to your last week' },
      h('div', { class: 'md-wrow md-whead', role: 'row' }, h('span', { role: 'columnheader' }, ''), h('span', { role: 'columnheader' }, 'This week'), h('span', { role: 'columnheader' }, ''), h('span', { role: 'columnheader' }, 'Last week')),
      rows.map(([label, cur, prev, unit]) => h('div', { class: 'md-wrow', role: 'row' },
        h('span', { class: 'md-wl', role: 'rowheader' }, label),
        h('b', { role: 'cell' }, show(cur, unit)),
        h('span', { role: 'cell' }, hasPrev ? mark(cur, prev, unit || '') : ''),
        h('span', { class: 'md-wprev', role: 'cell' }, hasPrev ? show(prev, unit) : '–'))));
  }
  const goChat = (contact) => { close(); U.openChat(String(contact)); };
  function quotes(d) {
    const list = Array.isArray(d.thanks) ? d.thanks : [];
    if (!list.length) return h('p', { class: 'md-none' }, 'No thank-yous yet this week. When a customer thanks you, their words show up here.');
    return h('ul', { class: 'md-list' }, list.map((x) => h('li', null, h('button', { class: 'md-item', type: 'button', title: 'Open this chat', onclick: () => goChat(x.contact) },
      h('span', { class: 'md-q', dir: 'auto' }, `“${String(x.text || '').trim() || 'Thank you'}”`),
      h('span', { class: 'md-by' }, `${custName(x)} · ${when(x.at)}`)))));
  }
  function stars(d) {
    const list = Array.isArray(d.stars) ? d.stars : [];
    if (!list.length) return h('p', { class: 'md-none' }, 'No stars yet. They appear here when the owner marks one of your chats as well handled.');
    return h('ul', { class: 'md-list' }, list.map((x) => h('li', null, h('button', { class: 'md-item star', type: 'button', title: 'Open this chat', onclick: () => goChat(x.contact) },
      h('span', { class: 'md-q' }, h('span', { 'aria-hidden': 'true' }, '⭐ '), 'Well handled', x.by ? ` · ${x.by}` : ''),
      x.note ? h('span', { class: 'md-note', dir: 'auto' }, String(x.note)) : null,
      h('span', { class: 'md-by' }, `${custName(x)} · ${when(x.at)}`)))));
  }
  // one plain sentence under the title
  function opener(d) {
    const t = figures(d.today);
    if (t.thanks) return `${plural(t.thanks, 'customer')} thanked you today.`;
    if (t.solves) return `${plural(t.solves, 'chat')} solved today.`;
    if (t.replies) return `${plural(t.replies, 'reply', 'replies')} sent today.`;
    return 'Nothing counted yet today. This fills in as you work.';
  }
  const section = (title, sub, ...kids) => h('section', { class: 'md-sec' }, h('h3', null, title, sub ? h('span', { class: 'md-sub' }, sub) : null), ...kids);

  // ---------------------------------------------------------------- screen

  function draw() {
    if (!root) return;
    const d = st.data;
    const old = root.querySelector('.md-body');
    const top = old ? old.scrollTop : 0;
    const name = (d && d.name) || (U.me && U.me.name) || '';
    const dayT = d && d.day ? Date.parse(d.day + 'T00:00:00Z') : NaN;
    const head = h('header', { class: 'md-head' },
      h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', h('kbd', null, 'Esc')),
      h('div', { class: 'md-title' }, h('h2', null, 'My day'),
        h('span', { class: 'muted' }, [name, Number.isFinite(dayT) ? fLong.format(new Date(dayT)) : null, 'only you see this'].filter(Boolean).join(' · '))),
      h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: load }, U.icon('refresh')));
    let body;
    if (!d) {
      body = h('div', { class: 'md-body' }, h('div', { class: 'md-wrap' }, h('div', { class: 'md-none center' },
        st.error ? [h('b', null, 'My day could not be loaded.'), h('div', null, st.error), h('button', { class: 'btn', onclick: load }, 'Try again')] : 'Loading…')));
    } else {
      body = h('div', { class: 'md-body' }, h('div', { class: 'md-wrap' },
        st.error ? h('p', { class: 'md-none' }, `Could not refresh (${st.error}). Showing the last numbers.`) : null,
        h('p', { class: 'md-open' }, opener(d)),
        section('Today', null, todayTiles(d)),
        section('This week vs your last week', 'last 7 days next to the 7 days before', weekTable(d)),
        h('div', { class: 'md-cols' },
          section('Thank-yous this week', null, quotes(d)),
          section('Stars from the owner', 'last 30 days', stars(d)))));
    }
    root.replaceChildren(head, body);
    root.classList.toggle('busy', st.loading);
    body.scrollTop = top;
  }

  function onKey(e) {
    if (!root) return;
    // the desk's own shortcuts stay off while this screen is open
    e.stopPropagation();
    const el = document.activeElement;
    const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (e.key === 'Escape' || (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M'))) { e.preventDefault(); close(); }
  }
  function open(helpers) {
    U = helpers;
    if (root) return;
    root = h('div', { class: 'team-screen md-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'My day' });
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    draw();
    load();
    // the server keeps the numbers for a minute; refresh quietly while the screen stays open
    timer = setInterval(() => { if (root && !document.hidden) load(); }, 60000);
    const back = root.querySelector('button');
    if (back) back.focus();
  }
  function close() {
    if (!root) return;
    clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
  }

  window.DeskMyDay = { open, close, isOpen: () => !!root };
})();
