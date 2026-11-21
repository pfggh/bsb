/* Teshrij Desk — Team & quality (admins only), v3.
 *
 * Five tabs, in plain words:
 *   Live      who is doing what this minute, which customers are waiting, the latest actions (refreshes itself)
 *   Quality   how well customers are served: answer speed, missed customers, solved for real, sales results
 *   People    how long each person worked and when, what they got done, their day action by action
 *   AI check  chats that were marked solved / complete but were not (the AI scanner's findings),
 *             per employee, with the conversation one click away and a yes / no for the admin
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
    open: new Set(), filter: 'open', person: 0, logMore: false, scanning: false, scanLeft: null, stopScan: false,
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
    if (st.tab === 'quality' && st.qKey !== `${st.from}|${st.to}`) loadQuality(true);
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
    return h('div', { class: 'tm-axis', 'aria-hidden': 'true' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, hr(x))));
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
        single ? h('div', { class: 'tm-sessions' }, h('h5', null, 'Everything they did, in order'), dayLog(p, st.data.from)) : null,
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
    if (g.after_admin) out.push(['warn', 'Marked finished again after you marked it unsolved']);
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
    // One case per chat: a chat that was marked finished several times is one row (its latest mark),
    // and the answer covers all of them. "Every marked chat" stays a plain log.
    const cases = (list) => {
      const by = new Map();
      for (const c of list) { const g = by.get(c.contact); if (g) g.push(c); else by.set(c.contact, [c]); }
      return [...by.values()].map((g) => {
        g.sort((a, b) => Date.parse(b.solved_at) - Date.parse(a.solved_at));
        const head = g.find(mine) || g[0];
        head._group = g;
        return head;
      }).filter((c) => c._group.some(mine));
    };
    const grouped = { open: cases(sets.open), confirmed: cases(sets.confirmed), dismissed: cases(sets.dismissed), all: sets.all.filter(mine) };
    for (const c of grouped.all) c._group = [c];
    const sure = (c) => c._group.some((x) => x.status === 'flagged');
    const order = (a, b) => (st.filter === 'open' ? sure(b) - sure(a) : 0) || Date.parse(b.solved_at) - Date.parse(a.solved_at);
    const counts = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length]));
    const perPerson = new Map();
    for (const c of cases(sets.open)) for (const id of new Set(c._group.map((x) => x.staff_id))) perPerson.set(id, (perPerson.get(id) || 0) + 1);
    return { rows: [...(grouped[st.filter] || grouped.open)].sort(order), counts, checks, perPerson };
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
        (e) => { p.group.forEach((x, k) => { x.review = p.was[k]; }); draw(); U.toast(`Not saved: ${e.message}`, 'error'); });
  }
  function undoAnswer() {
    if (!pendingAns) return false;
    const p = pendingAns; pendingAns = null;
    clearTimeout(p.timer); p.bar.remove();
    p.group.forEach((x, k) => { x.review = p.was[k]; });
    st.sel = p.c.id; st.selScroll = true; st.threadTop = null;
    draw();
    return true;
  }
  function answer(c, value) {            // value: 'dismissed' (V) | 'unsolved' (C) | null (change my answer)
    if (!c) return;
    flushAnswer();
    const group = c._group && c._group.length ? c._group : [c];
    const was = group.map((x) => x.review);
    const i = rvRows.findIndex((x) => x.id === c.id);
    const next = rvRows[i + 1] || rvRows[i - 1] || null;
    for (const x of group) x.review = value === 'unsolved' ? 'confirmed' : value;
    const text = value === 'unsolved' ? [h('b', null, custName(c)), ' marked unsolved · it goes back to Unresolved']
      : value === 'dismissed' ? [h('b', null, custName(c)), ' was fine'] : [h('b', null, custName(c)), ' · answer removed'];
    const bar = h('div', { class: 'undo tm-undo', role: 'status' },
      h('div', { class: 'undo-bar' }, h('div', { class: 'undo-text' }, h('div', null, text)),
        h('button', { class: 'btn sm', onclick: undoAnswer }, 'Undo', h('kbd', null, 'Z'))),
      h('div', { class: 'undo-progress' }, h('i', { style: 'animation-duration:5000ms' })));
    root.append(bar);
    pendingAns = { c, group, value, was, bar, timer: setTimeout(flushAnswer, 5000) };
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
          c._group && c._group.length > 1 ? h('span', { class: 'tm-chip', title: 'This chat was marked finished several times; one answer covers them all' }, `marked ${c._group.length}×`) : null,
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
    const grp = c._group && c._group.length > 1 ? c._group : null;
    const again = grp ? h('p', { class: 'tm-again' }, U.icon('refresh', 'xs'), h('span', null, h('b', null, `This chat was marked finished ${grp.length} times`), ': ',
      [...grp].reverse().map((x) => `${x.actor} ${fDay.format(new Date(x.solved_at)) === today() ? fTime.format(new Date(x.solved_at)) : fDateTime.format(new Date(x.solved_at))}`).join(' · '),
      '. You are looking at the latest one; your answer covers all of them.')) : null;
    const scroller = h('div', { class: 'tm-rv-scroll' }, again, verdict, conv);
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
    const { rows, counts, checks, perPerson } = reviewRows(d);
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
            onclick: () => { st.person = st.person === p.id ? 0 : p.id; st.sel = null; draw(); } }, p.name, perPerson.get(p.id) ? h('span', { class: 'bad' }, num(perPerson.get(p.id))) : h('span', null, '0')); })),
        scan),
      h('div', { class: 'tm-rv-cols' },
        h('ul', { class: 'tm-rv-list', 'aria-label': 'Chats to review' }, rows.length ? rows.slice(0, 400).map(listRow)
          : h('li', { class: 'tm-rv-none' }, st.filter === 'open' ? (left ? 'No problems found so far. The AI is still reading.' : 'No problems waiting for you.') : 'Nothing here.')),
        detailPane(cur)),
      h('div', { class: 'tm-rv-keys muted' }, h('kbd', null, 'J'), h('kbd', null, 'K'), ' move  ', h('kbd', null, 'V'), ' it’s fine  ', h('kbd', null, 'C'), ' mark unsolved (back to Unresolved)  ',
        h('kbd', null, 'Z'), ' undo  ', h('kbd', null, 'O'), ' open chat  ', h('kbd', null, 'Esc'), ' back to chats'))];
  }

  // ---------------------------------------------------------------- live board
  // Who is doing what this minute, who is waiting, and the latest actions. Refreshes itself every 10 seconds.

  const OPS = { send: 'sent a message', send_media: 'sent a photo, file or voice note', resolve: 'solved a chat with a closing message', resolve_silent: 'marked a chat finished',
    reopen: 'reopened a chat', label: 'changed a label', set_kind: 'changed sales / support', close_no_reply: 'closed a chat without reply' };
  const who = (name, contact) => name && /[\p{L}\p{N}]/u.test(name) ? name : /^\d+$/.test(String(contact || '')) ? '+' + contact : 'Instagram user';
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
        tip: `The AI checked ${num(chk.checked)} chats marked ${kind === 'support' ? 'solved' : 'complete'}; ${num(chk.not_solved)} were not (${num(chk.doubt)} more are doubtful).` },
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
    if (q.flags_open) items.push(['warn', `${plural(q.flags_open, 'chat')} marked finished that the AI thinks are not`, h('button', { class: 'btn sm', onclick: () => { st.tab = 'ai'; st.filter = 'open'; st.person = 0; st.sel = null; draw(); } }, 'Review')]);
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
    const cats = (kind) => (q.categories || []).filter((x) => x.kind === kind).map((x) => ({ name: CATEGORY[x.category] || CATEGORY.none, v: x.n, cls: 'bad' }));
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
          qTile('Marked solved, but not', num(sc.not_solved), h('span', { class: 'tm-tile-s' }, sc.checked ? `${pct(sc.not_solved, sc.checked)} of ${num(sc.checked)} checked` : 'nothing checked yet'), 'Found by the AI check and not dismissed by you.', sc.not_solved ? 'bad' : '')),
        h('div', { class: 'tm-charts' },
          multi ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Typical answer time per day'), h('span', { class: 'muted' }, 'minutes')),
            columns(days, { unit: 'n', label: 'Support: typical answer time per day', value: (x) => minutes(x.sup_median_s), tip: (x) => `${dayName(x.day)}\nTypical answer after ${secs(x.sup_median_s)}\n${pct(x.sup_in_5, x.sup_turns)} of ${x.sup_turns} within 5 min` })) : null,
          multi ? h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Solved per day'), h('span', { class: 'muted' }, 'and how many the AI found not solved')),
            columns(days, { unit: 'n', label: 'Support chats solved per day', value: (x) => x.solved, tip: (x) => `${dayName(x.day)}\n${x.solved} solved\n${x.problems} of ${x.checked} checked had a problem` })) : null,
          compare('What went wrong in solved chats', 'found by the AI check', cats('support'), num, true))),

      h('section', { class: 'tm-sec' }, h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Sales'))),
        h('div', { class: 'tm-tiles' },
          qTile('Typical answer time', secs(L.median_s), delta(L.median_s, PL.median_s, { lower: true }), `Half of the ${num(L.answered)} answers were faster than this.`),
          qTile('Never answered', num(L.missed), delta(L.missed, PL.missed, { lower: true }), 'Sales customers who got no answer within 24 hours.', L.missed ? 'bad' : ''),
          qTile('Got a price', num(f.priced), delta(f.priced, (p.funnel || {}).priced, { neutral: true }), 'Chats in which a price was sent in this period.'),
          qTile('Bought', num(f.bought), delta(f.bought, (p.funnel || {}).bought), 'Purchases recorded in this period.'),
          qTile('Priced → bought', f.priced ? pct(f.bought, f.priced) : '–', null, 'Purchases in the period divided by prices sent in the period.'),
          qTile('Marked complete, but not', num(lc.not_solved), h('span', { class: 'tm-tile-s' }, lc.checked ? `${pct(lc.not_solved, lc.checked)} of ${num(lc.checked)} checked` : 'nothing checked yet'), 'The customer was still waiting for something. Found by the AI check.', lc.not_solved ? 'bad' : '')),
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
          h('thead', null, h('tr', null, ['Employee', 'Typical reply', 'Slow replies', 'Solved', 'Completed', 'Checked by AI', 'Not finished', 'Customer came back'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
          h('tbody', null, staff.map((x) => { const t = x.totals, bad = t.flagged + t.doubt; return h('tr', null, h('td', null, x.name), h('td', { class: 'r' }, secs(t.reply_median_s)), h('td', { class: 'r' }, secs(t.reply_p90_s)),
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
    const convKey = oldConv ? oldConv.dataset.key : '', convTop = oldConv ? oldConv.scrollTop : 0;
    if (oldConv && st.threadTop !== null) st.threadTop = oldConv.scrollTop;
    const from = h('input', { type: 'date', value: st.from, max: today(), 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: st.to, max: today(), 'aria-label': 'To' });
    const custom = () => { if (from.value && to.value && from.value <= to.value) { st.preset = ''; st.from = from.value; st.to = to.value; st.logMore = false; load(); } };
    from.addEventListener('change', custom); to.addEventListener('change', custom);
    const head = h('header', { class: 'tm-head' },
      h('div', { class: 'tm-head-1' },
        h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', h('kbd', null, 'Esc')),
        h('h2', null, 'Team & quality'),
        st.tab === 'live' ? h('span', { class: 'tm-livedot' }, h('i'), 'Live · updates every 10 seconds') : st.tab === 'ai' ? null : h('div', { class: 'tm-range', role: 'group', 'aria-label': 'Period' },
          PRESETS.map(([k, l]) => h('button', { class: `tm-tab${st.preset === k ? ' on' : ''}`, onclick: () => { setPreset(k); st.logMore = false; load(); } }, l)),
          h('span', { class: 'tm-dates' }, from, h('span', { class: 'muted' }, 'to'), to)),
        h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => { if (st.tab === 'live') loadLive(); else { load(); if (st.tab === 'quality') loadQuality(false, true); } } }, U.icon('refresh'))),
      h('nav', { class: 'tm-tabs', role: 'tablist' }, [['live', 'clock', 'Live'], ['quality', 'check', 'Quality'], ['people', 'team', 'People'], ['ai', 'warn', 'Radar'], ['compare', 'chart', 'Compare']].map(([k, ic, l]) =>
        h('button', { class: `tm-maintab${st.tab === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.tab === k), onclick: () => { st.tab = k; if (k === 'live') loadLive(); draw(); } },
          U.icon(ic, 'sm'), l, k === 'ai' && window.DeskRadar.count() ? h('span', { class: 'tm-badge' }, num(window.DeskRadar.count())) : null))));

    let body;
    if (st.tab === 'live') body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-wrap' }, liveTab().flat(Infinity)));
    else if (st.tab === 'ai') body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-wrap' }, window.DeskRadar.view()));
    else if (!d) body = h('div', { class: 'tm-body', dataset: { tab: st.tab } }, h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load the report.'), h('div', null, st.error), h('button', { class: 'btn', onclick: () => load() }, 'Try again')] : 'Loading…'));
    else {
      const single = d.from === d.to;
      const staff = [...d.staff].sort((a, b) => (b.totals.active_min - a.totals.active_min) || (b.totals.sent - a.totals.sent) || a.name.localeCompare(b.name));
      const parts = st.tab === 'people' ? peopleTab(d, staff, single) : st.tab === 'ai' ? aiTab(d, staff) : st.tab === 'quality' ? qualityTab(d) : compareTab(d, staff, single);
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
      if (on && (st.selScroll || st.tab === 'ai')) { on.scrollIntoView({ block: 'nearest' }); st.selScroll = false; }
    }
    if (conv && st.tab === 'ai') conv.scrollTop = conv.dataset.key === convKey ? convTop : conv.scrollHeight;   // a new chat opens on its latest messages
    else if (conv) {
      if (st.threadTop !== null) conv.scrollTop = st.threadTop;
      else if (conv._conv && conv._conv._mark) { conv.scrollTop = 0; st.threadTop = 0; }   // the AI's finding first; the mark is one scroll away
    }
  }

  function onKey(e) {
    if (!root) return;
    // the desk's own shortcuts (J, K, V, Tab, arrows...) stay off while this screen is open
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (st.tab === 'ai' && window.DeskRadar.key(e)) e.preventDefault();
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
    window.DeskRadar.start({ U, draw, close, root: () => root });
    draw();
    load();
    loadLive();
    liveTimer = setInterval(() => { if (root && !document.hidden && (st.tab === 'live' || st.tab === 'quality')) loadLive(); }, 10000);
  }
  function close() {
    if (!root) return;
    clearTimeout(timer); clearInterval(liveTimer);
    window.DeskRadar.stop();
    flushAnswer();
    st.stopScan = true;
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (tip) { tip.remove(); tip = null; }
  }

  window.DeskTeam = { open, close };
})();
