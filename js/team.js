/* Teshrij Desk — Team activity (admins only), v2.
 *
 * Three tabs, in plain words:
 *   People    who is working now, how long each person worked and when, what they got done
 *   AI check  chats that were marked solved / complete but were not (the AI scanner's findings),
 *             per employee, with the conversation one click away and a yes / no for the admin
 *   Compare   the same numbers side by side, and per day
 * All numbers come from the server (op team_report); this file only draws them. Times are Beirut time.
 */
(function () {
  'use strict';
  let U = null;            // helpers handed over by app.js
  let root = null;
  let timer = null;
  const st = {
    tab: 'people', preset: 'today', from: '', to: '', data: null, loading: false, error: '',
    open: new Set(), filter: 'open', person: 0, logMore: false, scanning: false, scanLeft: null, stopScan: false,
    sel: null, selScroll: false, threadTop: null,
  };

  const TZ = 'Asia/Beirut';
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const today = () => fDay.format(new Date(U.now()));
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayName = (day) => fShort.format(new Date(day + 'T00:00:00Z'));
  const hm = (min) => { const m = Math.max(0, Math.round(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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
  const CATEGORY = {
    still_broken: 'It was still not working', unanswered_question: 'A question was left unanswered', promise_not_kept: 'A promise was not kept',
    customer_waiting: 'The customer was left waiting', no_reply_at_all: 'Nobody replied to the customer', none: 'It was not finished',
  };
  const isFinding = (c) => c.status === 'flagged' || c.status === 'doubt';
  const custName = (c) => c.name && /[\p{L}\p{N}]/u.test(c.name) ? c.name : c.handle ? '@' + c.handle : /^\d+$/.test(c.contact) ? '+' + c.contact : 'Instagram user';

  // ---------------------------------------------------------------- data

  async function load(quiet = false) {
    if (st.loading) return;
    st.loading = true;
    if (!quiet) { st.error = ''; draw(); }
    try { st.data = await U.api.call('team_report', { from: st.from, to: st.to }); st.error = ''; }
    catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    draw();
    schedule();
  }
  // While the scanner still has chats to read the screen refreshes every 15 s, otherwise every minute.
  function schedule() {
    clearTimeout(timer);
    if (!root) return;
    const busy = st.data && st.data.scanner && st.data.scanner.queued > 0;
    timer = setTimeout(() => { if (document.hidden || st.scanning || pendingAns) schedule(); else load(true); }, busy ? 20000 : 60000);
  }
  // "Check now": batch after batch until nothing is left (or the admin stops it).
  async function scanNow() {
    if (st.scanning) { st.stopScan = true; return; }
    st.scanning = true; st.stopScan = false; st.scanLeft = st.data ? st.data.scanner.queued : null; draw();
    let total = 0, found = 0, idle = 0;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      while (root && !st.stopScan) {
        const r = await U.api.call('audit_run');
        if (r.off) { U.toast('The AI check is switched off (no AI key on the server)', 'error'); break; }
        if (r.busy) { if (++idle > 20) break; await wait(4000); continue; }
        total += r.checked || 0; found += (r.flagged || 0) + (r.doubt || 0);
        st.scanLeft = r.left;
        draw();
        if (!r.left) break;
        if (!r.checked) { if (++idle > 3) break; await wait(5000); } else idle = 0;
      }
      U.toast(total ? `Checked ${plural(total, 'chat')}${found ? ` · ${plural(found, 'problem')} found` : ' · no problems found'}` : 'Nothing new to check', found ? '' : 'ok');
    } catch (e) { U.toast(`The check stopped: ${e.message}`, 'error'); }
    st.scanning = false; st.scanLeft = null;
    load(true);
  }
  async function retryErrors() {
    try { const r = await U.api.call('audit_retry'); U.toast(`Trying ${plural(r.retried || 0, 'chat')} again`); load(true); }
    catch (e) { U.toast(e.message, 'error'); }
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
  // One day as a 24 h strip: working minutes dark, desk open without input light.
  function strip(day, label) {
    const svg = s('svg', { class: 'tm-strip', viewBox: '0 0 1440 20', preserveAspectRatio: 'none', role: 'img',
      'aria-label': `${label}: working ${hm(day.active_min)}, desk open ${hm(day.online_min)}` });
    svg.append(s('rect', { x: 0, y: 0, width: 1440, height: 20, class: 'tm-track' }));
    for (const [a, b, on] of day.segs || []) {
      const w = Math.max(b - a, 2.5);
      const r = s('rect', { x: Math.min(a, 1440 - w), y: 0, width: w, height: 20, class: on ? 'tm-on' : 'tm-idle' });
      r.dataset.tip = `${clock(a)} – ${clock(b)}\n${on ? 'Working' : 'Desk open, not touching it'} · ${hm(b - a)}`;
      svg.append(r);
    }
    return svg;
  }
  function stripAxis() {
    return h('div', { class: 'tm-axis', 'aria-hidden': 'true' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, `${String(x).padStart(2, '0')}:00`)));
  }
  function legend() {
    return h('span', { class: 'tm-legend' }, h('i', { class: 'on' }), 'Working', h('i', { class: 'idle' }), 'Desk open, not touching it', h('i', { class: 'off' }), 'Away');
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
        return h('span', { class: `tm-cell l${lvl}`, dataset: { tip: `${String(i).padStart(2, '0')}:00 – ${String(i + 1).padStart(2, '0')}:00\n${v ? hm(v) + ' working' : 'Not working'}` } });
      })),
      h('div', { class: 'tm-heat-axis', 'aria-hidden': 'true' }, [0, 6, 12, 18].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, `${String(x).padStart(2, '0')}:00`))));
  }
  // Horizontal bars comparing employees on one measure.
  function compare(title, sub, rows, fmt) {
    const max = Math.max(...rows.map((r) => r.v), 1);
    return h('div', { class: 'tm-card' },
      h('div', { class: 'tm-card-h' }, h('b', null, title), sub ? h('span', { class: 'muted' }, sub) : null),
      rows.length ? h('div', { class: 'tm-hbars' }, rows.map((r) => h('div', { class: 'tm-hbar', dataset: { tip: `${r.name}\n${r.tip || fmt(r.v)}` } },
        h('span', { class: 'tm-hbar-n' }, r.name),
        h('span', { class: 'tm-hbar-t' }, h('i', { class: r.cls || '', style: `width:${Math.max(r.v ? 1.5 : 0, (r.v / max) * 100)}%` })),
        h('span', { class: 'tm-hbar-v' }, fmt(r.v))))) : h('p', { class: 'muted' }, 'Nothing in this period.'));
  }

  // ---------------------------------------------------------------- people

  // Work sessions of one day: stretches of presence with no gap longer than 10 minutes.
  function sessions(day) {
    const out = [];
    for (const [a, b, on] of day.segs || []) {
      const last = out[out.length - 1];
      if (last && a - last.end <= 10) { last.end = b; if (on) last.active += b - a; }
      else out.push({ start: a, end: b, active: on ? b - a : 0 });
    }
    return out.filter((x) => x.end - x.start >= 2 || x.active > 0);
  }
  function presence(p) {
    const n = U.now();
    const act = p.last_active_at ? n - Date.parse(p.last_active_at) : Infinity;
    const open = p.last_open_at ? n - Date.parse(p.last_open_at) : Infinity;
    if (act < 180000) return { cls: 'on', text: 'Working now' };
    if (open < 180000) return { cls: 'idle', text: act === Infinity ? 'Desk open, not touching it' : `Desk open, not touching it for ${U.dur(act)}` };
    const last = p.last_active_at || p.last_open_at || p.last_seen_at;
    return { cls: '', text: last ? `Away · last here ${fDay.format(new Date(last)) === today() ? 'at ' + fTime.format(new Date(last)) : U.ago(last)}` : 'Has not opened the desk yet' };
  }
  function presenceEl(p) { const x = presence(p); return h('span', { class: `tm-pres ${x.cls}` }, h('i'), x.text); }
  // The period in one sentence.
  function story(p, single, d) {
    const t = p.totals;
    if (!t.active_min && !t.online_min) return single ? 'Did not work on the desk this day.' : 'Did not work on the desk in this period.';
    if (!single) return `Worked ${hm(t.active_min)} over ${plural(t.days_active, 'day')} — about ${hm(t.active_min / Math.max(1, t.days_active))} a day.`;
    const ss = sessions(d);
    if (!ss.length) return `Worked ${hm(t.active_min)}.`;
    const breaks = [];
    for (let i = 1; i < ss.length; i++) breaks.push(ss[i].start - ss[i - 1].end);
    const longest = breaks.length ? Math.max(...breaks) : 0;
    return `Worked ${hm(t.active_min)}, between ${clock(ss[0].start)} and ${clock(ss[ss.length - 1].end)}`
      + (breaks.length ? `, with ${plural(breaks.length, 'break')} (longest ${hm(longest)}).` : ', without a break.');
  }
  function big(value, label, tipText, cls = '') {
    return h('div', { class: `tm-n ${cls}`, dataset: tipText ? { tip: `${label}\n${tipText}` } : null }, h('b', null, value), h('span', null, label));
  }
  function findingsPill(t, onclick) {
    const n = t.flagged + t.doubt;
    if (n) return h('button', { class: `tm-flag${t.flagged ? '' : ' soft'}`, title: 'See these chats', onclick }, U.icon('warn', 'xs'), `${plural(n, 'problem')} found`);
    if (t.pending) return h('span', { class: 'tm-okpill' }, `AI still checking ${num(t.pending)}`);
    return h('span', { class: 'tm-okpill good' }, U.icon('check', 'xs'), t.checked ? 'No problems found' : 'Nothing to check');
  }
  function statGroup(title, rows) {
    return h('div', { class: 'tm-sg' }, h('h5', null, title), rows.map(([label, value, tipText]) => h('div', { class: 'tm-stat', dataset: tipText ? { tip: `${label}\n${tipText}` } : null }, h('span', null, label), h('b', null, value))));
  }
  function fillDays(days) {
    const by = new Map(days.map((d) => [d.day, d]));
    const out = [];
    for (let d = st.data.from; d <= st.data.to; d = addDays(d, 1)) out.push(by.get(d) || { day: d, active_min: 0, online_min: 0, sent: 0, solved: 0, sales_done: 0, flagged: 0, segs: [] });
    return out;
  }
  function employee(p, single, maxActive) {
    const t = p.totals;
    const isOpen = st.open.has(p.id);
    const day0 = single ? (p.days[0] || { active_min: 0, online_min: 0, segs: [] }) : null;
    const toggle = () => { if (isOpen) st.open.delete(p.id); else st.open.add(p.id); draw(); };
    const head = h('div', { class: 'tm-emp-h' },
      h('div', { class: 'av', style: `background:${U.avColor(p.name)}` }, U.initials({ name: p.name })),
      h('div', { class: 'tm-emp-who' },
        h('b', null, p.name, p.role === 'admin' ? h('span', { class: 'role' }, 'admin') : null, p.active ? null : h('span', { class: 'role' }, 'access removed')),
        presenceEl(p)),
      h('div', { class: 'tm-emp-nums' },
        h('div', { class: 'tm-n main', dataset: { tip: 'Working time\nMinutes in which this person used the keyboard, mouse or touch screen on the desk, or did something (sent, solved, labelled).' } },
          h('b', null, hm(t.active_min)), h('span', null, 'working time'),
          h('span', { class: 'tm-meter' }, h('i', { style: `width:${maxActive ? (t.active_min / maxActive) * 100 : 0}%` }))),
        big(num(t.sent), 'messages sent', `To ${plural(t.chats, 'customer')}.`),
        big(num(t.solved), 'support solved', `${num(t.solved_msg)} with a closing message, ${num(t.solved - t.solved_msg)} without.`),
        big(num(t.sales_done), 'sales completed', 'Sales chats marked complete.'),
        big(secs(t.reply_median_s), 'typical reply time', t.reply_n ? `Half of the replies were faster than this (${num(t.reply_n)} replies). The slowest 10% took longer than ${secs(t.reply_p90_s)}.` : 'No replies to a waiting customer in this period.'),
        findingsPill(t, () => { st.tab = 'ai'; st.person = p.id; st.filter = 'open'; st.sel = null; draw(); })),
      h('button', { class: 'btn sm ghost tm-more', 'aria-expanded': String(isOpen), onclick: toggle }, isOpen ? 'Less' : 'Details', h('span', { class: `tm-chev${isOpen ? ' up' : ''}` }, U.icon('chev'))));

    const body = [h('p', { class: 'tm-story' }, story(p, single, day0))];
    if (single && (day0.segs || []).length) body.push(h('div', { class: 'tm-day pad' }, strip(day0, p.name), stripAxis()));
    if (isOpen) {
      const days = fillDays(p.days);
      const ss = single ? sessions(day0) : [];
      body.push(h('div', { class: 'tm-detail' },
        single && ss.length ? h('div', { class: 'tm-sessions' }, h('h5', null, 'The day, step by step'),
          h('ol', null, ss.flatMap((x, i) => [
            i ? h('li', { class: 'brk' }, `${clock(ss[i - 1].end)} – ${clock(x.start)}`, h('span', null, `away ${hm(x.start - ss[i - 1].end)}`)) : null,
            h('li', null, `${clock(x.start)} – ${clock(x.end)}`, h('span', null, `at the desk ${hm(x.end - x.start)} · working ${hm(x.active)}`))]))) : null,
        h('div', { class: 'tm-sgs' },
          statGroup('Time', [
            ['Working time', hm(t.active_min), 'Minutes with keyboard, mouse or touch input, or an action.'],
            ['Desk open', hm(t.online_min), 'Minutes the desk was open in a browser, used or not.'],
            ['Days worked', String(t.days_active)]]),
          statGroup('Messages', [
            ['Customers messaged', num(t.chats)], ['Text replies', num(t.replies)], ['Photos, files, voice notes', num(t.media)],
            ['Closing messages', num(t.closers)], ['Messages that failed to send', num(t.failed)]]),
          statGroup('Speed', [
            ['Typical reply time', secs(t.reply_median_s), 'Half of the replies were faster than this.'],
            ['Slow replies', secs(t.reply_p90_s), 'The slowest 10% of replies took longer than this.'],
            ['Replies measured', num(t.reply_n), 'Replies sent straight after a customer message.']]),
          statGroup('Quality', [
            ['Chats checked by the AI', `${num(t.checked)} of ${num(t.audited)}`],
            ['Not solved', num(t.flagged), 'The AI is sure these were marked solved / complete too early.'],
            ['Please check', num(t.doubt), 'The AI suspects these, but is not sure.'],
            ['Customer came back', `${num(t.reopened)} of ${num(t.audited)}`, 'The customer wrote again within 48 hours of the solve.'],
            ['Solved despite a warning', num(t.overrides), 'The desk said "this does not look solved" and they solved it anyway.'],
            ['You agreed / disagreed', `${num(t.confirmed)} / ${num(t.dismissed)}`, 'Findings you confirmed, and findings you marked as fine.']])),
        h('div', { class: 'tm-charts' },
          days.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Working time per day')),
            columns(days, { unit: 'h', label: `${p.name}: working time per day`, value: (d) => d.active_min,
              tip: (d) => `${dayName(d.day)}\nWorking ${hm(d.active_min)} · desk open ${hm(d.online_min)}\n${d.first_at ? `${fTime.format(new Date(d.first_at))} – ${fTime.format(new Date(d.last_at))}` : 'Not at the desk'}` })) : null,
          days.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Chats solved and completed per day')),
            columns(days, { unit: 'n', label: `${p.name}: chats solved and completed per day`, value: (d) => d.solved + d.sales_done,
              tip: (d) => `${dayName(d.day)}\n${d.solved} solved · ${d.sales_done} sales completed\n${d.sent} messages sent${d.flagged ? ` · ${d.flagged} problems found` : ''}` })) : null,
          h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Usual working hours'), h('span', { class: 'muted' }, 'darker = more work')), hourHeat(p.hours || {}))),
        !single && p.days.length ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Day by day'), legend()),
          h('div', { class: 'tm-daylist' }, [...p.days].reverse().map((d) => h('div', { class: 'tm-dayrow' },
            h('span', { class: 'tm-dayrow-d' }, dayName(d.day)), h('div', { class: 'tm-day' }, strip(d, `${p.name} ${d.day}`)),
            h('span', { class: 'tm-dayrow-v' }, hm(d.active_min))))), h('div', { class: 'tm-dayrow' }, h('span', { class: 'tm-dayrow-d' }), stripAxis(), h('span', { class: 'tm-dayrow-v' }))) : null));
    }
    return h('section', { class: `tm-emp${isOpen ? ' open' : ''}` }, head, body);
  }
  function tile(label, value, sub, cls = '', onclick = null) {
    return h(onclick ? 'button' : 'div', { class: `tm-tile ${cls}`, onclick }, h('span', { class: 'tm-tile-l' }, label), h('b', { class: 'tm-tile-v' }, value), sub ? h('span', { class: 'tm-tile-s' }, sub) : null);
  }
  function peopleTab(d, staff, single) {
    const sum = (k) => staff.reduce((n, p) => n + Number(p.totals[k] || 0), 0);
    const maxActive = Math.max(...staff.map((p) => p.totals.active_min), 0);
    const problems = sum('flagged') + sum('doubt');
    const since = d.tracking_since ? Date.parse(d.tracking_since) : null;
    const partial = !since || since > Date.parse(d.from + 'T00:00:00Z');
    const showNow = d.to >= today();
    return [
      h('div', { class: 'tm-tiles' },
        tile('Working time', hm(sum('active_min')), `${staff.filter((p) => p.totals.active_min > 0).length} of ${staff.filter((p) => p.active).length} people worked`),
        tile('Messages sent', num(sum('sent')), `to ${plural(sum('chats'), 'customer')}`),
        tile('Support chats solved', num(sum('solved'))),
        tile('Sales chats completed', num(sum('sales_done'))),
        tile('Typical reply time', secs(d.team && d.team.reply_n ? d.team.reply_median_s : null), 'customer message → our reply'),
        tile('Problems found by the AI', num(problems), problems ? 'Click to see them' : sum('pending') ? `still checking ${plural(sum('pending'), 'chat')}` : 'none', problems ? 'bad click' : '', problems ? () => { st.tab = 'ai'; st.person = 0; st.filter = 'open'; st.sel = null; draw(); } : null)),
      partial ? h('p', { class: 'tm-note warn' }, since
        ? `Exact minute-by-minute tracking started ${fDateTime.format(new Date(since))}. Before that, working time only counts the minutes in which someone sent, solved or labelled something, so it reads lower than the truth.`
        : 'Exact minute-by-minute tracking starts as people use the desk; until then working time only counts minutes with a sent message, a solve or a label.') : null,
      showNow ? h('section', { class: 'tm-now' }, h('h3', null, 'Right now'),
        h('div', { class: 'tm-now-row' }, staff.filter((p) => p.active).map((p) => { const x = presence(p); return h('div', { class: `tm-nowc ${x.cls}` },
          h('div', { class: 'av sm', style: `background:${U.avColor(p.name)}` }, U.initials({ name: p.name })), h('div', null, h('b', null, p.name), h('span', null, x.text))); }))) : null,
      h('section', { class: 'tm-sec' },
        h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Each person'),
          h('p', { class: 'muted' }, single ? 'The bar is the day from midnight to midnight. Move the mouse over it to see exact times.' : 'Press Details for charts and the day-by-day timeline.')), single ? legend() : null),
        staff.map((p) => employee(p, single, maxActive))),
    ];
  }

  // ---------------------------------------------------------------- AI check: a review desk
  // Left: the chats to look at. Right: what the AI found and the conversation it read.
  // Keys: J / K (or arrows) move, V = it was fine, C = mark unsolved (the chat goes back to Unresolved),
  // Z undoes the last answer, O opens the chat in the desk.

  function factChips(c) {
    const g = c.signals || {}, out = [];
    if (c.reopened_at) out.push(['warn', `Customer wrote again ${g.reopened_after_s != null && g.reopened_after_s < 5400 ? (g.reopened_after_s < 90 ? 'within a minute' : `${Math.round(g.reopened_after_s / 60)} min later`) : fDateTime.format(new Date(c.reopened_at))}`]);
    if (g.unanswered) out.push(['warn', 'Customer’s last message got no reply']);
    if (g.staff_replies === 0) out.push(['warn', 'Nobody replied in this chat']);
    if (g.warned) out.push(['warn', 'The desk warned “not solved” — solved anyway']);
    if (g.bulk) out.push(['', `One of ${g.bulk} chats solved within a minute`]);
    if (g.earlier_solves) out.push(['', `Marked finished ${g.earlier_solves}× before this week`]);
    if (c.still_open) out.push(['', 'Open again now']);
    const m = c.media || {};
    const read = [m.messages ? `read ${plural(m.messages, 'message')}` : '', m.voice ? `heard ${plural(m.voice, 'voice note')}` : '', m.images ? `saw ${plural(m.images, 'photo')}` : ''].filter(Boolean);
    if (read.length) out.push(['quiet', `AI ${read.join(', ')}`]);
    if (m.voice_failed) out.push(['quiet', `${plural(m.voice_failed, 'voice note')} could not be heard`]);
    return out.map(([cls, text]) => h('span', { class: `tm-chip ${cls}` }, text));
  }
  const RESULT = {
    ok: ['good', 'Looks solved'], flagged: ['sure', 'Not solved'], doubt: ['maybe', 'Please check'], queued: ['wait', 'Waiting for the AI'],
    error: ['err', 'Could not be checked'], skipped: ['wait', 'Taken back by staff'],
  };
  const REVIEWED = { confirmed: 'You marked it unsolved', dismissed: 'You said it was fine' };
  const NEED = { done: ['good', '✓'], not_done: ['sure', '✗'], customer_dropped_it: ['wait', '–'], unknown: ['wait', '?'] };

  // which chats the list shows
  function reviewRows(d) {
    const checks = d.checks || [];
    const mine = (c) => !st.person || c.staff_id === st.person;
    const sets = {
      open: checks.filter((c) => isFinding(c) && !c.review),
      confirmed: checks.filter((c) => c.review === 'confirmed'),
      dismissed: checks.filter((c) => c.review === 'dismissed'),
      all: checks,
    };
    const order = (a, b) => (st.filter === 'open' ? (b.status === 'flagged') - (a.status === 'flagged') : 0) || Date.parse(b.solved_at) - Date.parse(a.solved_at);
    const counts = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.filter(mine).length]));
    return { rows: (sets[st.filter] || sets.open).filter(mine).sort(order), counts, checks };
  }
  let rvRows = [];             // the list as drawn (the keyboard moves through it)
  const details = new Map();   // audit id -> {key, data | error | loading}
  function loadDetail(c, then) {
    const key = `${c.id}|${c.checked_at}|${c.status}`;
    const hit = details.get(c.id);
    if (hit && hit.key === key) return hit;
    const entry = { key, loading: true };
    details.set(c.id, entry);
    if (details.size > 40) details.delete(details.keys().next().value);
    U.api.call('audit_detail', { id: c.id }).then((data) => { entry.data = data; }, (e) => { entry.error = e.message; })
      .finally(() => { entry.loading = false; if (then) then(); });
    return entry;
  }
  function select(id, scroll = true) {
    if (st.sel === id) return;
    st.sel = id; st.selScroll = scroll; st.threadTop = null;
    draw();
  }
  function move(dir) {
    if (!rvRows.length) return;
    const i = rvRows.findIndex((c) => c.id === st.sel);
    const n = rvRows[Math.max(0, Math.min(rvRows.length - 1, i < 0 ? 0 : i + dir))];
    if (n) select(n.id);
  }
  // An answer is shown at once and sent 5 seconds later, so Z can take it back before anything changes.
  let pendingAns = null;
  function flushAnswer() {
    if (!pendingAns) return;
    const p = pendingAns; pendingAns = null;
    clearTimeout(p.timer); p.bar.remove();
    (p.value === 'unsolved' ? U.api.call('audit_unsolve', { id: p.c.id }) : U.api.call('audit_review', { id: p.c.id, review: p.value }))
      .then((r) => { if (p.value === 'unsolved' && r && r.how === 'already') U.toast(`${custName(p.c)} is already back in Unresolved`); load(true); },
        (e) => { p.c.review = p.was; draw(); U.toast(`Not saved: ${e.message}`, 'error'); });
  }
  function undoAnswer() {
    if (!pendingAns) return false;
    const p = pendingAns; pendingAns = null;
    clearTimeout(p.timer); p.bar.remove();
    p.c.review = p.was;
    st.sel = p.c.id; st.selScroll = true; st.threadTop = null;
    draw();
    return true;
  }
  function answer(c, value) {            // value: 'dismissed' (V) | 'unsolved' (C) | null (change my answer)
    if (!c) return;
    flushAnswer();
    const was = c.review;
    const i = rvRows.findIndex((x) => x.id === c.id);
    const next = rvRows[i + 1] || rvRows[i - 1] || null;
    c.review = value === 'unsolved' ? 'confirmed' : value;
    const text = value === 'unsolved' ? [h('b', null, custName(c)), ' marked unsolved · it goes back to Unresolved']
      : value === 'dismissed' ? [h('b', null, custName(c)), ' was fine'] : [h('b', null, custName(c)), ' · answer removed'];
    const bar = h('div', { class: 'undo tm-undo', role: 'status' },
      h('div', { class: 'undo-bar' }, h('div', { class: 'undo-text' }, h('div', null, text)),
        h('button', { class: 'btn sm', onclick: undoAnswer }, 'Undo', h('kbd', null, 'Z'))),
      h('div', { class: 'undo-progress' }, h('i', { style: 'animation-duration:5000ms' })));
    root.append(bar);
    pendingAns = { c, value, was, bar, timer: setTimeout(flushAnswer, 5000) };
    // the answered chat leaves the "to review" list: go on with the next one
    if (st.filter === 'open' && next) { st.sel = next.id; st.selScroll = true; st.threadTop = null; }
    draw();
  }
  function openInDesk(c) { if (!c) return; flushAnswer(); close(); U.openChat(c.contact); }
  function reviewKey(e) {
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const cur = rvRows.find((c) => c.id === st.sel);
    switch (e.key) {
      case 'j': case 'J': case 'ArrowDown': move(1); return true;
      case 'k': case 'K': case 'ArrowUp': move(-1); return true;
      case 'v': case 'V': if (cur) answer(cur, 'dismissed'); return true;
      case 'c': case 'C': if (cur) answer(cur, 'unsolved'); return true;
      case 'z': case 'Z': undoAnswer(); return true;
      case 'o': case 'O': case 'Enter': openInDesk(cur); return true;
      default: return false;
    }
  }

  function listRow(c) {
    const [cls, label] = RESULT[c.status] || RESULT.queued;
    return h('li', { class: `tm-rv-row${c.id === st.sel ? ' on' : ''}${c.review ? ' done' : ''}`, dataset: { id: c.id }, onclick: () => select(c.id, false) },
      h('span', { class: `tm-dot ${cls}`, title: label }),
      h('div', { class: 'tm-rv-main' },
        h('div', { class: 'tm-rv-top' }, h('b', null, custName(c)), h('span', { class: 'muted' }, fDay.format(new Date(c.solved_at)) === today() ? fTime.format(new Date(c.solved_at)) : fDateTime.format(new Date(c.solved_at)))),
        h('div', { class: 'tm-rv-sub' }, h('span', { class: 'tm-rv-who' }, c.actor), ` · ${c.kind === 'sales' ? 'sales' : 'support'}`,
          c.review ? h('span', { class: `tm-chip ${c.review === 'confirmed' ? 'bad' : 'quiet'}` }, c.review === 'confirmed' ? 'unsolved' : 'fine') : null),
        h('div', { class: 'tm-rv-why' }, isFinding(c) ? (c.reason || CATEGORY[c.category] || '') : c.status === 'ok' ? (c.summary || c.reason || label) : label)));
  }
  function bubble(m, d) {
    const mine = m.dir !== 'customer';
    const kids = [];
    const text = String(m.text || '').replace(/^🎤 \*Voice Message\*$|^📎 \*Media Received\*$/u, '').trim();
    if (m.hidden) kids.push(h('em', null, 'Reply sent from the BSB phone app (text not visible here)'));
    else if (text) kids.push(h('span', { dir: 'auto' }, text));
    const url = m.media_ref && d.urls ? d.urls[m.media_ref] : null;
    const safe = typeof url === 'string' && (/^https:\/\//.test(url) || /^\/media\/[\w.-]+$/.test(url));
    if (/image/i.test(m.media || '') && safe) kids.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: url, alt: 'Photo', loading: 'lazy' })));
    else if (/audio|voice/i.test(m.media || '')) {
      const tr = m.media_ref && d.transcripts ? d.transcripts[m.media_ref] : null;
      kids.push(h('span', { class: 'tm-voice' }, U.icon('mic', 'xs'), tr ? h('i', { dir: 'auto' }, `“${tr}”`) : h('i', null, 'Voice note')));
      if (safe) kids.push(h('audio', { src: url, controls: true, preload: 'none' }));
    } else if (m.media && !['text', 'None', 'reaction'].includes(String(m.media).replace(/^instagram_/, ''))) kids.push(h('em', null, `[${String(m.media).replace(/^instagram_/, '')}]`));
    if (!kids.length) kids.push(h('em', null, '[empty]'));
    return h('div', { class: `tm-b ${mine ? 'out' : 'in'}${m.closer ? ' closer' : ''}${m.cur === false ? ' old' : ''}` }, kids,
      h('span', { class: 'tm-b-t' }, `${m.closer ? 'closing message · ' : ''}${mine ? (m.by || 'Staff') + ' · ' : ''}${fDay.format(new Date(m.ts)) === today() ? '' : fShortTz(m.ts) + ' '}${fTime.format(new Date(m.ts))}`));
  }
  const fShortTz = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(ts));
  function thread(d) {
    const a = d.audit, inp = d.input || {};
    const before = inp.before || [], after = inp.after || [];
    const marks = (inp.marks || []).map((k) => ({ ts: k.at, el: h('div', { class: 'tm-markline quiet' }, h('span', null,
      `${k.kind === 'resolved' ? `${k.actor} marked it ${k.sales ? 'complete' : 'solved'}` : k.actor === 'customer' ? 'The customer wrote again' : `${k.actor} reopened it`} · ${fDateTime.format(new Date(k.at))}`)) }));
    const items = [...before.map((m) => ({ ts: m.ts, el: bubble(m, d), cur: m.cur })), ...after.map((m) => ({ ts: m.ts, el: bubble(m, d), cur: true })), ...marks];
    const firstCur = before.find((m) => m.cur);
    if (firstCur && before[0] !== firstCur) items.push({ ts: firstCur.ts, first: true, el: h('div', { class: 'tm-markline ep' }, h('span', null, 'The episode that was marked starts here')) });
    const mark = h('div', { class: 'tm-markline' }, h('span', null, `${a.actor} marked this ${a.kind === 'sales' ? 'complete' : 'solved'} here · ${fDateTime.format(new Date(a.solved_at))}`),
      h('small', null, inp.closer_body ? `with the closing message “${inp.closer}”` : 'no closing message'));
    items.push({ ts: a.solved_at, mark: true, el: mark });
    items.sort((x, y) => (Date.parse(x.ts) - Date.parse(y.ts)) || ((x.first ? -1 : x.mark ? 1 : 0) - (y.first ? -1 : y.mark ? 1 : 0)));
    const box = h('div', { class: 'tm-thread' },
      before.length >= 120 ? h('div', { class: 'tm-markline quiet' }, h('span', null, 'Older messages are not shown')) : null,
      items.map((x) => x.el),
      !after.length ? h('div', { class: 'tm-markline quiet' }, h('span', null, 'The customer did not write again')) : null);
    box._mark = mark;
    return box;
  }
  function detailPane(c) {
    if (!c) return h('div', { class: 'tm-rv-empty' }, h('div', { class: 'empty-big' }, '✓'), h('b', null, st.filter === 'open' ? 'Nothing left to review' : 'Nothing here'),
      h('div', { class: 'muted' }, st.filter === 'open' ? 'New findings appear here as the AI checks chats.' : 'Pick another list above.'));
    const entry = loadDetail(c, () => { if (root && st.sel === c.id) draw(); });
    const [cls, label] = RESULT[c.status] || RESULT.queued;
    const a = entry.data ? entry.data.audit : null;
    const det = a && a.detail ? a.detail : {};
    const needs = (det.needs || []).filter((n) => n.need);
    const verdict = h('div', { class: `tm-verdict ${cls}` },
      h('div', { class: 'tm-verdict-h' }, h('span', { class: `tm-res ${cls}` }, label),
        isFinding(c) ? h('b', null, CATEGORY[c.category] || CATEGORY.none) : null,
        c.review ? h('span', { class: `tm-chip ${c.review === 'confirmed' ? 'bad' : 'quiet'}` }, REVIEWED[c.review]) : null),
      (det.summary || c.summary) ? h('p', { class: 'tm-sum' }, det.summary || c.summary) : c.reason ? h('p', { class: 'tm-sum' }, c.reason)
        : c.status === 'queued' ? h('p', { class: 'tm-sum' }, 'The AI has not read this chat yet.') : c.status === 'error' ? h('p', { class: 'tm-sum' }, `The AI could not check it: ${c.last_error || 'no answer'}`) : null,
      needs.length ? h('ul', { class: 'tm-needs' }, needs.map((n) => { const [nc, sym] = NEED[n.status] || NEED.unknown; return h('li', { class: nc }, h('span', { class: 'tm-need-s' }, sym), h('div', null, h('b', null, n.need), h('span', null, n.how))); })) : null,
      c.evidence ? h('blockquote', { class: 'tm-fc-q', dir: 'auto' }, h('span', null, 'The customer said'), c.evidence) : null,
      (det.missing_action || c.missing) && isFinding(c) ? h('p', { class: 'tm-todo' }, h('b', null, 'Should have been done: '), det.missing_action || c.missing) : null,
      a && a.note && isFinding(c) ? h('p', { class: 'tm-second muted' }, h('b', null, c.status === 'flagged' ? 'Second check agreed: ' : 'Second check was not sure: '), a.note) : null,
      h('div', { class: 'tm-fc-chips' }, factChips(a ? { ...c, signals: a.signals, media: a.media } : c)));
    let conv;
    if (entry.data) { conv = thread(entry.data); }
    else conv = h('div', { class: 'tm-thread' }, h('div', { class: 'tm-markline quiet' }, h('span', null, entry.error ? `Could not load the conversation: ${entry.error}` : 'Loading the conversation…')));
    const scroller = h('div', { class: 'tm-rv-scroll' }, verdict, conv);
    scroller._conv = conv;
    const i = rvRows.findIndex((x) => x.id === c.id);
    return h('div', { class: 'tm-rv-detail' },
      h('div', { class: 'tm-rv-head' },
        h('div', null, h('h3', null, custName(c)), h('span', { class: 'muted' }, `${c.kind === 'sales' ? 'Sales chat, marked complete' : 'Support chat, marked solved'} by `, h('b', null, c.actor), ` · ${fDateTime.format(new Date(c.solved_at))}`)),
        h('span', { class: 'muted tm-rv-pos' }, `${i + 1} of ${rvRows.length}`)),
      scroller,
      h('div', { class: 'tm-rv-foot' },
        h('div', { class: 'tm-rv-nav' },
          h('button', { class: 'btn sm', disabled: i <= 0, title: 'Previous (K or ↑)', onclick: () => move(-1) }, h('kbd', null, 'K'), 'Previous'),
          h('button', { class: 'btn sm', disabled: i >= rvRows.length - 1, title: 'Next (J or ↓)', onclick: () => move(1) }, h('kbd', null, 'J'), 'Next'),
          h('button', { class: 'btn sm ghost', title: 'Open this chat in the desk (O)', onclick: () => openInDesk(c) }, h('kbd', null, 'O'), 'Open chat')),
        h('div', { class: 'tm-rv-act' },
          c.review ? h('button', { class: 'btn ghost', onclick: () => answer(c, null) }, 'Change my answer') : null,
          h('button', { class: `btn fine${c.review === 'dismissed' ? ' on' : ''}`, title: 'The chat was handled properly. It stops counting against the employee.', onclick: () => answer(c, 'dismissed') }, h('kbd', null, 'V'), 'It’s fine'),
          h('button', { class: `btn unsolve${c.review === 'confirmed' ? ' on' : ''}`, title: 'Not solved: remove the solved status and put the chat back in Unresolved.', onclick: () => answer(c, 'unsolved') }, h('kbd', null, 'C'), 'Mark unsolved'))));
  }
  function aiTab(d, staff) {
    const sc = d.scanner || {};
    const { rows, counts, checks } = reviewRows(d);
    rvRows = rows;
    if (!rows.some((c) => c.id === st.sel)) { st.sel = rows.length ? rows[0].id : null; st.threadTop = null; st.selScroll = false; }
    const cur = rows.find((c) => c.id === st.sel) || null;
    if (cur) { const i = rows.indexOf(cur); if (rows[i + 1]) loadDetail(rows[i + 1]); }   // the next one opens instantly
    const left = st.scanning && st.scanLeft != null ? st.scanLeft : sc.queued || 0;
    const total = (sc.done || 0) + left;
    const scan = sc.enabled === false ? h('div', { class: 'tm-scanline err' }, U.icon('warn', 'sm'), h('span', null, h('b', null, 'The AI check is switched off.')))
      : h('div', { class: `tm-scanline${left ? ' busy' : ''}` }, U.icon(left ? 'refresh' : 'check', 'sm'),
        h('span', null, left ? [h('b', null, `AI is reading: ${num(left)} chats to go`), ` · newest first${left > 15 ? `, about ${Math.ceil(left / 13)} min` : ''}`]
          : [h('b', null, 'AI has checked every chat'), sc.last_checked_at ? ` · last check ${U.ago(sc.last_checked_at)}` : '']),
        left ? h('span', { class: 'tm-prog' }, h('i', { style: `width:${total ? Math.round(((sc.done || 0) / total) * 100) : 0}%` })) : null,
        left || st.scanning ? h('button', { class: 'btn sm', onclick: scanNow }, st.scanning ? 'Stop' : 'Check now') : null,
        sc.errors ? h('button', { class: 'btn sm', title: sc.last_error || '', onclick: retryErrors }, `${plural(sc.errors, 'chat')} failed · try again`) : null);
    const who = staff.filter((p) => checks.some((c) => c.staff_id === p.id));
    const tabs = [['open', 'To review'], ['confirmed', 'Marked unsolved'], ['dismissed', 'Fine'], ['all', 'Every marked chat']];
    return [h('div', { class: 'tm-review' },
      h('div', { class: 'tm-rv-bar' },
        h('div', { class: 'tm-filter', role: 'tablist' }, tabs.map(([k, l]) => h('button', { class: `tm-tab${st.filter === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.filter === k),
          onclick: () => { st.filter = k; st.sel = null; draw(); } }, l, h('span', null, num(counts[k]))))),
        h('div', { class: 'tm-people' }, h('button', { class: `tm-tab${!st.person ? ' on' : ''}`, onclick: () => { st.person = 0; st.sel = null; draw(); } }, 'Everyone'),
          who.map((p) => { const t = p.totals, bad = t.flagged + t.doubt; return h('button', { class: `tm-tab${st.person === p.id ? ' on' : ''}`, dataset: { tip: `${p.name}\n${bad} of ${t.checked} checked chats had a problem (${pct(bad, t.checked)})\n${t.flagged} not solved · ${t.doubt} please check${t.pending ? `\n${t.pending} still waiting for the AI` : ''}` },
            onclick: () => { st.person = st.person === p.id ? 0 : p.id; st.sel = null; draw(); } }, p.name, bad ? h('span', { class: 'bad' }, `${num(bad)} · ${pct(bad, t.checked)}`) : h('span', null, '0')); })),
        scan),
      h('div', { class: 'tm-rv-cols' },
        h('ul', { class: 'tm-rv-list', 'aria-label': 'Chats to review' }, rows.length ? rows.slice(0, 400).map(listRow)
          : h('li', { class: 'tm-rv-none' }, st.filter === 'open' ? (left ? 'No problems found so far. The AI is still reading.' : 'No problems waiting for you.') : 'Nothing here.')),
        detailPane(cur)),
      h('div', { class: 'tm-rv-keys muted' }, h('kbd', null, 'J'), h('kbd', null, 'K'), ' move  ', h('kbd', null, 'V'), ' it’s fine  ', h('kbd', null, 'C'), ' mark unsolved (back to Unresolved)  ',
        h('kbd', null, 'Z'), ' undo  ', h('kbd', null, 'O'), ' open chat  ', h('kbd', null, 'Esc'), ' back to chats'))];
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
        compare('Problems found by the AI', 'fewer is better', staff.map((p) => ({ name: p.name, v: p.totals.flagged + p.totals.doubt, cls: 'bad', tip: `${p.totals.flagged} not solved · ${p.totals.doubt} please check · of ${p.totals.checked} checked` })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v), num),
        teamDays.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Whole team: working time per day')),
          columns(teamDays, { unit: 'h', label: 'Team working time per day', value: (x) => x.active_min, tip: (x) => `${dayName(x.day)}\nWorking ${hm(x.active_min)} (everyone together)\n${x.sent} sent · ${x.solved} solved · ${x.sales_done} sales completed` })) : null,
        teamDays.length > 1 ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Whole team: messages sent per day')),
          columns(teamDays, { unit: 'n', label: 'Messages sent per day', value: (x) => x.sent, tip: (x) => `${dayName(x.day)}\n${x.sent} messages sent` })) : null),
      h('div', { class: 'tm-card' },
        h('div', { class: 'tm-card-h' }, h('b', null, 'All the numbers'), h('button', { class: 'btn sm', onclick: () => downloadCsv(d, staff) }, U.icon('file', 'sm'), 'Download as spreadsheet')),
        h('div', { class: 'tm-scroll' }, h('table', { class: 'tm-table wide' },
          h('thead', null, h('tr', null, ['Employee', 'Working time', 'Desk open', 'Messages', 'Customers', 'Solved', 'Sales completed', 'Typical reply', 'Not solved', 'Please check'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
          h('tbody', null, staff.map((p) => { const t = p.totals; return h('tr', null, h('td', null, p.name), h('td', { class: 'r' }, hm(t.active_min)), h('td', { class: 'r' }, hm(t.online_min)), h('td', { class: 'r' }, num(t.sent)),
            h('td', { class: 'r' }, num(t.chats)), h('td', { class: 'r' }, num(t.solved)), h('td', { class: 'r' }, num(t.sales_done)), h('td', { class: 'r' }, secs(t.reply_median_s)), h('td', { class: 'r' }, num(t.flagged)), h('td', { class: 'r' }, num(t.doubt))); }))))),
    ];
  }
  function downloadCsv(d, staff) {
    const cols = [['Employee', (p) => p.name], ['Working minutes', (p) => p.totals.active_min], ['Desk open minutes', (p) => p.totals.online_min], ['Days worked', (p) => p.totals.days_active],
      ['Messages sent', (p) => p.totals.sent], ['Customers messaged', (p) => p.totals.chats], ['Support solved', (p) => p.totals.solved], ['Sales completed', (p) => p.totals.sales_done],
      ['Typical reply seconds', (p) => p.totals.reply_median_s ?? ''], ['Chats checked by AI', (p) => p.totals.checked], ['Not solved', (p) => p.totals.flagged], ['Please check', (p) => p.totals.doubt],
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
    const openFindings = d ? (d.checks || []).filter((c) => isFinding(c) && !c.review).length : 0;
    const head = h('header', { class: 'tm-head' },
      h('div', { class: 'tm-head-1' },
        h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', h('kbd', null, 'Esc')),
        h('h2', null, 'Team activity'),
        h('div', { class: 'tm-range', role: 'group', 'aria-label': 'Period' },
          PRESETS.map(([k, l]) => h('button', { class: `tm-tab${st.preset === k ? ' on' : ''}`, onclick: () => { setPreset(k); st.logMore = false; load(); } }, l)),
          h('span', { class: 'tm-dates' }, from, h('span', { class: 'muted' }, 'to'), to)),
        h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => load() }, U.icon('refresh'))),
      h('nav', { class: 'tm-tabs', role: 'tablist' }, [['people', 'team', 'People'], ['ai', 'warn', 'AI check'], ['compare', 'chart', 'Compare']].map(([k, ic, l]) =>
        h('button', { class: `tm-maintab${st.tab === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.tab === k), onclick: () => { st.tab = k; draw(); } },
          U.icon(ic, 'sm'), l, k === 'ai' && openFindings ? h('span', { class: 'tm-badge' }, num(openFindings)) : null))));

    let body;
    if (!d) body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load the report.'), h('div', null, st.error), h('button', { class: 'btn', onclick: () => load() }, 'Try again')] : 'Loading…'));
    else {
      const single = d.from === d.to;
      const staff = [...d.staff].sort((a, b) => (b.totals.active_min - a.totals.active_min) || (b.totals.sent - a.totals.sent) || a.name.localeCompare(b.name));
      const parts = st.tab === 'people' ? peopleTab(d, staff, single) : st.tab === 'ai' ? aiTab(d, staff) : compareTab(d, staff, single);
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
      else if (conv._conv && conv._conv._mark) { conv.scrollTop = 0; st.threadTop = 0; }   // the AI's finding first; the mark is one scroll away
    }
  }

  function onKey(e) {
    if (!root) return;
    // the desk's own shortcuts (J, K, V, Tab, arrows...) stay off while this screen is open
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (st.tab === 'ai' && st.data && reviewKey(e)) e.preventDefault();
  }
  function open(helpers, opts = {}) {
    U = helpers;
    if (root) return;
    if (!st.from) setPreset('today');
    if (opts.tab) st.tab = opts.tab;
    root = h('div', { class: 'team-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Team activity' });
    document.body.append(root);
    bindTip(root);
    document.addEventListener('keydown', onKey, true);
    draw();
    load();
  }
  function close() {
    if (!root) return;
    clearTimeout(timer);
    flushAnswer();
    st.stopScan = true;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (tip) { tip.remove(); tip = null; }
  }

  window.DeskTeam = { open, close };
})();
