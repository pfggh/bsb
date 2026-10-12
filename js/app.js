/**
 * Teshrij Follow-up - Live Chat Panel
 *
 * Shows WhatsApp conversations from the past 24h whose latest message is at least 2h old,
 * minus the ones the `triage` edge function hid as finished (explicit confirmation, explicit
 * decline, or final follow-up already sent, each double-checked by two AI models).
 * Anything not yet checked, changed since its check, or uncertain stays in the list.
 */

(() => {
  'use strict';

  const HOURS_LOOKBACK_CONVS = 24; // 24h window
  const MIN_HOURS_OLD = 2.0;       // At least 2h old
  const REFRESH_MS = 3 * 60 * 1000;
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024; // upper bound for an "Ingest Backup" CSV
  const MAX_MEDIA_BYTES = 30 * 1024 * 1024;  // upper bound for one image / voice note

  const STATUS_LABELS = {
    NEEDS_REPLY: 'Unanswered',
    OPEN: 'Follow up',
    CONFIRMED: 'Confirmed working',
    DECLINED: 'Declined',
    ACKNOWLEDGED: 'Thanked',
    FOLLOWED_UP: 'Final follow-up sent',
    NOT_RELEVANT: 'Not a customer',
    MANUAL_DONE: 'Marked done',
    MANUAL_SHOW: 'Kept visible'
  };

  const state = {
    session: null,
    conversations: [],
    filteredConversations: [],
    activeContact: null,
    activeConversationData: null,
    activeFilter: 'todo',
    searchQuery: '',
    isLoadingConversations: false,
    isTriaging: false,
    lastTriage: null,
    refreshTimer: null,
    triageTimer: null,
    authEpoch: 0,          // bumped on every login/logout so stale async work is dropped
    activeTab: 'followup'  // 'followup' or the id of a view registered by another script
  };

  const TAB_STORAGE_KEY = 'followup_active_tab';
  const views = {};        // extra top-bar tabs (js/support.js), see registerView()
  let chatView = null;     // message renderer of the follow-up chat pane

  const el = {};

  function initDOMElements() {
    el.loginView = document.getElementById('login-view');
    el.appView = document.getElementById('app-view');
    el.loginForm = document.getElementById('login-form');
    el.emailInput = document.getElementById('login-email');
    el.passwordInput = document.getElementById('login-password');
    el.loginError = document.getElementById('login-error');
    el.loginSubmitBtn = document.getElementById('login-submit-btn');
    el.userEmailDisplay = document.getElementById('user-email-display');
    el.logoutBtn = document.getElementById('logout-btn');
    el.syncBtn = document.getElementById('sync-btn');
    el.triageStatusText = document.getElementById('triage-status-text');

    el.convCountBadge = document.getElementById('conv-count-badge');
    el.total24hCount = document.getElementById('total-24h-count');
    el.searchInput = document.getElementById('search-input');
    el.convList = document.getElementById('conv-list');
    el.filterPills = document.querySelectorAll('#view-chats .pill-btn');
    el.pillCountTodo = document.getElementById('pill-count-todo');
    el.pillCountUnanswered = document.getElementById('pill-count-unanswered');
    el.pillCountHidden = document.getElementById('pill-count-hidden');

    el.chatEmptyState = document.getElementById('chat-empty-state');
    el.chatActiveView = document.getElementById('chat-active-view');
    el.chatPhone = document.getElementById('chat-phone');
    el.chatProfileName = document.getElementById('chat-profile-name');
    el.chatWaLink = document.getElementById('chat-wa-link');
    el.chatAdBanner = document.getElementById('chat-ad-banner');
    el.chatTriageBar = document.getElementById('chat-triage-bar');
    el.btnMarkDone = document.getElementById('btn-mark-done');
    el.btnShowAgain = document.getElementById('btn-show-again');
    el.chatMessagesContainer = document.getElementById('chat-messages-container');
    el.chatTextarea = document.getElementById('chat-textarea');
    el.btnSend = document.getElementById('btn-send');
    el.sendStatusLine = document.getElementById('send-status-line');
    el.quickTemplates = document.querySelectorAll('#view-chats .template-pill');
    chatView = createChatRenderer(el.chatMessagesContainer);

    el.viewChats = document.getElementById('view-chats');
    el.triageStatus = document.getElementById('triage-status');
    el.tabButtons = document.querySelectorAll('.suite-tab-btn[data-tab]');
  }

  // =========================================================================
  // Phone Formatting & Utilities
  // =========================================================================
  function normalizePhone(phoneStr) {
    if (!phoneStr) return "";
    let raw = String(phoneStr).trim();
    let digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("961")) {
      let rest = digits.slice(3);
      if (rest.startsWith("03") && rest.length === 8) return "961" + rest.slice(1);
      return digits;
    }
    if (digits.length === 8 && digits.startsWith("03")) return "961" + digits.slice(1);
    if (digits.length === 7 && digits.startsWith("3")) return "961" + digits;
    if (digits.length === 7 && (digits.startsWith("7") || digits.startsWith("8"))) return "961" + digits;
    if (digits.length === 8 && (digits.startsWith("7") || digits.startsWith("8"))) return "961" + digits;
    return digits;
  }

  function formatPhoneDisplay(contact) {
    if (!contact) return "Unknown";
    const str = String(contact);
    if (str.startsWith("961") && str.length >= 10) {
      const rest = str.slice(3);
      if (rest.length === 8) return `+961 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
      return `+961 ${rest}`;
    }
    return `+${str}`;
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return "";
    const diffSec = Math.floor((new Date() - new Date(isoStr)) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  }

  function formatMessageTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    return date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Rendering uses DOM nodes + textContent everywhere; this helper is kept for any HTML string
  // that might be needed later. It escapes & < > " ' so it is safe in text and quoted attributes.
  function escapeHTML(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // Short, single-line text for messages shown to the user (never dump raw server payloads)
  function safeErrorText(value, fallback) {
    let text = '';
    if (typeof value === 'string') text = value;
    else if (value && typeof value.message === 'string') text = value.message;
    text = text.slice(0, 2000).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Never echo anything that looks like a token or key
    text = text.replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)*/g, '[redacted]').replace(/\b(sb_[a-z]+_|sk-)[A-Za-z0-9_-]+/g, '[redacted]');
    if (!text) return fallback || 'Unexpected error';
    return text.length > 200 ? text.slice(0, 200) + '...' : text;
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(classes) {
    return createEl('i', classes);
  }

  const SUPABASE_ORIGIN = (() => {
    try { return new URL(window.SUPABASE_URL).origin; } catch (e) { return ''; }
  })();
  const PUBLIC_MEDIA_PATH = '/storage/v1/object/public/bsb-media/';

  // Only an https URL on our own Supabase host inside the public bsb-media bucket may be used
  // directly as <img>/<audio> src. Anything else (javascript:, data:, other hosts, markup) is rejected.
  function safePublicMediaUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.length > 2048 || !SUPABASE_ORIGIN) return null;
    let u;
    try { u = new URL(trimmed); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.origin !== SUPABASE_ORIGIN) return null;
    if (u.username || u.password) return null;
    if (!u.pathname.startsWith(PUBLIC_MEDIA_PATH) || u.pathname.includes('..')) return null;
    return u.href;
  }

  // Media is either already cached in the public bucket (direct URL) or must be fetched from the
  // admin-only bsb_media function. The access token is sent as a header, never in the URL.
  function resolveMedia(chatId, mediaType, rawUrl) {
    const direct = safePublicMediaUrl(rawUrl);
    if (direct) return { kind: 'direct', url: direct };
    if (chatId !== null && chatId !== undefined && String(chatId) !== '') {
      const typeParam = String(mediaType || '').toLowerCase().includes('image') ? 'image' : 'audio';
      return {
        kind: 'protected',
        type: typeParam,
        url: `${SUPABASE_ORIGIN}/functions/v1/bsb_media?chatid=${encodeURIComponent(String(chatId))}&type=${typeParam}`
      };
    }
    return null;
  }

  async function fetchProtectedMedia(url, expectedType) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const token = session && session.access_token;
    if (!token) throw new Error('Not signed in');
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, apikey: window.SUPABASE_ANON_KEY },
      credentials: 'omit',
      cache: 'default',
      referrerPolicy: 'no-referrer'
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (!blob.size || blob.size > MAX_MEDIA_BYTES) throw new Error('Unexpected media size');
    // The upstream content type is not trustworthy. Refuse anything that could be an active
    // document (HTML, SVG, XML, script...) and give every other payload a fixed, inert media type,
    // so a blob: URL opened in a new tab can never run script in this origin.
    const mime = String(blob.type || '').toLowerCase().split(';')[0].trim();
    if (/^text\/|html|xml|svg|script|json/.test(mime)) throw new Error('Unexpected media type');
    const allowed = expectedType === 'image'
      ? /^image\/[a-z0-9.+-]+$/.test(mime)             // svg/xml already refused above
      : /^(audio|video)\/[a-z0-9.+-]+$/.test(mime);
    if (allowed) return blob;
    return new Blob([blob], { type: expectedType === 'image' ? 'image/jpeg' : 'audio/ogg' });
  }

  function showMediaError(holder, text) {
    const old = holder.querySelector('.media-status');
    if (old) old.remove();
    const note = createEl('div', 'media-status media-status-error');
    note.append(icon('fa-solid fa-triangle-exclamation'), ' ' + text);
    holder.appendChild(note);
  }

  function buildMessageRow(isIncoming, bubbleChildren, timeText, statusIconClasses) {
    const row = createEl('div', `chat-msg ${isIncoming ? 'incoming' : 'outgoing'}`);
    const bubble = createEl('div', 'msg-bubble');
    bubbleChildren.forEach(child => { if (child) bubble.appendChild(child); });
    const meta = createEl('div', 'msg-meta');
    meta.appendChild(createEl('span', '', timeText));
    if (statusIconClasses) meta.appendChild(icon(statusIconClasses));
    row.append(bubble, meta);
    return row;
  }

  // One renderer per message pane (follow-up chat, support chat). Each keeps its own media
  // bookkeeping, so re-rendering one pane never drops or leaks the downloads of the other.
  function createChatRenderer(container) {
    const media = {
      renderToken: 0,   // identifies the current chat render; late media downloads are dropped
      objectUrls: [],   // blob: URLs created for the open chat (revoked on re-render)
      observer: null
    };

    function releaseMediaResources() {
      if (media.observer) {
        media.observer.disconnect();
        media.observer = null;
      }
      media.objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
      media.objectUrls = [];
    }

    // Download one protected media item and attach it as a blob: URL
    async function loadProtectedMedia(node) {
      const job = node.__mediaJob;
      if (!job || job.started) return;
      job.started = true;
      const epoch = state.authEpoch;
      const renderToken = job.renderToken;
      const status = job.holder.querySelector('.media-status');
      try {
        const blob = await fetchProtectedMedia(job.url, job.type);
        // The chat was re-rendered or the user logged out while downloading: drop the result
        if (epoch !== state.authEpoch || renderToken !== media.renderToken || !node.isConnected) return;
        const objectUrl = URL.createObjectURL(blob);
        media.objectUrls.push(objectUrl);
        node.src = objectUrl;
        if (job.link) job.link.href = objectUrl;
        node.style.display = '';
        if (status) status.remove();
      } catch (e) {
        if (epoch !== state.authEpoch || renderToken !== media.renderToken) return;
        node.style.display = 'none';
        showMediaError(job.holder, job.type === 'image' ? 'Image unavailable' : 'Voice note unavailable');
      }
    }

    function queueProtectedMedia(node) {
      if (media.observer) media.observer.observe(node.__mediaJob.holder);
      else loadProtectedMedia(node);
    }

    function buildMediaElement(msg, kind) {
      const resolved = resolveMedia(msg.chat_id, kind, msg.media_url);
      if (!resolved) return null;
      const isImage = kind === 'image';
      const holder = createEl('div', isImage ? 'chat-media-image-wrap' : 'voice-note-card');
      let node;
      let link = null;

      if (isImage) {
        link = document.createElement('a');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node = createEl('img', 'chat-media-img');
        node.alt = 'Image';
        node.referrerPolicy = 'no-referrer';
        link.appendChild(node);
        holder.appendChild(link);
      } else {
        const header = createEl('div', 'voice-note-header');
        const title = document.createElement('span');
        title.append(icon('fa-solid fa-microphone-lines'), ' Voice Note');
        header.appendChild(title);
        node = createEl('audio', 'voice-note-audio');
        node.controls = true;
        node.preload = 'none';
        holder.append(header, node);
      }

      if (resolved.kind === 'direct') {
        if (isImage) {
          node.loading = 'lazy';
          link.href = resolved.url;
        }
        node.addEventListener('error', () => {
          node.style.display = 'none';
          showMediaError(holder, isImage ? 'Image unavailable' : 'Voice note unavailable');
        }, { once: true });
        node.src = resolved.url;
      } else {
        node.style.display = 'none';
        const status = createEl('div', 'media-status');
        status.append(icon('fa-solid fa-spinner fa-spin'), isImage ? ' Loading image...' : ' Loading voice note...');
        holder.appendChild(status);
        node.__mediaJob = { url: resolved.url, type: resolved.type, holder, link, started: false, renderToken: media.renderToken };
        holder.__mediaNode = node;
        queueProtectedMedia(node);
      }
      return holder;
    }

    // Drop the media of the current render (downloads still in flight are ignored when they land)
    function reset() {
      releaseMediaResources();
      media.renderToken++;
    }

    function notice(text, iconClasses) {
      const note = document.createElement('div');
      note.style.cssText = 'text-align: center; color: var(--text-dim); padding: 40px;';
      if (iconClasses) note.append(icon(iconClasses), ' ');
      note.append(text);
      container.replaceChildren(note);
    }

    // Built with DOM nodes + textContent only: customer text and media URLs are never parsed as HTML
    function render(messages) {
      reset();
      container.replaceChildren();

      // Protected media is downloaded only when its bubble comes near the visible area
      if ('IntersectionObserver' in window) {
        media.observer = new IntersectionObserver((entries, observer) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            if (entry.target.__mediaNode) loadProtectedMedia(entry.target.__mediaNode);
          });
        }, { root: container, rootMargin: '300px 0px' });
      }

      const frag = document.createDocumentFragment();
      messages.forEach(msg => {
        if (!msg || typeof msg !== 'object') return;
        const isIncoming = String(msg.direction).toLowerCase() === 'incoming';
        const text = typeof msg.message === 'string' ? msg.message : (msg.message === null || msg.message === undefined ? '' : String(msg.message));
        const mediaType = typeof msg.media_type === 'string' ? msg.media_type.toLowerCase() : '';
        const mediaUrl = typeof msg.media_url === 'string' ? msg.media_url : '';
        const mediaPath = mediaUrl.split(/[?#]/)[0].toLowerCase();

        const isAudio = mediaType.includes('audio') || text.includes('🎤') || text.toLowerCase().includes('voice message');
        const isImage = mediaType.includes('image') || mediaPath.endsWith('.jpg') || mediaPath.endsWith('.jpeg') || mediaPath.endsWith('.png');

        let mediaEl = null;
        if (msg.chat_id && (isAudio || isImage)) {
          mediaEl = buildMediaElement(msg, isAudio ? 'audio' : 'image');
        }

        const notSynced = !isIncoming && text === '[Outgoing Message]';
        let textEl = null;
        if (notSynced) textEl = createEl('div', 'msg-text msg-not-synced', 'Message text not synced from BSB yet');
        else if (text) textEl = createEl('div', 'msg-text', text);

        frag.appendChild(buildMessageRow(
          isIncoming,
          [mediaEl, textEl],
          formatMessageTime(msg.timestamp),
          isIncoming ? '' : 'fa-solid fa-check-double msg-status-icon msg-status-read'
        ));
      });
      container.appendChild(frag);

      container.scrollTop = container.scrollHeight;
    }

    // A just-sent message, shown before the next sync brings the stored row
    function appendOutgoing(text) {
      container.appendChild(buildMessageRow(
        false,
        [createEl('div', 'msg-text', text)],
        'Just now',
        'fa-solid fa-check msg-status-icon'
      ));
      container.scrollTop = container.scrollHeight;
    }

    return { render, notice, reset, appendOutgoing };
  }

  // A conversation is hidden only by a fresh HIDE verdict (fresh = no new message since it was checked)
  function isHidden(c) {
    return c.triage_fresh && c.triage_verdict === 'HIDE';
  }

  function isUnanswered(c) {
    return c.triage_fresh ? c.triage_status === 'NEEDS_REPLY' : String(c.last_direction).toLowerCase() === 'incoming';
  }

  // =========================================================================
  // Top-bar tabs: "Follow-up" (this file) and views registered by other scripts
  // =========================================================================
  // def: { onSignIn(), onSignOut(), onShow(), onHide(), refresh() }, all optional. The view's
  // markup is the <section id="view-{id}"> in index.html, its tab the button with data-tab="{id}".
  function registerView(id, def) {
    const key = String(id || '');
    if (!/^[a-z]{1,20}$/.test(key) || key === 'followup' || views[key] || !def || typeof def !== 'object') return false;
    views[key] = def;
    return true;
  }

  function callView(id, hook) {
    const view = views[id];
    if (!view || typeof view[hook] !== 'function') return undefined;
    try {
      return view[hook]();
    } catch (e) {
      console.warn(`[view ${id}.${hook}]`, safeErrorText(e));
      return undefined;
    }
  }

  function storedTab() {
    try {
      const tab = localStorage.getItem(TAB_STORAGE_KEY);
      return tab && views[tab] ? tab : 'followup';
    } catch (e) {
      return 'followup';
    }
  }

  function switchTab(tab, remember) {
    const next = views[tab] ? tab : 'followup';
    const prev = state.activeTab;
    state.activeTab = next;
    el.tabButtons.forEach(btn => {
      const on = btn.getAttribute('data-tab') === next;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (el.viewChats) el.viewChats.classList.toggle('active', next === 'followup');
    Object.keys(views).forEach(id => {
      const section = document.getElementById(`view-${id}`);
      if (section) section.classList.toggle('active', id === next);
    });
    if (el.triageStatus) el.triageStatus.style.display = next === 'followup' ? '' : 'none';
    if (remember) {
      try { localStorage.setItem(TAB_STORAGE_KEY, next); } catch (e) {}
    }
    if (prev !== next) {
      callView(prev, 'onHide');
      callView(next, 'onShow');
    }
  }

  // =========================================================================
  // Authentication
  // =========================================================================
  async function checkAuth() {
    if (!window.supabaseClient) return;
    // Keep state.session current after token refreshes, and follow sign-outs (other tab, expiry)
    window.supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        if (state.session) setUnauthenticated();
      } else if (session && session.access_token && state.session) {
        state.session = session;
      }
    });
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (session && session.access_token) {
        setAuthenticated(session);
      } else {
        setUnauthenticated();
      }
    } catch (err) {
      setUnauthenticated();
    }
  }

  function setAuthenticated(session) {
    const wasSignedOut = !state.session;
    if (wasSignedOut) state.authEpoch++;
    state.session = session;
    if (el.userEmailDisplay) el.userEmailDisplay.textContent = session.user?.email || "Admin";
    if (el.passwordInput) el.passwordInput.value = '';
    el.loginView.style.display = 'none';
    el.appView.style.display = 'flex';
    refreshInbox();
    if (!state.refreshTimer) state.refreshTimer = setInterval(refreshInbox, REFRESH_MS);
    if (wasSignedOut) {
      Object.keys(views).forEach(id => callView(id, 'onSignIn'));
      switchTab(storedTab(), false);
    }
  }

  // Wipes everything that belongs to the signed-in admin: timers, data in memory and on screen
  function setUnauthenticated() {
    state.authEpoch++;
    state.session = null;
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.triageTimer) {
      clearTimeout(state.triageTimer);
      state.triageTimer = null;
    }
    chatView.reset();
    state.conversations = [];
    state.filteredConversations = [];
    state.activeContact = null;
    state.activeConversationData = null;
    state.searchQuery = '';
    state.isLoadingConversations = false;
    state.isTriaging = false;
    state.lastTriage = null;
    if (el.convList) el.convList.replaceChildren();
    if (el.chatMessagesContainer) el.chatMessagesContainer.replaceChildren();
    if (el.chatTriageBar) el.chatTriageBar.replaceChildren();
    if (el.chatAdBanner) el.chatAdBanner.replaceChildren();
    if (el.chatTextarea) el.chatTextarea.value = '';
    if (el.searchInput) el.searchInput.value = '';
    if (el.sendStatusLine) el.sendStatusLine.textContent = '';
    if (el.chatPhone) el.chatPhone.textContent = '';
    if (el.chatProfileName) el.chatProfileName.textContent = '';
    if (el.chatWaLink) el.chatWaLink.removeAttribute('href');
    if (el.userEmailDisplay) el.userEmailDisplay.textContent = 'Admin';
    if (el.passwordInput) el.passwordInput.value = '';
    if (el.chatActiveView) el.chatActiveView.style.display = 'none';
    if (el.chatEmptyState) el.chatEmptyState.style.display = '';
    el.loginView.style.display = 'flex';
    el.appView.style.display = 'none';
    if (el.loginError) el.loginError.textContent = '';
    // Other tabs wipe their own state and DOM; the next sign-in reopens the remembered tab
    Object.keys(views).forEach(id => callView(id, 'onSignOut'));
    switchTab('followup', false);
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = el.emailInput.value.trim();
    const password = el.passwordInput.value;
    if (!email || !password) {
      el.loginError.textContent = "Please enter email and password.";
      return;
    }

    el.loginSubmitBtn.disabled = true;
    el.loginSubmitBtn.replaceChildren(icon('fa-solid fa-spinner fa-spin'), ' Authenticating...');
    el.loginError.textContent = '';

    try {
      const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        // Fixed wording: do not echo the auth server's raw answer
        const status = Number(error.status) || 0;
        el.loginError.textContent = status === 429
          ? "Too many attempts. Please wait a moment and try again."
          : (status >= 500 || status === 0)
            ? "Sign-in service unavailable. Please try again."
            : "Invalid email or password.";
      } else if (data && data.session) {
        setAuthenticated(data.session);
      }
    } catch (err) {
      el.loginError.textContent = "Network error during authentication.";
    } finally {
      el.passwordInput.value = '';
      el.loginSubmitBtn.disabled = false;
      el.loginSubmitBtn.replaceChildren(icon('fa-solid fa-arrow-right-to-bracket'), ' Sign In');
    }
  }

  async function handleLogout() {
    try {
      await window.supabaseClient.auth.signOut();
    } catch (err) {}
    setUnauthenticated();
  }

  // =========================================================================
  // Inbox + AI triage
  // =========================================================================
  async function loadConversations() {
    if (state.isLoadingConversations) return;
    state.isLoadingConversations = true;
    const epoch = state.authEpoch;

    try {
      const res = await window.supabaseClient.rpc('get_followup_inbox', {
        hours_lookback: HOURS_LOOKBACK_CONVS,
        min_hours_old: MIN_HOURS_OLD
      });
      if (epoch !== state.authEpoch) return; // logged out meanwhile
      if (!res.error && Array.isArray(res.data)) {
        state.conversations = res.data.filter(c => c && typeof c === 'object');
        filterAndRenderConversations();
        if (state.activeContact) {
          const fresh = state.conversations.find(c => c.contact === state.activeContact);
          if (fresh) {
            state.activeConversationData = fresh;
            renderTriageBar(fresh);
          }
        }
      } else if (res.error) {
        console.warn('[get_followup_inbox]', safeErrorText(res.error));
      }
    } catch (e) {
      console.warn('[loadConversations]', safeErrorText(e));
    } finally {
      if (epoch === state.authEpoch) state.isLoadingConversations = false;
    }
  }

  // Ask the triage function to check conversations that are new or changed since their last check
  async function runTriage() {
    if (state.isTriaging) return;
    const pending = state.conversations.filter(c => !c.triage_fresh).length;
    if (!pending) {
      updateTriageStatus();
      return;
    }
    state.isTriaging = true;
    const epoch = state.authEpoch;
    setTriageStatus(`Checking ${pending} chat${pending > 1 ? 's' : ''}...`, 'fa-solid fa-circle-notch fa-spin');
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session || !session.access_token) throw new Error('Not signed in');
      const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/triage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: window.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const data = (await resp.json().catch(() => null)) || {};
      if (epoch !== state.authEpoch) return; // logged out meanwhile
      if (!resp.ok || !data.success) throw new Error(`HTTP ${resp.status}`);
      state.lastTriage = new Date();
      await loadConversations();
      if (epoch !== state.authEpoch) return;
      // Large backlogs are processed in several passes
      if (data.remaining > 0) {
        if (state.triageTimer) clearTimeout(state.triageTimer);
        state.triageTimer = setTimeout(() => {
          state.triageTimer = null;
          if (epoch !== state.authEpoch) return;
          state.isTriaging = false;
          runTriage();
        }, 500);
      }
    } catch (e) {
      if (epoch !== state.authEpoch) return;
      console.warn('[triage]', safeErrorText(e));
      setTriageStatus('AI check unavailable, showing all chats', 'fa-solid fa-triangle-exclamation');
      state.isTriaging = false;
      return;
    }
    state.isTriaging = false;
    updateTriageStatus();
  }

  async function refreshInbox() {
    await loadConversations();
    await runTriage();
  }

  function setTriageStatus(text, iconClasses) {
    if (!el.triageStatusText) return;
    el.triageStatusText.replaceChildren();
    if (iconClasses) el.triageStatusText.append(icon(iconClasses), ' ');
    el.triageStatusText.append(String(text));
  }

  function updateTriageStatus() {
    const hidden = state.conversations.filter(isHidden).length;
    const pending = state.conversations.filter(c => !c.triage_fresh).length;
    const when = state.lastTriage ? ` · checked ${state.lastTriage.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    setTriageStatus(pending
      ? `${hidden} hidden · ${pending} waiting for check`
      : `${hidden} finished chat${hidden === 1 ? '' : 's'} hidden${when}`);
  }

  function filterAndRenderConversations() {
    const all = state.conversations;
    const visible = all.filter(c => !isHidden(c));
    let list;
    if (state.activeFilter === 'hidden') list = all.filter(isHidden);
    else if (state.activeFilter === 'unanswered') list = visible.filter(isUnanswered);
    else list = visible;

    if (state.searchQuery) {
      const q = String(state.searchQuery).slice(0, 200).toLowerCase();
      list = list.filter(c => String(c.contact).includes(q) || String(c.profile_name || '').toLowerCase().includes(q) || String(c.last_message || '').toLowerCase().includes(q));
    }

    state.filteredConversations = list;
    if (el.pillCountTodo) el.pillCountTodo.textContent = visible.length;
    if (el.pillCountUnanswered) el.pillCountUnanswered.textContent = visible.filter(isUnanswered).length;
    if (el.pillCountHidden) el.pillCountHidden.textContent = all.length - visible.length;
    if (el.convCountBadge) el.convCountBadge.textContent = visible.length;
    if (el.total24hCount) el.total24hCount.textContent = `${all.length} chats in window`;
    renderConversationList();
    if (!state.isTriaging) updateTriageStatus();
  }

  function updateActiveConversationHighlight(contact) {
    if (!el.convList) return;
    el.convList.querySelectorAll('.conv-item').forEach(item => {
      item.classList.toggle('active', item.dataset.contact === String(contact));
    });
  }

  function statusLabel(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : String(status || '');
  }

  function triagePill(c) {
    if (!c.triage_fresh) {
      const checking = createEl('span', 'triage-pill pill-checking');
      checking.append(icon('fa-solid fa-circle-notch fa-spin'), ' Checking');
      return checking;
    }
    const cls = c.triage_verdict === 'HIDE' ? 'pill-hidden' : c.triage_status === 'NEEDS_REPLY' ? 'pill-unanswered' : 'pill-open';
    return createEl('span', `triage-pill ${cls}`, statusLabel(c.triage_status));
  }

  // Built with DOM nodes + textContent only: nothing from the database is ever parsed as HTML
  function renderConversationList(preserveScroll = true) {
    if (!el.convList) return;
    const prevScroll = preserveScroll ? el.convList.scrollTop : 0;
    el.convList.replaceChildren();

    if (state.filteredConversations.length === 0) {
      const msg = state.activeFilter === 'hidden' ? 'No hidden chats.' : 'Nothing to follow up right now.';
      const empty = createEl('div', '', msg);
      empty.style.cssText = 'text-align: center; color: var(--text-dim); padding: 30px;';
      el.convList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    state.filteredConversations.forEach(c => {
      const item = createEl('div', `conv-item${state.activeContact === c.contact ? ' active' : ''}`);
      item.dataset.contact = String(c.contact);
      item.addEventListener('click', () => selectConversation(c));

      const isIncoming = String(c.last_direction).toLowerCase() === 'incoming';
      const preview = c.last_message === '[Outgoing Message]' ? 'You replied' : (c.last_message || '[Media]');
      const initialSource = String(c.profile_name || c.contact || '?').trim() || '?';
      const initial = (Array.from(initialSource)[0] || '?').toUpperCase();

      const avatar = createEl('div', `conv-avatar${isIncoming ? ' incoming-indicator' : ''}`, initial);

      const info = createEl('div', 'conv-info');
      const headerLine = createEl('div', 'conv-header-line');
      headerLine.append(
        createEl('span', 'conv-name', formatPhoneDisplay(c.contact)),
        createEl('span', 'conv-time', formatRelativeTime(c.last_timestamp))
      );

      const subline = createEl('div', 'conv-subline');
      const previewEl = createEl('span', 'conv-preview');
      previewEl.append(
        icon(isIncoming ? 'fa-solid fa-arrow-down-left dir-icon dir-incoming' : 'fa-solid fa-arrow-up-right dir-icon dir-outgoing'),
        ' ' + String(preview)
      );
      const badges = createEl('div', 'conv-badges');
      if (c.has_tracking) {
        const adPill = createEl('span', 'ad-pill');
        adPill.append(icon('fa-brands fa-meta'), ' Ads');
        badges.appendChild(adPill);
      }
      badges.appendChild(triagePill(c));
      subline.append(previewEl, badges);

      info.append(headerLine, subline);
      if (c.triage_fresh && c.triage_reason) info.appendChild(createEl('div', 'conv-reason', c.triage_reason));

      item.append(avatar, info);
      frag.appendChild(item);
    });
    el.convList.appendChild(frag);

    if (preserveScroll && prevScroll > 0) {
      el.convList.scrollTop = prevScroll;
    }
  }

  function renderTriageBar(c) {
    if (!el.chatTriageBar) return;
    const hidden = isHidden(c);
    el.btnMarkDone.style.display = hidden ? 'none' : 'flex';
    el.btnShowAgain.style.display = hidden ? 'flex' : 'none';
    el.chatTriageBar.replaceChildren();
    if (!c.triage_fresh) {
      el.chatTriageBar.className = 'triage-bar bar-checking';
      el.chatTriageBar.append(icon('fa-solid fa-circle-notch fa-spin'), ' Not checked yet since the last message');
      return;
    }
    const by = c.triage_method === 'manual' ? ' (by an agent)' : '';
    el.chatTriageBar.className = `triage-bar ${hidden ? 'bar-hidden' : c.triage_status === 'NEEDS_REPLY' ? 'bar-unanswered' : 'bar-open'}`;
    el.chatTriageBar.append(
      icon(`fa-solid ${hidden ? 'fa-eye-slash' : 'fa-circle-info'}`),
      ' ',
      createEl('strong', '', statusLabel(c.triage_status) + by),
      ' · ' + String(c.triage_reason || '')
    );
  }

  // Manual override, valid until the next message in this chat
  async function setManualVerdict(verdict) {
    const c = state.activeConversationData;
    if (!c || !c.signature) return;
    const btn = verdict === 'HIDE' ? el.btnMarkDone : el.btnShowAgain;
    btn.disabled = true;
    try {
      const row = {
        contact: c.contact,
        signature: c.signature,
        verdict,
        status: verdict === 'HIDE' ? 'MANUAL_DONE' : 'MANUAL_SHOW',
        reason: verdict === 'HIDE' ? 'An agent marked this chat as done' : 'An agent brought this chat back',
        method: 'manual',
        votes: null,
        tokens: 0,
        updated_by: state.session?.user?.email || 'agent',
        updated_at: new Date().toISOString()
      };
      const { error } = await window.supabaseClient.from('chat_triage').upsert(row, { onConflict: 'contact' });
      if (error) throw error;
      Object.assign(c, { triage_verdict: verdict, triage_status: row.status, triage_reason: row.reason, triage_method: 'manual', triage_fresh: true });
      filterAndRenderConversations();
      renderTriageBar(c);
      return true;
    } catch (e) {
      alert(`Could not save: ${safeErrorText(e, 'please try again')}`);
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  // Keyboard: C = next chat, V = mark done and go to the next chat
  function nextConversationAfter(contact) {
    const list = state.filteredConversations;
    const idx = list.findIndex(c => c.contact === contact);
    if (idx === -1) return list[0] || null;
    return list[idx + 1] || null;
  }

  function openConversation(c) {
    if (!c) return;
    selectConversation(c);
    const item = el.convList && el.convList.querySelector(`.conv-item[data-contact="${CSS.escape(String(c.contact))}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  async function markDoneAndNext() {
    const c = state.activeConversationData;
    if (!c) return openConversation(state.filteredConversations[0]);
    const next = nextConversationAfter(c.contact);
    if (!isHidden(c) && !(await setManualVerdict('HIDE'))) return;
    if (next) openConversation(next);
  }

  function handleShortcut(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !state.session) return;
    if (state.activeTab !== 'followup') return; // the keys belong to the visible tab only
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      openConversation(nextConversationAfter(state.activeContact));
    } else if (key === 'v') {
      e.preventDefault();
      markDoneAndNext();
    }
  }

  async function selectConversation(c) {
    state.activeContact = c.contact;
    state.activeConversationData = c;

    el.chatEmptyState.style.display = 'none';
    el.chatActiveView.style.display = 'flex';

    el.chatPhone.textContent = formatPhoneDisplay(c.contact);
    el.chatProfileName.textContent = c.profile_name || 'BSB Contact';
    // normalizePhone() returns digits only, so nothing else can end up in the link
    el.chatWaLink.href = `https://web.whatsapp.com/send?phone=${encodeURIComponent(normalizePhone(c.contact))}`;
    renderTriageBar(c);

    if (el.chatAdBanner) {
      el.chatAdBanner.replaceChildren();
      if (c.has_tracking) {
        el.chatAdBanner.style.display = 'flex';
        el.chatAdBanner.append(icon('fa-brands fa-meta'), ` Meta Ad Lead (ID: ${c.ad_id || 'Active'})`);
      } else {
        el.chatAdBanner.style.display = 'none';
      }
    }

    updateActiveConversationHighlight(c.contact); // In-place highlight without touching scroll position

    chatView.reset();
    chatView.notice('Loading conversation...', 'fa-solid fa-spinner fa-spin');
    const epoch = state.authEpoch;
    try {
      const { data, error } = await window.supabaseClient
        .from('bsb_messages')
        .select('*')
        .eq('contact', c.contact)
        .order('timestamp', { ascending: false })
        .limit(100);
      if (epoch !== state.authEpoch || state.activeContact !== c.contact) return;
      if (error) throw error;
      chatView.render((Array.isArray(data) ? data : []).reverse());
    } catch (e) {
      if (epoch === state.authEpoch && state.activeContact === c.contact) chatView.notice('Failed to load messages.');
    }
  }

  async function sendDirectChatMessage() {
    if (!state.activeContact || !el.chatTextarea.value.trim()) return;
    const text = el.chatTextarea.value.trim();
    const contact = state.activeContact;
    const dest = normalizePhone(contact);
    const epoch = state.authEpoch;
    if (!dest) {
      el.sendStatusLine.textContent = "Error: this contact has no valid phone number.";
      return;
    }
    if (text.length > 4096) {
      el.sendStatusLine.textContent = "Error: message is too long (max 4096 characters).";
      return;
    }

    el.btnSend.disabled = true;
    el.sendStatusLine.textContent = "Sending via BestSMSBulk...";

    try {
      // BSB credentials live server-side: the bsb_send edge function forwards the message
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (!session || !session.access_token) throw new Error('You are signed out. Please sign in again.');
      const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/bsb_send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: window.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          destination: dest,
          message: text
        })
      });
      const data = (await resp.json().catch(() => null)) || {};
      const edgeOk = resp.status === 200 && data && typeof data.upstream_status === 'number';
      // resJson is BestSMSBulk's own answer (or the edge function's error when it never reached BSB)
      const resJson = edgeOk
        ? ((data.result && typeof data.result === 'object') ? data.result : { raw: 'Non-JSON' })
        : { status: 'error', message: (data && (data.error || data.message)) || `HTTP ${resp.status}` };
      const isSuccess = edgeOk && data.upstream_status === 200 && resJson.status !== 'error' && resJson.success !== false;

      // Record every send in send_queue: keeps the 1h dispatcher filter working and gives the
      // AI check the text of follow-ups sent from this panel (BSB webhooks don't include it)
      if (window.supabaseClient) {
        try {
          await window.supabaseClient.from('send_queue').insert({
            contact: dest,
            message: text,
            status: isSuccess ? 'SENT' : 'FAILED',
            sent_at: isSuccess ? new Date().toISOString() : null,
            api_response: JSON.stringify(resJson),
            error_message: isSuccess ? null : JSON.stringify(resJson)
          });
        } catch (dbErr) {
          console.warn('[SEND_QUEUE INSERT ERROR]', safeErrorText(dbErr));
        }
      }

      if (epoch !== state.authEpoch) return; // logged out meanwhile

      if (isSuccess) {
        el.chatTextarea.value = '';
        el.sendStatusLine.textContent = "✓ Message sent successfully!";

        // Only add the bubble if the same chat is still open
        if (state.activeContact === contact) chatView.appendOutgoing(text);

        // The chat leaves the list now and comes back after 2h only if it still needs action
        state.conversations = state.conversations.filter(c => normalizePhone(c.contact) !== dest);
        filterAndRenderConversations();
      } else {
        // Short reason only; the full upstream answer is kept in send_queue, not shown on screen
        el.sendStatusLine.textContent = `Error: ${safeErrorText(resJson.message || resJson.error, 'message was not sent')}`;
      }
    } catch (e) {
      if (epoch !== state.authEpoch) return;
      el.sendStatusLine.textContent = `Network error: ${safeErrorText(e, 'please try again')}`;
    } finally {
      el.btnSend.disabled = false;
    }
  }

  // =========================================================================
  // Event wiring
  // =========================================================================
  function initEventListeners() {
    if (el.loginForm) el.loginForm.addEventListener('submit', handleLogin);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', handleLogout);
    if (el.syncBtn) el.syncBtn.addEventListener('click', async () => {
      el.syncBtn.classList.add('spinning');
      if (state.activeTab === 'followup') await refreshInbox();
      else await callView(state.activeTab, 'refresh');
      el.syncBtn.classList.remove('spinning');
    });
    el.tabButtons.forEach(btn => {
      const tab = btn.getAttribute('data-tab');
      if (tab !== 'followup' && !views[tab]) {
        btn.style.display = 'none'; // its script did not load
        return;
      }
      btn.addEventListener('click', () => switchTab(tab, true));
    });

    const btnIngestBackup = document.getElementById('btn-ingest-backup');
    const followupBackupInput = document.getElementById('followup-backup-input');
    if (btnIngestBackup && followupBackupInput) {
      btnIngestBackup.addEventListener('click', () => {
        followupBackupInput.value = '';
        followupBackupInput.click();
      });

      followupBackupInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        // Only a plain, reasonably sized .csv export is accepted
        const fileName = String(file.name || '');
        const displayName = fileName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        const fileType = String(file.type || '').toLowerCase();
        const typeOk = ['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'].includes(fileType);
        if (!/\.csv$/i.test(fileName) || !typeOk) {
          alert('Please choose a .csv file exported from BestSMSBulk.');
          followupBackupInput.value = '';
          return;
        }
        if (file.size === 0 || file.size > MAX_BACKUP_BYTES) {
          alert(file.size === 0
            ? 'This file is empty.'
            : `This file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is ${MAX_BACKUP_BYTES / 1024 / 1024} MB.`);
          followupBackupInput.value = '';
          return;
        }

        const confirmed = confirm(
          `Ingest BSB chat export "${displayName}" (${(file.size / 1024 / 1024).toFixed(2)} MB) into bsb_messages?\n\nAll messages will be safely merged and deduplicated by chat_id.`
        );
        if (!confirmed) {
          followupBackupInput.value = '';
          return;
        }

        const labelSpan = btnIngestBackup.querySelector('span');
        const labelIcon = btnIngestBackup.querySelector('i');
        const originalLabel = labelSpan ? labelSpan.textContent : '';
        const originalIconClass = labelIcon ? labelIcon.className : '';
        btnIngestBackup.disabled = true;
        if (labelIcon) labelIcon.className = 'fa-solid fa-spinner fa-spin';
        if (labelSpan) labelSpan.textContent = 'Ingesting...';

        try {
          const { data: { session } } = await window.supabaseClient.auth.getSession();
          if (!session || !session.access_token) throw new Error('You are signed out. Please sign in again.');

          const formData = new FormData();
          formData.append('file', file);

          const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/ingest_backup`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: window.SUPABASE_ANON_KEY
            },
            body: formData
          });

          const data = (await resp.json().catch(() => null)) || {};
          if (!resp.ok || data.error) {
            throw new Error(safeErrorText(data.error, `Failed to ingest backup file (HTTP ${resp.status})`));
          }

          const inserted = Number(data.inserted) || 0;
          const updated = Number(data.updated) || 0;
          alert(typeof data.message === 'string' && data.message
            ? safeErrorText(data.message)
            : `Ingested successfully! ${inserted} new, ${updated} updated.`);
          refreshInbox();
        } catch (err) {
          console.error('[ingest_backup error]', safeErrorText(err));
          alert(`Error ingesting backup: ${safeErrorText(err, 'please try again')}`);
        } finally {
          btnIngestBackup.disabled = false;
          if (labelIcon) labelIcon.className = originalIconClass;
          if (labelSpan) labelSpan.textContent = originalLabel;
          followupBackupInput.value = '';
        }
      });
    }

    if (el.btnMarkDone) el.btnMarkDone.addEventListener('click', () => setManualVerdict('HIDE'));
    if (el.btnShowAgain) el.btnShowAgain.addEventListener('click', () => setManualVerdict('SHOW'));
    document.addEventListener('keydown', handleShortcut);

    if (el.btnSend) el.btnSend.addEventListener('click', sendDirectChatMessage);
    if (el.chatTextarea) {
      el.chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendDirectChatMessage();
        }
      });
    }
    if (el.searchInput) {
      el.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        filterAndRenderConversations();
      });
    }
    el.filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        el.filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeFilter = pill.getAttribute('data-filter') || 'todo';
        filterAndRenderConversations();
      });
    });
    el.quickTemplates.forEach(t => {
      t.addEventListener('click', () => {
        if (el.chatTextarea) {
          el.chatTextarea.value = t.getAttribute('data-text') || '';
          el.chatTextarea.focus();
        }
      });
    });
  }

  // The only thing this file exposes: inert helpers and hooks for the other tabs (js/support.js).
  // No session, token or panel state is reachable through it.
  if (!window.__FRAMED__) {
    window.PanelCore = Object.freeze({
      createEl,
      icon,
      safeErrorText,
      normalizePhone,
      formatPhoneDisplay,
      formatRelativeTime,
      createChatRenderer,
      registerView,
      authEpoch: () => state.authEpoch,
      activeTab: () => state.activeTab
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.__FRAMED__) return; // refuse to run inside a foreign frame (see js/config.js)
    initDOMElements();
    initEventListeners();
    checkAuth();
  });

})();
