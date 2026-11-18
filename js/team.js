/* Teshrij Desk — Team activity (admins only).
 *
 * One screen over the desk: per employee the time they were active on the desk, when, what they
 * did (messages, solves, sales completed, reply time) and the AI scanner's findings: chats that
 * were marked solved / complete while the customer's issue was not. All numbers come from the
 * server (op team_report); this file only draws them. Times are Beirut time.
 */
(function () {
  'use strict';
  let U = null;            // helpers handed over by app.js
  let root = null;
  let timer = null;
  const st = { preset: 'today', from: '', to: '', data: null, loading: false, error: '', open: new Set(), review: 'open', scanning: false };

  const TZ = 'Asia/Beirut';
  const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const today = () => fDay.format(new Date(U.now()));
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayName = (day) => fShort.format(new Date(day + 'T00:00:00Z'));
  const hm = (min) => { const m = Math.max(0, Math.round(min)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const secs = (s) => s == null ? '–' : s < 90 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '–';

  const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days']];
  function setPreset(p) {
    st.preset = p;
    const t = today();
    if (p === 'today') { st.from = t; st.to = t; }
    else if (p === 'yesterday') { st.from = st.to = addDays(t, -1); }
    else { st.from = addDays(t, -(Number(p) - 1)); st.to = t; }
  }
  const CATEGORY = {
    still_broken: 'Still not working', unanswered_question: 'Question not answered', promise_not_kept: 'Promise not kept',
    customer_waiting: 'Customer left waiting', no_reply_at_all: 'Nobody replied', none: 'Not solved',
  };

  // ---------------------------------------------------------------- data

  async function load(quiet = false) {
    if (st.loading) return;
    st.loading = true; st.error = '';
    if (!quiet) draw();
    try { st.data = await U.api.call('team_report', { from: st.from, to: st.to }); }
    catch (e) { st.error = e.message || 'Could not load'; }
    st.loading = false;
    draw();
  }
  async function scanNow() {
    if (st.scanning) return;
    st.scanning = true; draw();
    try {
      const r = await U.api.call('audit_run');
      U.toast(r.off ? 'The AI scanner is off (no OpenAI key)' : r.busy ? 'A scan is already running' : `Scanned ${r.checked || 0} chat${r.checked === 1 ? '' : 's'}${r.flagged ? ` · ${r.flagged} flagged` : ''}`, r.flagged ? '' : 'ok');
    } catch (e) { U.toast(e.message, 'error'); }
    st.scanning = false;
    load(true);
  }
  async function review(f, value) {
    try {
      await U.api.call('audit_review', { id: f.id, review: value });
      f.review = value; f.reviewed_by = value ? 'you' : null;
      draw();
      load(true);
    } catch (e) { U.toast(e.message, 'error'); }
  }

  // ---------------------------------------------------------------- tooltip (one for every chart)

  let tip = null;
  function bindTip(el) {
    el.addEventListener('pointermove', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { if (tip) tip.hidden = true; return; }
      if (!tip) { tip = U.h('div', { class: 'tm-tip', role: 'tooltip' }); document.body.append(tip); }
      if (tip._for !== t) { tip._for = t; tip.replaceChildren(...String(t.dataset.tip).split('\n').map((line, i) => U.h(i ? 'div' : 'b', null, line))); }
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

  // One day as a 24 h strip: active minutes dark, desk open but no input light.
  function strip(day, label) {
    const svg = s('svg', { class: 'tm-strip', viewBox: '0 0 1440 20', preserveAspectRatio: 'none', role: 'img',
      'aria-label': `${label}: active ${hm(day.active_min)}, desk open ${hm(day.online_min)}` });
    svg.append(s('rect', { x: 0, y: 0, width: 1440, height: 20, class: 'tm-track' }));
    for (const [a, b, on] of day.segs || []) {
      const w = Math.max(b - a, 2.5);
      const r = s('rect', { x: Math.min(a, 1440 - w), y: 0, width: w, height: 20, class: on ? 'tm-on' : 'tm-idle' });
      r.dataset.tip = `${clock(a)} – ${clock(b)}\n${on ? 'Active' : 'Desk open, no input'} · ${hm(b - a)}`;
      svg.append(r);
    }
    return svg;
  }
  function stripAxis() {
    return U.h('div', { class: 'tm-axis', 'aria-hidden': 'true' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => U.h('span', { style: `left:${(x / 24) * 100}%` }, String(x).padStart(2, '0'))));
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

  // 24 cells, one hue, light -> dark by active minutes in that hour of the day.
  function hourHeat(hours) {
    const vals = Array.from({ length: 24 }, (_, i) => Number(hours[i] || 0));
    const max = Math.max(...vals, 1);
    return U.h('div', { class: 'tm-heat' },
      U.h('div', { class: 'tm-heat-row' }, vals.map((v, i) => {
        const lvl = v ? 1 + Math.min(4, Math.floor((v / max) * 4.999)) : 0;
        return U.h('span', { class: `tm-cell l${lvl}`, dataset: { tip: `${String(i).padStart(2, '0')}:00 – ${String(i + 1).padStart(2, '0')}:00\n${v ? hm(v) + ' active' : 'Not active'}` } });
      })),
      U.h('div', { class: 'tm-heat-axis', 'aria-hidden': 'true' }, [0, 6, 12, 18].map((x) => U.h('span', { style: `left:${(x / 24) * 100}%` }, `${String(x).padStart(2, '0')}:00`))));
  }

  // Horizontal bars comparing employees on one measure (one hue: it is the same measure).
  function compare(title, sub, rows, fmt) {
    const max = Math.max(...rows.map((r) => r.v), 1);
    return U.h('div', { class: 'tm-card' },
      U.h('div', { class: 'tm-card-h' }, U.h('b', null, title), sub ? U.h('span', { class: 'muted' }, sub) : null),
      rows.length ? U.h('div', { class: 'tm-hbars' }, rows.map((r) => U.h('div', { class: 'tm-hbar', dataset: { tip: `${r.name}\n${r.tip || fmt(r.v)}` } },
        U.h('span', { class: 'tm-hbar-n' }, r.name),
        U.h('span', { class: 'tm-hbar-t' }, U.h('i', { class: r.cls || '', style: `width:${Math.max(r.v ? 1.5 : 0, (r.v / max) * 100)}%` })),
        U.h('span', { class: 'tm-hbar-v' }, fmt(r.v))))) : U.h('p', { class: 'muted' }, 'Nothing in this period.'));
  }

  // ---------------------------------------------------------------- pieces

  function presence(p) {
    const n = U.now();
    const act = p.last_active_at ? n - Date.parse(p.last_active_at) : Infinity;
    const open = p.last_open_at ? n - Date.parse(p.last_open_at) : Infinity;
    if (act < 150000) return U.h('span', { class: 'tm-pres on' }, U.h('i'), 'Active now');
    if (open < 150000) return U.h('span', { class: 'tm-pres idle' }, U.h('i'), `Desk open · idle ${U.dur(act === Infinity ? open : act)}`);
    const last = p.last_active_at || p.last_seen_at;
    return U.h('span', { class: 'tm-pres' }, U.h('i'), last ? `Offline · last active ${U.ago(last)}` : 'Never signed in');
  }
  function tile(label, value, sub, cls = '') {
    return U.h('div', { class: `tm-tile ${cls}` }, U.h('span', { class: 'tm-tile-l' }, label), U.h('b', { class: 'tm-tile-v' }, value), sub ? U.h('span', { class: 'tm-tile-s' }, sub) : null);
  }
  function stat(label, value, title) {
    return U.h('div', { class: 'tm-stat', title: title || null }, U.h('span', null, label), U.h('b', null, value));
  }
  function flagPill(n, pending) {
    if (n) return U.h('span', { class: 'tm-flag', title: `${n} chat${n > 1 ? 's' : ''} marked solved / complete while the issue was not` }, U.icon('warn', 'xs'), `${n} flagged`);
    return U.h('span', { class: 'tm-okpill', title: pending ? `${pending} not scanned yet` : 'The AI scanner found nothing' }, pending ? `${pending} to scan` : 'No flags');
  }

  function employee(p, single, maxActive) {
    const t = p.totals;
    const isOpen = st.open.has(p.id);
    const day0 = single ? (p.days[0] || { active_min: 0, online_min: 0, segs: [] }) : null;
    const head = U.h('button', { class: 'tm-emp-h', 'aria-expanded': String(isOpen), onclick: () => { if (isOpen) st.open.delete(p.id); else st.open.add(p.id); draw(); } },
      U.h('div', { class: 'av', style: `background:${U.avColor(p.name)}` }, U.initials({ name: p.name })),
      U.h('div', { class: 'tm-emp-who' }, U.h('b', null, p.name, p.role === 'admin' ? U.h('span', { class: 'role' }, 'admin') : null, p.active ? null : U.h('span', { class: 'role' }, 'revoked')), presence(p)),
      U.h('div', { class: 'tm-emp-nums' },
        U.h('div', { class: 'tm-n main', title: 'Minutes with keyboard, mouse or touch input on the desk' }, U.h('b', null, hm(t.active_min)), U.h('span', null, 'active'),
          U.h('span', { class: 'tm-meter' }, U.h('i', { style: `width:${maxActive ? (t.active_min / maxActive) * 100 : 0}%` }))),
        U.h('div', { class: 'tm-n' }, U.h('b', null, num(t.sent)), U.h('span', null, 'sent')),
        U.h('div', { class: 'tm-n' }, U.h('b', null, num(t.solved)), U.h('span', null, 'solved')),
        U.h('div', { class: 'tm-n' }, U.h('b', null, num(t.sales_done)), U.h('span', null, 'sales done')),
        U.h('div', { class: 'tm-n' }, U.h('b', null, secs(t.reply_median_s)), U.h('span', null, 'reply time')),
        flagPill(t.flagged, t.pending)),
      U.h('span', { class: `tm-chev${isOpen ? ' up' : ''}` }, U.icon('chev')));

    const body = [];
    if (single) {
      body.push(U.h('div', { class: 'tm-day' }, strip(day0, p.name), stripAxis()),
        U.h('div', { class: 'tm-day-sub muted' }, day0.first_at ? `First active ${fTime.format(new Date(day0.first_at))} · last ${fTime.format(new Date(day0.last_at))} · desk open ${hm(day0.online_min)}` : 'No activity recorded this day'));
    }
    if (isOpen) {
      const days = fillDays(p.days);
      body.push(U.h('div', { class: 'tm-detail' },
        U.h('div', { class: 'tm-stats' },
          stat('Desk open', hm(t.online_min), 'Minutes the desk was open in a browser tab, active or not'),
          stat('Days active', `${t.days_active}`),
          stat('Chats messaged', num(t.chats), 'Different customers this person sent a message to'),
          stat('Replies', num(t.replies)), stat('Photos / files / voice', num(t.media)), stat('Closing messages', num(t.closers)),
          stat('Failed sends', num(t.failed)),
          stat('Solved with a message', `${num(t.solved_msg)} of ${num(t.solved)}`),
          stat('Reply time (median)', secs(t.reply_median_s), `From the customer's message to this person's reply, ${num(t.reply_n)} replies`),
          stat('Reply time (slowest 10%)', secs(t.reply_p90_s)),
          stat('Labels set', num(t.labels)), stat('Sales / support corrected', num(t.relabels)),
          stat('Solved despite AI warning', num(t.overrides), 'The desk warned "issue does not seem solved" and they solved it anyway'),
          stat('Reopened by the customer', `${num(t.reopened)} of ${num(t.audited)}`, 'The customer wrote again within 48 h of the solve'),
          stat('Scanned by AI', `${num(t.checked)} of ${num(t.audited)}`),
          stat('Flags confirmed / dismissed', `${num(t.confirmed)} / ${num(t.dismissed)}`)),
        U.h('div', { class: 'tm-charts' },
          days.length > 1 ? U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Active time per day')),
            columns(days, { unit: 'h', label: `${p.name}: active time per day`, value: (d) => d.active_min,
              tip: (d) => `${dayName(d.day)}\nActive ${hm(d.active_min)} · desk open ${hm(d.online_min)}\n${d.first_at ? `${fTime.format(new Date(d.first_at))} – ${fTime.format(new Date(d.last_at))}` : 'No activity'}` })) : null,
          days.length > 1 ? U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Chats solved and completed per day')),
            columns(days, { unit: 'n', label: `${p.name}: chats solved and completed per day`, value: (d) => d.solved + d.sales_done,
              tip: (d) => `${dayName(d.day)}\n${d.solved} solved · ${d.sales_done} sales completed\n${d.sent} messages sent${d.flagged ? ` · ${d.flagged} flagged` : ''}` })) : null,
          U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Active by hour of day'), U.h('span', { class: 'muted' }, 'darker = more active minutes')), hourHeat(p.hours || {}))),
        !single && p.days.length ? U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Day by day'), legend()),
          U.h('div', { class: 'tm-daylist' }, [...p.days].reverse().map((d) => U.h('div', { class: 'tm-dayrow' },
            U.h('span', { class: 'tm-dayrow-d' }, dayName(d.day)), U.h('div', { class: 'tm-day' }, strip(d, `${p.name} ${d.day}`)),
            U.h('span', { class: 'tm-dayrow-v' }, hm(d.active_min))))), U.h('div', { class: 'tm-dayrow' }, U.h('span', { class: 'tm-dayrow-d' }), stripAxis(), U.h('span', { class: 'tm-dayrow-v' }))) : null));
    }
    return U.h('section', { class: `tm-emp${isOpen ? ' open' : ''}` }, head, body);
  }
  // every day of the range, also the ones with nothing
  function fillDays(days) {
    const by = new Map(days.map((d) => [d.day, d]));
    const out = [];
    for (let d = st.data.from; d <= st.data.to; d = addDays(d, 1)) out.push(by.get(d) || { day: d, active_min: 0, online_min: 0, sent: 0, solved: 0, sales_done: 0, flagged: 0, segs: [] });
    return out;
  }
  function legend() {
    return U.h('span', { class: 'tm-legend' }, U.h('i', { class: 'on' }), 'Active', U.h('i', { class: 'idle' }), 'Desk open, no input');
  }

  function flagCard(f) {
    const who = f.name && /[\p{L}\p{N}]/u.test(f.name) ? f.name : f.handle ? '@' + f.handle : /^\d+$/.test(f.contact) ? '+' + f.contact : 'Instagram user';
    return U.h('article', { class: `tm-fc${f.review ? ' ' + f.review : ''}` },
      U.h('div', { class: 'tm-fc-h' },
        U.h('b', null, who),
        U.h('span', { class: `sys k-${f.kind === 'sales' ? 'sales' : 'support'}` }, f.kind === 'sales' ? 'Sales · marked complete' : 'Support · marked solved'),
        U.h('span', { class: 'muted' }, fDateTime.format(new Date(f.solved_at))),
        f.reopened_at ? U.h('span', { class: 'tm-chip warn', title: `The customer wrote again ${fDateTime.format(new Date(f.reopened_at))}` }, 'Customer came back') : null,
        f.warned ? U.h('span', { class: 'tm-chip warn', title: `The desk warned before the solve: ${f.warned}` }, 'Ignored the warning') : null,
        f.still_open ? U.h('span', { class: 'tm-chip' }, 'Open again now') : null,
        f.review ? U.h('span', { class: `tm-chip ${f.review === 'confirmed' ? 'bad' : ''}` }, f.review === 'confirmed' ? 'Confirmed' : 'False alarm') : null),
      U.h('p', { class: 'tm-fc-why' }, U.h('span', { class: 'tm-cat' }, CATEGORY[f.category] || CATEGORY.none), f.reason || ''),
      f.evidence ? U.h('blockquote', { class: 'tm-fc-q', dir: 'auto' }, f.evidence) : null,
      U.h('div', { class: 'tm-fc-a' },
        U.h('button', { class: 'btn sm', onclick: () => { close(); U.openChat(f.contact); } }, U.icon('chat', 'sm'), 'Open chat'),
        f.review ? U.h('button', { class: 'btn sm ghost', onclick: () => review(f, null) }, 'Undo review')
          : [U.h('button', { class: 'btn sm', title: 'The AI is right: this was not solved', onclick: () => review(f, 'confirmed') }, U.icon('check', 'sm'), 'Confirm'),
            U.h('button', { class: 'btn sm ghost', title: 'The AI is wrong: it was solved. It stops counting against the employee', onclick: () => review(f, 'dismissed') }, 'False alarm')],
        f.confidence != null ? U.h('span', { class: 'muted tm-conf' }, `AI confidence ${Math.round(f.confidence * 100)}%`) : null));
  }

  function scanner(d) {
    const sc = d.scanner || {};
    const all = d.flags || [];
    const shown = all.filter((f) => st.review === 'all' ? true : st.review === 'open' ? !f.review : f.review === st.review);
    const count = (k) => all.filter((f) => k === 'all' ? true : k === 'open' ? !f.review : f.review === k).length;
    const groups = d.staff.map((p) => ({ p, list: shown.filter((f) => f.staff_id === p.id) })).filter((g) => g.list.length)
      .sort((a, b) => b.list.length - a.list.length);
    const rate = d.staff.filter((p) => p.totals.checked > 0).map((p) => ({
      name: p.name, v: p.totals.flagged, cls: 'bad',
      tip: `${p.totals.flagged} flagged of ${p.totals.checked} scanned (${pct(p.totals.flagged, p.totals.checked)})${p.totals.pending ? `\n${p.totals.pending} not scanned yet` : ''}`,
      share: p.totals.checked ? p.totals.flagged / p.totals.checked : 0, checked: p.totals.checked,
    })).sort((a, b) => b.v - a.v);
    return U.h('section', { class: 'tm-sec' },
      U.h('div', { class: 'tm-sec-h' },
        U.h('div', null, U.h('h3', null, U.icon('warn'), 'Marked solved, but not solved'),
          U.h('p', { class: 'muted' }, 'The AI reads every chat an employee marks solved (support) or complete (sales), about 10 minutes later and again if the customer comes back. It flags a chat only when the customer’s own words show the issue was still open.')),
        U.h('div', { class: 'tm-scan' },
          U.h('span', { class: 'muted' }, sc.enabled === false ? 'Scanner is off' : `${sc.queued ? `${sc.queued} waiting to be scanned` : 'All scanned'}${sc.last_checked_at ? ` · last scan ${U.ago(sc.last_checked_at)}` : ''}`),
          U.h('button', { class: 'btn sm', disabled: st.scanning || !sc.queued, onclick: scanNow }, U.icon('refresh', 'sm'), st.scanning ? 'Scanning…' : 'Scan now'))),
      U.h('div', { class: 'tm-charts' },
        compare('Flagged chats per employee', 'in this period', rate, (v) => String(v)),
        U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Share of their solves that were flagged')),
          rate.length ? U.h('table', { class: 'tm-table' },
            U.h('thead', null, U.h('tr', null, ['Employee', 'Scanned', 'Flagged', 'Share'].map((x, i) => U.h('th', { class: i ? 'r' : '' }, x)))),
            U.h('tbody', null, rate.map((r) => U.h('tr', null, U.h('td', null, r.name), U.h('td', { class: 'r' }, num(r.checked)), U.h('td', { class: 'r' }, num(r.v)),
              U.h('td', { class: 'r' }, U.h('span', { class: `tm-share${r.share >= 0.15 ? ' bad' : ''}` }, pct(r.v, r.checked))))))) : U.h('p', { class: 'muted' }, 'No solves scanned in this period yet.'))),
      U.h('div', { class: 'tm-filter', role: 'tablist' }, [['open', 'To review'], ['confirmed', 'Confirmed'], ['dismissed', 'False alarms'], ['all', 'All']].map(([k, l]) =>
        U.h('button', { class: `tm-tab${st.review === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(st.review === k), onclick: () => { st.review = k; draw(); } }, l, U.h('span', null, count(k))))),
      groups.length ? groups.map((g) => U.h('div', { class: 'tm-fgroup' },
        U.h('div', { class: 'tm-fgroup-h' }, U.h('div', { class: 'av sm', style: `background:${U.avColor(g.p.name)}` }, U.initials({ name: g.p.name })),
          U.h('b', null, g.p.name), U.h('span', { class: 'tm-flag' }, U.icon('warn', 'xs'), `${g.list.length} chat${g.list.length > 1 ? 's' : ''}`),
          U.h('span', { class: 'muted' }, `${pct(g.p.totals.flagged, g.p.totals.checked)} of ${g.p.totals.checked} scanned solves in this period`)),
        U.h('div', { class: 'tm-fcards' }, g.list.map(flagCard))))
        : U.h('div', { class: 'tm-empty' }, st.review === 'open' ? (all.length ? 'Nothing left to review.' : sc.queued ? 'Nothing flagged so far. Some chats are still waiting to be scanned.' : 'Nothing flagged in this period.') : 'Nothing here.'));
  }

  // ---------------------------------------------------------------- screen

  function draw() {
    if (!root) return;
    const d = st.data;
    const keepScroll = root.querySelector('.tm-body') ? root.querySelector('.tm-body').scrollTop : 0;
    const from = U.h('input', { type: 'date', value: st.from, max: today(), 'aria-label': 'From' });
    const to = U.h('input', { type: 'date', value: st.to, max: today(), 'aria-label': 'To' });
    const custom = () => { if (from.value && to.value && from.value <= to.value) { st.preset = ''; st.from = from.value; st.to = to.value; load(); } };
    from.addEventListener('change', custom); to.addEventListener('change', custom);
    const head = U.h('header', { class: 'tm-head' },
      U.h('button', { class: 'btn sm', onclick: close }, U.icon('back', 'sm'), 'Back to chats', U.h('kbd', null, 'Esc')),
      U.h('h2', null, 'Team activity'),
      U.h('div', { class: 'tm-range', role: 'group', 'aria-label': 'Period' },
        PRESETS.map(([k, l]) => U.h('button', { class: `tm-tab${st.preset === k ? ' on' : ''}`, onclick: () => { setPreset(k); load(); } }, l)),
        U.h('span', { class: 'tm-dates' }, from, U.h('span', { class: 'muted' }, 'to'), to)),
      U.h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => load() }, U.icon('refresh')));

    let body;
    if (!d) body = U.h('div', { class: 'tm-empty' }, st.error ? `Could not load: ${st.error}` : 'Loading…');
    else {
      const single = d.from === d.to;
      const staff = [...d.staff].sort((a, b) => (b.totals.active_min - a.totals.active_min) || (b.totals.sent - a.totals.sent) || a.name.localeCompare(b.name));
      const sum = (k) => staff.reduce((n, p) => n + Number(p.totals[k] || 0), 0);
      const maxActive = Math.max(...staff.map((p) => p.totals.active_min), 0);
      const since = d.tracking_since ? Date.parse(d.tracking_since) : null;
      const partial = !since || since > Date.parse(d.from + 'T00:00:00Z');
      const medians = staff.filter((p) => p.totals.reply_n > 0);
      const teamMedian = d.team && d.team.reply_n ? d.team.reply_median_s : null;
      const active = (v) => v.map((p) => ({ name: p.name, v: p.totals.active_min, tip: `Active ${hm(p.totals.active_min)} · desk open ${hm(p.totals.online_min)}` })).filter((r) => r.v > 0);
      const teamDays = single ? [] : (() => {
        const m = new Map();
        for (const p of staff) for (const x of fillDays(p.days)) {
          const o = m.get(x.day) || { day: x.day, active_min: 0, sent: 0, solved: 0, sales_done: 0, flagged: 0 };
          o.active_min += x.active_min; o.sent += x.sent; o.solved += x.solved; o.sales_done += x.sales_done; o.flagged += x.flagged; m.set(x.day, o);
        }
        return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
      })();
      body = U.h('div', { class: 'tm-body' },
        st.error ? U.h('div', { class: 'tm-note bad' }, `Could not refresh: ${st.error}`) : null,
        U.h('p', { class: 'tm-note' }, `${single ? dayName(d.from) : `${dayName(d.from)} – ${dayName(d.to)}`} · Beirut time. `,
          U.h('b', null, 'Active'), ' = a minute with keyboard, mouse or touch input on the desk, or a recorded action (message sent, chat solved, label set). ',
          partial ? U.h('span', { class: 'tm-warn' }, since ? `Minute-by-minute tracking started ${fDateTime.format(new Date(since))}; before that only recorded actions count, so earlier active time reads low.`
            : 'Minute-by-minute tracking starts when each person reloads the desk; until then only recorded actions count.') : null),
        U.h('div', { class: 'tm-tiles' },
          tile('Active time', hm(sum('active_min')), `${staff.filter((p) => p.totals.active_min > 0).length} of ${staff.filter((p) => p.active).length} people active`),
          tile('Messages sent', num(sum('sent')), `to ${num(sum('chats'))} chats`),
          tile('Support solved', num(sum('solved')), `${num(sum('solved_msg'))} with a closing message`),
          tile('Sales completed', num(sum('sales_done'))),
          tile('Reply time', secs(teamMedian), 'median, customer message → reply'),
          tile('Flagged by AI', num(sum('flagged')), sum('checked') ? `${pct(sum('flagged'), sum('checked'))} of ${num(sum('checked'))} scanned solves` : 'nothing scanned yet', sum('flagged') ? 'bad' : '')),
        U.h('section', { class: 'tm-sec' },
          U.h('div', { class: 'tm-sec-h' }, U.h('div', null, U.h('h3', null, U.icon('team'), 'Employees'),
            U.h('p', { class: 'muted' }, single ? 'The strip shows the day from 00:00 to 24:00. Click a person for the full breakdown.' : 'Click a person for charts and the day-by-day timeline.')), single ? legend() : null),
          staff.map((p) => employee(p, single, maxActive))),
        U.h('section', { class: 'tm-sec' },
          U.h('div', { class: 'tm-sec-h' }, U.h('div', null, U.h('h3', null, U.icon('chart'), 'Compare'))),
          U.h('div', { class: 'tm-charts' },
            compare('Active time', '', active(staff), hm),
            compare('Messages sent', '', staff.map((p) => ({ name: p.name, v: p.totals.sent, tip: `${p.totals.sent} sent · ${p.totals.chats} chats` })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v), num),
            compare('Chats solved + sales completed', '', staff.map((p) => ({ name: p.name, v: p.totals.solved + p.totals.sales_done, tip: `${p.totals.solved} solved · ${p.totals.sales_done} sales completed` })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v), num),
            compare('Reply time (median)', 'shorter is better', medians.map((p) => ({ name: p.name, v: p.totals.reply_median_s, tip: `median ${secs(p.totals.reply_median_s)} · slowest 10% ${secs(p.totals.reply_p90_s)} · ${p.totals.reply_n} replies` })).sort((a, b) => a.v - b.v), secs),
            teamDays.length > 1 ? U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Team active time per day')),
              columns(teamDays, { unit: 'h', label: 'Team active time per day', value: (x) => x.active_min, tip: (x) => `${dayName(x.day)}\nActive ${hm(x.active_min)} (everyone)\n${x.sent} sent · ${x.solved} solved · ${x.sales_done} sales completed` })) : null,
            teamDays.length > 1 ? U.h('div', { class: 'tm-card' }, U.h('div', { class: 'tm-card-h' }, U.h('b', null, 'Messages sent per day')),
              columns(teamDays, { unit: 'n', label: 'Messages sent per day', value: (x) => x.sent, tip: (x) => `${dayName(x.day)}\n${x.sent} messages sent` })) : null)),
        scanner(d));
    }
    root.replaceChildren(head, body);
    if (st.loading) root.classList.add('busy'); else root.classList.remove('busy');
    const nb = root.querySelector('.tm-body');
    if (nb) nb.scrollTop = keepScroll;
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    // the desk's own shortcuts (J, K, V, Tab, arrows...) stay off while this screen is open
    e.stopPropagation();
  }
  function open(helpers) {
    U = helpers;
    if (root) return;
    if (!st.from) setPreset('today');
    root = U.h('div', { class: 'team-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Team activity' });
    document.body.append(root);
    bindTip(root);
    document.addEventListener('keydown', onKey, true);
    draw();
    load();
    timer = setInterval(() => { if (!document.hidden) load(true); }, 60000);
  }
  function close() {
    if (!root) return;
    clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (tip) { tip.remove(); tip = null; }
  }

  window.DeskTeam = { open, close };
})();
