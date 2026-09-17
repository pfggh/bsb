/**
 * Teshrij BSB 24h Messenger - Core Application
 * Engineered for maximum throughput & ultra-smooth 60fps on low-spec hardware
 */

(() => {
  'use strict';

  // Application State
  const state = {
    session: null,
    conversations: [],
    filteredConversations: [],
    activeContact: null,
    activeConversationData: null,
    messages: [],
    oldestLoadedTimestamp: null,
    hasOlderMessages: false,
    activeFilter: 'all',
    searchQuery: '',
    isLoadingConversations: false,
    isLoadingMessages: false,
    isLoadingMore: false,
    isSending: false,
    pollInterval: null
  };

  // DOM Elements Cache
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
    el.convCountBadge = document.getElementById('conv-count-badge');
    el.total24hCount = document.getElementById('total-24h-count');
    el.searchInput = document.getElementById('search-input');
    el.convList = document.getElementById('conv-list');
    el.filterPills = document.querySelectorAll('.pill-btn');

    el.chatEmptyState = document.getElementById('chat-empty-state');
    el.chatActiveView = document.getElementById('chat-active-view');
    el.chatPhone = document.getElementById('chat-phone');
    el.chatProfileName = document.getElementById('chat-profile-name');
    el.chatWaLink = document.getElementById('chat-wa-link');
    el.chatAdBanner = document.getElementById('chat-ad-banner');
    el.chatMessagesContainer = document.getElementById('chat-messages-container');
    el.loadMoreWrapper = document.getElementById('load-more-wrapper');
    el.chatTextarea = document.getElementById('chat-textarea');
    el.btnSend = document.getElementById('btn-send');
    el.sendStatusLine = document.getElementById('send-status-line');
    el.quickTemplates = document.querySelectorAll('.template-pill');
  }

  // =========================================================================
  // Phone Normalization (Mirrored from ~/Projects/Fady_bot/core/importer.py)
  // =========================================================================
  function normalizePhone(phoneStr) {
    if (!phoneStr) return "";
    let raw = String(phoneStr).trim();
    if (raw.toLowerCase().startsWith("ig_")) return "";

    let digits = raw.replace(/\D/g, "");
    if (!digits) return "";

    if (digits.startsWith("00")) {
      digits = digits.slice(2);
      if (!digits) return "";
    }

    if (digits.startsWith("961")) {
      let rest = digits.slice(3);
      if (rest.startsWith("03") && rest.length === 8) {
        return "961" + rest.slice(1);
      }
      return digits;
    }

    if (digits.length === 8 && digits.startsWith("03")) {
      return "961" + digits.slice(1);
    }
    if (digits.length === 7 && digits.startsWith("3")) {
      return "961" + digits;
    }
    if (digits.length === 7 && (digits.startsWith("7") || digits.startsWith("8"))) {
      return "961" + digits;
    }
    if (digits.length === 8 && (digits.startsWith("7") || digits.startsWith("8"))) {
      return "961" + digits;
    }

    return digits;
  }

  function formatPhoneDisplay(contact) {
    if (!contact) return "Unknown";
    const str = String(contact);
    if (str.startsWith("961") && str.length >= 10) {
      const rest = str.slice(3);
      if (rest.length === 8) {
        return `+961 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
      }
      return `+961 ${rest}`;
    }
    if (str.length === 11 && str.startsWith("1")) {
      return `+1 (${str.slice(1, 4)}) ${str.slice(4, 7)}-${str.slice(7)}`;
    }
    return `+${str}`;
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);

    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    
    // Fallback date
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatMessageTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHTML(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // =========================================================================
  // Authentication Management (Exact Security of Admin Panel)
  // =========================================================================
  async function checkAuth() {
    if (!window.supabaseClient) {
      console.error("Supabase client not initialized.");
      return;
    }

    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (session && session.access_token) {
        setAuthenticated(session);
      } else {
        setUnauthenticated();
      }
    } catch (err) {
      console.error("Auth check error:", err);
      setUnauthenticated();
    }
  }

  function setAuthenticated(session) {
    state.session = session;
    if (el.userEmailDisplay) {
      el.userEmailDisplay.textContent = session.user?.email || "Admin";
    }
    el.loginView.style.display = 'none';
    el.appView.style.display = 'flex';

    // Start loading data
    loadConversations();
    startPolling();
  }

  function setUnauthenticated() {
    state.session = null;
    stopPolling();
    el.loginView.style.display = 'flex';
    el.appView.style.display = 'none';
    if (el.loginError) el.loginError.textContent = '';
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = el.emailInput.value.trim();
    const password = el.passwordInput.value;

    if (!email || !password) {
      el.loginError.textContent = "Please enter both email and password.";
      return;
    }

    el.loginSubmitBtn.disabled = true;
    el.loginSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';
    el.loginError.textContent = '';

    try {
      const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        el.loginError.textContent = error.message || "Invalid credentials.";
      } else if (data && data.session) {
        setAuthenticated(data.session);
      }
    } catch (err) {
      el.loginError.textContent = "Network error during authentication.";
      console.error(err);
    } finally {
      el.loginSubmitBtn.disabled = false;
      el.loginSubmitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
    }
  }

  async function handleLogout() {
    try {
      await window.supabaseClient.auth.signOut();
    } catch (err) {
      console.error(err);
    }
    setUnauthenticated();
  }

  // =========================================================================
  // Data Fetching: 24h Conversations List (Lightning Fast RPC & Fallback)
  // =========================================================================
  async function loadConversations(isBackground = false) {
    if (state.isLoadingConversations) return;
    state.isLoadingConversations = true;

    if (!isBackground && el.syncBtn) {
      el.syncBtn.classList.add('spinning');
    }

    try {
      // 1. Try Lightning-fast RPC get_bsb_recent_conversations
      let data = null;
      let error = null;

      try {
        const res = await window.supabaseClient.rpc('get_bsb_recent_conversations', { hours_lookback: 24 });
        data = res.data;
        error = res.error;
      } catch (rpcErr) {
        console.warn("RPC fetch failed, falling back to direct query:", rpcErr);
        error = rpcErr;
      }

      // 2. Fallback if RPC failed
      if (error || !data) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const fallbackRes = await window.supabaseClient
          .from('bsb_messages')
          .select('contact, profile_name, message, direction, timestamp, status, has_tracking, ad_id')
          .gte('timestamp', twentyFourHoursAgo)
          .order('timestamp', { ascending: false })
          .limit(2000);

        if (fallbackRes.error) throw fallbackRes.error;

        // Group by contact client-side
        const map = new Map();
        for (const msg of fallbackRes.data) {
          if (!map.has(msg.contact)) {
            map.set(msg.contact, {
              contact: msg.contact,
              profile_name: msg.profile_name,
              last_message: msg.message,
              last_direction: msg.direction,
              last_timestamp: msg.timestamp,
              last_status: msg.status,
              msg_count_24h: 1,
              incoming_count_24h: String(msg.direction).toLowerCase() === 'incoming' ? 1 : 0,
              has_tracking: msg.has_tracking,
              ad_id: msg.ad_id
            });
          } else {
            const item = map.get(msg.contact);
            item.msg_count_24h++;
            if (String(msg.direction).toLowerCase() === 'incoming') item.incoming_count_24h++;
          }
        }
        data = Array.from(map.values());
      }

      state.conversations = data || [];
      applyFilterAndSearch();

      // Update counters
      const totalCount = state.conversations.length;
      if (el.convCountBadge) el.convCountBadge.textContent = totalCount;
      if (el.total24hCount) el.total24hCount.textContent = `${totalCount} active`;

      // Auto-select first conversation if none selected on desktop
      if (!state.activeContact && state.filteredConversations.length > 0 && window.innerWidth > 768) {
        selectConversation(state.filteredConversations[0].contact);
      }

    } catch (err) {
      console.error("Failed to load 24h conversations:", err);
    } finally {
      state.isLoadingConversations = false;
      if (el.syncBtn) el.syncBtn.classList.remove('spinning');
    }
  }

  // =========================================================================
  // Rendering Conversations (DocumentFragment + content-visibility)
  // =========================================================================
  function applyFilterAndSearch() {
    const q = state.searchQuery.toLowerCase().trim();
    const filter = state.activeFilter;

    state.filteredConversations = state.conversations.filter(c => {
      // Filter logic
      if (filter === 'incoming' && (c.incoming_count_24h || 0) <= 0) return false;
      if (filter === 'tracking' && !c.has_tracking && !c.ad_id) return false;

      // Search logic
      if (!q) return true;
      const contactMatch = String(c.contact || '').includes(q);
      const nameMatch = String(c.profile_name || '').toLowerCase().includes(q);
      const msgMatch = String(c.last_message || '').toLowerCase().includes(q);
      return contactMatch || nameMatch || msgMatch;
    });

    renderConversationsList();
  }

  function renderConversationsList() {
    if (!el.convList) return;

    if (state.filteredConversations.length === 0) {
      el.convList.innerHTML = `
        <div style="padding: 30px 20px; text-align: center; color: var(--text-dim);">
          <i class="fa-solid fa-comment-slash" style="font-size: 1.8rem; margin-bottom: 8px; opacity: 0.5;"></i>
          <p>No active conversations found</p>
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const c of state.filteredConversations) {
      const item = document.createElement('div');
      item.className = `conv-item ${c.contact === state.activeContact ? 'active' : ''}`;
      item.dataset.contact = c.contact;

      const isIncoming = String(c.last_direction || '').toLowerCase() === 'incoming';
      const initial = (c.profile_name ? c.profile_name.charAt(0) : (c.contact ? c.contact.slice(-2) : '?')).toUpperCase();
      const displayName = c.profile_name ? escapeHTML(c.profile_name) : formatPhoneDisplay(c.contact);
      const subPhone = c.profile_name ? formatPhoneDisplay(c.contact) : '';
      const timeStr = formatRelativeTime(c.last_timestamp);
      const previewStr = escapeHTML((c.last_message || '').slice(0, 75));

      item.innerHTML = `
        <div class="conv-avatar ${isIncoming ? 'incoming-indicator' : ''}">
          ${initial}
        </div>
        <div class="conv-info">
          <div class="conv-header-line">
            <span class="conv-name" title="${displayName}">${displayName}</span>
            <span class="conv-time">${timeStr}</span>
          </div>
          <div class="conv-subline">
            <span class="conv-preview">
              <i class="fa-solid ${isIncoming ? 'fa-arrow-down dir-incoming' : 'fa-arrow-up dir-outgoing'} dir-icon"></i>
              ${previewStr || '<em>No message</em>'}
            </span>
            <div class="conv-badges">
              ${c.has_tracking || c.ad_id ? '<span class="ad-pill">AD</span>' : ''}
              <span class="msg-count-pill">${c.msg_count_24h || 1}</span>
            </div>
          </div>
        </div>
      `;

      fragment.appendChild(item);
    }

    el.convList.innerHTML = '';
    el.convList.appendChild(fragment);
  }

  // =========================================================================
  // Active Conversation & Message Loading (First 24h + Lightning load_more)
  // =========================================================================
  async function selectConversation(contact) {
    if (!contact) return;
    state.activeContact = contact;
    state.activeConversationData = state.conversations.find(c => c.contact === contact) || null;

    // Update list selection highlight
    const items = el.convList.querySelectorAll('.conv-item');
    items.forEach(it => {
      it.classList.toggle('active', it.dataset.contact === contact);
    });

    // Switch view from empty state to active
    el.chatEmptyState.style.display = 'none';
    el.chatActiveView.style.display = 'flex';

    // Header info
    const displayName = state.activeConversationData?.profile_name || formatPhoneDisplay(contact);
    el.chatPhone.textContent = displayName;
    el.chatProfileName.textContent = state.activeConversationData?.profile_name ? formatPhoneDisplay(contact) : 'BSB Contact';
    el.chatWaLink.href = `https://wa.me/${contact}`;

    // Meta Ad Info
    if (state.activeConversationData?.has_tracking || state.activeConversationData?.ad_id) {
      el.chatAdBanner.style.display = 'flex';
      el.chatAdBanner.innerHTML = `<i class="fa-brands fa-facebook"></i> Meta Ad: ${state.activeConversationData.ad_id || 'Tracked'}`;
    } else {
      el.chatAdBanner.style.display = 'none';
    }

    // Reset Chat messages state
    state.messages = [];
    state.oldestLoadedTimestamp = null;
    state.hasOlderMessages = false;
    el.chatMessagesContainer.innerHTML = `
      <div style="padding: 40px; text-align: center; color: var(--text-dim);">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem; margin-bottom: 8px;"></i>
        <p>Loading messages...</p>
      </div>
    `;

    await loadInitial24hMessages(contact);
  }

  async function loadInitial24hMessages(contact) {
    state.isLoadingMessages = true;
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

      // Query past 24h messages
      const { data, error } = await window.supabaseClient
        .from('bsb_messages')
        .select('id, chat_id, contact, profile_name, direction, message, sent_by, reply_to, status, media_type, media_url, timestamp, has_tracking, ad_id, headline')
        .eq('contact', contact)
        .gte('timestamp', twentyFourHoursAgo)
        .order('timestamp', { ascending: true });

      if (error) throw error;

      state.messages = data || [];

      // Check oldest timestamp loaded
      if (state.messages.length > 0) {
        state.oldestLoadedTimestamp = state.messages[0].timestamp;
      } else {
        state.oldestLoadedTimestamp = twentyFourHoursAgo;
      }

      // Check if there are older messages prior to the 24h window
      const { data: olderCheck } = await window.supabaseClient
        .from('bsb_messages')
        .select('id')
        .eq('contact', contact)
        .lt('timestamp', state.oldestLoadedTimestamp)
        .limit(1);

      state.hasOlderMessages = (olderCheck && olderCheck.length > 0);

      renderChatMessages();
      scrollChatToBottom(false);

    } catch (err) {
      console.error("Failed to load initial messages:", err);
      el.chatMessagesContainer.innerHTML = `
        <div style="padding: 30px; text-align: center; color: var(--accent-rose);">
          <i class="fa-solid fa-triangle-exclamation"></i> Error loading messages.
        </div>
      `;
    } finally {
      state.isLoadingMessages = false;
    }
  }

  // =========================================================================
  // Lightning Fast "Load More" Older Messages
  // =========================================================================
  async function loadMoreMessages() {
    if (!state.activeContact || !state.oldestLoadedTimestamp || state.isLoadingMore) return;
    state.isLoadingMore = true;

    const btn = document.getElementById('btn-load-more');
    if (btn) {
      btn.classList.add('loading');
      btn.innerHTML = '<i class="fa-solid fa-spinner"></i> Loading earlier chats...';
    }

    // Capture scroll geometry before DOM mutation to preserve scroll position
    const container = el.chatMessagesContainer;
    const oldScrollHeight = container.scrollHeight;
    const oldScrollTop = container.scrollTop;

    try {
      const { data: olderBatch, error } = await window.supabaseClient
        .from('bsb_messages')
        .select('id, chat_id, contact, profile_name, direction, message, sent_by, reply_to, status, media_type, media_url, timestamp, has_tracking, ad_id, headline')
        .eq('contact', state.activeContact)
        .lt('timestamp', state.oldestLoadedTimestamp)
        .order('timestamp', { ascending: false })
        .limit(50);

      if (error) throw error;

      if (olderBatch && olderBatch.length > 0) {
        // Chronological order
        olderBatch.reverse();
        state.oldestLoadedTimestamp = olderBatch[0].timestamp;
        state.messages = [...olderBatch, ...state.messages];

        // Re-check if even older messages exist
        const { data: nextCheck } = await window.supabaseClient
          .from('bsb_messages')
          .select('id')
          .eq('contact', state.activeContact)
          .lt('timestamp', state.oldestLoadedTimestamp)
          .limit(1);

        state.hasOlderMessages = (nextCheck && nextCheck.length > 0);

        renderChatMessages();

        // Restore scroll position seamlessly with zero jump!
        requestAnimationFrame(() => {
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
        });
      } else {
        state.hasOlderMessages = false;
        renderChatMessages();
      }

    } catch (err) {
      console.error("Failed to load more messages:", err);
    } finally {
      state.isLoadingMore = false;
    }
  }

  function renderChatMessages() {
    const container = el.chatMessagesContainer;
    if (!container) return;

    const fragment = document.createDocumentFragment();

    // 1. Load More Banner at the top
    const bannerWrapper = document.createElement('div');
    bannerWrapper.className = 'load-more-wrapper';
    if (state.hasOlderMessages) {
      bannerWrapper.innerHTML = `
        <button id="btn-load-more" class="btn-load-more">
          <i class="fa-solid fa-clock-rotate-left"></i> Load Earlier Messages
        </button>
      `;
    } else {
      bannerWrapper.innerHTML = `
        <div class="all-loaded-banner">
          <i class="fa-solid fa-check"></i> Beginning of chat history
        </div>
      `;
    }
    fragment.appendChild(bannerWrapper);

    // 2. 24h Indicator Pill
    const pillDiv = document.createElement('div');
    pillDiv.className = 'chat-date-divider';
    pillDiv.innerHTML = `<span class="chat-date-pill">Past 24 Hours (${state.messages.length} messages)</span>`;
    fragment.appendChild(pillDiv);

    // 3. Render Message Bubbles
    for (const msg of state.messages) {
      const isIncoming = String(msg.direction || '').toLowerCase() === 'incoming';
      const msgDiv = document.createElement('div');
      msgDiv.className = `chat-msg ${isIncoming ? 'incoming' : 'outgoing'}`;

      let mediaHTML = '';
      if (msg.media_type && msg.media_type !== 'None' && msg.media_url) {
        if (msg.media_type.toLowerCase().includes('audio') || msg.media_type.toLowerCase().includes('voice')) {
          mediaHTML = `<div class="msg-media-box"><audio controls class="msg-audio-player" src="${escapeHTML(msg.media_url)}"></audio></div>`;
        } else if (msg.media_type.toLowerCase().includes('image')) {
          mediaHTML = `<div class="msg-media-box"><img class="msg-image-thumb" src="${escapeHTML(msg.media_url)}" alt="Media" onclick="window.open('${escapeHTML(msg.media_url)}')"/></div>`;
        }
      }

      // Ad context banner if message contains ad click info
      let adContext = '';
      if (msg.headline) {
        adContext = `<div style="font-size:0.75rem; font-weight:700; color:var(--accent-cyan); margin-bottom:4px;"><i class="fa-brands fa-facebook"></i> ${escapeHTML(msg.headline)}</div>`;
      }

      const formattedText = escapeHTML(msg.message || '').replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">$1</a>');
      const timeStr = formatMessageTime(msg.timestamp);
      const sentByStr = msg.sent_by ? ` • ${escapeHTML(msg.sent_by)}` : '';
      const statusIcon = !isIncoming ? '<i class="fa-solid fa-check-double msg-status-icon msg-status-read"></i>' : '';

      msgDiv.innerHTML = `
        <div class="msg-bubble">
          ${adContext}
          ${mediaHTML}
          <div>${formattedText}</div>
        </div>
        <div class="msg-meta">
          <span>${timeStr}${sentByStr}</span>
          ${statusIcon}
        </div>
      `;

      fragment.appendChild(msgDiv);
    }

    container.innerHTML = '';
    container.appendChild(fragment);

    // Attach load more click listener
    const loadMoreBtn = document.getElementById('btn-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', loadMoreMessages);
    }
  }

  function scrollChatToBottom(smooth = true) {
    requestAnimationFrame(() => {
      if (el.chatMessagesContainer) {
        el.chatMessagesContainer.scrollTo({
          top: el.chatMessagesContainer.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto'
        });
      }
    });
  }

  // =========================================================================
  // Sending WhatsApp Messages (Integration with BestSMSBulk from sender.py)
  // =========================================================================
  async function sendMessage() {
    if (!state.activeContact || state.isSending) return;
    const text = el.chatTextarea.value.trim();
    if (!text) return;

    const normDest = normalizePhone(state.activeContact);
    if (!normDest) {
      showSendStatus("Invalid destination phone number", "error");
      return;
    }

    state.isSending = true;
    el.btnSend.disabled = true;
    showSendStatus("Sending message via BestSMSBulk...", "");

    try {
      const payload = {
        api_key: window.BSB_CONFIG.api_key,
        api_secret: window.BSB_CONFIG.api_secret,
        destination: normDest,
        message: text
      };

      const response = await fetch(window.BSB_CONFIG.api_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      let resJson;
      try {
        resJson = await response.json();
      } catch (e) {
        resJson = { raw: await response.text() };
      }

      // Check BestSMSBulk response
      const success = (response.status === 200 && resJson.status !== 'error' && resJson.success !== false);

      if (success) {
        el.chatTextarea.value = '';
        showSendStatus("Message sent successfully!", "success");

        // Optimistically add to state.messages
        const optimisticMsg = {
          id: Date.now(),
          chat_id: `out_${Date.now()}`,
          contact: normDest,
          direction: 'Outgoing',
          message: text,
          sent_by: state.session?.user?.email?.split('@')[0] || 'Admin',
          status: 'Sent',
          timestamp: new Date().toISOString()
        };

        state.messages.push(optimisticMsg);
        renderChatMessages();
        scrollChatToBottom(true);

        // Record in Supabase bsb_messages
        try {
          await window.supabaseClient.from('bsb_messages').insert([{
            chat_id: optimisticMsg.chat_id,
            contact: normDest,
            direction: 'Outgoing',
            message: text,
            sent_by: optimisticMsg.sent_by,
            status: 'Sent',
            timestamp: optimisticMsg.timestamp
          }]);
        } catch (dbErr) {
          console.warn("Optimistic DB sync notice:", dbErr);
        }

        // Update conversation in list
        const conv = state.conversations.find(c => c.contact === state.activeContact);
        if (conv) {
          conv.last_message = text;
          conv.last_direction = 'Outgoing';
          conv.last_timestamp = optimisticMsg.timestamp;
          conv.msg_count_24h = (conv.msg_count_24h || 0) + 1;
          renderConversationsList();
        }

      } else {
        const errMsg = resJson.message || resJson.error || "BestSMSBulk dispatch failed";
        showSendStatus(`Failed: ${errMsg}`, "error");
      }

    } catch (err) {
      console.error("Dispatch network error:", err);
      showSendStatus(`Network error: ${err.message}`, "error");
    } finally {
      state.isSending = false;
      el.btnSend.disabled = false;
      setTimeout(() => {
        if (el.sendStatusLine.classList.contains('success')) {
          el.sendStatusLine.textContent = '';
          el.sendStatusLine.className = 'send-status-line';
        }
      }, 4000);
    }
  }

  function showSendStatus(msg, type) {
    if (!el.sendStatusLine) return;
    el.sendStatusLine.textContent = msg;
    el.sendStatusLine.className = `send-status-line ${type}`;
  }

  // =========================================================================
  // Background Polling / Auto-Refresh
  // =========================================================================
  function startPolling() {
    stopPolling();
    // Poll every 25 seconds for new 24h messages
    state.pollInterval = setInterval(() => {
      if (document.hidden) return; // Save CPU when tab is backgrounded
      loadConversations(true);
      // If conversation is open, check for new messages
      if (state.activeContact) {
        pollActiveConversationNewMessages();
      }
    }, 25000);
  }

  function stopPolling() {
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }
  }

  async function pollActiveConversationNewMessages() {
    if (!state.activeContact || state.isLoadingMessages || state.messages.length === 0) return;
    const latestTimestamp = state.messages[state.messages.length - 1].timestamp;

    try {
      const { data, error } = await window.supabaseClient
        .from('bsb_messages')
        .select('id, chat_id, contact, profile_name, direction, message, sent_by, reply_to, status, media_type, media_url, timestamp, has_tracking, ad_id, headline')
        .eq('contact', state.activeContact)
        .gt('timestamp', latestTimestamp)
        .order('timestamp', { ascending: true });

      if (!error && data && data.length > 0) {
        state.messages.push(...data);
        renderChatMessages();
        scrollChatToBottom(true);
      }
    } catch (e) {
      // Background poll silently fails
    }
  }

  // =========================================================================
  // Event Bindings
  // =========================================================================
  function bindEvents() {
    // Login form
    if (el.loginForm) el.loginForm.addEventListener('submit', handleLogin);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', handleLogout);

    // Sync button
    if (el.syncBtn) el.syncBtn.addEventListener('click', () => loadConversations(false));

    // Search input (debounced with requestAnimationFrame)
    if (el.searchInput) {
      let rAF;
      el.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        cancelAnimationFrame(rAF);
        rAF = requestAnimationFrame(applyFilterAndSearch);
      });
    }

    // Filter pills
    el.filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        el.filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeFilter = pill.dataset.filter;
        applyFilterAndSearch();
      });
    });

    // Single delegated click listener on conversation list for performance
    if (el.convList) {
      el.convList.addEventListener('click', (e) => {
        const item = e.target.closest('.conv-item');
        if (item && item.dataset.contact) {
          selectConversation(item.dataset.contact);
        }
      });
    }

    // Chat textarea & send button
    if (el.btnSend) el.btnSend.addEventListener('click', sendMessage);

    if (el.chatTextarea) {
      el.chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Quick canned templates
    el.quickTemplates.forEach(t => {
      t.addEventListener('click', () => {
        const templateText = t.dataset.text || t.textContent.trim();
        if (el.chatTextarea) {
          el.chatTextarea.value = templateText;
          el.chatTextarea.focus();
        }
      });
    });
  }

  // Initialize on DOM Ready
  document.addEventListener('DOMContentLoaded', () => {
    initDOMElements();
    bindEvents();
    checkAuth();
  });

})();
