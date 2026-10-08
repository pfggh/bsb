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
    lastTriage: null
  };

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
    el.filterPills = document.querySelectorAll('.pill-btn');
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
    el.quickTemplates = document.querySelectorAll('.template-pill');
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

  function escapeHTML(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function resolveMediaUrl(chatId, mediaType, rawUrl) {
    const trimmed = (rawUrl || '').trim();
    if (trimmed.includes('supabase.co/storage/v1/object/public/bsb-media/')) return trimmed;
    if (chatId) {
      const typeParam = (mediaType || '').toLowerCase().includes('image') ? 'image' : 'audio';
      return `${window.SUPABASE_URL}/functions/v1/bsb_media?chatid=${encodeURIComponent(chatId)}&type=${typeParam}`;
    }
    return trimmed;
  }

  // A conversation is hidden only by a fresh HIDE verdict (fresh = no new message since it was checked)
  function isHidden(c) {
    return c.triage_fresh && c.triage_verdict === 'HIDE';
  }

  function isUnanswered(c) {
    return c.triage_fresh ? c.triage_status === 'NEEDS_REPLY' : String(c.last_direction).toLowerCase() === 'incoming';
  }

  // =========================================================================
  // Authentication
  // =========================================================================
  async function checkAuth() {
    if (!window.supabaseClient) return;
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
    state.session = session;
    if (el.userEmailDisplay) el.userEmailDisplay.textContent = session.user?.email || "Admin";
    el.loginView.style.display = 'none';
    el.appView.style.display = 'flex';
    refreshInbox();
    if (!state.refreshTimer) state.refreshTimer = setInterval(refreshInbox, REFRESH_MS);
  }

  function setUnauthenticated() {
    state.session = null;
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    el.loginView.style.display = 'flex';
    el.appView.style.display = 'none';
    if (el.loginError) el.loginError.textContent = '';
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
    } finally {
      el.loginSubmitBtn.disabled = false;
      el.loginSubmitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
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

    try {
      const res = await window.supabaseClient.rpc('get_followup_inbox', {
        hours_lookback: HOURS_LOOKBACK_CONVS,
        min_hours_old: MIN_HOURS_OLD
      });
      if (!res.error && res.data) {
        state.conversations = res.data;
        filterAndRenderConversations();
        if (state.activeContact) {
          const fresh = state.conversations.find(c => c.contact === state.activeContact);
          if (fresh) {
            state.activeConversationData = fresh;
            renderTriageBar(fresh);
          }
        }
      } else if (res.error) {
        console.warn('[get_followup_inbox]', res.error);
      }
    } catch (e) {
      console.warn('[loadConversations]', e);
    } finally {
      state.isLoadingConversations = false;
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
    setTriageStatus(`<i class="fa-solid fa-circle-notch fa-spin"></i> Checking ${pending} chat${pending > 1 ? 's' : ''}...`);
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/triage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token || ''}`,
          apikey: window.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) throw new Error(data.error || `HTTP ${resp.status}`);
      state.lastTriage = new Date();
      await loadConversations();
      // Large backlogs are processed in several passes
      if (data.remaining > 0) setTimeout(() => { state.isTriaging = false; runTriage(); }, 500);
    } catch (e) {
      console.warn('[triage]', e);
      setTriageStatus(`<i class="fa-solid fa-triangle-exclamation"></i> AI check unavailable, showing all chats`);
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

  function setTriageStatus(html) {
    if (el.triageStatusText) el.triageStatusText.innerHTML = html;
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
      const q = state.searchQuery.toLowerCase();
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

  function triagePill(c) {
    if (!c.triage_fresh) return '<span class="triage-pill pill-checking"><i class="fa-solid fa-circle-notch fa-spin"></i> Checking</span>';
    const label = STATUS_LABELS[c.triage_status] || c.triage_status;
    if (c.triage_verdict === 'HIDE') return `<span class="triage-pill pill-hidden">${escapeHTML(label)}</span>`;
    if (c.triage_status === 'NEEDS_REPLY') return `<span class="triage-pill pill-unanswered">${escapeHTML(label)}</span>`;
    return `<span class="triage-pill pill-open">${escapeHTML(label)}</span>`;
  }

  function renderConversationList(preserveScroll = true) {
    if (!el.convList) return;
    const prevScroll = preserveScroll ? el.convList.scrollTop : 0;
    el.convList.innerHTML = '';

    if (state.filteredConversations.length === 0) {
      const msg = state.activeFilter === 'hidden' ? 'No hidden chats.' : 'Nothing to follow up right now.';
      el.convList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 30px;">${msg}</div>`;
      return;
    }

    state.filteredConversations.forEach(c => {
      const item = document.createElement('div');
      item.dataset.contact = String(c.contact);
      item.className = `conv-item ${state.activeContact === c.contact ? 'active' : ''}`;
      item.onclick = () => selectConversation(c);

      const isIncoming = String(c.last_direction).toLowerCase() === 'incoming';
      const dirIcon = isIncoming
        ? '<i class="fa-solid fa-arrow-down-left dir-icon dir-incoming"></i>'
        : '<i class="fa-solid fa-arrow-up-right dir-icon dir-outgoing"></i>';
      const preview = c.last_message === '[Outgoing Message]' ? 'You replied' : (c.last_message || '[Media]');
      const initial = (c.profile_name || c.contact || '?').trim()[0].toUpperCase();
      const adBadge = c.has_tracking ? '<span class="ad-pill"><i class="fa-brands fa-meta"></i> Ads</span>' : '';
      const reason = c.triage_fresh && c.triage_reason ? `<div class="conv-reason">${escapeHTML(c.triage_reason)}</div>` : '';

      item.innerHTML = `
        <div class="conv-avatar ${isIncoming ? 'incoming-indicator' : ''}">
          ${escapeHTML(initial)}
        </div>
        <div class="conv-info">
          <div class="conv-header-line">
            <span class="conv-name">${formatPhoneDisplay(c.contact)}</span>
            <span class="conv-time">${formatRelativeTime(c.last_timestamp)}</span>
          </div>
          <div class="conv-subline">
            <span class="conv-preview">${dirIcon} ${escapeHTML(preview)}</span>
            <div class="conv-badges">
              ${adBadge}
              ${triagePill(c)}
            </div>
          </div>
          ${reason}
        </div>
      `;
      el.convList.appendChild(item);
    });

    if (preserveScroll && prevScroll > 0) {
      el.convList.scrollTop = prevScroll;
    }
  }

  function renderTriageBar(c) {
    if (!el.chatTriageBar) return;
    const hidden = isHidden(c);
    el.btnMarkDone.style.display = hidden ? 'none' : 'flex';
    el.btnShowAgain.style.display = hidden ? 'flex' : 'none';
    if (!c.triage_fresh) {
      el.chatTriageBar.className = 'triage-bar bar-checking';
      el.chatTriageBar.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Not checked yet since the last message';
      return;
    }
    const label = STATUS_LABELS[c.triage_status] || c.triage_status;
    const by = c.triage_method === 'manual' ? ' (by an agent)' : '';
    el.chatTriageBar.className = `triage-bar ${hidden ? 'bar-hidden' : c.triage_status === 'NEEDS_REPLY' ? 'bar-unanswered' : 'bar-open'}`;
    el.chatTriageBar.innerHTML = `<i class="fa-solid ${hidden ? 'fa-eye-slash' : 'fa-circle-info'}"></i> <strong>${escapeHTML(label)}${by}</strong> · ${escapeHTML(c.triage_reason || '')}`;
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
    } catch (e) {
      alert(`Could not save: ${e.message || e}`);
    } finally {
      btn.disabled = false;
    }
  }

  async function selectConversation(c) {
    state.activeContact = c.contact;
    state.activeConversationData = c;

    el.chatEmptyState.style.display = 'none';
    el.chatActiveView.style.display = 'flex';

    el.chatPhone.textContent = formatPhoneDisplay(c.contact);
    el.chatProfileName.textContent = c.profile_name || 'BSB Contact';
    el.chatWaLink.href = `https://web.whatsapp.com/send?phone=${normalizePhone(c.contact)}`;
    renderTriageBar(c);

    if (el.chatAdBanner) {
      if (c.has_tracking) {
        el.chatAdBanner.style.display = 'flex';
        el.chatAdBanner.innerHTML = `<i class="fa-brands fa-meta"></i> Meta Ad Lead (ID: ${escapeHTML(c.ad_id || 'Active')})`;
      } else {
        el.chatAdBanner.style.display = 'none';
      }
    }

    updateActiveConversationHighlight(c.contact); // In-place highlight without touching scroll position

    el.chatMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 40px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading conversation...</div>';
    try {
      const { data } = await window.supabaseClient
        .from('bsb_messages')
        .select('*')
        .eq('contact', c.contact)
        .order('timestamp', { ascending: false })
        .limit(100);
      if (state.activeContact === c.contact) renderChatMessages((data || []).reverse());
    } catch (e) {
      el.chatMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 40px;">Failed to load messages.</div>';
    }
  }

  function renderChatMessages(messages) {
    el.chatMessagesContainer.innerHTML = '';
    messages.forEach(msg => {
      const isIncoming = String(msg.direction).toLowerCase() === 'incoming';
      const msgRow = document.createElement('div');
      msgRow.className = `chat-msg ${isIncoming ? 'incoming' : 'outgoing'}`;

      let mediaHtml = '';
      const isAudio = (msg.media_type && msg.media_type.toLowerCase().includes('audio')) ||
                      (msg.message && (msg.message.includes('🎤') || msg.message.toLowerCase().includes('voice message')));
      const isImage = (msg.media_type && msg.media_type.toLowerCase().includes('image')) ||
                      (msg.media_url && (msg.media_url.endsWith('.jpg') || msg.media_url.endsWith('.jpeg') || msg.media_url.endsWith('.png')));

      if (isAudio && msg.chat_id) {
        const mUrl = resolveMediaUrl(msg.chat_id, 'audio', msg.media_url);
        mediaHtml = `
          <div class="voice-note-card">
            <div class="voice-note-header">
              <span><i class="fa-solid fa-microphone-lines"></i> Voice Note</span>
            </div>
            <audio controls class="voice-note-audio" preload="none" src="${mUrl}"></audio>
          </div>
        `;
      } else if (isImage && msg.chat_id) {
        const mUrl = resolveMediaUrl(msg.chat_id, 'image', msg.media_url);
        mediaHtml = `
          <div class="chat-media-image-wrap">
            <a href="${mUrl}" target="_blank" rel="noopener noreferrer">
              <img class="chat-media-img" src="${mUrl}" loading="lazy" alt="Image" />
            </a>
          </div>
        `;
      }

      const notSynced = !isIncoming && msg.message === '[Outgoing Message]';
      const textHtml = notSynced
        ? '<div class="msg-text msg-not-synced">Message text not synced from BSB yet</div>'
        : (msg.message ? `<div class="msg-text">${escapeHTML(msg.message)}</div>` : '');

      msgRow.innerHTML = `
        <div class="msg-bubble">
          ${mediaHtml}
          ${textHtml}
        </div>
        <div class="msg-meta">
          <span>${formatMessageTime(msg.timestamp)}</span>
          ${!isIncoming ? '<i class="fa-solid fa-check-double msg-status-icon msg-status-read"></i>' : ''}
        </div>
      `;
      el.chatMessagesContainer.appendChild(msgRow);
    });

    el.chatMessagesContainer.scrollTop = el.chatMessagesContainer.scrollHeight;
  }

  async function sendDirectChatMessage() {
    if (!state.activeContact || !el.chatTextarea.value.trim()) return;
    const text = el.chatTextarea.value.trim();
    const dest = normalizePhone(state.activeContact);

    el.btnSend.disabled = true;
    el.sendStatusLine.textContent = "Sending via BestSMSBulk...";

    try {
      const resp = await fetch(window.BSB_CONFIG.api_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: window.BSB_CONFIG.api_key,
          api_secret: window.BSB_CONFIG.api_secret,
          destination: dest,
          message: text
        })
      });
      const resJson = await resp.json().catch(() => ({ raw: 'Non-JSON' }));
      const isSuccess = resp.status === 200 && resJson.status !== 'error' && resJson.success !== false;

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
          console.warn('[SEND_QUEUE INSERT ERROR]', dbErr);
        }
      }

      if (isSuccess) {
        el.chatTextarea.value = '';
        el.sendStatusLine.textContent = "✓ Message sent successfully!";

        const msgRow = document.createElement('div');
        msgRow.className = 'chat-msg outgoing';
        msgRow.innerHTML = `
          <div class="msg-bubble">
            <div class="msg-text">${escapeHTML(text)}</div>
          </div>
          <div class="msg-meta">
            <span>Just now</span>
            <i class="fa-solid fa-check msg-status-icon"></i>
          </div>
        `;
        el.chatMessagesContainer.appendChild(msgRow);
        el.chatMessagesContainer.scrollTop = el.chatMessagesContainer.scrollHeight;

        // The chat leaves the list now and comes back after 2h only if it still needs action
        state.conversations = state.conversations.filter(c => normalizePhone(c.contact) !== dest);
        filterAndRenderConversations();
      } else {
        el.sendStatusLine.textContent = `Error: ${resJson.message || JSON.stringify(resJson)}`;
      }
    } catch (e) {
      el.sendStatusLine.textContent = `Network error: ${e.message}`;
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
      await refreshInbox();
      el.syncBtn.classList.remove('spinning');
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

        const confirmed = confirm(
          `Ingest BSB chat export "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB) into bsb_messages?\n\nAll messages will be safely merged and deduplicated by chat_id.`
        );
        if (!confirmed) {
          followupBackupInput.value = '';
          return;
        }

        const originalText = btnIngestBackup.innerHTML;
        btnIngestBackup.disabled = true;
        btnIngestBackup.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Ingesting...`;

        try {
          const session = await window.supabaseClient.auth.getSession();
          const token = session.data?.session?.access_token || window.SUPABASE_ANON_KEY;

          const formData = new FormData();
          formData.append('file', file);

          const resp = await fetch(`${window.SUPABASE_URL}/functions/v1/ingest_backup`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`
            },
            body: formData
          });

          const data = await resp.json();
          if (!resp.ok || data.error) {
            throw new Error(data.error || 'Failed to ingest backup file');
          }

          alert(data.message || `Ingested successfully! ${data.inserted || 0} new, ${data.updated || 0} updated.`);
          refreshInbox();
        } catch (err) {
          console.error('[ingest_backup error]', err);
          alert(`Error ingesting backup: ${err.message}`);
        } finally {
          btnIngestBackup.disabled = false;
          btnIngestBackup.innerHTML = originalText;
          followupBackupInput.value = '';
        }
      });
    }

    if (el.btnMarkDone) el.btnMarkDone.addEventListener('click', () => setManualVerdict('HIDE'));
    if (el.btnShowAgain) el.btnShowAgain.addEventListener('click', () => setManualVerdict('SHOW'));

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

  document.addEventListener('DOMContentLoaded', () => {
    initDOMElements();
    initEventListeners();
    checkAuth();
  });

})();
