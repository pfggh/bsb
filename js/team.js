/* Teshrij Desk — Team & quality (admins only), v3.
 *
 * Four tabs, in plain words:
 *   Live      who is doing what this minute, which customers are waiting, the latest actions (refreshes itself)
 *   Quality   how well customers are served: answer speed, missed customers, solved for real, sales results
 *   People    js/people.js (op people_report): working time split into on-chats / no-action / open-unused,
 *             typed messages apart from automatic closers, solves as distinct chats with / without a reply
 *   (Radar moved to its own screen for everyone on 2026-11-27: js/radar.js, sidebar "Radar". The
 *   "solved for real" numbers still come from Radar answers: admin Good = reviewed, anyone's send-back = flagged.)
 *   Compare   the same numbers side by side, and per day
 * All numbers come from the server (op team_report); this file only draws them. Times are Beirut time.
 */
(function () {
  'use strict';
  let U = null;            // helpers handed over by app.js
  let root = null;
  let timer = null, liveTimer = null;
  const st = {
    live: null, liveError: '', liveBusy: false, q: null, qKey: '', qBusy: false, qError: '',
    tab: 'live', preset: 'today', from: '', to: '', data: null, loading: false, error: '',
    open: new Set(), filter: 'open', person: 0, logMore: false,
    sel: null, selScroll: false, threadTop: null,
  };

  const TZ = 'Asia/Beirut';
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  const fShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  const today = () => fDay.format(new Date(U.now()));
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayName = (day) => fShort.format(new Date(day + 'T00:00:00Z'));
  const hm = (min) => { const m = Math.max(0, Math.round(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  // 12-hour times everywhere: "5 pm", "5:30 pm".
  const hr = (x) => { const k = ((x % 24) + 24) % 24; return `${k % 12 || 12} ${k < 12 ? 'am' : 'pm'}`; };
  const clock = (m) => { const k = Math.floor(m / 60) % 24; return `${k % 12 || 12}:${String(m % 60).padStart(2, '0')} ${k < 12 ? 'am' : 'pm'}`; };
  const secs = (s) => s == null ? '–' : s < 90 ? `${Math.round(s)} sec` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '–';
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many || one + 's'}`;
  const h = (...a) => U.h(...a);

  const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days']];
  function setPreset(p) {
    st.preset = p;
    const t = today();
    if (p === 'today') { st.from = t; st.to = t; }
    else if (p === 'yesterday') { st.from = st.to = addDays(t, -1); }
    else { st.from = addDays(t, -(Number(p) - 1)); st.to = t; }
  }
  const custName = (c) => c.name && /[\p{L}\p{N}]/u.test(c.name) ? c.name : c.handle ? '@' + c.handle : /^\d+$/.test(c.contact) ? '+' + c.contact : /^tt_/.test(c.contact) ? 'TikTok user' : 'Instagram user';

  // ---------------------------------------------------------------- data

  async function load(quiet = false) {
    if (st.loading) return;
    st.loading = true;
    if (!quiet) { st.error = ''; draw(); }
    if (st.tab === 'quality' && st.qKey !== `${st.from}|${st.to}`) loadQuality(true);
    try { st.data = await U.api.call('team_report', { from: st.from, to: st.to }); st.error = ''; }
    catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    draw();
    schedule();
  }
  // The report refreshes itself every minute.
  function schedule() {
    clearTimeout(timer);
    if (!root) return;
    timer = setTimeout(() => { if (document.hidden) schedule(); else load(true); }, 60000);
  }
  // ---------------------------------------------------------------- tooltip (one for every chart)

  let tip = null;
  function bindTip(el) {
    el.addEventListener('pointermove', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { if (tip) tip.hidden = true; return; }
      if (!tip) { tip = h('div', { class: 'tm-tip', role: 'tooltip' }); document.body.append(tip); }
      if (tip._for !== t) { tip._for = t; tip.replaceChildren(...String(t.dataset.tip).split('\n').map((line, i) => h(i ? 'div' : 'b', null, line))); }
      tip.hidden = false;
      const w = tip.offsetWidth, hgt = tip.offsetHeight;
      tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14))}px`;
      tip.style.top = `${e.clientY + hgt + 24 > innerHeight ? e.clientY - hgt - 12 : e.clientY + 18}px`;
    });
    el.addEventListener('pointerleave', () => { if (tip) tip.hidden = true; });
  }

  // ---------------------------------------------------------------- charts

  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  // Columns: one value per day. opts: {value(d), tip(d), unit: 'h'|'n'}
  function columns(days, opts) {
    const W = Math.max(260, days.length * 30 + 44), H = 132, padL = 34, padB = 20, padT = 8;
    const vals = days.map(opts.value);
    const rawMax = Math.max(...vals, opts.unit === 'h' ? 60 : 4);
    const step = opts.unit === 'h' ? Math.max(60, Math.ceil(rawMax / 3 / 60) * 60) : Math.max(1, Math.ceil(rawMax / 3 / (rawMax > 40 ? 10 : 1)) * (rawMax > 40 ? 10 : 1));
    const max = step * Math.ceil(rawMax / step);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const svg = s('svg', { class: 'tm-cols', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label, style: `max-width:${Math.round(W * 1.2)}px` });
    for (let v = 0; v <= max; v += step) {
      svg.append(s('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: v ? 'tm-grid' : 'tm-base' }),
        s('text', { x: padL - 6, y: y(v) + 3.5, class: 'tm-tick', 'text-anchor': 'end' }, opts.unit === 'h' ? `${v / 60}h` : String(v)));
    }
    const band = (W - padL) / days.length, bw = Math.min(22, band - 6);
    const every = Math.ceil(days.length / 10);
    days.forEach((d, i) => {
      const v = vals[i], x = padL + band * i + (band - bw) / 2, top = y(v), base = y(0);
      const g = s('g', { class: 'tm-col' });
      const hit = s('rect', { x: padL + band * i, y: padT, width: band, height: H - padT - padB, fill: 'transparent' });
      hit.dataset.tip = opts.tip(d);
      g.append(hit);
      if (v > 0) {
        const r = Math.min(4, (base - top) / 2);
        const bar = s('path', { class: 'tm-bar', d: `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z` });
        bar.dataset.tip = opts.tip(d);
        g.append(bar);
      }
      if (i % every === 0 || i === days.length - 1) g.append(s('text', { x: x + bw / 2, y: H - 6, class: 'tm-tick', 'text-anchor': 'middle' }, String(Number(d.day.slice(8)))));
      svg.append(g);
    });
    return svg;
  }
  // 24 cells, one hue, light -> dark by working minutes in that hour of the day.
  function hourHeat(hours) {
    const vals = Array.from({ length: 24 }, (_, i) => Number(hours[i] || 0));
    const max = Math.max(...vals, 1);
    return h('div', { class: 'tm-heat' },
      h('div', { class: 'tm-heat-row' }, vals.map((v, i) => {
        const lvl = v ? 1 + Math.min(4, Math.floor((v / max) * 4.999)) : 0;
        return h('span', { class: `tm-cell l${lvl}`, dataset: { tip: `${hr(i)} – ${hr(i + 1)}\n${v ? hm(v) + ' working' : 'Not working'}` } });
      })),
      h('div', { class: 'tm-heat-axis', 'aria-hidden': 'true' }, [0, 6, 12, 18].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, hr(x)))));
  }
  // Horizontal bars comparing employees on one measure.
  function compare(title, sub, rows, fmt, wide = false) {
    const max = Math.max(...rows.map((r) => r.v), 1);
    return h('div', { class: 'tm-card' },
      h('div', { class: 'tm-card-h' }, h('b', null, title), sub ? h('span', { class: 'muted' }, sub) : null),
      rows.length ? h('div', { class: 'tm-hbars' }, rows.map((r) => h('div', { class: `tm-hbar${wide ? ' wide' : ''}`, dataset: { tip: `${r.name}\n${r.tip || fmt(r.v)}` } },
        h('span', { class: 'tm-hbar-n' }, r.name),
        h('span', { class: 'tm-hbar-t' }, h('i', { class: r.cls || '', style: `width:${Math.max(r.v ? 1.5 : 0, (r.v / max) * 100)}%` })),
        h('span', { class: 'tm-hbar-v' }, fmt(r.v))))) : h('p', { class: 'muted' }, 'Nothing in this period.'));
  }

  // ---------------------------------------------------------------- shared by Compare / Live (People lives in js/people.js)
  function fillDays(days) {
    const by = new Map(days.map((d) => [d.day, d]));
    const out = [];
    for (let d = st.data.from; d <= st.data.to; d = addDays(d, 1)) out.push(by.get(d) || { day: d, active_min: 0, online_min: 0, sent: 0, solved: 0, sales_done: 0, flagged: 0, segs: [] });
    return out;
  }
  function tile(label, value, sub, cls = '', onclick = null) {
    return h(onclick ? 'button' : 'div', { class: `tm-tile ${cls}`, onclick }, h('span', { class: 'tm-tile-l' }, label), h('b', { class: 'tm-tile-v' }, value), sub ? h('span', { class: 'tm-tile-s' }, sub) : null);
  }

  // ---------------------------------------------------------------- live board
  // Who is doing what this minute, who is waiting, and the latest actions. Refreshes itself every 10 seconds.

  const OPS = { send: 'sent a message', send_media: 'sent a photo, file or voice note', resolve: 'solved a chat with a closing message', resolve_silent: 'marked a chat finished',
    reopen: 'reopened a chat', label: 'changed a label', set_kind: 'changed sales / support', close_no_reply: 'closed a chat without reply' };
  const who = (name, contact) => name && /[\p{L}\p{N}]/u.test(name) ? name : /^\d+$/.test(String(contact || '')) ? '+' + contact : /^tt_/.test(String(contact || '')) ? 'TikTok user' : 'Instagram user';
  const since = (ts) => ts ? U.dur(Math.max(0, U.now() - Date.parse(ts))) : '';
  const chatLink = (name, contact) => h('button', { class: 'tm-link', title: 'Open this chat', onclick: () => { close(); U.openChat(contact); } }, who(name, contact));
  async function loadLive() {
    if (!root || st.liveBusy) return;
    st.liveBusy = true;
    try { st.live = await U.api.call('team_live'); st.liveError = ''; } catch (e) { st.liveError = e.message || 'Could not load'; }
    st.liveBusy = false;
    if (root && st.tab === 'live') draw();
  }
  function liveState(p) {
    const n = U.now();
    const input = p.input_at ? n - Date.parse(p.input_at) : Infinity;
    const seen = p.seen_at ? n - Date.parse(p.seen_at) : Infinity;
    if (seen < 150000 && input < 150000) return { cls: 'on', text: 'Working now', rank: 0 };
    if (seen < 150000) return { cls: 'idle', rank: 1, idle: input, text: !p.visible ? 'Desk open in another tab or behind a window' : input === Infinity ? 'Desk open, not touching it' : `Desk open, not touching it for ${U.dur(input)}` };
    const last = p.seen_at;
    return { cls: '', rank: 2, text: last ? `Away · last here ${fDay.format(new Date(last)) === today() ? 'at ' + fTime.format(new Date(last)) : U.ago(last)}` : 'Has not opened the desk yet' };
  }
  function feedLine(f) {
    let text;
    if (f.kind === 'sent') text = f.ok === false ? 'a message failed to send to' : f.what === 'closer' ? 'sent a closing message to' : f.what === 'media' ? 'sent a photo, file or voice note to' : f.what === 'followup' ? 'sent an automatic follow-up to' : 'replied to';
    else if (f.kind === 'resolved') text = f.what === 'sales' ? 'marked complete:' : 'solved:';
    else text = f.by_review ? 'marked unsolved after review:' : f.actor === 'customer' ? 'wrote again, chat reopened:' : 'reopened:';
    const cls = f.kind === 'sent' ? (f.ok === false ? 'bad' : '') : f.kind === 'resolved' ? 'good' : 'warn';
    return h('li', { class: `tm-feed-i ${cls}` }, h('time', null, fTime.format(new Date(f.at))), h('span', null, h('b', null, f.actor === 'customer' ? 'Customer' : f.actor), ' ', text, ' ', chatLink(f.name, f.contact)));
  }
  function liveTab() {
    const L = st.live;
    if (!L) return [h('div', { class: 'tm-empty' }, st.liveError ? [h('b', null, 'Could not load the live board.'), h('div', null, st.liveError)] : 'Loading…')];
    const q = L.queue || {};
    const staff = [...(L.staff || [])].map((p) => ({ p, s: liveState(p) })).sort((a, b) => a.s.rank - b.s.rank || (b.p.active_min - a.p.active_min) || a.p.name.localeCompare(b.p.name));
    const working = staff.filter((x) => x.s.rank === 0).length;
    const oldest = q.oldest_at ? U.now() - Date.parse(q.oldest_at) : 0;
    return [
      st.liveError ? h('p', { class: 'tm-note warn' }, `Could not refresh (${st.liveError}). Showing the last picture.`) : null,
      h('div', { class: 'tm-tiles' },
        tile('People working now', `${working} of ${staff.length}`, working ? staff.filter((x) => x.s.rank === 0).map((x) => x.p.name).join(', ') : 'nobody is touching the desk', !working && q.waiting ? 'bad' : ''),
        tile('Customers waiting', num(q.waiting), q.waiting ? `${num(q.support)} support · ${num(q.sales)} sales` : 'everyone has an answer', ''),
        tile('Waiting over 5 minutes', num(q.over_5), '', q.over_5 ? 'warnt' : ''),
        tile('Waiting over 15 minutes', num(q.over_15), '', q.over_15 ? 'bad' : ''),
        tile('Waiting over 1 hour', num(q.over_60), '', q.over_60 ? 'bad' : ''),
        tile('Longest wait', q.waiting ? U.dur(oldest) : '–', q.waiting && L.longest && L.longest[0] ? who(L.longest[0].name, L.longest[0].contact) : '', oldest > 900000 ? 'bad' : '')),
      h('section', { class: 'tm-sec' }, h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Each person, right now'),
        h('p', { class: 'muted' }, 'Updates every 10 seconds. “On screen” is the chat open on their desk.'))),
        h('div', { class: 'tm-live' }, staff.map(({ p, s }) => {
          const slack = s.rank === 1 && s.idle > 300000 && q.over_5 > 0;
          return h('div', { class: `tm-lc ${s.cls}${slack ? ' slack' : ''}` },
            h('div', { class: 'tm-lc-h' }, h('div', { class: 'av', style: `background:${U.avColor(p.name)}` }, U.initials({ name: p.name })),
              h('div', null, h('b', null, p.name, p.role === 'admin' ? h('span', { class: 'role' }, 'admin') : null), h('span', { class: `tm-pres ${s.cls}` }, h('i'), s.text))),
            slack ? h('div', { class: 'tm-lc-warn' }, U.icon('warn', 'xs'), `${plural(q.over_5, 'customer')} waiting over 5 minutes`) : null,
            h('dl', { class: 'tm-lc-d' },
              h('dt', null, 'On screen'), h('dd', null, p.contact ? [chatLink(p.chat_name, p.contact), p.chat_since ? h('span', { class: 'muted' }, ` · for ${since(p.chat_since)}`) : null] : h('span', { class: 'muted' }, s.rank === 2 ? '–' : 'the chat list')),
              h('dt', null, 'Last action'), h('dd', null, p.op_at ? [OPS[p.op] || p.op, p.op_contact ? ' · ' : null, p.op_contact ? chatLink(p.op_name, p.op_contact) : null, h('span', { class: 'muted' }, ` · ${U.ago(p.op_at)}`)] : h('span', { class: 'muted' }, 'nothing yet'))),
            h('div', { class: 'tm-lc-n' },
              h('span', { dataset: { tip: `Working time today\n${p.first_at ? 'Started at ' + fTime.format(new Date(p.first_at)) : 'Not started today'}` } }, h('b', null, hm(p.active_min)), 'worked today'),
              h('span', null, h('b', null, num(p.sent)), 'sent'), h('span', null, h('b', null, num(p.solved)), 'solved'), h('span', null, h('b', null, num(p.sales_done)), 'completed')));
        }))),
      h('div', { class: 'tm-live-cols' },
        h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Waiting longest'), h('span', { class: 'muted' }, 'customer wrote last, nobody answered yet')),
          (L.longest || []).length ? h('ul', { class: 'tm-wait' }, L.longest.map((x) => { const ms = U.now() - Date.parse(x.since);
            return h('li', null, h('span', { class: `tm-wait-t${ms > 3600000 ? ' bad' : ms > 900000 ? ' warn' : ''}` }, U.dur(ms)), chatLink(x.name, x.contact), h('span', { class: 'muted' }, x.kind === 'support' ? 'support' : 'sales')); }))
            : h('p', { class: 'muted' }, 'Nobody is waiting.')),
        h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Happening now'), h('span', { class: 'muted' }, 'last 3 hours, newest first')),
          (L.feed || []).length ? h('ul', { class: 'tm-feed' }, L.feed.map(feedLine)) : h('p', { class: 'muted' }, 'Nothing in the last 3 hours.'))),
    ];
  }

  // one person's day, action by action (People → Details, single day)
  const logs = new Map();
  function dayLog(p, day) {
    const key = `${p.id}|${day}`;
    let e = logs.get(key);
    if (!e) {
      e = { loading: true };
      logs.set(key, e);
      U.api.call('team_log', { staff: p.id, day }).then((r) => { e.rows = r.rows || []; }, (err) => { e.error = err.message; }).finally(() => { e.loading = false; if (root) draw(); });
    }
    if (e.loading) return h('p', { class: 'muted' }, 'Loading…');
    if (e.error) return h('p', { class: 'muted' }, `Could not load: ${e.error}`);
    if (!e.rows.length) return h('p', { class: 'muted' }, 'Nothing was sent, solved or labelled this day.');
    const line = (f) => {
      const t = f.kind === 'sent' ? (f.ok === false ? 'Message failed to send' : f.what === 'closer' ? 'Closing message' : f.what === 'media' ? 'Photo, file or voice note' : 'Message')
        : f.kind === 'resolved' ? (f.what === 'sales' ? 'Marked complete' : `Solved${f.title ? ` (${f.title})` : ''}`) : f.kind === 'reopened' ? 'Reopened'
        : f.kind === 'label_add' ? `Label added${f.what ? `: ${f.what}` : ''}` : f.kind === 'label_remove' ? `Label removed${f.what ? `: ${f.what}` : ''}` : 'Changed sales / support';
      return h('li', { class: f.kind === 'resolved' ? 'good' : f.ok === false ? 'bad' : '' }, h('time', null, fTime.format(new Date(f.at))), h('span', null, h('b', null, t), ' · ', chatLink(f.name, f.contact),
        f.text ? h('q', { dir: 'auto' }, f.text) : null));
    };
    return h('ul', { class: 'tm-feed log' }, e.rows.map(line));
  }

  // ---------------------------------------------------------------- quality
  // How well customers are served: answer speed, nobody left without an answer, solved for real, sales results.

  async function loadQuality(quiet = false, fresh = false) {
    if (st.qBusy) return;
    st.qBusy = true; st.qKey = `${st.from}|${st.to}`;
    if (!quiet) { st.qError = ''; draw(); }
    try { st.q = await U.api.call('quality_report', { from: st.from, to: st.to, fresh }); st.qError = ''; } catch (e) { st.qError = e.message || 'Could not load'; }
    st.qBusy = false;
    if (root && st.tab === 'quality') draw();
  }
  const share = (a, b) => (b ? Number(a || 0) / Number(b) : null);
  const p100 = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  function scoreOf(parts) {
    let w = 0, sum = 0;
    for (const x of parts) if (x.v != null) { w += x.w; sum += x.w * Math.max(0, Math.min(1, x.v)); }
    return w ? Math.round((sum / w) * 100) : null;
  }
  function parts(kind, c) {
    const k = c[kind] || {}, chk = c[`${kind}_check`] || {};
    const out = [
      { w: 40, label: 'Answered within 5 minutes', v: share(k.in_5, k.turns), tip: `${num(k.in_5)} of ${num(k.turns)} customer messages got a reply from a person within 5 minutes.` },
      { w: 20, label: 'Nobody left without an answer', v: k.turns ? 1 - share(k.missed, k.turns) : null, tip: `${num(k.missed)} customers got no answer within 24 hours (a plain “thanks” does not count).` },
      { w: 25, label: kind === 'support' ? 'Solved for real' : 'Completed for real', v: chk.checked ? 1 - share(chk.not_solved, chk.checked) : null,
        tip: `You reviewed ${num(chk.checked)} chats marked ${kind === 'support' ? 'solved' : 'complete'} in Radar and sent ${num(chk.not_solved)} back.` },
    ];
    if (kind === 'support') out.push({ w: 15, label: 'Customer did not have to come back', v: chk.marked ? 1 - share(chk.came_back, chk.marked) : null,
      tip: `After ${num(chk.came_back)} of ${num(chk.marked)} solves the customer wrote again within 48 hours.` });
    return out;
  }
  const grade = (s) => (s == null ? '' : s >= 85 ? 'good' : s >= 65 ? 'mid' : 'low');
  const gradeWord = (s) => (s == null ? 'No data yet' : s >= 85 ? 'Good' : s >= 65 ? 'Needs attention' : 'Poor');
  function ring(score) {
    const r = 34, c = 2 * Math.PI * r, v = score == null ? 0 : score / 100;
    return s('svg', { class: `tm-ring ${grade(score)}`, viewBox: '0 0 84 84', role: 'img', 'aria-label': score == null ? 'No score' : `Score ${score} of 100` },
      s('circle', { cx: 42, cy: 42, r, class: 'tm-ring-t' }),
      s('circle', { cx: 42, cy: 42, r, class: 'tm-ring-v', 'stroke-dasharray': `${c * v} ${c}`, transform: 'rotate(-90 42 42)' }),
      s('text', { x: 42, y: 47, 'text-anchor': 'middle', class: 'tm-ring-n' }, score == null ? '–' : String(score)));
  }
  function delta(cur, prev, opts = {}) {            // opts.lower = lower is better, opts.kind = 'pts' | 'pct'
    if (cur == null || prev == null || (!prev && opts.kind !== 'pts')) return null;
    const d = opts.kind === 'pts' ? Math.round((cur - prev) * (opts.scale || 1)) : prev ? Math.round(((cur - prev) / prev) * 100) : null;
    if (d == null || !Number.isFinite(d) || d === 0) return h('span', { class: 'tm-delta' }, 'same as the period before');
    const good = opts.neutral ? null : opts.lower ? d < 0 : d > 0;
    return h('span', { class: `tm-delta ${good == null ? '' : good ? 'good' : 'bad'}` }, `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${opts.kind === 'pts' ? ' pts' : '%'} vs the period before`);
  }
  function qTile(label, value, sub, tipText, cls = '') {
    return h('div', { class: `tm-tile ${cls}`, dataset: tipText ? { tip: `${label}\n${tipText}` } : null }, h('span', { class: 'tm-tile-l' }, label), h('b', { class: 'tm-tile-v' }, value), sub || null);
  }
  function scoreCard(title, kind, q) {
    const cur = parts(kind, q.cur), prev = parts(kind, q.prev);
    const sc = scoreOf(cur), ps = scoreOf(prev);
    return h('div', { class: `tm-card tm-score ${grade(sc)}` },
      h('div', { class: 'tm-score-h' }, ring(sc), h('div', null, h('h3', null, title), h('b', { class: `tm-grade ${grade(sc)}` }, gradeWord(sc)), delta(sc, ps, { kind: 'pts' }))),
      h('div', { class: 'tm-meters' }, cur.map((x) => { const g = x.v == null ? '' : grade(Math.round(x.v * 100));
        return h('div', { class: 'tm-m', dataset: { tip: `${x.label}\n${x.tip}\nCounts for ${x.w}% of the score.` } }, h('span', { class: 'tm-m-l' }, x.label), h('span', { class: 'tm-m-t' }, h('i', { class: g, style: `width:${x.v == null ? 0 : Math.max(2, x.v * 100)}%` })), h('b', { class: 'tm-m-v' }, p100(x.v))); })));
  }
  function attention(q) {
    const L = st.live && st.live.queue ? st.live.queue : q.live || {};
    const items = [];
    const al = q.alerts || [];
    const paid = al.filter((a) => a.kind === 'says_paid'), ready = al.filter((a) => a.kind === 'plan_chosen');
    const names = (list) => h('span', { class: 'tm-att-names' }, list.slice(0, 8).flatMap((a, i) => [i ? ', ' : null, chatLink(a.name, a.contact)]), list.length > 8 ? ` and ${list.length - 8} more` : null);
    if (L.over_60) items.push(['bad', `${plural(L.over_60, 'customer')} waiting over an hour`, h('button', { class: 'btn sm', onclick: () => { st.tab = 'live'; draw(); } }, 'See who')]);
    else if (L.over_15) items.push(['warn', `${plural(L.over_15, 'customer')} waiting over 15 minutes`, h('button', { class: 'btn sm', onclick: () => { st.tab = 'live'; draw(); } }, 'See who')]);
    if (paid.length) items.push(['bad', [`${plural(paid.length, 'customer says', 'customers say')} they paid and nothing was activated: `, names(paid)], null]);
    if (ready.length) items.push(['warn', [`${plural(ready.length, 'customer')} chose a plan and wait for payment details: `, names(ready)], null]);
    if (q.flags_open) items.push(['warn', `${plural(q.flags_open, 'finished chat')} waiting for your review`, h('button', { class: 'btn sm', onclick: () => { close(); if (U.openRadar) U.openRadar(); } }, 'Review')]);
    const f = q.followup_health;
    if (f) {
      const age = f.last_run_at ? U.now() - Date.parse(f.last_run_at) : Infinity;
      if (f.mode !== 'live') items.push(['warn', `Automatic follow-ups are not sending (mode: ${f.mode})`, null]);
      else if (age > 180000) items.push(['bad', `The follow-up engine has not run for ${age === Infinity ? 'a day' : U.dur(age)}`, null]);
      if (f.provider_paused) items.push(['bad', 'WhatsApp provider is refusing messages: automatic follow-ups are paused until it answers again', null]);
      if (f.gave_up_24h) items.push(['warn', `${plural(f.gave_up_24h, 'automatic follow-up')} could not be sent after 3 tries`, null]);
      if (f.labels_stuck) items.push(['warn', `${plural(f.labels_stuck, 'customer message')} the follow-up AI could not read`, null]);
    }
    return h('section', { class: 'tm-att' }, h('h3', null, 'Needs attention now'),
      items.length ? h('ul', null, items.map(([cls, text, btn]) => h('li', { class: cls }, U.icon(cls === 'bad' ? 'warn' : 'clock', 'sm'), h('span', null, text), btn)))
        : h('p', { class: 'tm-att-ok' }, U.icon('check', 'sm'), 'Nothing needs you right now.'));
  }
  function hoursCard(q) {
    const by = new Map((q.hours || []).map((x) => [x.h, x]));
    const rows = Array.from({ length: 24 }, (_, i) => by.get(i) || { h: i, turns: 0, median_s: null, in_5: 0 });
    const max = Math.max(...rows.map((r) => r.turns), 1);
    const lvl = (sv) => (sv == null ? 0 : sv <= 120 ? 1 : sv <= 300 ? 2 : sv <= 900 ? 3 : sv <= 1800 ? 4 : 5);
    const tipOf = (r) => `${hr(r.h)} – ${hr(r.h + 1)}\n${plural(r.turns, 'customer message')} to answer\n${r.median_s == null ? 'No answers measured' : `Typical answer after ${secs(r.median_s)} · ${pct(r.in_5, r.turns)} within 5 min`}`;
    return h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Hour by hour'), h('span', { class: 'muted' }, 'bars: customers writing · strip: how long they waited (darker = longer)')),
      h('div', { class: 'tm-hours' }, rows.map((r) => h('span', { class: 'tm-hr', dataset: { tip: tipOf(r) } }, h('i', { style: `height:${Math.max(r.turns ? 4 : 0, (r.turns / max) * 100)}%` })))),
      h('div', { class: 'tm-heat-row' }, rows.map((r) => h('span', { class: `tm-cell l${lvl(r.median_s)}`, dataset: { tip: tipOf(r) } }))),
      h('div', { class: 'tm-heat-axis', 'aria-hidden': 'true' }, [0, 6, 12, 18].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, hr(x)))));
  }
  function funnelCard(q) {
    const f = q.cur.funnel || {}, pf = q.prev.funnel || {};
    const steps = [['Sales chats', f.chats], ['Got a price', f.priced], ['Got payment details', f.pay_sent], ['Bought', f.bought]];
    const max = Math.max(...steps.map((x) => Number(x[1] || 0)), 1);
    return h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'From question to purchase'),
      h('span', { class: 'muted' }, f.priced ? `${pct(f.bought, f.priced)} of priced chats bought` : '')),
      h('div', { class: 'tm-hbars' }, steps.map(([label, v], i) => h('div', { class: 'tm-hbar wide', dataset: { tip: `${label}\n${num(v)}${i && steps[i - 1][1] ? ` · ${pct(v, steps[i - 1][1])} of the step before` : ''}` } },
        h('span', { class: 'tm-hbar-n' }, label), h('span', { class: 'tm-hbar-t' }, h('i', { style: `width:${Math.max(v ? 1.5 : 0, (Number(v || 0) / max) * 100)}%` })), h('span', { class: 'tm-hbar-v' }, num(v))))),
      h('p', { class: 'tm-foot' }, delta(share(f.bought, f.priced), share(pf.bought, pf.priced), { kind: 'pts', scale: 100 })));
  }
  function qualityTab(d) {
    const q = st.q;
    if (st.qKey !== `${st.from}|${st.to}` && !st.qBusy) { loadQuality(true); }
    if (!q) return [h('div', { class: 'tm-empty' }, st.qError ? [h('b', null, 'Could not load the quality report.'), h('div', null, st.qError), h('button', { class: 'btn', onclick: () => loadQuality() }, 'Try again')] : 'Calculating…')];
    const c = q.cur, p = q.prev, S = c.support || {}, PS = p.support || {}, L = c.sales || {}, PL = p.sales || {};
    const sc = c.support_check || {}, lc = c.sales_check || {}, fu = q.followup, f = c.funnel || {};
    const days = q.days || [], multi = days.length > 1;
    const minutes = (sv) => (sv == null ? 0 : Math.round(sv / 60));
    const staff = d ? [...d.staff].filter((x) => x.totals.sent || x.totals.solved || x.totals.sales_done || x.totals.audited) : [];
    const fh = q.followup_health;
    return [
      st.qError ? h('p', { class: 'tm-note warn' }, `Could not refresh (${st.qError}). Showing the last numbers.`) : null,
      q.to >= today() ? attention(q) : null,
      h('div', { class: 'tm-scores' }, scoreCard('Customer support', 'support', q), scoreCard('Sales', 'sales', q)),

      h('section', { class: 'tm-sec' }, h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Customer support'), h('p', { class: 'muted' }, 'Answer time = from a customer’s message to the next message a person on our side sent (automatic greetings and follow-ups do not count).'))),
        h('div', { class: 'tm-tiles' },
          qTile('Typical answer time', secs(S.median_s), delta(S.median_s, PS.median_s, { lower: true }), `Half of the ${num(S.answered)} answers were faster than this.`),
          qTile('Slow answers', secs(S.p90_s), delta(S.p90_s, PS.p90_s, { lower: true }), 'The slowest 10% of answers took longer than this.'),
          qTile('Never answered', num(S.missed), delta(S.missed, PS.missed, { lower: true }), 'Customers who got no answer within 24 hours.', S.missed ? 'bad' : ''),
          qTile('Chats solved', num(c.solved), delta(c.solved, p.solved, { neutral: true }), `${num(c.solved_msg)} with a closing message.`),
          qTile('Typical time to solve', secs(c.solve_median_s), delta(c.solve_median_s, p.solve_median_s, { lower: true }), 'From the start of the issue (or the customer writing again) to the solve.'),
          qTile('Sent back after review', num(sc.not_solved), h('span', { class: 'tm-tile-s' }, sc.checked ? `${pct(sc.not_solved, sc.checked)} of ${num(sc.checked)} reviewed` : 'nothing reviewed yet'), 'Solved chats you reviewed in Radar and sent back to Unresolved.', sc.not_solved ? 'bad' : '')),
        h('div', { class: 'tm-charts' },
          multi ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Typical answer time per day'), h('span', { class: 'muted' }, 'minutes')),
            columns(days, { unit: 'n', label: 'Support: typical answer time per day', value: (x) => minutes(x.sup_median_s), tip: (x) => `${dayName(x.day)}\nTypical answer after ${secs(x.sup_median_s)}\n${pct(x.sup_in_5, x.sup_turns)} of ${x.sup_turns} within 5 min` })) : null,
          multi ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Solved per day'), h('span', { class: 'muted' }, 'and how many you sent back')),
            columns(days, { unit: 'n', label: 'Support chats solved per day', value: (x) => x.solved, tip: (x) => `${dayName(x.day)}\n${x.solved} solved\n${x.problems} of ${x.checked} reviewed were sent back` })) : null)),

      h('section', { class: 'tm-sec' }, h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Sales'))),
        h('div', { class: 'tm-tiles' },
          qTile('Typical answer time', secs(L.median_s), delta(L.median_s, PL.median_s, { lower: true }), `Half of the ${num(L.answered)} answers were faster than this.`),
          qTile('Never answered', num(L.missed), delta(L.missed, PL.missed, { lower: true }), 'Sales customers who got no answer within 24 hours.', L.missed ? 'bad' : ''),
          qTile('Got a price', num(f.priced), delta(f.priced, (p.funnel || {}).priced, { neutral: true }), 'Chats in which a price was sent in this period.'),
          qTile('Bought', num(f.bought), delta(f.bought, (p.funnel || {}).bought), 'Purchases recorded in this period.'),
          qTile('Priced → bought', f.priced ? pct(f.bought, f.priced) : '–', null, 'Purchases in the period divided by prices sent in the period.'),
          qTile('Sent back after review', num(lc.not_solved), h('span', { class: 'tm-tile-s' }, lc.checked ? `${pct(lc.not_solved, lc.checked)} of ${num(lc.checked)} reviewed` : 'nothing reviewed yet'), 'Completed sales chats you reviewed in Radar and sent back.', lc.not_solved ? 'bad' : '')),
        h('div', { class: 'tm-charts' },
          funnelCard(q),
          multi ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Purchases per day')),
            columns(days, { unit: 'n', label: 'Purchases per day', value: (x) => x.bought, tip: (x) => `${dayName(x.day)}\n${x.bought} bought · ${x.priced} got a price` })) : null,
          h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'By product')),
            (q.products || []).length ? h('table', { class: 'tm-table' }, h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', { class: 'r' }, 'Got a price'), h('th', { class: 'r' }, 'Bought'))),
              h('tbody', null, q.products.map((x) => h('tr', null, h('td', null, x.product), h('td', { class: 'r' }, num(x.priced)), h('td', { class: 'r' }, num(x.bought)))))) : h('p', { class: 'muted' }, 'Nothing in this period.')))),

      fu ? h('section', { class: 'tm-sec' }, h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Automatic follow-ups'),
        h('p', { class: 'muted' }, fh ? `${fh.mode === 'live' ? 'Running' : 'Not sending (' + fh.mode + ')'}${fh.last_run_at ? ` · last run ${U.ago(fh.last_run_at)}` : ''} · ${plural(fh.planned, 'message')} booked · ${num(fh.sent_24h)} sent in the last 24 hours` : ''))),
        h('div', { class: 'tm-tiles' },
          qTile('Follow-ups sent', num(fu.sent), h('span', { class: 'tm-tile-s' }, `to ${plural(fu.chats, 'customer')}`)),
          qTile('Customer wrote back', fu.chats ? pct(fu.replied, fu.chats) : '–', h('span', { class: 'tm-tile-s' }, `${num(fu.replied)} of ${num(fu.chats)}`), 'The customer wrote within 24 hours after the follow-up.'),
          qTile('Bought afterwards', num(fu.bought), h('span', { class: 'tm-tile-s' }, fu.chats ? `${pct(fu.bought, fu.chats)} of followed-up customers` : '')),
          qTile('Could not be sent', num(fu.failed), null, 'Sends the provider refused, after all retries.', fu.failed ? 'bad' : ''),
          qTile('Too late to send', num(fu.window_missed), null, 'The 24-hour WhatsApp window closed before the follow-up was due.')),
        (fu.by_template || []).length ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Which wording works')),
          h('div', { class: 'tm-scroll' }, h('table', { class: 'tm-table wide' }, h('thead', null, h('tr', null, h('th', null, 'Message'), h('th', { class: 'r' }, 'Sent'), h('th', { class: 'r' }, 'Wrote back'), h('th', { class: 'r' }, 'Bought after'))),
            h('tbody', null, fu.by_template.map((x) => h('tr', null, h('td', { dir: 'auto' }, x.text || x.key), h('td', { class: 'r' }, num(x.sent)), h('td', { class: 'r' }, `${num(x.replied)} (${pct(x.replied, x.sent)})`), h('td', { class: 'r' }, num(x.bought)))))))) : null) : null,

      h('div', { class: 'tm-charts' }, hoursCard(q),
        h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Longest waits in this period'), h('span', { class: 'muted' }, 'over 30 minutes')),
          (q.slowest || []).length ? h('ul', { class: 'tm-wait' }, q.slowest.map((x) => h('li', null, h('span', { class: `tm-wait-t${x.wait_s > 3600 ? ' bad' : ' warn'}` }, secs(x.wait_s)), chatLink(x.name, x.contact),
            h('span', { class: 'muted' }, `${x.kind} · ${fDateTime.format(new Date(x.ts))}${x.answered_at ? '' : ' · still no answer'}`)))) : h('p', { class: 'muted' }, 'Nobody waited longer than 30 minutes.'))),

      staff.length ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Quality per person'), h('span', { class: 'muted' }, 'replies sent from the desk; replies from the BSB phone app cannot be told apart')),
        h('div', { class: 'tm-scroll' }, h('table', { class: 'tm-table wide' },
          h('thead', null, h('tr', null, ['Employee', 'Typical reply', 'Slow replies', 'Solved', 'Completed', 'Reviewed by you', 'Sent back', 'Customer came back'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
          h('tbody', null, staff.map((x) => { const t = x.totals, bad = t.flagged; return h('tr', null, h('td', null, x.name), h('td', { class: 'r' }, secs(t.reply_median_s)), h('td', { class: 'r' }, secs(t.reply_p90_s)),
            h('td', { class: 'r' }, num(t.solved)), h('td', { class: 'r' }, num(t.sales_done)), h('td', { class: 'r' }, num(t.checked)),
            h('td', { class: `r${t.checked && bad / t.checked > 0.15 ? ' tm-badcell' : ''}` }, t.checked ? `${num(bad)} (${pct(bad, t.checked)})` : '–'), h('td', { class: 'r' }, t.audited ? `${num(t.reopened)} (${pct(t.reopened, t.audited)})` : '–')); }))))) : null,
    ];
  }

  // ---------------------------------------------------------------- compare

  function compareTab(d, staff, single) {
    const medians = staff.filter((p) => p.totals.reply_n > 0);
    const teamDays = single ? [] : (() => {
      const m = new Map();
      for (const p of staff) for (const x of fillDays(p.days)) {
        const o = m.get(x.day) || { day: x.day, active_min: 0, sent: 0, solved: 0, sales_done: 0, flagged: 0 };
        o.active_min += x.active_min; o.sent += x.sent; o.solved += x.solved; o.sales_done += x.sales_done; o.flagged += x.flagged; m.set(x.day, o);
      }
      return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
    })();
    const rows = (f, tipf) => staff.map((p) => ({ name: p.name, v: f(p), tip: tipf ? tipf(p) : null })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    return [
      h('div', { class: 'tm-charts' },
        compare('Working time', '', rows((p) => p.totals.active_min, (p) => `Working ${hm(p.totals.active_min)} · desk open ${hm(p.totals.online_min)}`), hm),
        compare('Messages sent', '', rows((p) => p.totals.sent, (p) => `${p.totals.sent} sent to ${p.totals.chats} customers`), num),
        compare('Support chats solved', '', rows((p) => p.totals.solved), num),
        compare('Sales chats completed', '', rows((p) => p.totals.sales_done), num),
        compare('Typical reply time', 'shorter is better', medians.map((p) => ({ name: p.name, v: p.totals.reply_median_s, tip: `typical ${secs(p.totals.reply_median_s)} · slow replies ${secs(p.totals.reply_p90_s)} · ${p.totals.reply_n} replies` })).sort((a, b) => a.v - b.v), secs),
        compare('Sent back after your review', 'fewer is better', staff.map((p) => ({ name: p.name, v: p.totals.flagged, cls: 'bad', tip: `${p.totals.flagged} sent back · of ${p.totals.checked} you reviewed` })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v), num),
        teamDays.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Whole team: working time per day')),
          columns(teamDays, { unit: 'h', label: 'Team working time per day', value: (x) => x.active_min, tip: (x) => `${dayName(x.day)}\nWorking ${hm(x.active_min)} (everyone together)\n${x.sent} sent · ${x.solved} solved · ${x.sales_done} sales completed` })) : null,
        teamDays.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Whole team: messages sent per day')),
          columns(teamDays, { unit: 'n', label: 'Messages sent per day', value: (x) => x.sent, tip: (x) => `${dayName(x.day)}\n${x.sent} messages sent` })) : null),
      h('div', { class: 'tm-card' },
        h('div', { class: 'tm-card-h' }, h('b', null, 'All the numbers'), h('button', { class: 'btn sm', onclick: () => downloadCsv(d, staff) }, U.icon('file', 'sm'), 'Download as spreadsheet')),
        h('div', { class: 'tm-scroll' }, h('table', { class: 'tm-table wide' },
          h('thead', null, h('tr', null, ['Employee', 'Working time', 'Desk open', 'Messages', 'Customers', 'Solved', 'Sales completed', 'Typical reply', 'Reviewed by you', 'Sent back'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
          h('tbody', null, staff.map((p) => { const t = p.totals; return h('tr', null, h('td', null, p.name), h('td', { class: 'r' }, hm(t.active_min)), h('td', { class: 'r' }, hm(t.online_min)), h('td', { class: 'r' }, num(t.sent)),
            h('td', { class: 'r' }, num(t.chats)), h('td', { class: 'r' }, num(t.solved)), h('td', { class: 'r' }, num(t.sales_done)), h('td', { class: 'r' }, secs(t.reply_median_s)), h('td', { class: 'r' }, num(t.checked)), h('td', { class: 'r' }, num(t.flagged))); }))))),
    ];
  }
  function downloadCsv(d, staff) {
    const cols = [['Employee', (p) => p.name], ['Working minutes', (p) => p.totals.active_min], ['Desk open minutes', (p) => p.totals.online_min], ['Days worked', (p) => p.totals.days_active],
      ['Messages sent', (p) => p.totals.sent], ['Customers messaged', (p) => p.totals.chats], ['Support solved', (p) => p.totals.solved], ['Sales completed', (p) => p.totals.sales_done],
      ['Typical reply seconds', (p) => p.totals.reply_median_s ?? ''], ['Reviewed by you', (p) => p.totals.checked], ['Sent back after review', (p) => p.totals.flagged],
      ['Customer came back', (p) => p.totals.reopened]];
    // a cell starting with = + - @ would run as a formula in a spreadsheet: keep it text
    const esc = (v) => { let x = String(v); if (/^[=+\-@]/.test(x) && typeof v !== 'number') x = "'" + x; return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const csv = [cols.map((c) => c[0]), ...staff.map((p) => cols.map((c) => c[1](p)))].map((r) => r.map(esc).join(',')).join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `team-${d.from}_${d.to}.csv` });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- screen

  function draw() {
    if (!root) return;
    const d = st.data;
    const oldBody = root.querySelector('.tm-body');
    const keepScroll = oldBody && oldBody.dataset.tab === st.tab ? oldBody.scrollTop : 0;
    const oldList = root.querySelector('.tm-rv-list'), oldConv = root.querySelector('.tm-rv-scroll');
    const listTop = oldList ? oldList.scrollTop : 0;
    if (oldConv && st.threadTop !== null) st.threadTop = oldConv.scrollTop;
    const from = h('input', { type: 'date', value: st.from, max: today(), 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: st.to, max: today(), 'aria-label': 'To' });
    const custom = () => { if (from.value && to.value && from.value <= to.value) { st.preset = ''; st.from = from.value; st.to = to.value; st.logMore = false; load(); } };
    from.addEventListener('change', custom); to.addEventListener('change', custom);
    const head = h('header', { class: 'tm-head' },
      h('div', { class: 'tm-head-1' },
        h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', h('kbd', null, 'Esc')),
        h('h2', null, 'Team & quality'),
        st.tab === 'live' ? h('span', { class: 'tm-livedot' }, h('i'), 'Live · updates every 10 seconds') : h('div', { class: 'tm-range', role: 'group', 'aria-label': 'Period' },
          PRESETS.map(([k, l]) => h('button', { class: `tm-tab${st.preset === k ? ' on' : ''}`, onclick: () => { setPreset(k); st.logMore = false; load(); } }, l)),
          h('span', { class: 'tm-dates' }, from, h('span', { class: 'muted' }, 'to'), to)),
        h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => { if (st.tab === 'live') loadLive(); else { load(); if (st.tab === 'quality') loadQuality(false, true); if (st.tab === 'people') window.DeskPeople.refresh(); } } }, U.icon('refresh'))),
      h('nav', { class: 'tm-tabs', role: 'tablist' }, [['live', 'clock', 'Live'], ['quality', 'check', 'Quality'], ['people', 'team', 'People'], ['compare', 'chart', 'Compare']].map(([k, ic, l]) =>
        h('button', { class: `tm-maintab${st.tab === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.tab === k), onclick: () => { st.tab = k; if (k === 'live') loadLive(); draw(); } },
          U.icon(ic, 'sm'), l))));

    let body;
    if (st.tab === 'live') body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-wrap' }, liveTab().flat(Infinity)));
    else if (st.tab === 'people') body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-wrap' },
      h('p', { class: 'tm-period' }, st.from === st.to ? dayName(st.from) : `${dayName(st.from)} – ${dayName(st.to)}`, h('span', { class: 'muted' }, ' · Beirut time')),
      window.DeskPeople.view({ U, from: st.from, to: st.to, redraw: draw, dayLog, hourHeat }).flat(Infinity)));
    else if (!d) body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load the report.'), h('div', null, st.error), h('button', { class: 'btn', onclick: () => load() }, 'Try again')] : 'Loading…'));
    else {
      const single = d.from === d.to;
      const staff = [...d.staff].sort((a, b) => (b.totals.active_min - a.totals.active_min) || (b.totals.sent - a.totals.sent) || a.name.localeCompare(b.name));
      const parts = st.tab === 'quality' ? qualityTab(d) : compareTab(d, staff, single);
      body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-wrap' },
        st.error ? h('p', { class: 'tm-note warn' }, `Could not refresh (${st.error}). Showing the last numbers.`) : null,
        h('p', { class: 'tm-period' }, single ? dayName(d.from) : `${dayName(d.from)} – ${dayName(d.to)}`, h('span', { class: 'muted' }, ' · Beirut time')),
        parts.flat(Infinity)));
    }
    const undo = root.querySelector('.tm-undo');
    root.replaceChildren(head, body);
    if (undo) root.append(undo);
    root.classList.toggle('busy', st.loading);
    body.scrollTop = keepScroll;
    // the review desk keeps its place: list position, and the conversation stays where it was read
    const list = root.querySelector('.tm-rv-list'), conv = root.querySelector('.tm-rv-scroll');
    if (list) {
      list.scrollTop = listTop;
      const on = list.querySelector('.tm-rv-row.on');
      if (on && st.selScroll) { on.scrollIntoView({ block: 'nearest' }); st.selScroll = false; }
    }
    if (conv) {
      if (st.threadTop !== null) conv.scrollTop = st.threadTop;
      else if (conv._conv && conv._conv._mark) { conv.scrollTop = 0; st.threadTop = 0; }   // the mark first; the rest is one scroll away
    }
  }

  function onKey(e) {
    if (!root) return;
    // the desk's own shortcuts (J, K, V, Tab, arrows...) stay off while this screen is open
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (st.tab === 'people' && window.DeskPeople.key(e)) e.preventDefault();
  }
  function open(helpers, opts = {}) {
    U = helpers;
    if (root) return;
    if (!st.from) setPreset('today');
    if (opts.tab) st.tab = opts.tab;
    if (st.tab === 'ai') st.tab = 'live';   // Radar moved to its own screen (js/radar.js)
    root = h('div', { class: 'team-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Team activity' });
    document.body.append(root);
    bindTip(root);
    document.addEventListener('keydown', onKey, true);
    draw();
    load();
    loadLive();
    liveTimer = setInterval(() => { if (root && !document.hidden && (st.tab === 'live' || st.tab === 'quality')) loadLive(); }, 10000);
  }
  function close() {
    if (!root) return;
    clearTimeout(timer); clearInterval(liveTimer);
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (tip) { tip.remove(); tip = null; }
  }

  window.DeskTeam = { open, close };
})();
