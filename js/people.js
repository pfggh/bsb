/* Teshrij Desk — Team → People (admins only), v2 (2026-11-23).
 *
 * The owner asked to "see exactly how active and how much work each person is doing". The old tab mixed
 * things that look alike but are not: closing messages the desk picks itself counted as messages sent,
 * every V press counted as a solve (a quarter came < 5 s after the previous one, a fifth without any reply),
 * and an open tab looked like time at work. This tab keeps them apart and says how each number is counted.
 *
 * Data: op people_report (desk.people_report). Keys while the tab is open: J / K move, Enter opens / closes a person.
 */
(function () {
  'use strict';
  const TZ = 'Asia/Beirut';
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fDow = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayName = (day) => fShort.format(new Date(day + 'T00:00:00Z'));
  const hm = (min) => { const m = Math.max(0, Math.round(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const hr = (x) => { const k = ((x % 24) + 24) % 24; return `${k % 12 || 12} ${k < 12 ? 'am' : 'pm'}`; };
  const clock = (m) => { const k = Math.floor(m / 60) % 24; return `${k % 12 || 12}:${String(m % 60).padStart(2, '0')} ${k < 12 ? 'am' : 'pm'}`; };
  const secs = (s) => s == null ? '–' : s < 90 ? `${Math.round(s)} sec` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const pctN = (a, b) => b ? Math.round((a / b) * 100) : null;
  const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '–';
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many || one + 's'}`;

  const st = { key: '', data: null, loading: false, error: '', at: 0, sort: 'eff', open: new Set(), sel: null };
  let ctx = null;            // { U, from, to, redraw, dayLog, hourHeat }
  const h = (...a) => ctx.U.h(...a);

  // ------------------------------------------------------------------ data
  async function load(quiet) {
    if (st.loading || !ctx) return;
    const key = `${ctx.from}|${ctx.to}`;
    st.loading = true;
    if (!quiet) st.error = '';
    try {
      const r = await ctx.U.api.call('people_report', { from: ctx.from, to: ctx.to });
      if (`${ctx.from}|${ctx.to}` === key) { st.data = r; st.key = key; st.at = Date.now(); st.error = ''; }
    } catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    ctx.redraw();
  }
  function refresh() { st.at = 0; load(true); }

  // ------------------------------------------------------------------ numbers
  const typedOf = (t) => t.typed + t.files;
  const paceOf = (t) => t.work_min >= 30 ? t.customers / (t.work_min / 60) : null;
  // Efficiency: customers answered ÷ fair share of the customers who wrote while they worked (see the SQL),
  // against the team's same ratio. 100 = team average. Judged only from a fair share of 15 customers (8 for one day).
  let teamRatio = null, teamDay = {};
  const effOf = (t) => t && t.fair >= 15 && teamRatio ? Math.round(((t.did / t.fair) / teamRatio) * 100) : null;
  const effDay = (x) => {
    const td = teamDay[x.day];
    return x.fair >= 8 && td && td[0] > 0 && td[1] > 0 ? Math.round(((x.did / x.fair) / (td[1] / td[0])) * 100) : null;
  };
  const effWords = (e) => e == null ? 'too little work to judge' : e >= 103 ? `${e - 100}% more than the team average` : e <= 97 ? `${100 - e}% less than the team average` : 'about the team average';
  const effCls = (e) => e == null ? 'na' : e >= 110 ? 'hi' : e >= 95 ? 'mid' : e >= 80 ? 'lo' : 'bad';
  const fastOf = (t) => pctN(t.reply_within5, t.reply_n);
  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name),
    work: (a, b) => b.totals.work_min - a.totals.work_min,
    customers: (a, b) => b.totals.customers - a.totals.customers,
    typed: (a, b) => typedOf(b.totals) - typedOf(a.totals),
    solved: (a, b) => b.totals.s_chats - a.totals.s_chats,
    sales: (a, b) => b.totals.sales - a.totals.sales,
    fast: (a, b) => (fastOf(b.totals) ?? -1) - (fastOf(a.totals) ?? -1),
    eff: (a, b) => (effOf(b.totals) ?? -1) - (effOf(a.totals) ?? -1),
  };
  function ordered(d) {
    const did = (p) => p.totals.work_min > 0 || typedOf(p.totals) > 0 || p.totals.s_real + p.totals.s_bare + p.totals.sales > 0;
    const list = d.staff.filter(did);
    list.sort((a, b) => SORTS[st.sort](a, b) || b.totals.work_min - a.totals.work_min || a.name.localeCompare(b.name));
    return { list, absent: d.staff.filter((p) => !did(p) && p.active) };
  }

  function presence(p) {
    const n = ctx.U.now(), pr = p.presence || {};
    const input = pr.input_at ? n - Date.parse(pr.input_at) : Infinity;
    const seen = pr.seen_at ? n - Date.parse(pr.seen_at) : Infinity;
    if (pr.typing_at && n - Date.parse(pr.typing_at) < 60000) return { cls: 'on', text: 'Typing a reply now' };
    if (input < 180000) return { cls: 'on', text: 'Working now' };
    if (seen < 180000) return { cls: 'idle', text: 'Desk open, not touching it' };
    const last = p.last_active_at || pr.input_at;
    if (!last) return { cls: '', text: 'Not here this week' };
    return { cls: '', text: fDay.format(new Date(last)) === fDay.format(new Date(n)) ? `Away · last worked ${fTime.format(new Date(last))}` : `Away · last worked ${ctx.U.ago(last)}` };
  }

  // things the owner should know before trusting a row (plain facts, no judgement)
  function flags(t) {
    const out = [];
    const presses = t.s_real + t.s_bare;
    if (t.idle_min >= 120) out.push(['', `Desk left open ${hm(t.idle_min)} without being used (not counted)`]);
    if (t.work_min >= 60 && t.chat_min / t.work_min < 0.6) out.push(['warn', `Only ${pct(t.chat_min, t.work_min)} of working time was near a chat action`]);
    if (presses >= 5 && t.s_bare / presses >= 0.3) out.push(['warn', `${pct(t.s_bare, presses)} of support solves had no reply from them`]);
    if (t.warned) out.push(['bad', `Solved ${plural(t.warned, 'chat')} through the red "not helped" warning`]);
    if (t.flagged) out.push(['bad', `You sent back ${plural(t.flagged, 'chat')} they had closed`]);
    return out;
  }

  // ------------------------------------------------------------------ charts
  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const STATE = ['pp-open', 'pp-desk', 'pp-chat'];
  const STATE_TXT = ['Desk open, not used', 'At the desk, no chat action', 'Working on chats'];
  // One day, midnight to midnight: the strip shows the state of every minute, the ticks above it the messages typed.
  function dayStrip(day, label, tall) {
    const H = tall ? 34 : 26, TK = tall ? 12 : 9;
    const svg = s('svg', { class: `pp-strip${tall ? ' tall' : ''}`, viewBox: `0 0 1440 ${H}`, preserveAspectRatio: 'none', role: 'img',
      'aria-label': `${label}: working ${hm(day.work_min)}, ${num(day.typed + day.files)} messages typed` });
    svg.append(s('rect', { x: 0, y: TK + 2, width: 1440, height: H - TK - 2, class: 'pp-track' }));
    for (const [a, b, k] of day.segs || []) {
      const w = Math.max(b - a, 2.5);
      const r = s('rect', { x: Math.min(a, 1440 - w), y: TK + 2, width: w, height: H - TK - 2, class: STATE[k] });
      r.dataset.tip = `${clock(a)} – ${clock(b)}\n${STATE_TXT[k]} · ${hm(b - a)}`;
      svg.append(r);
    }
    const ticks = day.ticks || [];
    const max = Math.max(4, ...ticks.map((x) => x[1]));
    for (const [bin, n] of ticks) {
      const th = Math.max(2, (n / max) * TK);
      const r = s('rect', { x: bin, y: TK - th, width: 4, height: th, class: 'pp-tick' });
      r.dataset.tip = `${clock(bin)} – ${clock(bin + 5)}\n${plural(n, 'message')} typed`;
      svg.append(r);
    }
    return svg;
  }
  function axis() {
    return h('div', { class: 'tm-axis', 'aria-hidden': 'true' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => h('span', { class: x % 6 ? 'minor' : null, style: `left:${(x / 24) * 100}%` }, hr(x))));
  }
  function legend() {
    return h('span', { class: 'pp-legend' },
      h('i', { class: 'pp-chat' }), 'Working on chats', h('i', { class: 'pp-desk' }), 'At the desk, no chat action',
      h('i', { class: 'pp-open' }), 'Open, not used', h('i', { class: 'pp-tick' }), 'Messages typed');
  }
  function daysOf(d) { const out = []; for (let x = d.from; x <= d.to; x = addDays(x, 1)) out.push(x); return out; }
  const empty = (day) => ({ day, work_min: 0, chat_min: 0, idle_min: 0, typed: 0, files: 0, closers: 0, customers: 0, s_real: 0, s_bare: 0, s_chats: 0, s_repeat: 0, s_fast: 0, sales: 0, sales_bare: 0, delivered: 0, segs: [], ticks: [] });
  function byDay(p) { const m = new Map(p.days.map((x) => [x.day, x])); return (day) => m.get(day) || empty(day); }

  // single day: everybody's day on one picture
  function timeline(d, list) {
    const day = d.from;
    return h('section', { class: 'tm-sec' },
      h('div', { class: 'tm-sec-h' },
        h('div', null, h('h3', null, 'Who was working when'),
          h('p', { class: 'muted' }, 'Each line is one person from midnight to midnight. Dark = answering customers, the small marks on top = messages they typed. Hover for exact times.')),
        legend()),
      h('div', { class: 'tm-card pp-lanes' },
        list.map((p) => {
          const x = byDay(p)(day);
          return h('div', { class: 'pp-lane' },
            h('button', { class: 'pp-lane-n', onclick: () => openPerson(p.id) }, p.name),
            dayStrip(x, p.name),
            h('span', { class: 'pp-lane-v' }, h('b', null, hm(x.work_min)), x.first_at ? h('span', null, `${fTime.format(new Date(x.first_at))} – ${fTime.format(new Date(x.last_at))}`) : null));
        }),
        h('div', { class: 'pp-lane' }, h('span'), axis(), h('span'))));
  }
  // several days: a person × day grid
  function grid(d, list) {
    const days = daysOf(d);
    const max = Math.max(60, ...list.flatMap((p) => p.days.map((x) => x.work_min)));
    return h('section', { class: 'tm-sec' },
      h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Day by day'),
        h('p', { class: 'muted' }, 'Working time and messages typed for each person each day. Darker = longer. Click a name for the details.'))),
      h('div', { class: 'tm-card pp-gridwrap' },
        h('table', { class: 'pp-grid' },
          h('thead', null, h('tr', null, h('th'), days.map((x) => h('th', { title: dayName(x) }, h('span', null, fDow.format(new Date(x + 'T00:00:00Z'))), h('b', null, String(Number(x.slice(8)))))))),
          h('tbody', null, list.map((p) => {
            const get = byDay(p);
            return h('tr', null, h('th', null, h('button', { class: 'pp-lane-n', onclick: () => openPerson(p.id) }, p.name)),
              days.map((x) => {
                const v = get(x);
                const lvl = v.work_min ? 1 + Math.min(4, Math.floor((v.work_min / max) * 4.999)) : 0;
                return h('td', { class: `pp-cell l${lvl}`, dataset: { tip: `${p.name} · ${dayName(x)}\n${v.work_min ? `Working ${hm(v.work_min)} (${hm(v.chat_min)} on chats)` : 'Did not work'}${v.first_at ? `\n${fTime.format(new Date(v.first_at))} – ${fTime.format(new Date(v.last_at))}` : ''}\n${num(v.typed + v.files)} typed · ${num(v.customers)} customers · ${num(v.s_chats)} solved · ${num(v.sales)} sales` } },
                  v.work_min ? h('b', null, v.work_min >= 60 ? `${Math.floor(v.work_min / 60)}h${String(v.work_min % 60).padStart(2, '0')}` : `${v.work_min}m`) : h('span', { class: 'muted' }, '–'),
                  v.typed + v.files ? h('span', null, num(v.typed + v.files)) : null);
              }));
          })))));
  }

  // ------------------------------------------------------------------ efficiency
  function effTip(p) {
    const t = p.totals, e = effOf(t);
    if (p.role !== 'staff') return 'Admins are not compared';
    if (e == null) return `Efficiency\nToo little work in this period to judge (fair share ${num(Math.round(t.fair || 0))} customers)`;
    return `Efficiency ${e}\nAnswered ${num(t.did)} customers; their fair share was ${num(Math.round(t.fair))}\n`
      + `(customers who wrote while they worked, split by how many minutes each person was working)\n`
      + `Their hours: ${num(t.busy)} customers writing per hour`;
  }
  // Bar around the team average: 100 in the middle, 60 at the left edge, 140 at the right (beyond is drawn at the edge).
  function effBar(e) {
    const pos = (v) => ((Math.max(60, Math.min(140, v)) - 60) / 80) * 100;
    const a = pos(Math.min(100, e ?? 100)), b = pos(Math.max(100, e ?? 100));
    return h('span', { class: 'pp-ebar' }, h('i', { class: 'zero' }),
      e == null ? null : h('i', { class: `fill ${effCls(e)}`, style: `left:${a}%;width:${Math.max(0.8, b - a)}%` }));
  }
  function effTrend(p, d) {
    const get = byDay(p);
    return h('span', { class: 'pp-etrend' }, daysOf(d).map((day) => {
      const x = get(day), e = effDay(x);
      return h('i', { class: effCls(e), dataset: { tip: `${dayName(day)}\n${e == null ? (x.work_min ? 'Too little work to judge' : 'Did not work') : `Efficiency ${e} — ${effWords(e)}`}${x.fair ? `\nAnswered ${num(x.did)} · fair share ${num(Math.round(x.fair))} · worked ${hm(x.work_min)}` : ''}` } });
    }));
  }
  function effSection(d, list) {
    const staff = list.filter((p) => p.role === 'staff').sort((a, b) => (effOf(b.totals) ?? -1) - (effOf(a.totals) ?? -1) || b.totals.work_min - a.totals.work_min);
    const admins = list.filter((p) => p.role !== 'staff');
    const multi = d.from !== d.to;
    if (!staff.length) return null;
    return h('section', { class: 'tm-sec' },
      h('div', { class: 'tm-sec-h' },
        h('div', null, h('h3', null, 'Efficiency'),
          h('p', { class: 'muted' }, 'How many customers each person answered for the time they worked, fairly adjusted: when it is busy everyone answers more, so each person is measured against their share of the customers who wrote while they were working. 100 = team average.')),
        h('span', { class: 'pp-elegend' }, h('i', { class: 'hi' }), '110+', h('i', { class: 'mid' }), '95–109', h('i', { class: 'lo' }), '80–94', h('i', { class: 'bad' }), 'under 80')),
      h('div', { class: 'tm-card pp-eff' },
        h('div', { class: 'pp-erow head' }, h('span'), h('span', null, h('span', { class: 'pp-escale' }, h('span', null, '60'), h('span', null, 'team average 100'), h('span', null, '140'))), h('span'), h('span', null, 'Time worked and per hour of work'),
          multi ? h('span', { class: 'pp-etrend lab' }, daysOf(d).map((day) => h('i', { title: dayName(day) }, String(Number(day.slice(8)))))) : null),
        staff.map((p) => {
          const t = p.totals, e = effOf(t);
          return h('div', { class: `pp-erow${multi ? '' : ' one'}` },
            h('button', { class: 'pp-lane-n', onclick: () => openPerson(p.id) }, p.name),
            h('span', { dataset: { tip: effTip(p) } }, effBar(e)),
            h('span', { class: `pp-eval ${effCls(e)}`, dataset: { tip: effTip(p) } }, h('b', null, e == null ? '–' : String(e)), h('span', null, effWords(e))),
            h('span', { class: 'pp-efacts' },
              h('span', null, 'worked ', h('b', null, hm(t.work_min))),
              t.work_min >= 30 ? h('span', null, h('b', null, (t.customers / (t.work_min / 60)).toFixed(1)), ' customers') : h('span', { class: 'muted' }, 'under 30 min of work'),
              t.work_min >= 30 ? h('span', null, h('b', null, ((typedOf(t)) / (t.work_min / 60)).toFixed(0)), ' messages') : null,
              t.customers ? h('span', null, h('b', null, (t.chat_min / t.customers).toFixed(1)), ' min per customer') : null,
              t.busy != null ? h('span', { class: 'muted' }, `their hours: ${num(Math.round(t.busy))} customers writing / hour`) : null),
            multi ? effTrend(p, d) : null);
        }),
        admins.length ? h('p', { class: 'muted pp-enote' }, `Not compared: ${admins.map((p) => p.name).join(', ')} (admin accounts). Their answers are taken out of the customers staff are measured against.`) : null));
  }
  // One day, hour by hour: what they answered (bar) against their fair share (line).
  function hourChart(p, day) {
    const rows = (p.hourly || []).filter((x) => x[0] === day);
    if (!rows.length) return h('p', { class: 'muted' }, 'Not enough work this day to show.');
    const W = 960, H = 150, padL = 30, padB = 20, padT = 8, band = (W - padL) / 24;
    const raw = Math.max(5, ...rows.map((x) => Math.max(Number(x[3]), Number(x[4]))));
    const step = Math.max(5, Math.ceil(raw / 4 / 5) * 5), max = Math.ceil(raw / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const svg = s('svg', { class: 'pp-hours', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${p.name}: customers answered per hour against their fair share` });
    for (let v = 0; v <= max; v += step) svg.append(s('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: v ? 'tm-grid' : 'tm-base' }), s('text', { x: padL - 6, y: y(v) + 3.5, class: 'tm-tick', 'text-anchor': 'end' }, String(v)));
    for (const [, hr0, m, fair, did, writing] of rows) {
      const x = padL + band * hr0, bw = band - 8;
      const ratio = fair > 0 && teamRatio ? (did / fair) / teamRatio : null;
      const tipText = `${hr(hr0)} – ${hr(hr0 + 1)}\nWorked ${hm(m)} · ${num(writing)} customers wrote\nAnswered ${num(did)} · fair share ${Number(fair).toFixed(1)}${ratio != null ? `\nEfficiency ${Math.round(ratio * 100)}` : ''}`;
      const g = s('g', null);
      const hit = s('rect', { x, y: padT, width: band, height: H - padT - padB, fill: 'transparent' }); hit.dataset.tip = tipText; g.append(hit);
      if (did > 0) { const r = s('rect', { x: x + 4, y: y(did), width: bw, height: y(0) - y(did), rx: 3, class: `pp-hbar ${effCls(ratio == null ? null : Math.round(ratio * 100))}` }); r.dataset.tip = tipText; g.append(r); }
      const ln = s('line', { x1: x + 1, x2: x + band - 1, y1: y(fair), y2: y(fair), class: 'pp-fair' }); ln.dataset.tip = tipText; g.append(ln);
      svg.append(g);
    }
    for (const t of [0, 3, 6, 9, 12, 15, 18, 21]) svg.append(s('text', { x: padL + band * t + band / 2, y: H - 5, class: 'tm-tick', 'text-anchor': 'middle' }, hr(t)));
    return svg;
  }

  // ------------------------------------------------------------------ the table
  const COLS = [
    ['name', 'Person', ''],
    ['work', 'Working time', 'Minutes with keyboard, mouse or touch on the desk, or an action. An open tab nobody touches is not counted.'],
    ['customers', 'Customers', 'Different customers they typed a reply or sent a file to.'],
    ['typed', 'Messages typed', 'Replies and files they sent themselves. Closing messages the desk picks when V is pressed are counted apart.'],
    ['solved', 'Support solved', 'Different support chats they solved (a chat solved twice the same day counts once).'],
    ['sales', 'Sales done', 'Different sales chats they marked complete. Below: accounts they delivered (the sale bell).'],
    ['fast', 'Answered ≤ 5 min', 'Share of their replies sent within 5 minutes of the customer\'s message. Below: the typical wait.'],
    ['eff', 'Efficiency', 'Customers answered compared with their fair share of the customers who wrote while they worked. 100 = team average. Below: customers per working hour.'],
  ];
  function cell(main, sub, tip) {
    return h('td', { dataset: tip ? { tip } : null }, h('b', null, main), sub ? h('span', null, sub) : null);
  }
  function row(p, d, maxWork, teamTyped) {
    const t = p.totals, pr = presence(p), isOpen = st.open.has(p.id), fl = flags(t);
    const presses = t.s_real + t.s_bare;
    const tr = h('tr', { class: `pp-row${st.sel === p.id ? ' sel' : ''}${isOpen ? ' open' : ''}`, tabindex: '0', 'aria-expanded': String(isOpen),
      onclick: () => toggle(p.id) },
      h('td', { class: 'pp-who' }, h('div', { class: 'pp-whoin' },
        h('div', { class: 'av', style: `background:${ctx.U.avColor(p.name)}` }, ctx.U.initials({ name: p.name })),
        h('div', null,
          h('b', null, p.name, p.role === 'admin' ? h('span', { class: 'role' }, 'admin') : null),
          h('span', { class: `tm-pres ${pr.cls}` }, h('i'), pr.text),
          fl.length ? h('span', { class: 'pp-flags' }, fl.map(([c, x]) => h('span', { class: `pp-flag ${c}` }, x))) : null))),
      h('td', { class: 'pp-work', dataset: { tip: `Working ${hm(t.work_min)}\n${hm(t.chat_min)} working on chats (an action within 5 minutes)\n${hm(t.work_min - t.chat_min)} at the desk with no chat action (reading, searching)\n${hm(t.idle_min)} open but not used — not counted${t.days_worked > 1 ? `\n${plural(t.days_worked, 'day')} · about ${hm(t.work_min / t.days_worked)} a day` : ''}` } },
        h('b', null, hm(t.work_min)),
        h('span', { class: 'pp-bar' }, h('i', { class: 'pp-chat', style: `width:${maxWork ? (t.chat_min / maxWork) * 100 : 0}%` }), h('i', { class: 'pp-desk', style: `width:${maxWork ? ((t.work_min - t.chat_min) / maxWork) * 100 : 0}%` })),
        h('span', null, t.work_min ? `${pct(t.chat_min, t.work_min)} on chats` : 'no time recorded')),
      cell(num(t.customers), null),
      cell(num(typedOf(t)), `${pct(typedOf(t), teamTyped)} of the team${t.closers ? ` · +${num(t.closers)} auto` : ''}`,
        `${num(t.typed)} text replies · ${num(t.files)} photos, files, voice notes\n${num(t.closers)} closing messages picked by the desk on V (not counted here)${t.failed ? `\n${num(t.failed)} failed to send` : ''}`),
      cell(num(t.s_chats), presses ? (t.s_bare ? `${num(t.s_bare)} with no reply from them` : 'all after replying') : null,
        `V pressed ${plural(presses, 'time')} on ${plural(t.s_chats, 'chat')}\n${num(t.s_real)} after they replied to the customer · ${num(t.s_bare)} without replying\n${num(t.s_repeat)} the same chat again that day (the customer wrote back)\n${num(t.s_fast)} pressed less than 5 seconds after the previous V`),
      cell(num(t.sales), t.delivered ? `${plural(t.delivered, 'account')} delivered` : null,
        `${num(t.sales)} sales chats marked complete (${num(t.sales_bare)} without a reply from them)\n${num(t.delivered)} accounts delivered after a new subscription (sale bell)`),
      cell(t.reply_n ? `${fastOf(t)}%` : '–', t.reply_n ? `typical wait ${secs(t.reply_median_s)}` : null,
        t.reply_n ? `${num(t.reply_within5)} of ${num(t.reply_n)} replies within 5 minutes\nHalf were faster than ${secs(t.reply_median_s)} · slowest 10% over ${secs(t.reply_p90_s)}` : 'No replies to a waiting customer'),
      h('td', { class: `pp-effc ${effCls(effOf(t))}`, dataset: { tip: effTip(p) } }, h('b', null, effOf(t) == null ? '–' : String(effOf(t))),
        h('span', null, paceOf(t) == null ? (p.role === 'staff' ? '' : 'admin: not compared') : `${paceOf(t).toFixed(1)} customers / hour`)));
    if (!isOpen) return [tr];
    return [tr, h('tr', { class: 'pp-detail-row' }, h('td', { colspan: String(COLS.length) }, detail(p, d)))];
  }
  function table(d, list) {
    const maxWork = Math.max(...list.map((p) => p.totals.work_min), 1);
    const teamTyped = list.reduce((n, p) => n + typedOf(p.totals), 0);
    return h('section', { class: 'tm-sec' },
      h('div', { class: 'tm-sec-h' }, h('div', null, h('h3', null, 'Each person'),
        h('p', { class: 'muted' }, 'Click a column to sort and a person (or J / K, then Enter) to see how their numbers add up. Hover any number for what is behind it.'))),
      h('div', { class: 'pp-tablewrap' },
        h('table', { class: 'pp-table' },
          h('thead', null, h('tr', null, COLS.map(([k, l, tip]) => h('th', { class: st.sort === k ? 'on' : '', dataset: tip ? { tip: `${l}\n${tip}` } : null },
            h('button', { onclick: () => { st.sort = k; ctx.redraw(); } }, l, st.sort === k ? ' ↓' : ''))))),
          h('tbody', null, list.flatMap((p) => row(p, d, maxWork, teamTyped))))));
  }

  // ------------------------------------------------------------------ one person
  function lines(rows) {
    return h('div', { class: 'pp-add' }, rows.filter(Boolean).map(([k, v, note]) => h('div', { class: 'pp-li' }, h('span', null, k), h('b', null, v), note ? h('small', null, note) : null)));
  }
  function detail(p, d) {
    const t = p.totals, single = d.from === d.to, presses = t.s_real + t.s_bare;
    const parts = [
      h('div', { class: 'pp-addwrap' },
        h('div', null, h('h5', null, 'Time'), lines([
          ['Working', hm(t.work_min), t.days_worked > 1 ? `over ${plural(t.days_worked, 'day')}, about ${hm(t.work_min / t.days_worked)} a day` : null],
          ['— on chats', hm(t.chat_min), 'sent, solved or labelled something within 5 minutes'],
          ['— no chat action', hm(t.work_min - t.chat_min), 'moving around the desk: reading, searching, scrolling'],
          ['Open, not used', hm(t.idle_min), 'tab open with no input — not counted as work'],
        ])),
        h('div', null, h('h5', null, 'Messages'), lines([
          ['Customers answered', num(t.customers)],
          ['Text replies', num(t.typed)],
          ['Photos, files, voice', num(t.files)],
          ['Closing messages', num(t.closers), 'picked by the desk when they pressed V — not in "typed"'],
          t.failed ? ['Failed to send', num(t.failed)] : null,
        ])),
        h('div', null, h('h5', null, 'Solving'), lines([
          ['Support chats solved', num(t.s_chats), presses !== t.s_chats ? `V pressed ${plural(presses, 'time')}; ${num(t.s_repeat)} were the same chat again after the customer wrote back` : null],
          ['— after replying', num(t.s_real), 'they had written to that customer in the 24 hours before'],
          ['— without replying', num(t.s_bare), 'nothing from them to that customer in the 24 hours before'],
          ['Pressed < 5 s apart', num(t.s_fast), 'V straight after the previous V (support and sales)'],
          ['Sales completed', num(t.sales), t.sales_bare ? `${num(t.sales_bare)} without a reply from them` : null],
          ['Accounts delivered', num(t.delivered), 'sale bell: the account sent after a new subscription'],
        ])),
        h('div', null, h('h5', null, 'Speed & quality'), lines([
          p.role === 'staff' ? ['Efficiency', effOf(t) == null ? '–' : String(effOf(t)), t.fair ? `answered ${num(t.did)} of a fair share of ${num(Math.round(t.fair))} customers — ${effWords(effOf(t))}` : null] : null,
          ['Answered within 5 min', t.reply_n ? `${fastOf(t)}%` : '–', t.reply_n ? `${num(t.reply_within5)} of ${num(t.reply_n)} replies` : null],
          ['Typical wait', secs(t.reply_median_s), t.reply_n ? `slowest 10% over ${secs(t.reply_p90_s)}` : null],
          ['Sent back after your review', num(t.flagged), t.checked ? `of ${num(t.checked)} you reviewed in Radar` : 'none reviewed yet'],
          ['Customer came back', `${num(t.came_back)} of ${num(t.audited)}`, 'wrote again within 48 h of the solve'],
          ['Solved through red warning', num(t.warned)],
        ]))),
    ];
    if (single) {
      const x = byDay(p)(d.from);
      if (p.role === 'staff') parts.push(h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Hour by hour: customers answered against their fair share'),
        h('span', { class: 'pp-elegend' }, h('i', { class: 'mid' }), 'answered', h('i', { class: 'line' }), 'fair share')), hourChart(p, d.from)));
      parts.push(h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Their day'), legend()), dayStrip(x, p.name, true), axis()),
        h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Everything they did, in order')), ctx.dayLog(p, d.from)));
    } else {
      const get = byDay(p);
      parts.push(h('div', { class: 'pp-two' },
        h('div', { class: 'tm-card pp-gridwrap' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Each day')),
          h('table', { class: 'pp-days' },
            h('thead', null, h('tr', null, ['Day', 'Hours', 'Working', 'Efficiency', 'On chats', 'Typed', 'Customers', 'Solved', 'Sales', 'Delivered'].map((x) => h('th', null, x)))),
            h('tbody', null, daysOf(d).reverse().map((day) => {
              const v = get(day);
              return h('tr', { class: v.work_min || v.typed ? '' : 'off' },
                h('td', null, dayName(day)), h('td', null, v.first_at ? `${fTime.format(new Date(v.first_at))} – ${fTime.format(new Date(v.last_at))}` : '–'),
                h('td', null, v.work_min ? hm(v.work_min) : '–'),
                h('td', { class: `pp-effc ${effCls(effDay(v))}` }, effDay(v) == null ? '–' : h('b', null, String(effDay(v)))),
                h('td', null, v.chat_min ? hm(v.chat_min) : '–'),
                h('td', null, num(v.typed + v.files)), h('td', null, num(v.customers)), h('td', null, num(v.s_chats)), h('td', null, num(v.sales)), h('td', null, num(v.delivered)));
            })))),
        h('div', { class: 'tm-card' }, h('div', { class: 'tm-card-h' }, h('b', null, 'Usual working hours'), h('span', { class: 'muted' }, 'darker = more work')), ctx.hourHeat(p.hours || {}))));
    }
    return h('div', { class: 'pp-detail' }, parts);
  }

  // ------------------------------------------------------------------ page
  function tile(label, value, sub, tip) {
    return h('div', { class: 'tm-tile', dataset: tip ? { tip: `${label}\n${tip}` } : null }, h('span', { class: 'tm-tile-l' }, label), h('b', { class: 'tm-tile-v' }, value), sub ? h('span', { class: 'tm-tile-s' }, sub) : null);
  }
  function summary(d, list) {
    const sum = (k) => list.reduce((n, p) => n + Number(p.totals[k] || 0), 0);
    const tr = d.team_reply || {};
    return h('div', { class: 'tm-tiles' },
      tile('Working time', hm(sum('work_min')), `${plural(list.filter((p) => p.totals.work_min > 0).length, 'person', 'people')} · ${hm(sum('chat_min'))} on chats`, 'Input or actions on the desk. Open tabs nobody touches are left out.'),
      tile('Customers answered', num(sum('customers')), 'with a typed reply or file', 'Added up per person: a customer two people answered counts for both.'),
      tile('Messages typed', num(sum('typed') + sum('files')), `+${num(sum('closers'))} automatic closing messages`),
      tile('Support chats solved', num(sum('s_chats')), `${num(sum('s_bare'))} V presses without a reply`),
      tile('Sales completed', num(sum('sales')), `${plural(sum('delivered'), 'account')} delivered`),
      tile('Answered within 5 min', tr.n ? pct(tr.within5, tr.n) : '–', tr.n ? `typical wait ${secs(tr.median_s)}` : 'no replies yet'));
  }
  function view(c) {
    ctx = c;
    const key = `${c.from}|${c.to}`;
    if (st.key !== key && !st.loading) { st.data = null; load(false); }
    else if (st.data && Date.now() - st.at > 60000 && !st.loading) load(true);
    const d = st.key === key ? st.data : null;
    if (!d) return [h('div', { class: 'tm-empty' }, st.error ? [h('b', null, 'Could not load the people report.'), h('div', null, st.error), h('button', { class: 'btn', onclick: () => load(false) }, 'Try again')] : 'Loading…')];
    teamRatio = d.team_eff && d.team_eff.fair > 0 && d.team_eff.did > 0 ? d.team_eff.did / d.team_eff.fair : null;
    teamDay = (d.team_eff && d.team_eff.days) || {};
    const { list, absent } = ordered(d);
    st.list = list.map((p) => p.id);
    const single = d.from === d.to;
    const since = d.tracking_since ? Date.parse(d.tracking_since) : null;
    return [
      st.error ? h('p', { class: 'tm-note warn' }, `Could not refresh (${st.error}). Showing the last numbers.`) : null,
      effSection(d, list),
      summary(d, list),
      since && since > Date.parse(d.from + 'T00:00:00Z') ? h('p', { class: 'tm-note warn' }, 'Minute-by-minute tracking started on 18 Nov. Before that only minutes with an action are known, so working time reads low.') : null,
      list.length ? (single ? timeline(d, list) : grid(d, list)) : h('p', { class: 'muted' }, 'Nobody worked on the desk in this period.'),
      list.length ? table(d, list) : null,
      absent.length ? h('p', { class: 'muted pp-absent' }, `Did not work in this period: ${absent.map((p) => p.name).join(', ')}.`) : null,
      h('details', { class: 'pp-how' }, h('summary', null, 'How these numbers are counted'),
        h('ul', null,
          h('li', null, h('b', null, 'Working time'), ' — a minute counts when the person used the keyboard, mouse or touch screen on the desk, or did something (sent, solved, labelled). A tab left open with nobody touching it is shown faded and never counted.'),
          h('li', null, h('b', null, 'On chats'), ' — working minutes within 5 minutes of something they did to a chat. The rest is time on the desk without acting on any chat: reading, searching, scrolling.'),
          h('li', null, h('b', null, 'Messages typed'), ' — replies and files they sent themselves. The closing message the desk picks when V is pressed is counted apart, so pressing V does not look like writing.'),
          h('li', null, h('b', null, 'Solved'), ' — different chats, not V presses. A chat solved again the same day after the customer wrote back counts once. Solves with no reply from them in the 24 hours before are shown apart.'),
          h('li', null, h('b', null, 'Efficiency'), ' — for every hour someone worked: the customers who wrote that hour (minus those an admin answered) are split between the staff working, by their working minutes. That is their fair share. Efficiency = customers they answered ÷ fair share, compared with the whole team (100 = average). It is shown from a fair share of 15 customers (8 for one day).'),
          h('li', null, h('b', null, 'Not counted'), ' — replies typed in the BSB phone app: they reach us without a name, so nobody can be credited for them.')))
    ];
  }

  // ------------------------------------------------------------------ interaction
  function toggle(id) { st.sel = id; if (st.open.has(id)) st.open.delete(id); else st.open.add(id); ctx.redraw(); }
  function openPerson(id) {
    st.sel = id; st.open.add(id); ctx.redraw();
    focusSel('start');
  }
  // J / K move between people, Enter opens or closes the selected one (team.js hands keys over while this tab is open)
  function key(e) {
    if (!st.list || !st.list.length || e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = e.target;
    if (t && t.closest && t.closest('button,input,select,textarea,a,summary')) return false;
    const k = e.key.toLowerCase();
    if (k === 'enter') { if (st.sel == null) return false; toggle(st.sel); focusSel('nearest'); return true; }
    if (k !== 'j' && k !== 'k') return false;
    const i = st.list.indexOf(st.sel);
    st.sel = st.list[k === 'j' ? Math.min(st.list.length - 1, i + 1) : Math.max(0, i - 1)];
    ctx.redraw();
    focusSel('nearest');
    return true;
  }
  function focusSel(block) {
    requestAnimationFrame(() => { const el = document.querySelector('.pp-row.sel'); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block }); } });
  }

  window.DeskPeople = { view, key, refresh };
})();
