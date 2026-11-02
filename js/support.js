/**
 * Teshrij Follow-up - Support tab: a plain live WhatsApp chat.
 *
 * Chat list: rpc get_support_chats (last message of every chat, 3 days), then a cheap poll of
 * bsb_messages rows newer than the last id seen. Sending goes through the bsb_send edge function
 * (same as the Follow-up tab) and is logged in send_queue. No AI anywhere in this tab.
 *
 * Loaded after js/app.js and built on its window.PanelCore helpers. Exposes nothing itself.
 */

(() => {
  'use strict';

  const core = window.PanelCore;
  if (window.__FRAMED__ || !core) return;
  const { createEl, icon, safeErrorText, normalizePhone, formatPhoneDisplay, formatRelativeTime } = core;

  const LOOKBACK_HOURS = 72;
  const MAX_CHATS = 400;
  const POLL_MS = 3000;            // new messages, while this tab is open
  const POLL_HIDDEN_MS = 15000;    // new messages, while another tab is open (keeps the badge right)
  const FULL_REFRESH_MS = 60000;   // full chat list
  const CHAT_LIMIT = 150;          // messages loaded when a chat opens
  const MAX_MESSAGE_CHARS = 4096;
  const SEND_GAP_MS = 1500;        // anti-ban gap between two sends
  const PLACEHOLDER = '[Outgoing Message]';
  const MATCH_WINDOW_MS = 3 * 60 * 1000; // a BSB placeholder row this close to a known send gets its text
  const WA_WINDOW_MS = 24 * 3600 * 1000;
  const MSG_COLUMNS = 'id,chat_id,contact,profile_name,message,direction,media_type,media_url,timestamp';

  const state = {
    signedIn: false,
    loaded: false,
    chats: new Map(),     // contact -> chat summary
    maxId: 0,             // highest bsb_messages.id seen
    filter: 'waiting',
    search: '',
    active: null,         // { contact, ids:Set, sent:[{text,at,used}], lastTs }
    pollTimer: null,
    pollBusy: false,
    lastFull: 0,
    fullBusy: false,
    renderQueued: false,
    sendChain: Promise.resolve(),
    lastSendAt: 0
  };

  const $ = id => document.getElementById(id);
  const el = {
    view: $('view-support'),
    tabCount: $('tab-count-support'),
    countBadge: $('sup-count-badge'),
    countWaiting: $('sup-count-waiting'),
    countAll: $('sup-count-all'),
    updated: $('sup-updated'),
    search: $('sup-search-input'),
    pills: document.querySelectorAll('#view-support .pill-btn[data-sup-filter]'),
    list: $('sup-list'),
    panel: $('sup-panel'),
    empty: $('sup-empty-state'),
    activeView: $('sup-active-view'),
    back: $('sup-back-btn'),
    name: $('sup-name'),
    phone: $('sup-phone'),
    waLink: $('sup-wa-link'),
    messages: $('sup-messages'),
    windowNote: $('sup-window-note'),
    textarea: $('sup-textarea'),
    sendBtn: $('sup-send-btn'),
    status: $('sup-status')
  };
  if (!el.view || !el.list || !el.messages || !el.textarea) return;

  const chatView = core.createChatRenderer(el.messages);
  const db = () => window.supabaseClient;

  // =========================================================================
  // Helpers
  // =========================================================================
  const ms = iso => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const isIncoming = dir => String(dir || '').toLowerCase() === 'incoming';
  const text = v => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));

  function previewOf(message, mediaType, incoming) {
    const t = text(message).trim();
    const m = text(mediaType).toLowerCase();
    let p = t;
    if (!incoming && t === PLACEHOLDER) p = 'Sent';
    else if (!t || /^\[(image|audio|video|document|media)/i.test(t)) {
      p = m.includes('image') ? 'Photo' : m.includes('audio') ? 'Voice note' : m.includes('video') ? 'Video' : (m && m !== 'text' ? 'File' : '...');
    }
    return (incoming ? '' : 'You: ') + p.replace(/\s+/g, ' ').slice(0, 120);
  }

  function isWaiting(c) {
    return c.lastIncoming && Date.now() - c.lastAt < WA_WINDOW_MS;
  }

  function setUpdated(t, warn) {
    if (!el.updated) return;
    el.updated.textContent = t;
    el.updated.classList.toggle('warn', !!warn);
  }

  function setStatus(t, isError) {
    el.status.textContent = t || '';
    el.status.classList.toggle('error', !!isError);
  }

  // Fold one message row into the chat list
  function absorb(row) {
    const contact = text(row.contact);
    if (!/^[0-9]{6,20}$/.test(contact)) return false; // phone chats only (no ig_ handles)
    const at = ms(row.timestamp);
    const incoming = isIncoming(row.direction);
    let c = state.chats.get(contact);
    if (!c) {
      c = { contact, name: '', lastAt: 0, lastId: 0, preview: '', lastIncoming: false, lastIncomingAt: 0 };
      state.chats.set(contact, c);
    }
    if (incoming && row.profile_name) c.name = text(row.profile_name).slice(0, 80);
    if (incoming && at > c.lastIncomingAt) c.lastIncomingAt = at;
    if (at > c.lastAt || (at === c.lastAt && Number(row.id) > c.lastId)) {
      c.lastAt = at;
      c.lastId = Number(row.id) || c.lastId;
      c.lastIncoming = incoming;
      c.preview = previewOf(row.message, row.media_type, incoming);
    }
    return true;
  }

  // =========================================================================
  // Data
  // =========================================================================
  async function fullRefresh() {
    if (!state.signedIn || state.fullBusy) return;
    state.fullBusy = true;
    const epoch = core.authEpoch();
    try {
      const { data, error } = await db().rpc('get_support_chats', { hours_lookback: LOOKBACK_HOURS, max_rows: MAX_CHATS });
      if (epoch !== core.authEpoch()) return;
      if (error) throw error;
      const next = new Map();
      let top = 0;
      (Array.isArray(data) ? data : []).forEach(r => {
        if (!r || !/^[0-9]{6,20}$/.test(text(r.contact))) return;
        const incoming = isIncoming(r.last_direction);
        next.set(r.contact, {
          contact: r.contact,
          name: text(r.profile_name).slice(0, 80),
          lastAt: ms(r.last_timestamp),
          lastId: Number(r.last_id) || 0,
          preview: previewOf(r.last_message, r.last_media_type, incoming),
          lastIncoming: incoming,
          lastIncomingAt: ms(r.last_incoming_at)
        });
        top = Math.max(top, Number(r.last_id) || 0);
      });
      // Only the first load sets where the poll starts; later it must not skip rows the open chat needs
      if (!state.loaded) state.maxId = top;
      // Keep a chat that is open even if it fell out of the window
      if (state.active && !next.has(state.active.contact) && state.chats.has(state.active.contact)) {
        next.set(state.active.contact, state.chats.get(state.active.contact));
      }
      state.chats = next;
      state.loaded = true;
      state.lastFull = Date.now();
      setUpdated('');
      queueRender();
    } catch (e) {
      if (epoch !== core.authEpoch()) return;
      console.warn('[support chats]', safeErrorText(e));
      setUpdated('Could not load chats, retrying...', true);
      if (!state.loaded) renderList();
    } finally {
      if (epoch === core.authEpoch()) state.fullBusy = false;
    }
  }

  async function poll() {
    if (!state.signedIn || state.pollBusy || document.hidden) return;
    if (!state.loaded || Date.now() - state.lastFull > FULL_REFRESH_MS) {
      await fullRefresh();
      return;
    }
    state.pollBusy = true;
    const epoch = core.authEpoch();
    try {
      const { data, error } = await db().from('bsb_messages')
        .select(MSG_COLUMNS)
        .gt('id', state.maxId)
        .order('id', { ascending: true })
        .limit(300);
      if (epoch !== core.authEpoch()) return;
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return;
      const forActive = [];
      rows.forEach(r => {
        state.maxId = Math.max(state.maxId, Number(r.id) || 0);
        absorb(r);
        if (state.active && r.contact === state.active.contact) forActive.push(r);
      });
      if (forActive.length) appendToActive(forActive);
      queueRender();
      setUpdated('');
    } catch (e) {
      if (epoch === core.authEpoch()) setUpdated('Connection problem, retrying...', true);
    } finally {
      if (epoch === core.authEpoch()) state.pollBusy = false;
    }
  }

  function schedulePoll() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (!state.signedIn) return;
    const visible = core.activeTab() === 'support';
    state.pollTimer = setTimeout(async () => {
      await poll();
      schedulePoll();
    }, visible ? POLL_MS : POLL_HIDDEN_MS);
  }

  // =========================================================================
  // Chat list
  // =========================================================================
  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderList();
    });
  }

  function visibleChats() {
    const q = state.search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return Array.from(state.chats.values())
      .filter(c => state.filter === 'all' || isWaiting(c) || (state.active && state.active.contact === c.contact))
      .filter(c => !q
        || c.name.toLowerCase().includes(q)
        || c.preview.toLowerCase().includes(q)
        || (qDigits.length >= 3 && c.contact.includes(qDigits)))
      .sort((a, b) => (b.lastAt - a.lastAt) || (b.lastId - a.lastId));
  }

  function renderCounts() {
    let waiting = 0;
    state.chats.forEach(c => { if (isWaiting(c)) waiting++; });
    const all = state.chats.size;
    if (el.countWaiting) el.countWaiting.textContent = String(waiting);
    if (el.countAll) el.countAll.textContent = String(all);
    if (el.countBadge) el.countBadge.textContent = String(state.filter === 'all' ? all : waiting);
    if (el.tabCount) el.tabCount.textContent = String(waiting);
  }

  function renderList() {
    renderCounts();
    if (!state.loaded) {
      const note = createEl('div', 'sup-list-notice');
      note.append(icon('fa-solid fa-spinner fa-spin'), ' Loading chats...');
      el.list.replaceChildren(note);
      return;
    }
    const chats = visibleChats();
    const prevScroll = el.list.scrollTop;
    if (!chats.length) {
      el.list.replaceChildren(createEl('div', 'sup-list-notice', state.search ? 'No chat matches your search.' : (state.filter === 'waiting' ? 'Nobody is waiting for a reply.' : 'No chats in the last 3 days.')));
      return;
    }
    const frag = document.createDocumentFragment();
    chats.forEach(c => {
      const item = createEl('div', `conv-item${state.active && state.active.contact === c.contact ? ' active' : ''}`);
      item.dataset.contact = c.contact;
      const label = c.name || formatPhoneDisplay(c.contact);
      const initial = (Array.from(label.replace(/^\+/, '').trim())[0] || '?').toUpperCase();
      const avatar = createEl('div', `conv-avatar${isWaiting(c) ? ' incoming-indicator' : ''}`, initial);
      const info = createEl('div', 'conv-info');
      const head = createEl('div', 'conv-header-line');
      head.append(createEl('span', 'conv-name', label), createEl('span', 'conv-time', formatRelativeTime(new Date(c.lastAt).toISOString())));
      const sub = createEl('div', 'conv-subline');
      sub.append(createEl('span', `conv-preview${isWaiting(c) ? ' sup-unread' : ''}`, c.preview || '...'));
      info.append(head, sub);
      if (c.name) info.appendChild(createEl('div', 'sup-item-phone', formatPhoneDisplay(c.contact)));
      item.append(avatar, info);
      frag.appendChild(item);
    });
    el.list.replaceChildren(frag);
    el.list.scrollTop = prevScroll;
  }

  // =========================================================================
  // Open chat
  // =========================================================================
  // BSB stores most outgoing messages as "[Outgoing Message]" with no text. Fill the text in
  // from sends we know about (send_queue + this browser), nearest in time, each used once.
  function fillPlaceholder(row, sent) {
    if (isIncoming(row.direction) || text(row.message) !== PLACEHOLDER) return row;
    const t = ms(row.timestamp);
    const open = sent.filter(s => !s.used && Math.abs(s.at - t) <= MATCH_WINDOW_MS);
    // Sends from this browser arrive in the order they went out: oldest first.
    // Older sends (send_queue) are matched by the nearest time.
    let best = open.filter(s => s.local).sort((x, y) => x.at - y.at)[0] || null;
    if (!best) {
      open.forEach(s => {
        if (!best || Math.abs(s.at - t) < Math.abs(best.at - t)) best = s;
      });
    }
    if (!best) return row;
    best.used = true;
    return { ...row, message: best.text, __fromLocal: !!best.local };
  }

  async function openChat(contact) {
    const c = state.chats.get(contact);
    if (!c) return;
    const epoch = core.authEpoch();
    const a = { contact, ids: new Set(), sent: [], lastTs: 0 };
    state.active = a;

    el.empty.style.display = 'none';
    el.activeView.style.display = 'flex';
    el.panel.classList.add('active-mobile');
    el.name.textContent = c.name || formatPhoneDisplay(contact);
    el.phone.textContent = c.name ? formatPhoneDisplay(contact) : '';
    el.waLink.href = `https://web.whatsapp.com/send?phone=${encodeURIComponent(normalizePhone(contact))}`;
    setStatus('');
    updateWindowNote();
    queueRender();
    chatView.reset();
    chatView.notice('Loading...', 'fa-solid fa-spinner fa-spin');
    if (window.matchMedia('(min-width: 769px)').matches) el.textarea.focus();

    const local = contact.replace(/^961/, '');
    try {
      const [msgs, sq] = await Promise.all([
        db().from('bsb_messages').select(MSG_COLUMNS).eq('contact', contact)
          .order('timestamp', { ascending: false }).limit(CHAT_LIMIT),
        db().from('send_queue').select('message,sent_at').in('contact', [contact, local])
          .eq('status', 'SENT').order('sent_at', { ascending: false }).limit(CHAT_LIMIT)
      ]);
      if (epoch !== core.authEpoch() || state.active !== a) return;
      if (msgs.error) throw msgs.error;
      (Array.isArray(sq.data) ? sq.data : []).forEach(s => {
        const at = ms(s.sent_at);
        if (at && s.message) a.sent.push({ text: text(s.message), at, used: false });
      });
      const rows = (Array.isArray(msgs.data) ? msgs.data : []).slice().reverse()
        .map(r => {
          a.ids.add(r.id);
          a.lastTs = Math.max(a.lastTs, ms(r.timestamp));
          return fillPlaceholder(r, a.sent);
        });
      if (rows.length) chatView.render(rows);
      else chatView.notice('No messages in this chat yet.');
    } catch (e) {
      if (epoch === core.authEpoch() && state.active === a) chatView.notice('Could not load the messages. Click the chat to retry.');
    }
  }

  function nearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  function appendToActive(rows) {
    const a = state.active;
    if (!a) return;
    if (!a.ids.size) {
      // Chat was empty (or still loading): load it fully, keeping what was sent from here
      const sent = a.sent;
      openChat(a.contact).then(() => {
        if (state.active && state.active.contact === a.contact) state.active.sent.push(...sent.filter(x => x.local && !x.used));
      });
      return;
    }
    const stick = nearBottom();
    const fresh = [];
    rows.slice().sort((x, y) => ms(x.timestamp) - ms(y.timestamp)).forEach(r => {
      if (a.ids.has(r.id)) return;
      a.ids.add(r.id);
      const filled = fillPlaceholder(r, a.sent);
      if (filled.__fromLocal) return; // already on screen: we sent it from here
      if (!isIncoming(r.direction)) {
        // A message we sent from here that BSB stored with its real text
        const mine = a.sent.find(s => s.local && !s.used && s.text === text(r.message) && Math.abs(s.at - ms(r.timestamp)) <= MATCH_WINDOW_MS);
        if (mine) { mine.used = true; return; }
      }
      fresh.push(filled);
    });
    if (!fresh.length) return;
    chatView.append(fresh);
    if (stick || fresh.some(r => !isIncoming(r.direction))) el.messages.scrollTop = el.messages.scrollHeight;
    updateWindowNote();
  }

  function updateWindowNote() {
    const c = state.active && state.chats.get(state.active.contact);
    if (!c || !el.windowNote) return;
    const old = !c.lastIncomingAt || Date.now() - c.lastIncomingAt > WA_WINDOW_MS;
    el.windowNote.style.display = old ? '' : 'none';
    el.windowNote.textContent = old ? 'The customer has not written in the last 24 h, so WhatsApp may not deliver a normal message.' : '';
  }

  function closeChat() {
    state.active = null;
    chatView.reset();
    el.messages.replaceChildren();
    el.activeView.style.display = 'none';
    el.empty.style.display = '';
    el.panel.classList.remove('active-mobile');
    queueRender();
  }

  // =========================================================================
  // Send
  // =========================================================================
  function autoGrow() {
    el.textarea.style.height = 'auto';
    el.textarea.style.height = `${Math.min(el.textarea.scrollHeight, 180)}px`;
  }

  function submit() {
    const a = state.active;
    const msg = el.textarea.value.trim();
    if (!a || !msg) return;
    if (msg.length > MAX_MESSAGE_CHARS) return setStatus(`Too long (max ${MAX_MESSAGE_CHARS} characters).`, true);
    const dest = normalizePhone(a.contact);
    if (!dest) return setStatus('This chat has no valid phone number.', true);

    el.textarea.value = '';
    autoGrow();
    setStatus('');
    const row = chatView.appendOutgoing(msg);
    if (row) row.classList.add('sup-sending');
    const entry = { text: msg, at: Date.now(), used: false, local: true };
    a.sent.push(entry);

    // One send at a time, in order, at least SEND_GAP_MS apart
    state.sendChain = state.sendChain.then(() => sendOne(a, dest, msg, row, entry)).catch(() => {});
  }

  async function sendOne(a, dest, msg, row, entry) {
    const wait = state.lastSendAt + SEND_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const epoch = core.authEpoch();
    let ok = false;
    let reason = '';
    let resJson = {};
    try {
      const { data: { session } } = await db().auth.getSession();
      if (!session || !session.access_token) throw new Error('You are signed out. Please sign in again.');
      const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/bsb_send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: window.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ destination: dest, message: msg })
      });
      const data = (await resp.json().catch(() => null)) || {};
      const edgeOk = resp.status === 200 && typeof data.upstream_status === 'number';
      resJson = edgeOk
        ? ((data.result && typeof data.result === 'object') ? data.result : { raw: 'Non-JSON' })
        : { status: 'error', message: data.error || data.message || `HTTP ${resp.status}` };
      ok = edgeOk && data.upstream_status === 200 && resJson.status !== 'error' && resJson.success !== false;
      if (!ok) reason = safeErrorText(resJson.message || resJson.error, 'not sent');
    } catch (e) {
      reason = safeErrorText(e, 'network error');
    }
    state.lastSendAt = Date.now();
    entry.at = Date.now();

    // Log every send (keeps the follow-up filters right and gives this tab the text back)
    db().from('send_queue').insert({
      contact: dest,
      message: msg,
      status: ok ? 'SENT' : 'FAILED',
      sent_at: ok ? new Date().toISOString() : null,
      api_response: JSON.stringify(resJson),
      error_message: ok ? null : JSON.stringify(resJson)
    }).then(({ error }) => { if (error) console.warn('[send_queue]', safeErrorText(error)); });

    if (epoch !== core.authEpoch()) return;
    if (row) {
      row.classList.remove('sup-sending');
      if (!ok) row.classList.add('sup-failed');
      const statusIcon = row.querySelector('.msg-status-icon');
      if (statusIcon) statusIcon.className = ok ? 'fa-solid fa-check msg-status-icon' : 'fa-solid fa-circle-exclamation msg-status-icon';
    }
    if (!ok) {
      entry.used = true; // never match a failed send to a BSB row
      if (state.active === a) {
        setStatus(`Not sent: ${reason}`, true);
        if (!el.textarea.value.trim()) {
          el.textarea.value = msg;
          autoGrow();
        }
      }
      return;
    }
    // Move the chat up right away; the poll brings the stored row
    const c = state.chats.get(a.contact);
    if (c) {
      c.lastAt = Date.now();
      c.lastIncoming = false;
      c.preview = previewOf(msg, 'text', false);
      queueRender();
    }
  }

  // =========================================================================
  // Events
  // =========================================================================
  el.list.addEventListener('click', e => {
    const item = e.target.closest('.conv-item');
    if (item && item.dataset.contact) openChat(item.dataset.contact);
  });
  el.pills.forEach(p => p.addEventListener('click', () => {
    el.pills.forEach(x => x.classList.toggle('active', x === p));
    state.filter = p.getAttribute('data-sup-filter') === 'all' ? 'all' : 'waiting';
    el.list.scrollTop = 0;
    renderList();
  }));
  el.search.addEventListener('input', () => {
    state.search = el.search.value;
    el.list.scrollTop = 0;
    renderList();
  });
  el.textarea.addEventListener('input', autoGrow);
  el.textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  el.sendBtn.addEventListener('click', submit);
  if (el.back) el.back.addEventListener('click', closeChat);

  document.addEventListener('keydown', e => {
    if (core.activeTab() !== 'support') return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && t === el.search) {
      el.search.blur();
      if (state.active) el.textarea.focus();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.signedIn) poll();
  });

  // =========================================================================
  // Lifecycle hooks called by js/app.js
  // =========================================================================
  function onSignIn() {
    state.signedIn = true;
    renderList();
    fullRefresh();
    schedulePoll();
  }

  function onSignOut() {
    state.signedIn = false;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.loaded = false;
    state.chats = new Map();
    state.maxId = 0;
    state.search = '';
    state.pollBusy = false;
    state.fullBusy = false;
    el.search.value = '';
    el.textarea.value = '';
    setStatus('');
    setUpdated('');
    closeChat();
    el.list.replaceChildren();
    renderCounts();
  }

  function onShow() {
    poll();
    schedulePoll();
    if (state.active && window.matchMedia('(min-width: 769px)').matches) el.textarea.focus();
  }

  core.registerView('support', { onSignIn, onSignOut, onShow, onHide: schedulePoll, refresh: fullRefresh });

})();
