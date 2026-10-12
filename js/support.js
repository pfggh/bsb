/**
 * Teshrij Follow-up - Support tab (assisted replies)
 *
 * Lists the open records of the support copilot: replies the AI drafted for a live customer
 * chat, chats it escalated to a human (with the reason) and messages it thinks need no answer.
 * Nothing is ever sent from here without an employee pressing Send. The tab talks only to the
 * `support_act` edge function (and nudges `support_draft`); it reads no table directly.
 *
 * Loaded after js/app.js and built on its window.PanelCore helpers. Exposes nothing itself.
 */

(() => {
  'use strict';

  const core = window.PanelCore;
  if (window.__FRAMED__ || !core) return;
  const { createEl, icon, safeErrorText, normalizePhone, formatPhoneDisplay, formatRelativeTime } = core;

  const REFRESH_MS = 15 * 1000;               // inbox poll
  const NOT_DEPLOYED_REFRESH_MS = 60 * 1000;  // slower poll while the functions are missing or failing
  const KICK_MIN_MS = 30 * 1000;              // at most one support_draft nudge per browser in this time
  const KICK_STORAGE_KEY = 'support_draft_kick_at';
  const SEND_GUARD_MS = 400;                  // buttons stay locked this long after a chat opens
  const FLASH_MS = 8000;
  const MAX_MESSAGE_CHARS = 4096;
  const MAX_ITEMS = 500;
  const TEXTAREA_MAX_PX = 200;
  const LINK_PLACEHOLDER = '{{link}}';

  const DECISIONS = ['draft', 'escalate', 'no_reply'];
  const DECISION_LABELS = { draft: 'Draft', escalate: 'Needs human', no_reply: 'No reply needed' };
  const DECISION_PILLS = { draft: 'pill-draft', escalate: 'pill-unanswered', no_reply: 'pill-checking' };
  const SERVICE_LABELS = {
    chatgpt: 'ChatGPT', netflix: 'Netflix', anghami: 'Anghami', spotify: 'Spotify', canva: 'Canva',
    adobe: 'Adobe', gemini: 'Gemini', capcut: 'CapCut', shahid: 'Shahid', other: 'Other'
  };
  const EMPTY_LIST_TEXT = {
    draft: 'No drafts waiting for review.',
    escalate: 'No chat needs a human right now.',
    no_reply: 'Nothing here.'
  };
  // Plain wording for the fixes the AI may attach (see support/DESIGN.md)
  const ACTION_LABELS = {
    reactivate_link: "Reactivate the customer's ChatGPT link before sending",
    fix_profiles: "Fix the customer's Netflix profiles before sending"
  };
  // Suggested fixes an employee can run from an escalated chat: action name -> support_act op
  const ACTION_BUTTONS = {
    fix_profiles: { op: 'fix_profiles', label: 'Fix Netflix profiles', done: 'Netflix profiles fixed.' }
  };

  const state = {
    signedIn: false,
    phase: 'idle',        // idle | loading | ready | error | not_deployed
    errorText: '',
    items: [],
    counts: { draft: 0, escalate: 0, no_reply: 0 },
    filter: 'draft',
    search: '',
    active: null,         // the open review (see openItem)
    edits: new Map(),     // draft id -> unsent edits, so switching chats never loses typed text
    closedIds: new Set(), // drafts settled from this browser; a late inbox answer must not bring them back
    inboxBusy: false,
    lastAttemptAt: 0,
    refreshTimer: null,
    flashTimer: null,
    kickBusy: false,
    lastKickAt: 0
  };

  const el = {
    view: document.getElementById('view-support'),
    tabCount: document.getElementById('tab-count-support'),
    countBadge: document.getElementById('sup-count-badge'),
    updated: document.getElementById('sup-updated'),
    searchInput: document.getElementById('sup-search-input'),
    filterPills: document.querySelectorAll('#view-support .pill-btn[data-sup-filter]'),
    flash: document.getElementById('sup-flash'),
    list: document.getElementById('sup-list'),
    panel: document.getElementById('sup-panel'),
    emptyState: document.getElementById('sup-empty-state'),
    emptyIcon: document.getElementById('sup-empty-icon'),
    emptyTitle: document.getElementById('sup-empty-title'),
    emptyText: document.getElementById('sup-empty-text'),
    activeView: document.getElementById('sup-active-view'),
    backBtn: document.getElementById('sup-back-btn'),
    phone: document.getElementById('sup-phone'),
    profileName: document.getElementById('sup-profile-name'),
    headerPills: document.getElementById('sup-header-pills'),
    waLink: document.getElementById('sup-wa-link'),
    banner: document.getElementById('sup-banner'),
    messages: document.getElementById('sup-messages'),
    review: document.getElementById('sup-review')
  };
  if (!el.view || !el.list || !el.messages || !el.review) return;

  const chatView = core.createChatRenderer(el.messages);

  // =========================================================================
  // Server answers are untrusted: keep only the fields and types this tab uses
  // =========================================================================
  function str(value, max) {
    if (typeof value === 'string') return value.slice(0, max);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  function strList(value, maxItems, maxChars) {
    if (!Array.isArray(value)) return [];
    return value.map(v => str(v, maxChars)).filter(v => v.trim()).slice(0, maxItems);
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = (typeof raw.id === 'number' || typeof raw.id === 'string') ? String(raw.id).slice(0, 80) : '';
    const contact = str(raw.contact, 40).trim();
    if (!id || !contact) return null;
    const decision = DECISIONS.includes(raw.decision) ? raw.decision : 'escalate'; // unknown => a person looks at it
    let action = null;
    if (raw.action && typeof raw.action === 'object' && typeof raw.action.name === 'string' && raw.action.name) {
      action = { name: raw.action.name.slice(0, 40) };
    }
    const examples = (Array.isArray(raw.examples) ? raw.examples : [])
      .filter(x => x && typeof x === 'object')
      .map(x => ({ turn: str(x.turn, 1500), reply: str(x.reply, 1500), sim: Number(x.sim) }))
      .filter(x => x.turn || x.reply)
      .slice(0, 5);
    const confidence = Number(raw.confidence);
    return {
      id,
      rawId: raw.id, // sent back unchanged (bigint or uuid)
      contact,
      profile_name: str(raw.profile_name, 120),
      decision,
      stage: str(raw.stage, 40),
      reason: str(raw.reason, 80),
      reason_text: str(raw.reason_text, 600),
      service: str(raw.service, 30),
      messages: decision === 'draft' ? strList(raw.messages, 5, MAX_MESSAGE_CHARS) : [],
      canned_keys: strList(raw.canned_keys, 6, 60),
      action,
      confidence: raw.confidence !== null && raw.confidence !== undefined && Number.isFinite(confidence) ? confidence : null,
      facts: strList(raw.facts, 20, 400),
      examples,
      last_incoming_at: str(raw.last_incoming_at, 40),
      last_message: str(raw.last_message, 600),
      created_at: str(raw.created_at, 40)
    };
  }

  function timeValue(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  // When the customer started waiting (their last message), falling back to the draft's creation
  function waitingSince(item) {
    return timeValue(item.last_incoming_at) || timeValue(item.created_at);
  }

  // True unless `a` is provably older than `b` (a late answer must not put an old draft back)
  function isNewerDraft(a, b) {
    const ta = waitingSince(a);
    const tb = waitingSince(b);
    if (ta && tb && ta !== tb) return ta > tb;
    const ca = timeValue(a.created_at);
    const cb = timeValue(b.created_at);
    if (ca && cb && ca !== cb) return ca > cb;
    return true;
  }

  // Same call shape as the triage / bsb_send calls in js/app.js
  async function callFunction(name, body) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session || !session.access_token) throw new Error('You are signed out. Please sign in again.');
    const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: window.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, data: (data && typeof data === 'object' && !Array.isArray(data)) ? data : {} };
  }

  function failureText(res, fallback) {
    if (res.status === 404) return 'Support assistant is not deployed yet';
    if (res.status === 401) return 'Your session expired. Please sign in again.';
    return safeErrorText(res.data.error || res.data.message, res.ok ? fallback : `${fallback} (HTTP ${res.status})`);
  }

  // =========================================================================
  // Inbox: load, count, list
  // =========================================================================
  async function refreshInbox() {
    if (!state.signedIn || state.inboxBusy) return;
    state.inboxBusy = true;
    state.lastAttemptAt = Date.now();
    const epoch = core.authEpoch();
    if (state.phase === 'idle') {
      state.phase = 'loading';
      renderList();
    }

    let res = null;
    let networkError = null;
    try {
      res = await callFunction('support_act', { op: 'inbox' });
    } catch (e) {
      networkError = e;
    }
    if (epoch !== core.authEpoch()) return; // logged out meanwhile (its reset already cleared inboxBusy)
    state.inboxBusy = false;

    if (res && res.ok && Array.isArray(res.data.drafts)) {
      const seen = new Set();
      state.items = res.data.drafts.map(normalizeItem).filter(item => {
        if (!item || state.closedIds.has(item.id) || seen.has(item.contact)) return false;
        seen.add(item.contact); // one open record per chat
        return true;
      }).slice(0, MAX_ITEMS);
      const serverCounts = (res.data.counts && typeof res.data.counts === 'object') ? res.data.counts : {};
      DECISIONS.forEach(d => {
        const listed = state.items.filter(i => i.decision === d).length;
        const n = Number(serverCounts[d]);
        // The server count wins only when it knows about more rows than it returned
        state.counts[d] = Number.isFinite(n) && n > listed && !state.closedIds.size ? Math.floor(n) : listed;
      });
      state.phase = 'ready';
      state.errorText = '';
      setUpdatedLabel(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      // Unsent edits of drafts that are no longer open are of no use any more
      const openIds = new Set(state.items.map(i => i.id));
      Array.from(state.edits.keys()).forEach(id => {
        if (!openIds.has(id) && !(state.active && state.active.item.id === id)) state.edits.delete(id);
      });
      renderCounts();
      renderList();
      syncEmptyState();
      reconcileActive();
      kickDrafting();
      return;
    }

    if (res && res.status === 404) {
      state.phase = 'not_deployed';
      state.errorText = '';
      state.items = [];
      DECISIONS.forEach(d => { state.counts[d] = 0; });
      setUpdatedLabel('');
    } else {
      const text = networkError
        ? 'Could not reach the support assistant. It may not be deployed yet, or you are offline.'
        : failureText(res, 'The support inbox could not be loaded');
      console.warn('[support inbox]', networkError ? safeErrorText(networkError) : `HTTP ${res.status}`);
      if (state.phase === 'ready') {
        // Keep showing what we have; the next poll retries
        setUpdatedLabel('Refresh failed, retrying', true);
        return;
      }
      state.phase = 'error';
      state.errorText = text;
    }
    renderCounts();
    renderList();
    syncEmptyState();
  }

  // Drafts are normally produced by a server-side cron. Until it is enabled, nudge the drafting
  // function after an inbox refresh: fire and forget, throttled per browser (all tabs).
  function kickDrafting() {
    if (state.kickBusy) return;
    const now = Date.now();
    let last = state.lastKickAt;
    try {
      last = Math.max(last, Number(localStorage.getItem(KICK_STORAGE_KEY)) || 0);
    } catch (e) {}
    if (last > now) last = 0; // clock moved back
    if (now - last < KICK_MIN_MS) return;
    state.lastKickAt = now;
    try { localStorage.setItem(KICK_STORAGE_KEY, String(now)); } catch (e) {}
    state.kickBusy = true;
    callFunction('support_draft', {}).catch(() => null).then(() => { state.kickBusy = false; });
  }

  function setUpdatedLabel(text, isWarning) {
    if (!el.updated) return;
    el.updated.textContent = text;
    el.updated.classList.toggle('warn', !!isWarning);
  }

  function renderCounts() {
    DECISIONS.forEach(d => {
      const node = document.getElementById(`sup-count-${d}`);
      if (node) node.textContent = state.counts[d];
    });
    // "Open" = what an employee still has to act on
    const open = state.counts.draft + state.counts.escalate;
    if (el.countBadge) el.countBadge.textContent = open;
    if (el.tabCount) {
      el.tabCount.textContent = open;
      el.tabCount.classList.toggle('pill-warning', open > 0);
    }
  }

  function visibleItems() {
    let list = state.items.filter(i => i.decision === state.filter);
    if (state.search) {
      const q = String(state.search).slice(0, 200).toLowerCase().trim();
      const qDigits = /^[\d\s+()-]+$/.test(q) ? q.replace(/\D/g, '') : '';
      list = list.filter(i => (qDigits && i.contact.includes(qDigits))
        || i.contact.toLowerCase().includes(q)
        || i.profile_name.toLowerCase().includes(q)
        || i.last_message.toLowerCase().includes(q)
        || i.reason_text.toLowerCase().includes(q)
        || i.service.toLowerCase().includes(q));
    }
    // Longest-waiting customer first where an employee has to act; newest first for the rest
    const dir = state.filter === 'no_reply' ? -1 : 1;
    return list.slice().sort((a, b) => dir * (waitingSince(a) - waitingSince(b)));
  }

  function decisionPill(decision) {
    return createEl('span', `triage-pill ${DECISION_PILLS[decision] || 'pill-checking'}`, DECISION_LABELS[decision] || decision);
  }

  function serviceTag(service) {
    if (!service) return null;
    const known = Object.prototype.hasOwnProperty.call(SERVICE_LABELS, service);
    return createEl('span', 'sup-service-tag', known ? SERVICE_LABELS[service] : service);
  }

  function listNotice(text, iconClasses, withRetry) {
    const box = createEl('div', 'sup-list-notice');
    const line = createEl('div');
    if (iconClasses) line.append(icon(iconClasses), ' ');
    line.append(text);
    box.appendChild(line);
    if (withRetry) {
      const retry = createEl('button', 'btn-nav', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => refreshInbox());
      box.appendChild(retry);
    }
    el.list.replaceChildren(box);
  }

  // Built with DOM nodes + textContent only: nothing from the server is ever parsed as HTML
  function renderList() {
    const prevScroll = el.list.scrollTop;
    if (state.phase === 'idle' || state.phase === 'loading') {
      listNotice('Loading support inbox...', 'fa-solid fa-spinner fa-spin');
      return;
    }
    if (state.phase === 'not_deployed') {
      listNotice('Support assistant is not deployed yet', 'fa-solid fa-plug-circle-xmark');
      return;
    }
    if (state.phase === 'error') {
      listNotice(state.errorText, 'fa-solid fa-triangle-exclamation', true);
      return;
    }

    const list = visibleItems();
    if (list.length === 0) {
      listNotice(state.search ? 'No chat matches this search.' : EMPTY_LIST_TEXT[state.filter]);
      return;
    }

    const activeContact = state.active ? state.active.contact : null;
    const frag = document.createDocumentFragment();
    list.forEach(item => {
      const row = createEl('div', `conv-item sup-item${activeContact === item.contact ? ' active' : ''}`);
      row.dataset.contact = item.contact;
      row.addEventListener('click', () => openItem(item));

      const initialSource = String(item.profile_name || item.contact || '?').trim() || '?';
      const avatar = createEl('div', 'conv-avatar', (Array.from(initialSource)[0] || '?').toUpperCase());

      const info = createEl('div', 'conv-info');
      const headerLine = createEl('div', 'conv-header-line');
      const waited = formatRelativeTime(item.last_incoming_at || item.created_at);
      const timeEl = createEl('span', 'conv-time', waited);
      timeEl.title = 'Since the customer\'s last message';
      headerLine.append(createEl('span', 'conv-name', formatPhoneDisplay(item.contact)), timeEl);

      const previewEl = createEl('div', 'conv-preview sup-preview');
      const previewText = createEl('span', 'sup-preview-text', item.last_message || '[Media]');
      previewText.dir = 'auto';
      previewEl.append(icon('fa-solid fa-arrow-down-left dir-icon dir-incoming'), previewText);

      const reasonLine = createEl('div', 'sup-item-meta');
      const tag = serviceTag(item.service);
      if (tag) reasonLine.appendChild(tag);
      reasonLine.appendChild(decisionPill(item.decision));
      if (item.reason_text || item.reason) {
        const reason = createEl('span', 'sup-item-reason', item.reason_text || item.reason);
        reason.title = item.reason_text || item.reason;
        reasonLine.appendChild(reason);
      }

      info.append(headerLine, previewEl, reasonLine);
      row.append(avatar, info);
      frag.appendChild(row);
    });
    el.list.replaceChildren(frag);
    if (prevScroll > 0) el.list.scrollTop = prevScroll;
  }

  function highlightActive() {
    const contact = state.active ? state.active.contact : null;
    el.list.querySelectorAll('.conv-item').forEach(row => {
      row.classList.toggle('active', contact !== null && row.dataset.contact === contact);
    });
  }

  function flash(text, isError) {
    if (!el.flash) return;
    if (state.flashTimer) clearTimeout(state.flashTimer);
    el.flash.textContent = text;
    el.flash.classList.toggle('error', !!isError);
    el.flash.style.display = text ? 'block' : 'none';
    state.flashTimer = text ? setTimeout(() => {
      state.flashTimer = null;
      el.flash.textContent = '';
      el.flash.style.display = 'none';
    }, FLASH_MS) : null;
  }

  // =========================================================================
  // Right panel: empty / error states, header, banner
  // =========================================================================
  function syncEmptyState() {
    if (!el.emptyState) return;
    let iconClass = 'fa-solid fa-headset';
    let title = 'Select a chat';
    let text = 'Drafts are replies the AI wrote for a live customer chat: check them, edit if needed and send. "Needs human" lists the chats the AI will not answer, with the reason.';
    if (state.phase === 'idle' || state.phase === 'loading') {
      iconClass = 'fa-solid fa-spinner fa-spin';
      title = 'Loading support inbox...';
      text = '';
    } else if (state.phase === 'not_deployed') {
      iconClass = 'fa-solid fa-plug-circle-xmark';
      title = 'Support assistant is not deployed yet';
      text = 'The server side of this tab is not live yet. Nothing is wrong with your account: the inbox appears here by itself once it is deployed.';
    } else if (state.phase === 'error') {
      iconClass = 'fa-solid fa-triangle-exclamation';
      title = 'The support inbox could not be loaded';
      text = state.errorText;
    } else if (state.items.length === 0) {
      iconClass = 'fa-solid fa-circle-check';
      title = 'All caught up';
      text = 'No open drafts and no chat waiting for a human. New customer messages show up here within a minute.';
    }
    if (el.emptyIcon) el.emptyIcon.className = iconClass;
    if (el.emptyTitle) el.emptyTitle.textContent = title;
    if (el.emptyText) el.emptyText.textContent = text;
  }

  function showBanner(text, buttonLabel, onClick) {
    if (!el.banner) return;
    el.banner.replaceChildren();
    if (!text) {
      el.banner.style.display = 'none';
      return;
    }
    el.banner.append(icon('fa-solid fa-bolt'), createEl('span', 'sup-banner-text', text));
    if (buttonLabel) {
      const btn = createEl('button', 'btn-nav', buttonLabel);
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      el.banner.appendChild(btn);
    }
    el.banner.style.display = 'flex';
  }

  function closePanel() {
    const r = state.active;
    if (r) {
      stashEdits(r);
      if (r.guardTimer) clearTimeout(r.guardTimer);
    }
    state.active = null;
    chatView.reset();
    el.messages.replaceChildren();
    el.review.replaceChildren();
    showBanner('');
    el.activeView.style.display = 'none';
    el.emptyState.style.display = '';
    el.panel.classList.remove('active-mobile');
    syncEmptyState();
    highlightActive();
  }

  // =========================================================================
  // Review desk
  // =========================================================================
  function reviewMode(item) {
    if (item.decision === 'draft' && item.messages.length > 0) return 'draft';
    return item.decision === 'no_reply' ? 'no_reply' : 'human';
  }

  function openItem(item, opts) {
    const options = opts || {};
    const prev = state.active;
    if (prev && prev.busy) return; // a request for the open chat is in flight
    if (prev && prev.item.id === item.id && !options.reload) {
      el.panel.classList.add('active-mobile'); // narrow screens: back from the list to the open chat
      return;
    }
    if (prev) {
      if (options.discardEdits) state.edits.delete(prev.item.id);
      else stashEdits(prev);
      if (prev.guardTimer) clearTimeout(prev.guardTimer);
    }

    const r = {
      item,
      contact: item.contact,
      mode: reviewMode(item),
      openedAt: Date.now(),
      busy: false,
      fields: [],          // draft mode: { textarea, original, sent, chip }
      actionBox: null,
      actionRow: null,
      actionDone: false,   // the attached action already ran in a failed attempt: never run it twice
      replyBox: null,
      replyWrap: null,
      sendBtn: null,
      buttons: [],
      editedTag: null,
      status: null,
      factsHost: null,
      contextFacts: [],
      newer: null,
      gone: false,
      guardTimer: null
    };
    state.active = r;

    el.emptyState.style.display = 'none';
    el.activeView.style.display = 'flex';
    el.panel.classList.add('active-mobile');
    el.phone.textContent = formatPhoneDisplay(item.contact);
    el.profileName.textContent = item.profile_name || 'BSB Contact';
    const tag = serviceTag(item.service);
    el.headerPills.replaceChildren(decisionPill(item.decision));
    if (tag) el.headerPills.prepend(tag);
    // normalizePhone() returns digits only, so nothing else can end up in the link
    el.waLink.href = `https://web.whatsapp.com/send?phone=${encodeURIComponent(normalizePhone(item.contact))}`;
    showBanner(options.banner || '');
    highlightActive();

    renderReview(r);
    // Misclick guard: a click or key press that was meant for the previous chat must not act on this one
    r.guardTimer = setTimeout(() => {
      r.guardTimer = null;
      if (state.active === r) updateControls(r);
    }, SEND_GUARD_MS + 20);
    if (options.focusField !== undefined && r.fields[options.focusField]) r.fields[options.focusField].textarea.focus();
    loadChat(r);
  }

  async function loadChat(r) {
    const epoch = core.authEpoch();
    stickToBottom = true;
    chatView.reset();
    chatView.notice('Loading conversation...', 'fa-solid fa-spinner fa-spin');
    let res;
    try {
      res = await callFunction('support_act', { op: 'chat', contact: r.contact });
    } catch (e) {
      if (epoch === core.authEpoch() && state.active === r) chatView.notice('Failed to load messages.');
      return;
    }
    if (epoch !== core.authEpoch() || state.active !== r) return; // logged out or another chat opened meanwhile
    if (!res.ok || !Array.isArray(res.data.messages)) {
      chatView.notice(res.status === 404 ? 'Support assistant is not deployed yet.' : 'Failed to load messages.');
      return;
    }

    // Oldest first, whatever order the server used
    const messages = res.data.messages.filter(m => m && typeof m === 'object')
      .map((m, i) => ({ m, i, t: timeValue(m.timestamp) }))
      .sort((a, b) => (a.t - b.t) || (a.i - b.i))
      .map(x => x.m);
    // Facts first: they change the height of the review desk, and the chat must end up at its last message
    r.contextFacts = strList(res.data.context_facts, 20, 400);
    renderFacts(r);
    if (messages.length) chatView.render(messages);
    else chatView.notice('No stored messages for this chat yet.');

    // The chat answer carries the current draft: it may be newer than the inbox row that was clicked
    const fresh = normalizeItem(res.data.draft);
    if (fresh && fresh.contact === r.contact && fresh.id !== r.item.id && !state.closedIds.has(fresh.id) && isNewerDraft(fresh, r.item)) {
      handleSuperseded(r, fresh, false);
    }
  }

  function isEdited(r) {
    return r.fields.some(f => !f.sent && f.textarea.value !== f.original);
  }

  // Anything the employee would lose if the review desk were rebuilt
  function isTouched(r) {
    return isEdited(r)
      || r.fields.some(f => f.sent)
      || !!(r.actionBox && !r.actionBox.checked && !r.actionDone)
      || !!(r.replyBox && r.replyBox.value.trim());
  }

  function stashEdits(r) {
    if (!isTouched(r) || r.fields.some(f => f.sent)) {
      state.edits.delete(r.item.id);
      return;
    }
    state.edits.set(r.item.id, {
      texts: r.fields.map(f => f.textarea.value),
      runAction: r.actionBox ? r.actionBox.checked : true,
      reply: r.replyBox ? r.replyBox.value : ''
    });
  }

  function canAct(r) {
    return !r.busy && Date.now() - r.openedAt >= SEND_GUARD_MS;
  }

  function autoGrow(textarea) {
    if (!textarea.isConnected) return;
    textarea.style.height = 'auto';
    const wanted = textarea.scrollHeight;
    if (wanted > 0) textarea.style.height = `${Math.min(wanted + 2, TEXTAREA_MAX_PX)}px`; // 0 = tab not visible
    else textarea.style.height = '';
  }

  function setStatus(r, text, kind, iconClasses) {
    if (!r.status) return;
    r.status.className = `send-status-line sup-status${kind ? ` ${kind}` : ''}`;
    r.status.replaceChildren();
    if (iconClasses) r.status.append(icon(iconClasses));
    if (text) r.status.append(text);
  }

  function setChip(field, text, kind) {
    field.chip.textContent = text;
    field.chip.className = `sup-chip${kind ? ` ${kind}` : ''}`;
  }

  function updateControls(r) {
    const ready = canAct(r);
    r.buttons.forEach(btn => { btn.disabled = !ready; });
    if (r.sendBtn) {
      const hasText = r.mode === 'draft'
        ? r.fields.some(f => !f.sent && f.textarea.value.trim())
        : !!(r.replyBox && r.replyBox.value.trim());
      r.sendBtn.disabled = !ready || !hasText;
    }
    if (r.editedTag) r.editedTag.style.display = isEdited(r) ? '' : 'none';
    r.fields.forEach(f => { f.textarea.readOnly = r.busy || f.sent; });
    if (r.replyBox) r.replyBox.readOnly = r.busy;
    if (r.actionBox) r.actionBox.disabled = r.busy || r.actionDone;
  }

  function setBusy(r, busy) {
    r.busy = busy;
    updateControls(r);
  }

  function actionButton(r, label, iconClasses, className, onClick) {
    const btn = createEl('button', className);
    btn.type = 'button';
    btn.append(icon(iconClasses), ' ' + label);
    btn.addEventListener('click', onClick);
    r.buttons.push(btn);
    return btn;
  }

  function sendButton(r, label) {
    const btn = createEl('button', 'sup-btn-send');
    btn.type = 'button';
    btn.title = 'Ctrl+Enter';
    btn.append(icon('fa-solid fa-paper-plane'), ' ' + label);
    btn.addEventListener('click', () => sendActive());
    r.sendBtn = btn;
    return btn;
  }

  function onReviewTextareaKey(e) {
    // Enter always inserts a newline here: sending is Ctrl+Enter / Cmd+Enter (handled on the document)
    if (e.key === 'Escape') e.target.blur();
  }

  function buildTextarea(r, value, placeholder) {
    const textarea = createEl('textarea', 'chat-textarea sup-textarea');
    textarea.rows = 1;
    textarea.dir = 'auto';
    textarea.maxLength = MAX_MESSAGE_CHARS;
    textarea.spellcheck = false;
    textarea.value = value;
    if (placeholder) textarea.placeholder = placeholder;
    textarea.addEventListener('input', () => {
      autoGrow(textarea);
      updateControls(r);
    });
    textarea.addEventListener('keydown', onReviewTextareaKey);
    return textarea;
  }

  function renderFacts(r) {
    if (!r.factsHost) return;
    r.factsHost.replaceChildren();
    const facts = r.item.facts.slice();
    r.contextFacts.forEach(f => { if (!facts.includes(f)) facts.push(f); });
    if (!facts.length) return;
    r.factsHost.appendChild(createEl('div', 'sup-section-label', 'Facts from the database'));
    const ul = createEl('ul', 'sup-facts');
    facts.forEach(f => {
      const li = createEl('li', '', f);
      li.dir = 'auto';
      ul.appendChild(li);
    });
    r.factsHost.appendChild(ul);
  }

  function buildExamples(item) {
    if (!item.examples.length) return null;
    const details = createEl('details', 'sup-examples');
    details.appendChild(createEl('summary', '', `Similar past replies (${item.examples.length})`));
    item.examples.forEach(x => {
      const box = createEl('div', 'sup-example');
      const turn = createEl('div', 'sup-example-turn');
      turn.append(createEl('span', 'sup-example-who', 'Customer'), createEl('span', 'sup-example-text', x.turn || '[no text]'));
      const reply = createEl('div', 'sup-example-reply');
      reply.append(createEl('span', 'sup-example-who', 'Employee'), createEl('span', 'sup-example-text', x.reply || '[no text]'));
      turn.lastChild.dir = 'auto';
      reply.lastChild.dir = 'auto';
      box.append(turn, reply);
      if (Number.isFinite(x.sim) && x.sim > 0 && x.sim <= 1) {
        box.appendChild(createEl('div', 'sup-example-sim', `${Math.round(x.sim * 100)}% similar`));
      }
      details.appendChild(box);
    });
    return details;
  }

  function reasonBox(item, kind, iconClasses, title) {
    const box = createEl('div', `sup-reason-box ${kind}`);
    const text = createEl('div', 'sup-reason-text', item.reason_text || item.reason || 'No reason given.');
    text.dir = 'auto';
    const body = createEl('div', 'sup-reason-body');
    body.append(createEl('div', 'sup-reason-title', title), text);
    box.append(icon(iconClasses), body);
    return box;
  }

  function buildReplyBox(r, visible) {
    const wrap = createEl('div', 'sup-reply-wrap');
    wrap.appendChild(createEl('div', 'sup-section-label', 'Your reply'));
    r.replyBox = buildTextarea(r, '', 'Write the reply yourself... (Ctrl+Enter sends, Enter adds a line)');
    wrap.appendChild(r.replyBox);
    wrap.style.display = visible ? '' : 'none';
    r.replyWrap = wrap;
    return wrap;
  }

  function buildDraftReview(r, frag) {
    const item = r.item;
    const why = createEl('div', 'sup-why');
    const whyText = createEl('span', '', item.reason_text || item.reason || 'no reason given');
    whyText.dir = 'auto';
    why.append(createEl('strong', '', 'Why: '), whyText);
    if (item.confidence !== null && item.confidence >= 0 && item.confidence <= 1) {
      why.appendChild(createEl('span', 'sup-dim', ` · confidence ${Math.round(item.confidence * 100)}%`));
    }
    frag.appendChild(why);

    const total = item.messages.length;
    item.messages.forEach((text, i) => {
      const wrap = createEl('div', 'sup-field');
      const head = createEl('div', 'sup-field-head');
      const chip = createEl('span', 'sup-chip');
      head.append(createEl('span', 'sup-section-label', total > 1 ? `Message ${i + 1} of ${total}` : 'Reply'), chip);
      const textarea = buildTextarea(r, text);
      wrap.append(head, textarea);
      frag.appendChild(wrap);
      r.fields.push({ textarea, original: text, sent: false, chip });
    });
    if (item.messages.some(t => t.includes(LINK_PLACEHOLDER))) {
      frag.appendChild(createEl('div', 'sup-dim sup-note', `${LINK_PLACEHOLDER} is replaced by the customer's own portal link when the message is sent. Leave it as it is.`));
    }

    r.factsHost = createEl('div', 'sup-facts-host');
    frag.appendChild(r.factsHost);
    const examples = buildExamples(item);
    if (examples) frag.appendChild(examples);

    if (item.action) {
      const label = createEl('label', 'sup-action');
      r.actionBox = document.createElement('input');
      r.actionBox.type = 'checkbox';
      r.actionBox.checked = true;
      r.actionBox.addEventListener('change', () => updateControls(r));
      const known = Object.prototype.hasOwnProperty.call(ACTION_LABELS, item.action.name);
      label.append(r.actionBox, createEl('span', '', known ? ACTION_LABELS[item.action.name] : `Run the attached action (${item.action.name}) before sending`));
      r.actionRow = label; // placed right above Send (see renderReview) so it is never scrolled out of sight
    }

    const row = createEl('div', 'sup-buttons');
    r.editedTag = createEl('span', 'sup-edited', 'edited');
    row.append(
      sendButton(r, total > 1 ? `Send ${total} messages` : 'Send'),
      r.editedTag,
      actionButton(r, 'Reject', 'fa-solid fa-xmark', 'btn-nav btn-danger', () => settleActive('reject')),
      actionButton(r, 'Handled elsewhere', 'fa-solid fa-check', 'btn-nav', () => settleActive('handled'))
    );
    frag.appendChild(row);
  }

  function buildHumanReview(r, frag) {
    const item = r.item;
    frag.appendChild(reasonBox(item, 'human', 'fa-solid fa-user-shield', 'Needs a human'));
    r.factsHost = createEl('div', 'sup-facts-host');
    frag.appendChild(r.factsHost);

    if (item.action) {
      const known = Object.prototype.hasOwnProperty.call(ACTION_BUTTONS, item.action.name) ? ACTION_BUTTONS[item.action.name] : null;
      const line = createEl('div', 'sup-suggested');
      line.appendChild(createEl('span', 'sup-section-label', 'Suggested fix'));
      if (known) line.appendChild(actionButton(r, known.label, 'fa-solid fa-wrench', 'btn-nav sup-btn-fix', () => runSuggestedAction(known)));
      else line.appendChild(createEl('span', 'sup-dim', item.action.name));
      frag.appendChild(line);
    }

    const examples = buildExamples(item);
    if (examples) frag.appendChild(examples);
    frag.appendChild(buildReplyBox(r, true));

    const row = createEl('div', 'sup-buttons');
    row.append(
      sendButton(r, 'Send reply'),
      actionButton(r, 'Handled', 'fa-solid fa-check', 'btn-nav', () => settleActive('handled'))
    );
    frag.appendChild(row);
  }

  function buildNoReplyReview(r, frag) {
    frag.appendChild(reasonBox(r.item, 'quiet', 'fa-solid fa-comment-slash', 'No reply needed'));
    r.factsHost = createEl('div', 'sup-facts-host');
    frag.appendChild(r.factsHost);
    frag.appendChild(buildReplyBox(r, false));

    const row = createEl('div', 'sup-buttons');
    const send = sendButton(r, 'Send reply');
    send.style.display = 'none';
    const replyAnyway = actionButton(r, 'Reply anyway', 'fa-solid fa-reply', 'btn-nav', () => openReplyBox(r, true));
    r.replyAnywayBtn = replyAnyway;
    row.append(
      send,
      actionButton(r, 'Agree (dismiss)', 'fa-solid fa-check', 'btn-nav sup-btn-agree', () => settleActive('handled')),
      replyAnyway
    );
    frag.appendChild(row);
  }

  function openReplyBox(r, focus) {
    if (!r.replyWrap) return;
    r.replyWrap.style.display = '';
    if (r.sendBtn) r.sendBtn.style.display = '';
    if (r.replyAnywayBtn) r.replyAnywayBtn.style.display = 'none';
    autoGrow(r.replyBox);
    updateControls(r);
    if (focus) r.replyBox.focus();
  }

  function renderReview(r) {
    r.fields = [];
    r.buttons = [];
    const frag = document.createDocumentFragment();
    if (r.mode === 'draft') buildDraftReview(r, frag);
    else if (r.mode === 'no_reply') buildNoReplyReview(r, frag);
    else buildHumanReview(r, frag);
    // Buttons and their status line stay in view when the desk itself has to scroll
    r.status = createEl('div', 'send-status-line sup-status');
    r.status.setAttribute('role', 'status');
    const footer = createEl('div', 'sup-footer');
    const buttonRow = frag.lastChild;
    if (r.actionRow) footer.appendChild(r.actionRow);
    footer.append(buttonRow, r.status);
    frag.appendChild(footer);
    el.review.replaceChildren(frag);
    el.review.scrollTop = 0;
    renderFacts(r);

    // Bring back what was typed for this draft before another chat was opened
    const saved = state.edits.get(r.item.id);
    if (saved) {
      r.fields.forEach((f, i) => { if (typeof saved.texts[i] === 'string') f.textarea.value = saved.texts[i]; });
      if (r.actionBox) r.actionBox.checked = saved.runAction !== false;
      if (r.replyBox && saved.reply) {
        r.replyBox.value = saved.reply;
        openReplyBox(r, false);
      }
    }
    r.fields.forEach(f => autoGrow(f.textarea));
    if (r.replyBox) autoGrow(r.replyBox);
    updateControls(r);
  }

  // =========================================================================
  // Actions: send, reject, handled, suggested fix
  // =========================================================================
  // The record is settled: drop it from the list and move on to the next chat
  function finishActive(r, flashText) {
    const list = visibleItems();
    const idx = list.findIndex(i => i.contact === r.contact);
    const next = idx === -1 ? null : (list[idx + 1] || list[idx - 1] || null);

    state.closedIds.add(r.item.id);
    state.edits.delete(r.item.id);
    const before = state.items.length;
    state.items = state.items.filter(i => i.id !== r.item.id);
    if (state.items.length < before) state.counts[r.item.decision] = Math.max(0, state.counts[r.item.decision] - 1);
    r.busy = false;
    r.fields = []; // nothing left to stash
    if (r.replyBox) r.replyBox.value = '';
    if (r.actionBox) r.actionBox.checked = true;
    renderCounts();
    if (next) {
      openItem(next);
      renderList();
      const row = el.list.querySelector(`.conv-item[data-contact="${CSS.escape(next.contact)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    } else {
      closePanel();
      renderList();
    }
    flash(flashText);
  }

  function sendActive() {
    const r = state.active;
    if (!r || !canAct(r)) return;
    if (r.mode === 'draft') sendDraft(r);
    else if (r.replyBox && r.replyWrap.style.display !== 'none') sendReply(r);
  }

  async function sendDraft(r) {
    const pending = r.fields.filter(f => !f.sent && f.textarea.value.trim());
    if (!pending.length) {
      setStatus(r, 'Nothing to send: every message is empty.', 'error');
      return;
    }
    const texts = pending.map(f => f.textarea.value.trim());
    if (texts.some(t => t.length > MAX_MESSAGE_CHARS)) {
      setStatus(r, `A message is too long (max ${MAX_MESSAGE_CHARS} characters).`, 'error');
      return;
    }
    const runAction = !!(r.item.action && r.actionBox && r.actionBox.checked && !r.actionDone);
    const epoch = core.authEpoch();

    setBusy(r, true);
    pending.forEach(f => setChip(f, runAction ? 'waiting for the action' : 'sending...', 'busy'));
    setStatus(r, runAction
      ? 'Running the action, then sending...'
      : `Sending ${texts.length} message${texts.length > 1 ? 's' : ''}...`, '', 'fa-solid fa-spinner fa-spin');

    let res = null;
    let failure = '';
    try {
      res = await callFunction('support_act', {
        op: 'send',
        draft_id: r.item.rawId,
        contact: r.contact,
        messages: texts,
        run_action: runAction
      });
    } catch (e) {
      failure = `Network error: ${safeErrorText(e, 'please try again')}. Check WhatsApp before sending again.`;
    }
    if (epoch !== core.authEpoch() || state.active !== r) return; // logged out meanwhile

    const data = res ? res.data : {};
    if (res && res.ok && data.success === true) {
      const result = (data.action_result && typeof data.action_result === 'object') ? data.action_result : null;
      const extra = runAction ? ` · action done${result && result.message ? `: ${safeErrorText(result.message)}` : ''}` : '';
      finishActive(r, `Sent ${texts.length} message${texts.length > 1 ? 's' : ''} to ${formatPhoneDisplay(r.contact)}${extra}`);
      return;
    }

    // Failure: nothing leaves the list. Show exactly which messages went out, if any.
    const result = (data.action_result && typeof data.action_result === 'object') ? data.action_result : null;
    const sentCount = Math.max(0, Math.min(pending.length, Math.floor(Number(data.sent)) || 0));
    if (result && result.ok === true) r.actionDone = true;
    pending.forEach((f, i) => {
      if (i < sentCount) {
        f.sent = true;
        setChip(f, 'sent', 'ok');
      } else {
        setChip(f, 'not sent', 'bad');
      }
    });
    if (!failure) {
      const reason = failureText(res, 'the server refused the request');
      if (result && result.ok === false) {
        failure = `The action failed, so nothing was sent: ${safeErrorText(result.message || data.error, 'no details')}`;
      } else if (sentCount > 0) {
        failure = `Only ${sentCount} of ${pending.length} messages were sent: ${reason}. Send again to deliver the rest.`;
      } else {
        failure = `Not sent: ${reason}`;
      }
    }
    setBusy(r, false);
    setStatus(r, failure, 'error', 'fa-solid fa-triangle-exclamation');
  }

  // A reply typed by the employee (escalated or "no reply needed" chats): no draft is approved
  async function sendReply(r) {
    const text = r.replyBox.value.trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE_CHARS) {
      setStatus(r, `The message is too long (max ${MAX_MESSAGE_CHARS} characters).`, 'error');
      return;
    }
    const epoch = core.authEpoch();
    setBusy(r, true);
    setStatus(r, 'Sending...', '', 'fa-solid fa-spinner fa-spin');

    let res = null;
    let failure = '';
    try {
      res = await callFunction('support_act', { op: 'send', contact: r.contact, messages: [text], run_action: false });
    } catch (e) {
      failure = `Network error: ${safeErrorText(e, 'please try again')}. Check WhatsApp before sending again.`;
    }
    if (epoch !== core.authEpoch() || state.active !== r) return;
    if (!failure && !(res.ok && res.data.success === true)) failure = `Not sent: ${failureText(res, 'the server refused the request')}`;
    if (failure) {
      setBusy(r, false);
      setStatus(r, failure, 'error', 'fa-solid fa-triangle-exclamation');
      return;
    }

    // The customer has their answer; now close the record so it leaves everyone's inbox
    r.replyBox.value = '';
    autoGrow(r.replyBox);
    chatView.appendOutgoing(text);
    setStatus(r, 'Sent. Closing the item...', 'success', 'fa-solid fa-spinner fa-spin');
    let closeError = '';
    try {
      const closed = await callFunction('support_act', { op: 'handled', draft_id: r.item.rawId });
      if (!(closed.ok && closed.data.success === true)) closeError = failureText(closed, 'the server refused the request');
    } catch (e) {
      closeError = safeErrorText(e, 'network error');
    }
    if (epoch !== core.authEpoch() || state.active !== r) return;
    if (closeError) {
      setBusy(r, false);
      setStatus(r, `Your reply was sent, but the item could not be closed: ${closeError}. Press Handled to retry.`, 'error', 'fa-solid fa-triangle-exclamation');
      return;
    }
    finishActive(r, `Reply sent to ${formatPhoneDisplay(r.contact)}`);
  }

  // op = 'reject' (the draft is wrong) or 'handled' (answered elsewhere / nothing to do)
  async function settleActive(op) {
    const r = state.active;
    if (!r || !canAct(r)) return;
    if (op === 'reject' && r.mode !== 'draft') return;
    const epoch = core.authEpoch();
    setBusy(r, true);
    setStatus(r, op === 'reject' ? 'Rejecting...' : 'Closing...', '', 'fa-solid fa-spinner fa-spin');

    let failure = '';
    try {
      const res = await callFunction('support_act', { op, draft_id: r.item.rawId });
      if (!(res.ok && res.data.success === true)) failure = failureText(res, 'the server refused the request');
    } catch (e) {
      failure = `Network error: ${safeErrorText(e, 'please try again')}`;
    }
    if (epoch !== core.authEpoch() || state.active !== r) return;
    if (failure) {
      setBusy(r, false);
      setStatus(r, `Could not ${op === 'reject' ? 'reject the draft' : 'close the item'}: ${failure}`, 'error', 'fa-solid fa-triangle-exclamation');
      return;
    }
    const phone = formatPhoneDisplay(r.contact);
    finishActive(r, op === 'reject' ? `Draft for ${phone} rejected` : `${phone} marked as handled`);
  }

  // A fix the AI only suggested: it runs when the employee asks for it, after a confirmation
  async function runSuggestedAction(known) {
    const r = state.active;
    if (!r || !canAct(r)) return;
    if (!confirm(`${known.label} for ${formatPhoneDisplay(r.contact)}?\n\nThis runs on the customer's account right away.`)) return;
    const epoch = core.authEpoch();
    setBusy(r, true);
    setStatus(r, `${known.label}...`, '', 'fa-solid fa-spinner fa-spin');

    let failure = '';
    let message = '';
    try {
      const res = await callFunction('support_act', { op: known.op, contact: r.contact });
      if (res.ok && res.data.success === true) message = typeof res.data.message === 'string' ? safeErrorText(res.data.message) : '';
      else failure = failureText(res, 'the server refused the request');
    } catch (e) {
      failure = `Network error: ${safeErrorText(e, 'please try again')}`;
    }
    if (epoch !== core.authEpoch() || state.active !== r) return;
    setBusy(r, false);
    if (failure) setStatus(r, `${known.label} failed: ${failure}`, 'error', 'fa-solid fa-triangle-exclamation');
    else setStatus(r, message || known.done, 'success', 'fa-solid fa-check');
  }

  // =========================================================================
  // Auto-refresh vs. the open chat
  // =========================================================================
  function loadNewer(r, newer, focusField) {
    openItem(newer, { reload: true, discardEdits: true, banner: 'Customer wrote again — draft updated', focusField });
  }

  // The customer wrote again, so the server replaced the open draft with a new record
  function handleSuperseded(r, newer, reloadMessages) {
    if (r.newer && r.newer.id === newer.id) return; // already announced
    if (!isTouched(r)) {
      const focusField = r.fields.findIndex(f => f.textarea === document.activeElement);
      loadNewer(r, newer, focusField === -1 ? undefined : focusField);
      return;
    }
    // Typed text is never overwritten: the employee decides when to take the new draft
    r.newer = newer;
    showBanner('Customer wrote again — draft updated', 'Load new draft', () => {
      if (state.active === r && !r.busy) loadNewer(r, newer);
    });
    if (reloadMessages) loadChat(r);
  }

  function reconcileActive() {
    const r = state.active;
    if (!r || r.busy) return;
    const current = state.items.find(i => i.contact === r.contact);
    if (!current) {
      if (!r.gone && !r.newer) {
        r.gone = true;
        showBanner('This item is no longer open — it may have been handled from another screen.');
      }
      return;
    }
    if (current.id === r.item.id) {
      r.item = current;
      if (r.gone) {
        r.gone = false;
        showBanner('');
      }
      return;
    }
    if (isNewerDraft(current, r.item)) handleSuperseded(r, current, true);
  }

  // =========================================================================
  // Keyboard (only while this tab is visible)
  // =========================================================================
  function isTextField(t) {
    if (!t || !t.tagName) return false;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
    return t.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(String(t.type).toLowerCase());
  }

  function moveSelection(delta) {
    if (state.active && state.active.busy) return;
    const list = visibleItems();
    if (!list.length) return;
    const idx = state.active ? list.findIndex(i => i.contact === state.active.contact) : -1;
    const target = idx === -1 ? (delta > 0 ? list[0] : list[list.length - 1]) : list[idx + delta];
    if (!target) return;
    openItem(target);
    const row = el.list.querySelector(`.conv-item[data-contact="${CSS.escape(target.contact)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function focusFirstTextarea() {
    const r = state.active;
    if (!r || r.busy) return;
    const field = r.fields.find(f => !f.sent);
    if (field) {
      field.textarea.focus();
      return;
    }
    if (r.replyBox) openReplyBox(r, true);
  }

  function handleShortcut(e) {
    if (!state.signedIn || core.activeTab() !== 'support' || e.altKey || e.repeat) return;
    const t = e.target;
    const typing = isTextField(t);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (typing && !el.review.contains(t)) return; // e.g. the search box
      e.preventDefault();
      sendActive();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'j' || key === 'arrowdown') {
      e.preventDefault();
      moveSelection(1);
    } else if (key === 'k' || key === 'arrowup') {
      e.preventDefault();
      moveSelection(-1);
    } else if (key === 'e') {
      e.preventDefault();
      focusFirstTextarea();
    } else if (key === 'x') {
      e.preventDefault();
      settleActive('reject');
    } else if (key === 'h') {
      e.preventDefault();
      settleActive('handled');
    }
  }

  // =========================================================================
  // Lifecycle hooks called by js/app.js
  // =========================================================================
  function tick() {
    if (!state.signedIn || document.hidden) return;
    const unavailable = state.phase === 'not_deployed' || state.phase === 'error';
    if (unavailable && Date.now() - state.lastAttemptAt < NOT_DEPLOYED_REFRESH_MS) return;
    refreshInbox();
  }

  function onSignIn() {
    state.signedIn = true;
    state.phase = 'idle';
    renderList();
    syncEmptyState();
    refreshInbox();
    if (!state.refreshTimer) state.refreshTimer = setInterval(tick, REFRESH_MS);
  }

  // Wipes everything that belongs to the signed-in user: timers, data in memory and on screen
  function onSignOut() {
    state.signedIn = false;
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.flashTimer) {
      clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    if (state.active && state.active.guardTimer) clearTimeout(state.active.guardTimer);
    state.active = null;
    state.phase = 'idle';
    state.errorText = '';
    state.items = [];
    state.counts = { draft: 0, escalate: 0, no_reply: 0 };
    state.search = '';
    state.edits.clear();
    state.closedIds.clear();
    state.inboxBusy = false;
    state.kickBusy = false;
    state.lastAttemptAt = 0;
    chatView.reset();
    el.messages.replaceChildren();
    el.review.replaceChildren();
    el.list.replaceChildren();
    showBanner('');
    if (el.flash) {
      el.flash.textContent = '';
      el.flash.style.display = 'none';
    }
    if (el.searchInput) el.searchInput.value = '';
    if (el.phone) el.phone.textContent = '';
    if (el.profileName) el.profileName.textContent = '';
    if (el.headerPills) el.headerPills.replaceChildren();
    if (el.waLink) el.waLink.removeAttribute('href');
    setUpdatedLabel('');
    renderCounts();
    el.activeView.style.display = 'none';
    el.emptyState.style.display = '';
    el.panel.classList.remove('active-mobile');
    syncEmptyState();
  }

  function onShow() {
    // Sizes could not be measured while the tab was hidden
    if (state.active) {
      state.active.fields.forEach(f => autoGrow(f.textarea));
      if (state.active.replyBox) autoGrow(state.active.replyBox);
    }
    refreshInbox();
  }

  // =========================================================================
  // Event wiring
  // =========================================================================
  el.filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      el.filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.getAttribute('data-sup-filter');
      state.filter = DECISIONS.includes(filter) ? filter : 'draft';
      el.list.scrollTop = 0;
      renderList();
    });
  });
  if (el.searchInput) {
    el.searchInput.addEventListener('input', (e) => {
      state.search = e.target.value;
      renderList();
    });
  }
  // Keep the customer's last message in view while pictures load or the review desk changes height,
  // unless the employee scrolled up to read older messages
  let stickToBottom = true;
  const pinMessages = () => {
    if (stickToBottom) el.messages.scrollTop = el.messages.scrollHeight;
  };
  el.messages.addEventListener('scroll', () => {
    stickToBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 60;
  }, { passive: true });
  el.messages.addEventListener('load', pinMessages, true); // load does not bubble: capture it
  if ('ResizeObserver' in window) new ResizeObserver(pinMessages).observe(el.messages);

  if (el.backBtn) el.backBtn.addEventListener('click', () => el.panel.classList.remove('active-mobile'));
  document.addEventListener('keydown', handleShortcut);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.signedIn && Date.now() - state.lastAttemptAt > 5000) tick();
  });

  core.registerView('support', { onSignIn, onSignOut, onShow, refresh: refreshInbox });

})();
