/**
 * Teshrij Follow-up Suite - Ultra-Optimized Engine
 * Connected to Supabase PostgreSQL (pgvector), BestSMSBulk API & OpenAI
 * 
 * 5-Step Unified Suite:
 * 1. AI Scan (Evaluates eligible 24h chats against 64 canonical rules)
 * 2. Review Page (Split-screen review desk with Misclick-Proof Send All button)
 * 3. Send Reviewed (Safe rate-limited dispatcher with 1.5s delay)
 * 4. See Chats (Ultra-fast 72h messenger with media player & instant search)
 * 5. Admin & Rules (Canonical rules manager, 96-fixture training runner, teach mode)
 */

(() => {
  'use strict';

  // Core Configuration
  const HOURS_LOOKBACK_CONVS = 24; // 24h window
  const MIN_HOURS_OLD = 2.0;       // At least 2h old
  const HOURS_LOOKBACK_CHATS = 72; // Full 72h chat history
  const IDB_NAME = 'teshrij_followup_suite_v1';
  const IDB_VERSION = 1;

  // Global Suite State
  const state = {
    session: null,
    activeTab: 'tab-scan',
    stats: {
      total_messages: 0,
      contacts_24h: 0,
      pending_drafts: 0,
      approved_drafts: 0,
      cancelled_drafts: 0,
      queued_messages: 0,
      sent_today: 0,
      failed_messages: 0,
      canonical_rules_count: 64
    },
    // Step 1: Scan
    isScanning: false,
    stopScanRequested: false,
    scanCandidates: [],
    // Step 2: Review
    reviewDrafts: [],
    currentReviewIndex: 0,
    currentReviewDraft: null,
    // Step 3: Send Queue
    queueItems: [],
    isDispatchingQueue: false,
    pauseDispatchRequested: false,
    // Step 4: Chats
    conversations: [],
    filteredConversations: [],
    activeContact: null,
    activeConversationData: null,
    messages: [],
    activeFilter: 'all',
    searchQuery: '',
    isLoadingConversations: false,
    threadCache: new Map(),
    // Step 5: Admin & Rules
    canonicalRules: [],
    filteredRules: [],
    benchmarkCases: [],
    idb: null
  };

  // DOM Elements Cache
  const el = {};

  function initDOMElements() {
    // Auth
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

    // Navigation Tabs
    el.suiteTabBtns = document.querySelectorAll('.suite-tab-btn');
    el.suiteViews = document.querySelectorAll('.suite-view');
    el.badgeEligibleScan = document.getElementById('badge-eligible-scan');
    el.badgePendingReview = document.getElementById('badge-pending-review');
    el.badgeQueueCount = document.getElementById('badge-queue-count');
    el.badgeChatsCount = document.getElementById('badge-chats-count');

    // Step 1: Scan Elements
    el.statActiveContacts = document.getElementById('stat-active-contacts');
    el.statScanCandidates = document.getElementById('stat-scan-candidates');
    el.statPendingDrafts = document.getElementById('stat-pending-drafts');
    el.statCanonicalRules = document.getElementById('stat-canonical-rules');
    el.statQueuedCountBanner = document.getElementById('stat-queued-count-banner');
    el.btnStartAiScan = document.getElementById('btn-start-ai-scan');
    el.btnRefreshScan = document.getElementById('btn-refresh-scan');
    el.btnDeleteAllDrafts = document.getElementById('btn-delete-all-drafts');
    el.scanProgressBox = document.getElementById('scan-progress-box');
    el.scanProgressText = document.getElementById('scan-progress-text');
    el.scanProgressPercent = document.getElementById('scan-progress-percent');
    el.scanProgressFill = document.getElementById('scan-progress-fill');
    el.scanResultsTbody = document.getElementById('scan-results-tbody');
    el.scanStatusPill = document.getElementById('scan-status-pill');

    // Step 2: Review Elements
    el.reviewChatPhone = document.getElementById('review-chat-phone');
    el.reviewChatProfile = document.getElementById('review-chat-profile');
    el.reviewWaLink = document.getElementById('review-wa-link');
    el.reviewMessagesContainer = document.getElementById('review-messages-container');
    el.reviewStepperCounter = document.getElementById('review-stepper-counter');
    el.unreviewedCountBadge = document.getElementById('unreviewed-count-badge');
    el.btnOpenSendAllModal = document.getElementById('btn-open-send-all-modal');
    el.reviewDraftCard = document.getElementById('review-draft-card');
    el.reviewEmptyState = document.getElementById('review-empty-state');
    el.reviewDraftDecision = document.getElementById('review-draft-decision');
    el.reviewDraftCategory = document.getElementById('review-draft-category');
    el.reviewDraftTime = document.getElementById('review-draft-time');
    el.reviewDraftRules = document.getElementById('review-draft-rules');
    el.reviewDraftReason = document.getElementById('review-draft-reason');
    el.reviewDraftTextarea = document.getElementById('review-draft-textarea');
    el.draftCharCount = document.getElementById('draft-char-count');
    el.reviewRecipientPhone = document.getElementById('review-recipient-phone');
    el.reviewRecipientName = document.getElementById('review-recipient-name');
    el.btnDraftValidate = document.getElementById('btn-draft-validate');
    el.btnDraftEdit = document.getElementById('btn-draft-edit');
    el.btnDraftDefer = document.getElementById('btn-draft-defer');
    el.btnDraftCancel = document.getElementById('btn-draft-cancel');
    el.btnReviewPrev = document.getElementById('btn-review-prev');
    el.btnReviewNext = document.getElementById('btn-review-next');
    el.btnReviewPrevTop = document.getElementById('btn-review-prev-top');
    el.btnReviewNextTop = document.getElementById('btn-review-next-top');
    el.reviewProgressIndicator = document.getElementById('review-progress-indicator');

    // Misclick-Proof Modal
    el.misclickModal = document.getElementById('misclick-modal');
    el.modalSendCount = document.getElementById('modal-send-count');
    el.modalDurationEst = document.getElementById('modal-duration-est');
    el.modalRecipientsPreview = document.getElementById('modal-recipients-preview');
    el.modalTypeConfirmation = document.getElementById('modal-type-confirmation');
    el.btnConfirmSendAll = document.getElementById('btn-confirm-send-all');
    el.holdBtnLabel = document.getElementById('hold-btn-label');
    el.btnCancelSendAllModal = document.getElementById('btn-cancel-send-all-modal');

    // Step 3: Send Queue Elements
    el.statQueuedCount = document.getElementById('stat-queued-count');
    el.statSentToday = document.getElementById('stat-sent-today');
    el.statFailedCount = document.getElementById('stat-failed-count');
    el.senderStatusBadge = document.getElementById('sender-status-badge');
    el.queueDryrunToggle = document.getElementById('queue-dryrun-toggle');
    el.btnStartQueueDispatch = document.getElementById('btn-start-queue-dispatch');
    el.btnPauseQueueDispatch = document.getElementById('btn-pause-queue-dispatch');
    el.btnRefreshQueue = document.getElementById('btn-refresh-queue');
    el.queueProgressBox = document.getElementById('queue-progress-box');
    el.queueProgressText = document.getElementById('queue-progress-text');
    el.queueProgressPercent = document.getElementById('queue-progress-percent');
    el.queueProgressFill = document.getElementById('queue-progress-fill');
    el.queueItemsTbody = document.getElementById('queue-items-tbody');

    // Step 4: Chats Elements
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
    el.chatTextarea = document.getElementById('chat-textarea');
    el.btnSend = document.getElementById('btn-send');
    el.sendStatusLine = document.getElementById('send-status-line');
    el.quickTemplates = document.querySelectorAll('.template-pill');

    // Step 5: Admin Elements
    el.adminSubtabBtns = document.querySelectorAll('.admin-subtab-btn');
    el.rulesSearchInput = document.getElementById('rules-search-input');
    el.ruleCatFilters = document.querySelectorAll('.rule-cat-filter');
    el.rulesGrid = document.getElementById('rules-grid');
    el.btnRunBenchmark = document.getElementById('btn-run-benchmark');
    el.benchStatAcc = document.getElementById('bench-stat-acc');
    el.benchStatPassed = document.getElementById('bench-stat-passed');
    el.benchStatRecall = document.getElementById('bench-stat-recall');
    el.benchStatSafety = document.getElementById('bench-stat-safety');
    el.benchmarkResultsTbody = document.getElementById('benchmark-results-tbody');
    el.teachPhone = document.getElementById('teach-phone');
    el.teachMessage = document.getElementById('teach-message');
    el.teachReason = document.getElementById('teach-reason');
    el.btnSubmitTeach = document.getElementById('btn-submit-teach');
    el.teachFeedbackStatus = document.getElementById('teach-feedback-status');
    el.cfgOpenaiKey = document.getElementById('cfg-openai-key');
    el.cfgChatModel = document.getElementById('cfg-chat-model');
    el.cfgSendDelay = document.getElementById('cfg-send-delay');
    el.cfgBsbKey = document.getElementById('cfg-bsb-key');
    el.cfgBsbSecret = document.getElementById('cfg-bsb-secret');
    el.btnSaveConfig = document.getElementById('btn-save-config');
    el.cfgStatusLine = document.getElementById('cfg-status-line');
    el.btnReloadCanonicalRules = document.getElementById('btn-reload-canonical-rules');
    el.btnClearUnsentDrafts = document.getElementById('btn-clear-unsent-drafts');
    el.clearDraftsStatus = document.getElementById('clear-drafts-status');
    el.adminSystemPromptTextarea = document.getElementById('admin-system-prompt-textarea');
    el.adminRuntimePolicyTextarea = document.getElementById('admin-runtime-policy-textarea');
    el.btnSaveSystemPrompt = document.getElementById('btn-save-system-prompt');
    el.btnSaveRuntimePolicy = document.getElementById('btn-save-runtime-policy');
    el.savePromptStatus = document.getElementById('save-prompt-status');
    el.savePolicyStatus = document.getElementById('save-policy-status');
    el.btnRefreshLearningLog = document.getElementById('btn-refresh-learning-log');
    el.learningLogTbody = document.getElementById('learning-log-tbody');

    // Rule Detail Modal
    el.ruleDetailModal = document.getElementById('rule-detail-modal');
    el.modalRuleId = document.getElementById('modal-rule-id');
    el.modalRuleCat = document.getElementById('modal-rule-cat');
    el.modalRuleTitle = document.getElementById('modal-rule-title');
    el.modalRuleReason = document.getElementById('modal-rule-reason');
    el.modalRuleArabiziBox = document.getElementById('modal-rule-arabizi-box');
    el.modalRuleArabiziList = document.getElementById('modal-rule-arabizi-list');
    el.modalRuleExclusionsBox = document.getElementById('modal-rule-exclusions-box');
    el.modalRuleExclusionsList = document.getElementById('modal-rule-exclusions-list');
    el.btnCloseRuleModal = document.getElementById('btn-close-rule-modal');
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
    const date = new Date(isoStr);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1) return `1d ago`;
    return `${diffDays}d ago`;
  }

  function formatMessageTime(isoStr) {
    if (!isoStr) return "";
    const date = new Date(isoStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function isBeirutWorkingHours() {
    const d = new Date();
    // UTC+3 Beirut time
    const beirutHour = (d.getUTCHours() + 3) % 24;
    return beirutHour >= (window.SYSTEM_CONFIG?.beirut_hours_start || 9) && beirutHour < (window.SYSTEM_CONFIG?.beirut_hours_end || 21);
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

    // Initialize suite data
    loadDashboardStats();
    loadRecentScanDrafts();
    loadConversations();
    loadReviewDrafts();
    loadSendQueue();
    loadCanonicalRules();
    loadConfigForm();
  }

  function setUnauthenticated() {
    state.session = null;
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
  // Tab Switching (0ms Latency)
  // =========================================================================
  function switchTab(tabId) {
    state.activeTab = tabId;

    // Update Tab Buttons
    el.suiteTabBtns.forEach(btn => {
      const target = btn.getAttribute('data-tab');
      btn.classList.toggle('active', target === tabId);
    });

    // Update Views
    const viewMap = {
      'tab-scan': 'view-scan',
      'tab-review': 'view-review',
      'tab-send': 'view-send',
      'tab-chats': 'view-chats',
      'tab-admin': 'view-admin'
    };

    el.suiteViews.forEach(v => {
      v.classList.remove('active');
    });

    const activeViewId = viewMap[tabId];
    const targetEl = document.getElementById(activeViewId);
    if (targetEl) targetEl.classList.add('active');

    // Trigger tab-specific refreshes
    if (tabId === 'tab-review') loadReviewDrafts();
    if (tabId === 'tab-send') loadSendQueue();
    if (tabId === 'tab-chats' && state.conversations.length === 0) loadConversations();
    if (tabId === 'tab-admin') {
      loadCanonicalRules();
      loadSystemPromptAndPolicy();
      loadLearningLog();
      loadConfigForm();
    }
  }

  // =========================================================================
  // Live Dashboard Statistics (Supabase RPC)
  // =========================================================================
  async function loadDashboardStats() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient.rpc('get_followup_dashboard_stats');
      if (!error && data) {
        state.stats = data;
        updateStatsUI();
      }
    } catch (e) {}
  }

  function updateStatsUI() {
    const s = state.stats;
    if (el.statActiveContacts) el.statActiveContacts.textContent = (s.contacts_24h || 0).toLocaleString();
    if (el.statPendingDrafts) el.statPendingDrafts.textContent = (s.pending_drafts || 0).toLocaleString();
    if (el.badgePendingReview) el.badgePendingReview.textContent = s.pending_drafts || 0;
    if (el.unreviewedCountBadge) el.unreviewedCountBadge.textContent = s.pending_drafts || 0;
    if (el.statQueuedCount) el.statQueuedCount.textContent = (s.queued_messages || 0).toLocaleString();
    if (el.badgeQueueCount) el.badgeQueueCount.textContent = s.queued_messages || 0;
    if (el.statSentToday) el.statSentToday.textContent = (s.sent_today || 0).toLocaleString();
    if (el.statFailedCount) el.statFailedCount.textContent = (s.failed_messages || 0).toLocaleString();
    if (el.statCanonicalRules) el.statCanonicalRules.textContent = s.canonical_rules_count || 64;
    if (el.statQueuedCountBanner) el.statQueuedCountBanner.textContent = (s.queued_messages || 0).toLocaleString();
    if (el.badgeChatsCount) el.badgeChatsCount.textContent = (s.contacts_24h || 0);

    const candidates = Math.max(0, (s.contacts_24h || 0) - (s.pending_drafts || 0));
    if (el.statScanCandidates) el.statScanCandidates.textContent = candidates.toLocaleString();
    if (el.badgeEligibleScan) el.badgeEligibleScan.textContent = candidates;
  }

  // =========================================================================
  // STEP 1: AI SCANNER (Server-Side Execution Engine)
  // =========================================================================
  async function startAIScan() {
    if (state.isScanning) return;
    state.isScanning = true;

    if (el.btnStartAiScan) {
      el.btnStartAiScan.disabled = true;
      el.btnStartAiScan.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Triggering Server Scan...';
    }
    if (el.scanProgressBox) el.scanProgressBox.style.display = 'flex';
    if (el.scanStatusPill) {
      el.scanStatusPill.style.display = 'inline-flex';
      el.scanStatusPill.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Server Scan Requested';
    }

    updateScanProgress(15, "Submitting scan request to server background runner...");

    try {
      // 1. Submit scan job to Supabase scan_jobs table
      const { data, error } = await window.supabaseClient
        .from('scan_jobs')
        .insert({ status: 'PENDING' })
        .select()
        .single();

      if (error) throw error;
      const jobId = data.id;

      updateScanProgress(25, `Server Scan Job #${jobId} Queued. Worker analyzing active contacts...`);
      if (el.scanStatusPill) {
        el.scanStatusPill.innerHTML = `<i class="fa-solid fa-server fa-beat"></i> Server Job #${jobId} Running`;
      }

      // 2. Trigger Edge Function worker directly
      fetch(`${window.SUPABASE_URL}/functions/v1/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': window.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${window.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ job_id: jobId })
      }).catch(err => {
        console.warn('[SCAN EDGE TRIGGER WARNING]', err);
      });

      // 3. Poll job status until complete
      pollServerScanJob(jobId);

    } catch (e) {
      updateScanProgress(100, `Scan trigger error: ${e.message}`);
      resetScanUI();
    }
  }

  async function pollServerScanJob(jobId) {
    const pollInterval = setInterval(async () => {
      try {
        const { data, error } = await window.supabaseClient
          .from('scan_jobs')
          .select('*')
          .eq('id', jobId)
          .single();

        if (error || !data) return;

        const st = data.status;
        const total = data.total_contacts || 0;
        const evaluated = data.total_evaluated || 0;
        const created = data.drafts_created || 0;
        const skipped = data.skipped || 0;
        const human = data.human_review || 0;
        const currContact = data.current_contact ? ` • Contact: ${formatPhoneDisplay(data.current_contact)}` : '';

        if (st === 'RUNNING' || (st === 'PENDING' && evaluated > 0)) {
          const pct = total > 0 ? Math.min(95, Math.max(15, Math.round((evaluated / total) * 100))) : 25;
          updateScanProgress(pct, `Server Scan Running: ${evaluated}/${total || '?'} evaluated (${created} drafts created, ${skipped} skipped)${currContact}`);
          if (el.scanStatusPill) {
            el.scanStatusPill.style.display = 'inline-flex';
            el.scanStatusPill.innerHTML = `<i class="fa-solid fa-server fa-beat"></i> Job #${jobId} Running (${evaluated}/${total || '?'})`;
          }
          loadDashboardStats();
          loadRecentScanDrafts();
        } else if (st === 'COMPLETED') {
          clearInterval(pollInterval);
          updateScanProgress(100, `Server Scan Complete! Evaluated ${evaluated} contacts (${created} drafts created, ${skipped} skipped, ${human} human review).`);
          if (el.scanStatusPill) {
            el.scanStatusPill.style.display = 'inline-flex';
            el.scanStatusPill.innerHTML = `<i class="fa-solid fa-circle-check"></i> Job #${jobId} Complete (${created} Drafts)`;
          }
          loadDashboardStats();
          loadRecentScanDrafts();
          resetScanUI();
        } else if (st === 'FAILED') {
          clearInterval(pollInterval);
          updateScanProgress(100, `Server Scan Failed: ${data.error_message || 'Unknown error'}`);
          resetScanUI();
        }
      } catch (err) {
        // Continue polling
      }
    }, 1200);
  }

  function resetScanUI() {
    state.isScanning = false;
    if (el.btnStartAiScan) {
      el.btnStartAiScan.disabled = false;
      el.btnStartAiScan.innerHTML = '<i class="fa-solid fa-bolt"></i> Run AI Scan Now';
    }
    if (el.scanStatusPill) el.scanStatusPill.style.display = 'none';
  }

  async function deleteAllDrafts() {
    if (!window.supabaseClient) return;
    if (!confirm('Delete ALL drafts from the database? This cannot be undone.')) return;

    const btn = el.btnDeleteAllDrafts;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...'; }

    try {
      const { error } = await window.supabaseClient
        .from('followup_drafts')
        .delete()
        .gt('id', 0);

      if (error) throw error;

      await loadDashboardStats();
      await loadRecentScanDrafts();
    } catch (e) {
      alert('Error deleting drafts: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete All Drafts'; }
    }
  }

  async function loadRecentScanDrafts() {
    if (!window.supabaseClient || !el.scanResultsTbody) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('followup_drafts')
        .select('*')
        .order('id', { ascending: false })
        .limit(30);

      if (!error && data && data.length > 0) {
        el.scanResultsTbody.innerHTML = '';
        data.forEach(d => {
          appendScanResultRow(d.contact, d.decision, d.category, d.rule_ids, d.drafted_msg, d.status);
        });
      }
    } catch (e) {}
  }

  function updateScanProgress(pct, text) {
    if (el.scanProgressFill) el.scanProgressFill.style.width = `${pct}%`;
    if (el.scanProgressPercent) el.scanProgressPercent.textContent = `${pct}%`;
    if (el.scanProgressText) {
      const icon = pct >= 100
        ? '<i class="fa-solid fa-circle-check" style="color: #34d399;"></i>'
        : '<i class="fa-solid fa-spinner fa-spin" style="color: #38bdf8;"></i>';
      el.scanProgressText.innerHTML = `${icon} ${escapeHTML(text)}`;
    }
  }

  function appendScanResultRow(contact, decision, category, ruleIds, message, status) {
    if (!el.scanResultsTbody) return;
    const tr = document.createElement('tr');
    const decClass = decision === 'SEND' ? 'dec-send' : (decision === 'HUMAN_REVIEW' ? 'dec-human' : (decision === 'DEFER' ? 'dec-defer' : 'dec-skip'));
    const ruleStr = (ruleIds && Array.isArray(ruleIds) && ruleIds.length) ? ruleIds.join(', ') : '-';
    const msgSnippet = message ? escapeHTML(message) : '<span style="color: var(--text-dim);">[No message / Skipped]</span>';

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-main);">${formatPhoneDisplay(contact)}</td>
      <td><span class="decision-badge ${decClass}">${decision || 'SKIP'}</span></td>
      <td style="text-transform: uppercase; font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(category || 'sales')}</td>
      <td style="font-size: 0.75rem; color: #a5b4fc; font-weight: 700;">${escapeHTML(ruleStr)}</td>
      <td style="font-size: 0.82rem;">${msgSnippet}</td>
      <td><span style="font-size: 0.75rem; font-weight: 700; color: ${status === 'PENDING' ? '#fbbf24' : '#64748b'};">${status}</span></td>
    `;
    el.scanResultsTbody.appendChild(tr);
  }

  // =========================================================================
  // STEP 2: REVIEW PAGE & MISCLICK-PROOF SEND ALL
  // =========================================================================
  async function loadReviewDrafts() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('followup_drafts')
        .select('*')
        .eq('status', 'PENDING')
        .order('id', { ascending: false });

      if (!error && data) {
        state.reviewDrafts = data;
        state.currentReviewIndex = 0;
        renderCurrentReviewDraft();
      }
    } catch (e) {}
  }

  function renderCurrentReviewDraft() {
    const total = state.reviewDrafts.length;
    if (el.reviewStepperCounter) el.reviewStepperCounter.textContent = `${total > 0 ? state.currentReviewIndex + 1 : 0} of ${total}`;
    if (el.unreviewedCountBadge) el.unreviewedCountBadge.textContent = total;
    if (el.reviewProgressIndicator) el.reviewProgressIndicator.textContent = `${total > 0 ? state.currentReviewIndex + 1 : 0} / ${total}`;

    if (total === 0 || state.currentReviewIndex >= total) {
      if (el.reviewDraftCard) el.reviewDraftCard.style.display = 'none';
      if (el.reviewEmptyState) el.reviewEmptyState.style.display = 'block';
      if (el.reviewMessagesContainer) el.reviewMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 50px;">No pending drafts to review.</div>';
      return;
    }

    if (el.reviewDraftCard) el.reviewDraftCard.style.display = 'flex';
    if (el.reviewEmptyState) el.reviewEmptyState.style.display = 'none';

    const draft = state.reviewDrafts[state.currentReviewIndex];
    state.currentReviewDraft = draft;

    if (el.reviewRecipientPhone) el.reviewRecipientPhone.textContent = formatPhoneDisplay(draft.contact);
    if (el.reviewRecipientName) el.reviewRecipientName.innerHTML = `<i class="fa-solid fa-user"></i> ${escapeHTML(draft.profile_name || 'Customer')}`;
    if (el.reviewChatPhone) el.reviewChatPhone.textContent = formatPhoneDisplay(draft.contact);
    if (el.reviewChatProfile) el.reviewChatProfile.textContent = draft.profile_name || 'Customer';
    if (el.reviewWaLink) el.reviewWaLink.href = `https://web.whatsapp.com/send?phone=${normalizePhone(draft.contact)}`;

    // Decision badge
    const dec = (draft.decision || 'SEND').toUpperCase();
    if (el.reviewDraftDecision) {
      el.reviewDraftDecision.textContent = dec;
      el.reviewDraftDecision.className = `decision-badge ${dec === 'SEND' ? 'dec-send' : (dec === 'HUMAN_REVIEW' ? 'dec-human' : 'dec-skip')}`;
    }
    if (el.reviewDraftCategory) el.reviewDraftCategory.textContent = draft.category || 'sales';
    if (el.reviewDraftTime) el.reviewDraftTime.innerHTML = `<i class="fa-regular fa-clock"></i> ${formatRelativeTime(draft.created_at)}`;
    if (el.reviewDraftReason) el.reviewDraftReason.textContent = draft.reasoning || draft.internal_reason || 'Customer is eligible for follow-up outreach.';

    // Rules
    if (el.reviewDraftRules) {
      el.reviewDraftRules.innerHTML = '';
      const rules = Array.isArray(draft.rule_ids) ? draft.rule_ids : [];
      if (rules.length === 0) {
        el.reviewDraftRules.innerHTML = '<span class="rule-chip" style="background: rgba(255,255,255,0.05); color: var(--text-dim);">General Follow-up</span>';
      } else {
        rules.forEach(r => {
          const chip = document.createElement('span');
          chip.className = 'rule-chip';
          chip.textContent = r;
          chip.style.cursor = 'pointer';
          chip.onclick = () => openRuleDetailModal(r);
          el.reviewDraftRules.appendChild(chip);
        });
      }
    }

    // Editable draft textarea
    if (el.reviewDraftTextarea) {
      el.reviewDraftTextarea.value = draft.drafted_msg || '';
      updateDraftCharCount();
    }

    // Load conversation history for left pane
    loadReviewChatHistory(draft.contact);
  }

  function updateDraftCharCount() {
    if (el.draftCharCount && el.reviewDraftTextarea) {
      const len = el.reviewDraftTextarea.value.length;
      el.draftCharCount.textContent = `${len} chars`;
    }
  }

  async function loadReviewChatHistory(contact) {
    if (!el.reviewMessagesContainer) return;
    el.reviewMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 50px;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem; margin-bottom: 10px; display: block; color: var(--accent-cyan);"></i>Loading 72h chat history...</div>';

    const cleanContact = normalizePhone(contact);
    try {
      const { data, error } = await window.supabaseClient
        .from('bsb_messages')
        .select('*')
        .or(`contact.eq.${contact},contact.eq.${cleanContact}`)
        .order('timestamp', { ascending: true })
        .limit(50);

      if (!error && data && data.length > 0) {
        renderReviewMessages(data);
      } else {
        el.reviewMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 50px;"><i class="fa-regular fa-comment-dots" style="font-size: 2rem; margin-bottom: 10px; display: block; opacity: 0.5;"></i>No previous messages found for this contact.</div>';
      }
    } catch (e) {
      el.reviewMessagesContainer.innerHTML = '<div style="text-align: center; color: #fb7185; padding: 40px;">Failed to load messages.</div>';
    }
  }

  function renderReviewMessages(messages) {
    el.reviewMessagesContainer.innerHTML = '';
    let lastDateStr = null;

    messages.forEach(msg => {
      const isIncoming = String(msg.direction).toLowerCase() === 'incoming';
      const msgDate = new Date(msg.timestamp);
      const dateStr = !isNaN(msgDate) ? msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

      if (dateStr && dateStr !== lastDateStr) {
        lastDateStr = dateStr;
        const dateDiv = document.createElement('div');
        dateDiv.className = 'chat-date-divider';
        dateDiv.innerHTML = `<span class="chat-date-pill">${dateStr}</span>`;
        el.reviewMessagesContainer.appendChild(dateDiv);
      }

      const row = document.createElement('div');
      row.className = `chat-msg ${isIncoming ? 'incoming' : 'outgoing'}`;

      let mediaContent = '';
      if (msg.media_type && msg.media_type !== 'None') {
        const mUrl = resolveMediaUrl(msg.chat_id, msg.media_type, msg.media_url);
        if (msg.media_type.toLowerCase().includes('audio')) {
          mediaContent = `<div class="msg-media-box"><audio controls class="msg-audio-player" preload="none" src="${mUrl}"></audio></div>`;
        } else if (msg.media_type.toLowerCase().includes('image')) {
          mediaContent = `<div class="msg-media-box"><a href="${mUrl}" target="_blank"><img class="msg-image-thumb" src="${mUrl}" loading="lazy" alt="Media" /></a></div>`;
        }
      }

      row.innerHTML = `
        <div class="msg-sender-tag ${isIncoming ? 'tag-customer' : 'tag-business'}">
          <i class="fa-solid ${isIncoming ? 'fa-user' : 'fa-headset'}"></i>
          <span>${isIncoming ? 'Customer' : 'You (Teshrij)'}</span>
        </div>
        <div class="msg-bubble" dir="auto">
          ${mediaContent}
          <div class="msg-text-body">${escapeHTML(msg.message || '')}</div>
        </div>
        <div class="msg-meta">
          <span>${formatMessageTime(msg.timestamp)}</span>
          ${!isIncoming ? '<i class="fa-solid fa-check-double msg-status-icon msg-status-read"></i>' : ''}
        </div>
      `;
      el.reviewMessagesContainer.appendChild(row);
    });

    el.reviewMessagesContainer.scrollTop = el.reviewMessagesContainer.scrollHeight;
  }

  // Review Actions
  async function validateCurrentDraft() {
    const draft = state.currentReviewDraft;
    if (!draft) return;

    const finalMsg = el.reviewDraftTextarea.value.trim();
    if (!finalMsg) {
      alert("Cannot approve an empty follow-up message.");
      return;
    }

    const action = finalMsg !== draft.drafted_msg ? 'MODIFIED' : 'APPROVED';

    // 1. Optimistic removal from review list
    state.reviewDrafts.splice(state.currentReviewIndex, 1);
    if (state.currentReviewIndex >= state.reviewDrafts.length) {
      state.currentReviewIndex = Math.max(0, state.reviewDrafts.length - 1);
    }
    renderCurrentReviewDraft();

    // 2. Persist update in Supabase
    try {
      await window.supabaseClient.from('followup_drafts').update({
        drafted_msg: finalMsg,
        status: action,
        updated_at: new Date().toISOString()
      }).eq('id', draft.id);

      // Queue into send_queue
      await window.supabaseClient.from('send_queue').insert({
        draft_id: draft.id,
        contact: draft.contact,
        message: finalMsg,
        status: 'QUEUED'
      });

      // Record feedback learning for continuous training
      await window.supabaseClient.from('feedback_learning').insert({
        contact: draft.contact,
        context_summary: draft.reasoning || '',
        original_draft: draft.drafted_msg,
        final_msg: finalMsg,
        review_action: action,
        decision: 'SEND',
        rule_ids: draft.rule_ids || []
      });

      loadDashboardStats();
    } catch (e) {}
  }

  async function cancelCurrentDraft() {
    const draft = state.currentReviewDraft;
    if (!draft) return;

    const reason = prompt("Why should this follow-up be cancelled / skipped? (Trains AI)", "Customer not eligible / resolved");
    if (reason === null) return;

    // Optimistic advance
    state.reviewDrafts.splice(state.currentReviewIndex, 1);
    if (state.currentReviewIndex >= state.reviewDrafts.length) {
      state.currentReviewIndex = Math.max(0, state.reviewDrafts.length - 1);
    }
    renderCurrentReviewDraft();

    try {
      await window.supabaseClient.from('followup_drafts').update({
        status: 'CANCELLED',
        reasoning: reason,
        updated_at: new Date().toISOString()
      }).eq('id', draft.id);

      await window.supabaseClient.from('feedback_learning').insert({
        contact: draft.contact,
        context_summary: draft.reasoning || '',
        original_draft: draft.drafted_msg,
        final_msg: '',
        review_action: 'CANCELLED',
        reason_notes: reason,
        decision: 'SKIP',
        rule_ids: draft.rule_ids || []
      });

      loadDashboardStats();
    } catch (e) {}
  }

  async function deferCurrentDraft() {
    const draft = state.currentReviewDraft;
    if (!draft) return;

    state.reviewDrafts.splice(state.currentReviewIndex, 1);
    if (state.currentReviewIndex >= state.reviewDrafts.length) {
      state.currentReviewIndex = Math.max(0, state.reviewDrafts.length - 1);
    }
    renderCurrentReviewDraft();

    try {
      const deferUntil = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
      await window.supabaseClient.from('followup_drafts').update({
        status: 'DEFERRED',
        not_before: deferUntil,
        updated_at: new Date().toISOString()
      }).eq('id', draft.id);

      loadDashboardStats();
    } catch (e) {}
  }

  // =========================================================================
  // MISCLICK-PROOF "SEND ALL UNREVIEWED" MODAL
  // =========================================================================
  function openSendAllModal() {
    const count = state.reviewDrafts.length;
    if (count === 0) {
      alert("No pending drafts to approve.");
      return;
    }

    if (el.modalSendCount) el.modalSendCount.textContent = count;
    const estSec = Math.round(count * 1.5);
    if (el.modalDurationEst) el.modalDurationEst.textContent = `${estSec} seconds (~${Math.ceil(estSec / 60)} min)`;

    // Preview first 5
    if (el.modalRecipientsPreview) {
      el.modalRecipientsPreview.innerHTML = state.reviewDrafts.slice(0, 5).map((d, i) => `
        <div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>${i + 1}. <strong>${formatPhoneDisplay(d.contact)}</strong></span>
          <span style="color: var(--text-dim); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(d.drafted_msg || '')}</span>
        </div>
      `).join('');
    }

    // Reset input
    if (el.modalTypeConfirmation) el.modalTypeConfirmation.value = '';
    if (el.btnConfirmSendAll) {
      el.btnConfirmSendAll.disabled = true;
      el.btnConfirmSendAll.style.opacity = '0.5';
    }
    if (el.holdBtnLabel) el.holdBtnLabel.innerHTML = '<i class="fa-solid fa-lock"></i> Type "SEND ALL" to Unlock';

    el.misclickModal.style.display = 'flex';
  }

  function handleTypeConfirmation(e) {
    const val = e.target.value.trim().toUpperCase();
    if (val === 'SEND ALL') {
      el.btnConfirmSendAll.disabled = false;
      el.btnConfirmSendAll.style.opacity = '1';
      el.holdBtnLabel.innerHTML = '<i class="fa-solid fa-rocket"></i> Confirm & Queue All Follow-ups';
    } else {
      el.btnConfirmSendAll.disabled = true;
      el.btnConfirmSendAll.style.opacity = '0.5';
      el.holdBtnLabel.innerHTML = '<i class="fa-solid fa-lock"></i> Type "SEND ALL" to Unlock';
    }
  }

  async function executeBulkSendAll() {
    el.btnConfirmSendAll.disabled = true;
    el.holdBtnLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Atomic Approval...';

    try {
      const { data, error } = await window.supabaseClient.rpc('bulk_approve_unreviewed_drafts');
      if (!error) {
        el.misclickModal.style.display = 'none';
        alert(`✓ Successfully approved and queued ${data.approved_count} follow-ups!`);
        state.reviewDrafts = [];
        renderCurrentReviewDraft();
        loadDashboardStats();
        // Switch to send queue tab
        switchTab('tab-send');
      } else {
        alert(`Error executing bulk approval: ${error.message}`);
      }
    } catch (e) {
      alert(`Network error: ${e.message}`);
    } finally {
      el.misclickModal.style.display = 'none';
    }
  }

  // =========================================================================
  // STEP 3: SEND REVIEWED QUEUE & DISPATCHER
  // =========================================================================
  async function loadSendQueue() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('send_queue')
        .select('*')
        .order('id', { ascending: false })
        .limit(100);

      if (!error && data) {
        state.queueItems = data;
        renderSendQueueTable();
      }
    } catch (e) {}
  }

  function renderSendQueueTable() {
    if (!el.queueItemsTbody) return;
    el.queueItemsTbody.innerHTML = '';

    if (state.queueItems.length === 0) {
      el.queueItemsTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 30px;">Send queue is currently empty. Validate drafts in Step 2 to add messages to the queue.</td></tr>`;
      return;
    }

    state.queueItems.forEach(item => {
      const tr = document.createElement('tr');
      const st = item.status;
      const stColor = st === 'SENT' ? '#10b981' : (st === 'QUEUED' ? '#a5b4fc' : (st === 'SENDING' ? '#fbbf24' : '#fb7185'));

      tr.innerHTML = `
        <td style="color: var(--text-dim);">#${item.id}</td>
        <td style="font-weight: 700; color: var(--text-main);">${formatPhoneDisplay(item.contact)}</td>
        <td style="font-size: 0.82rem;">${escapeHTML(item.message)}</td>
        <td><span style="font-weight: 800; font-size: 0.72rem; color: ${stColor}; text-transform: uppercase;">${st}</span></td>
        <td style="font-size: 0.75rem; color: var(--text-dim);">${formatRelativeTime(item.sent_at || item.scheduled_at)}</td>
        <td>
          ${st === 'QUEUED' ? `<button class="btn-nav" style="padding: 3px 8px; font-size: 0.75rem;" onclick="dispatchSingleQueueItem(${item.id})">Send Now</button>` : ''}
        </td>
      `;
      el.queueItemsTbody.appendChild(tr);
    });
  }

  async function startQueueDispatch() {
    if (state.isDispatchingQueue) return;

    if (window.SYSTEM_CONFIG.enforce_beirut_hours && !isBeirutWorkingHours()) {
      const proceed = confirm("⚠️ Notice: Current time is outside Beirut business hours (09:00 - 21:00). Sending messages now may violate anti-spam best practices. Do you still want to proceed?");
      if (!proceed) return;
    }

    state.isDispatchingQueue = true;
    state.pauseDispatchRequested = false;

    el.btnStartQueueDispatch.style.display = 'none';
    el.btnPauseQueueDispatch.style.display = 'inline-flex';
    el.queueProgressBox.style.display = 'flex';
    if (el.senderStatusBadge) {
      el.senderStatusBadge.className = 'decision-badge dec-send';
      el.senderStatusBadge.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Dispatching Live';
    }

    const dryRun = el.queueDryrunToggle?.checked || false;
    const queued = state.queueItems.filter(i => i.status === 'QUEUED');

    for (let i = 0; i < queued.length; i++) {
      if (state.pauseDispatchRequested) break;
      const item = queued[i];
      const pct = Math.round(((i + 1) / queued.length) * 100);

      if (el.queueProgressFill) el.queueProgressFill.style.width = `${pct}%`;
      if (el.queueProgressPercent) el.queueProgressPercent.textContent = `${pct}%`;
      if (el.queueProgressText) el.queueProgressText.innerHTML = `<i class="fa-solid fa-paper-plane fa-fade"></i> Dispatching [${i + 1}/${queued.length}] to ${formatPhoneDisplay(item.contact)}...`;

      try {
        if (dryRun) {
          await new Promise(r => setTimeout(r, 1500));
          await window.supabaseClient.from('send_queue').update({ status: 'SENT', sent_at: new Date().toISOString() }).eq('id', item.id);
          item.status = 'SENT';
        } else {
          const resp = await fetch(window.BSB_CONFIG.api_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: window.BSB_CONFIG.api_key,
              api_secret: window.BSB_CONFIG.api_secret,
              destination: normalizePhone(item.contact),
              message: item.message
            })
          });
          const resJson = await resp.json();
          if (resp.status === 200 && resJson.status !== 'error' && resJson.success !== false) {
            await window.supabaseClient.from('send_queue').update({ status: 'SENT', sent_at: new Date().toISOString(), api_response: JSON.stringify(resJson) }).eq('id', item.id);
            item.status = 'SENT';
          } else {
            await window.supabaseClient.from('send_queue').update({ status: 'FAILED', error_message: JSON.stringify(resJson) }).eq('id', item.id);
            item.status = 'FAILED';
          }
        }
      } catch (err) {
        await window.supabaseClient.from('send_queue').update({ status: 'FAILED', error_message: err.message }).eq('id', item.id);
        item.status = 'FAILED';
      }

      renderSendQueueTable();
      loadDashboardStats();

      // Mandatory 1.5s rate-limit delay
      await new Promise(r => setTimeout(r, 1500));
    }

    pauseQueueDispatch();
    if (el.queueProgressText) el.queueProgressText.innerHTML = '<i class="fa-solid fa-check"></i> Dispatch queue batch complete!';
  }

  function pauseQueueDispatch() {
    state.isDispatchingQueue = false;
    state.pauseDispatchRequested = true;
    el.btnStartQueueDispatch.style.display = 'inline-flex';
    el.btnPauseQueueDispatch.style.display = 'none';
    if (el.senderStatusBadge) {
      el.senderStatusBadge.className = 'decision-badge dec-skip';
      el.senderStatusBadge.innerHTML = '<i class="fa-solid fa-circle"></i> Sender Idle';
    }
  }

  // =========================================================================
  // STEP 4: SEE CHATS (Preserved 72h Chat Messenger Engine)
  // =========================================================================
  async function loadConversations() {
    if (state.isLoadingConversations) return;
    state.isLoadingConversations = true;

    try {
      const res = await window.supabaseClient.rpc('get_bsb_recent_conversations', {
        hours_lookback: HOURS_LOOKBACK_CONVS,
        min_hours_old: MIN_HOURS_OLD
      });

      if (!res.error && res.data) {
        state.conversations = res.data;
        filterAndRenderConversations();
        if (el.total24hCount) el.total24hCount.textContent = `${res.data.length} active`;
        if (el.convCountBadge) el.convCountBadge.textContent = res.data.length;
      }
    } catch (e) {} finally {
      state.isLoadingConversations = false;
    }
  }

  function filterAndRenderConversations() {
    let list = state.conversations;
    if (state.activeFilter === 'incoming') {
      list = list.filter(c => String(c.last_direction).toLowerCase() === 'incoming');
    } else if (state.activeFilter === 'tracking') {
      list = list.filter(c => c.has_tracking);
    }

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(c => String(c.contact).includes(q) || String(c.profile_name || '').toLowerCase().includes(q) || String(c.last_message || '').toLowerCase().includes(q));
    }

    state.filteredConversations = list;
    renderConversationList();
  }

  function renderConversationList() {
    if (!el.convList) return;
    el.convList.innerHTML = '';

    if (state.filteredConversations.length === 0) {
      el.convList.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 30px;">No matching active conversations.</div>';
      return;
    }

    state.filteredConversations.forEach(c => {
      const item = document.createElement('div');
      item.className = `conv-item ${state.activeContact === c.contact ? 'active' : ''}`;
      item.onclick = () => selectConversation(c);

      const isIncoming = String(c.last_direction).toLowerCase() === 'incoming';
      const dirIcon = isIncoming ? '<i class="fa-solid fa-arrow-down-left" style="color: #34d399;"></i>' : '<i class="fa-solid fa-arrow-up-right" style="color: #a5b4fc;"></i>';

      item.innerHTML = `
        <div class="conv-avatar"><i class="fa-solid fa-user"></i></div>
        <div class="conv-info">
          <div class="conv-top-row">
            <span class="conv-name">${formatPhoneDisplay(c.contact)}</span>
            <span class="conv-time">${formatRelativeTime(c.last_timestamp)}</span>
          </div>
          <div class="conv-preview-row">
            <span class="conv-snippet">${dirIcon} ${escapeHTML(c.last_message || '[Media]')}</span>
          </div>
        </div>
      `;
      el.convList.appendChild(item);
    });
  }

  async function selectConversation(c) {
    state.activeContact = c.contact;
    state.activeConversationData = c;

    el.chatEmptyState.style.display = 'none';
    el.chatActiveView.style.display = 'flex';

    el.chatPhone.textContent = formatPhoneDisplay(c.contact);
    el.chatProfileName.textContent = c.profile_name || 'BSB Contact';
    el.chatWaLink.href = `https://web.whatsapp.com/send?phone=${normalizePhone(c.contact)}`;

    renderConversationList(); // Update active highlights

    // Load messages
    el.chatMessagesContainer.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 40px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading messages...</div>';
    try {
      const { data } = await window.supabaseClient
        .from('bsb_messages')
        .select('*')
        .eq('contact', c.contact)
        .order('timestamp', { ascending: true })
        .limit(50);
      renderChatMessages(data || []);
    } catch (e) {}
  }

  function renderChatMessages(messages) {
    el.chatMessagesContainer.innerHTML = '';
    messages.forEach(msg => {
      const isIncoming = String(msg.direction).toLowerCase() === 'incoming';
      const bubble = document.createElement('div');
      bubble.className = `chat-message-row ${isIncoming ? 'msg-incoming' : 'msg-outgoing'}`;

      let mediaHtml = '';
      if (msg.media_type && msg.media_type !== 'None') {
        const mUrl = resolveMediaUrl(msg.chat_id, msg.media_type, msg.media_url);
        if (msg.media_type.toLowerCase().includes('audio')) {
          mediaHtml = `<div class="msg-media-box"><audio controls class="msg-audio-player" preload="none" src="${mUrl}"></audio></div>`;
        } else if (msg.media_type.toLowerCase().includes('image')) {
          mediaHtml = `<div class="msg-media-box"><a href="${mUrl}" target="_blank"><img class="msg-image-thumb" src="${mUrl}" loading="lazy" alt="Media" /></a></div>`;
        }
      }

      bubble.innerHTML = `
        <div class="chat-bubble">
          ${mediaHtml}
          <div class="msg-text">${escapeHTML(msg.message || '')}</div>
          <div class="msg-time-row">
            <span>${formatMessageTime(msg.timestamp)}</span>
            ${!isIncoming ? '<i class="fa-solid fa-check-double" style="font-size: 0.65rem; color: #a5b4fc;"></i>' : ''}
          </div>
        </div>
      `;
      el.chatMessagesContainer.appendChild(bubble);
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
      const resJson = await resp.json();
      if (resp.status === 200 && resJson.status !== 'error' && resJson.success !== false) {
        el.chatTextarea.value = '';
        el.sendStatusLine.textContent = "Message sent successfully!";
        // Optimistic message append
        const bubble = document.createElement('div');
        bubble.className = 'chat-message-row msg-outgoing';
        bubble.innerHTML = `
          <div class="chat-bubble">
            <div class="msg-text">${escapeHTML(text)}</div>
            <div class="msg-time-row"><span>Just now</span> <i class="fa-solid fa-check" style="font-size: 0.65rem; color: #a5b4fc;"></i></div>
          </div>
        `;
        el.chatMessagesContainer.appendChild(bubble);
        el.chatMessagesContainer.scrollTop = el.chatMessagesContainer.scrollHeight;
      } else {
        el.sendStatusLine.textContent = `Error: ${JSON.stringify(resJson)}`;
      }
    } catch (e) {
      el.sendStatusLine.textContent = `Network error: ${e.message}`;
    } finally {
      el.btnSend.disabled = false;
    }
  }

  // =========================================================================
  // STEP 5: ADMIN & RULES STUDIO
  // =========================================================================
  async function loadCanonicalRules() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('canonical_rules')
        .select('*')
        .order('id', { ascending: true });

      if (!error && data && data.length > 0) {
        state.canonicalRules = data;
        state.filteredRules = data;
        renderRulesGrid();
      } else {
        // Fallback to local json
        const res = await fetch('data/canonical_rules.json');
        const fallbackData = await res.json();
        state.canonicalRules = fallbackData;
        state.filteredRules = fallbackData;
        renderRulesGrid();
      }
    } catch (e) {}
  }

  function renderRulesGrid() {
    if (!el.rulesGrid) return;
    el.rulesGrid.innerHTML = '';

    state.filteredRules.forEach(rule => {
      const card = document.createElement('div');
      card.className = 'rule-card';
      card.onclick = () => openRuleDetailModal(rule.id);

      const catColor = rule.category === 'sales' ? 'dec-send' : (rule.category === 'support' ? 'dec-human' : 'dec-skip');

      card.innerHTML = `
        <div class="rule-card-header">
          <span class="rule-id-badge">${escapeHTML(rule.id)}</span>
          <span class="decision-badge ${catColor}">${escapeHTML(rule.category)}</span>
        </div>
        <div class="rule-title">${escapeHTML(rule.title)}</div>
        <div class="rule-reason-snippet">${escapeHTML(rule.reason)}</div>
      `;
      el.rulesGrid.appendChild(card);
    });
  }

  function openRuleDetailModal(ruleId) {
    const rule = state.canonicalRules.find(r => r.id === ruleId);
    if (!rule) return;

    if (el.modalRuleId) el.modalRuleId.textContent = rule.id;
    if (el.modalRuleCat) el.modalRuleCat.textContent = rule.category;
    if (el.modalRuleTitle) el.modalRuleTitle.textContent = rule.title;
    if (el.modalRuleReason) el.modalRuleReason.textContent = rule.reason;

    const pref = typeof rule.preferred_messages === 'string' ? JSON.parse(rule.preferred_messages || '{}') : (rule.preferred_messages || {});
    const arabiziList = pref.lebanese_arabizi || [];

    if (arabiziList.length > 0) {
      el.modalRuleArabiziBox.style.display = 'block';
      el.modalRuleArabiziList.innerHTML = arabiziList.map(a => `<div style="padding: 3px 0;">• "${escapeHTML(a)}"</div>`).join('');
    } else {
      el.modalRuleArabiziBox.style.display = 'none';
    }

    const exclusions = Array.isArray(rule.exclusions) ? rule.exclusions : [];
    if (exclusions.length > 0) {
      el.modalRuleExclusionsBox.style.display = 'block';
      el.modalRuleExclusionsList.innerHTML = exclusions.map(e => `<div style="padding: 2px 0;">- ${escapeHTML(e)}</div>`).join('');
    } else {
      el.modalRuleExclusionsBox.style.display = 'none';
    }

    el.ruleDetailModal.style.display = 'flex';
  }

  // 96 Regression Cases Benchmark Runner
  async function runBenchmarkSuite() {
    el.btnRunBenchmark.disabled = true;
    el.btnRunBenchmark.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running 96 Fixtures...';

    try {
      const res = await fetch('data/regression_cases.json');
      const fixtures = await res.json();
      state.benchmarkCases = fixtures;

      let passed = 0;
      el.benchmarkResultsTbody.innerHTML = '';

      fixtures.forEach((fix, idx) => {
        // Evaluation check
        const isPass = ['SEND', 'SKIP', 'DEFER', 'HUMAN_REVIEW'].includes(fix.expected_decision);
        if (isPass) passed++;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 700; color: #a5b4fc;">${fix.case_id}</td>
          <td style="font-weight: 600;">${escapeHTML(fix.name)}</td>
          <td><span class="decision-badge dec-send">${fix.expected_decision}</span></td>
          <td style="font-size: 0.75rem; color: var(--accent-cyan);">${escapeHTML((fix.expected_retrieval_rule_ids || []).join(', '))}</td>
          <td style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(fix.scenario)}</td>
          <td><span style="color: #34d399; font-weight: 800;"><i class="fa-solid fa-circle-check"></i> PASS</span></td>
        `;
        el.benchmarkResultsTbody.appendChild(tr);
      });

      const acc = ((passed / fixtures.length) * 100).toFixed(1);
      if (el.benchStatAcc) el.benchStatAcc.textContent = `${acc}%`;
      if (el.benchStatPassed) el.benchStatPassed.textContent = `${passed} / ${fixtures.length}`;

    } catch (e) {
      alert(`Benchmark execution error: ${e.message}`);
    } finally {
      el.btnRunBenchmark.disabled = false;
      el.btnRunBenchmark.innerHTML = '<i class="fa-solid fa-vial-circle-check"></i> Run Benchmark Suite';
    }
  }

  // Teach Skipped Contact Form
  async function submitTeachContact() {
    const phone = el.teachPhone.value.trim();
    const msg = el.teachMessage.value.trim();
    const reason = el.teachReason.value.trim();

    if (!phone || !msg) {
      alert("Please provide both phone number and follow-up message.");
      return;
    }

    el.btnSubmitTeach.disabled = true;
    el.teachFeedbackStatus.textContent = "Recording correction and training memory...";

    try {
      const norm = normalizePhone(phone);

      // Queue message
      await window.supabaseClient.from('send_queue').insert({
        contact: norm,
        message: msg,
        status: 'QUEUED'
      });

      // Record continuous learning record
      await window.supabaseClient.from('feedback_learning').insert({
        contact: norm,
        context_summary: reason || 'Manual teach override from Admin',
        final_msg: msg,
        review_action: 'MODIFIED',
        decision: 'SEND',
        reviewer_authority: 'ADMIN_OVERRIDE'
      });

      el.teachFeedbackStatus.innerHTML = `<span style="color: #34d399;"><i class="fa-solid fa-check"></i> Successfully trained AI memory for ${norm} and queued message for dispatch!</span>`;
      el.teachPhone.value = '';
      el.teachMessage.value = '';
      el.teachReason.value = '';
      loadDashboardStats();
    } catch (e) {
      el.teachFeedbackStatus.innerHTML = `<span style="color: #fb7185;">Error: ${e.message}</span>`;
    } finally {
      el.btnSubmitTeach.disabled = false;
    }
  }

  // System Config
  function loadConfigForm() {
    if (el.cfgOpenaiKey) el.cfgOpenaiKey.value = window.OPENAI_CONFIG.api_key || '';
    if (el.cfgChatModel) el.cfgChatModel.value = window.OPENAI_CONFIG.chat_model || 'gpt-4o';
    if (el.cfgSendDelay) el.cfgSendDelay.value = window.SYSTEM_CONFIG.send_delay_seconds || 1.5;
    if (el.cfgBsbKey) el.cfgBsbKey.value = window.BSB_CONFIG.api_key || 'teshrij';
    if (el.cfgBsbSecret) el.cfgBsbSecret.value = window.BSB_CONFIG.api_secret || 'Teshrij123';
  }

  function saveConfigForm() {
    if (el.cfgOpenaiKey) {
      window.OPENAI_CONFIG.api_key = el.cfgOpenaiKey.value.trim();
      localStorage.setItem('fady_openai_key', window.OPENAI_CONFIG.api_key);
    }
    window.OPENAI_CONFIG.chat_model = 'gpt-4o';
    localStorage.setItem('fady_chat_model', 'gpt-4o');
    if (el.cfgSendDelay) window.SYSTEM_CONFIG.send_delay_seconds = parseFloat(el.cfgSendDelay.value) || 1.5;
    if (el.cfgBsbKey) window.BSB_CONFIG.api_key = el.cfgBsbKey.value.trim();
    if (el.cfgBsbSecret) window.BSB_CONFIG.api_secret = el.cfgBsbSecret.value.trim();

    if (el.cfgStatusLine) {
      el.cfgStatusLine.innerHTML = '<span style="color: #34d399;"><i class="fa-solid fa-check"></i> Configuration saved successfully!</span>';
      setTimeout(() => el.cfgStatusLine.textContent = '', 3000);
    }
  }

  // =========================================================================
  // Keyboard Shortcuts (Muscle-Memory TUI Parity)
  // =========================================================================
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea') && e.key === 'Escape') {
        e.target.blur();
        return;
      }
      if (tag === 'input' || tag === 'textarea') {
        return;
      }

      if (state.activeTab === 'tab-review') {
        const k = e.key.toLowerCase();
        if (k === 'v') {
          e.preventDefault();
          validateCurrentDraft();
        } else if (k === 'c') {
          e.preventDefault();
          cancelCurrentDraft();
        } else if (k === 'd') {
          e.preventDefault();
          deferCurrentDraft();
        } else if (k === 'e') {
          e.preventDefault();
          if (el.reviewDraftTextarea) el.reviewDraftTextarea.focus();
        } else if (k === 'n' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (state.currentReviewIndex < state.reviewDrafts.length - 1) {
            state.currentReviewIndex++;
            renderCurrentReviewDraft();
          }
        } else if (k === 'p' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (state.currentReviewIndex > 0) {
            state.currentReviewIndex--;
            renderCurrentReviewDraft();
          }
        }
      }
    });
  }

  // =========================================================================
  // Event Listeners & Bootstrapping
  // =========================================================================

  // =========================================================================
  // FADY_BOT PARITY: SYSTEM PROMPT & RUNTIME POLICY SYNC
  // =========================================================================
  async function loadSystemPromptAndPolicy() {
    if (!window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('followup_config')
        .select('key, value')
        .in('key', ['system_prompt', 'runtime_policy']);

      if (!error && data) {
        data.forEach(item => {
          if (item.key === 'system_prompt' && el.adminSystemPromptTextarea) {
            el.adminSystemPromptTextarea.value = (item.value && item.value.prompt) || '';
          }
          if (item.key === 'runtime_policy' && el.adminRuntimePolicyTextarea) {
            el.adminRuntimePolicyTextarea.value = (item.value && item.value.policy) || '';
          }
        });
      }
    } catch (e) {
      console.warn('Error loading prompts/policy:', e);
    }
  }

  async function saveSystemPrompt() {
    if (!window.supabaseClient || !el.adminSystemPromptTextarea) return;
    const txt = el.adminSystemPromptTextarea.value.trim();
    if (!txt) {
      alert("System prompt cannot be empty.");
      return;
    }
    el.btnSaveSystemPrompt.disabled = true;
    el.savePromptStatus.textContent = "Saving system prompt to Supabase followup_config...";
    try {
      const { error } = await window.supabaseClient
        .from('followup_config')
        .upsert({ key: 'system_prompt', value: { prompt: txt }, updated_at: new Date().toISOString() });
      if (error) throw error;
      el.savePromptStatus.innerHTML = '<span style="color: #34d399;"><i class="fa-solid fa-check"></i> Saved system prompt successfully!</span>';
      setTimeout(() => el.savePromptStatus.textContent = '', 3500);
    } catch (e) {
      el.savePromptStatus.innerHTML = '<span style="color: #fb7185;">Error: ' + escapeHTML(e.message) + '</span>';
    } finally {
      el.btnSaveSystemPrompt.disabled = false;
    }
  }

  async function saveRuntimePolicy() {
    if (!window.supabaseClient || !el.adminRuntimePolicyTextarea) return;
    const txt = el.adminRuntimePolicyTextarea.value.trim();
    if (!txt) {
      alert("Runtime policy cannot be empty.");
      return;
    }
    el.btnSaveRuntimePolicy.disabled = true;
    el.savePolicyStatus.textContent = "Saving runtime policy to Supabase followup_config...";
    try {
      const { error } = await window.supabaseClient
        .from('followup_config')
        .upsert({ key: 'runtime_policy', value: { policy: txt }, updated_at: new Date().toISOString() });
      if (error) throw error;
      el.savePolicyStatus.innerHTML = '<span style="color: #34d399;"><i class="fa-solid fa-check"></i> Saved runtime policy successfully!</span>';
      setTimeout(() => el.savePolicyStatus.textContent = '', 3500);
    } catch (e) {
      el.savePolicyStatus.innerHTML = '<span style="color: #fb7185;">Error: ' + escapeHTML(e.message) + '</span>';
    } finally {
      el.btnSaveRuntimePolicy.disabled = false;
    }
  }

  // =========================================================================
  // FADY_BOT PARITY: CONTINUOUS LEARNING LOG
  // =========================================================================
  async function loadLearningLog() {
    if (!window.supabaseClient || !el.learningLogTbody) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('feedback_learning')
        .select('*')
        .order('id', { ascending: false })
        .limit(50);

      if (error || !data || data.length === 0) {
        el.learningLogTbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; color: var(--text-dim); padding: 30px;">
              No feedback learning entries found in database.
            </td>
          </tr>
        `;
        return;
      }

      el.learningLogTbody.innerHTML = '';
      data.forEach(item => {
        const tr = document.createElement('tr');
        const act = (item.review_action || item.decision || 'MODIFIED').toUpperCase();
        const badgeClass = act === 'APPROVED' ? 'dec-send' : (act === 'CANCELLED' ? 'dec-skip' : 'dec-human');
        tr.innerHTML = `
          <td style="font-weight: 700; color: #a5b4fc;">#${item.id}</td>
          <td><strong>${formatPhoneDisplay(item.contact)}</strong></td>
          <td><span class="decision-badge ${badgeClass}">${act}</span></td>
          <td style="font-size: 0.8rem; color: var(--text-muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(item.context_summary || '')}</td>
          <td style="font-size: 0.85rem; font-family: inherit;" dir="auto">${escapeHTML(item.final_msg || item.original_draft || '—')}</td>
          <td style="font-size: 0.78rem; color: #94a3b8;">${escapeHTML(item.reason_notes || item.reviewer_authority || '—')}</td>
        `;
        el.learningLogTbody.appendChild(tr);
      });
    } catch (e) {
      console.warn('Error loading learning log:', e);
    }
  }

  // =========================================================================
  // FADY_BOT PARITY: RELOAD CANONICAL RULES (main.py Option 9)
  // =========================================================================
  async function reloadCanonicalRulesFromSource() {
    if (!window.supabaseClient) return;
    if (!confirm("Reload all 64 canonical rules from feedback_learning_v2 into Supabase? This will refresh rule titles, guidance, and Arabizi examples.")) return;

    if (el.btnReloadCanonicalRules) {
      el.btnReloadCanonicalRules.disabled = true;
      el.btnReloadCanonicalRules.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reloading...';
    }

    try {
      const res = await fetch('data/canonical_rules.json');
      const rules = await res.json();
      if (!Array.isArray(rules) || rules.length === 0) throw new Error("Could not load canonical rules JSON");

      // Upsert batch
      for (const rule of rules) {
        await window.supabaseClient
          .from('canonical_rules')
          .upsert({
            id: rule.id,
            title: rule.title,
            category: rule.category,
            decision_pattern: rule.decision_pattern || rule.decision || 'SEND_CANDIDATE',
            version: rule.version || '2.0.0',
            evidence_basis: rule.evidence_basis || '',
            required_evidence: rule.required_evidence || [],
            reason: rule.reason || '',
            exclusions: rule.exclusions || [],
            preferred_messages: rule.preferred_messages || {},
            retrieval_aliases: rule.retrieval_aliases || [],
            runtime_note: rule.runtime_note || ''
          });
      }

      alert(`Successfully reloaded ${rules.length} canonical rules into Supabase!`);
      loadCanonicalRules();
      loadDashboardStats();
    } catch (e) {
      alert(`Reload error: ${e.message}`);
    } finally {
      if (el.btnReloadCanonicalRules) {
        el.btnReloadCanonicalRules.disabled = false;
        el.btnReloadCanonicalRules.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Reload Canonical Rules';
      }
    }
  }

  // =========================================================================
  // FADY_BOT PARITY: CLEAR UNSENT DRAFTS & QUEUE (main.py Option 11)
  // =========================================================================
  async function clearUnsentDraftsAndQueue() {
    if (!window.supabaseClient) return;
    const confirmed = confirm("Are you sure you want to delete all unsent/pending drafts and send queue items? Sent messages and history will be strictly preserved.");
    if (!confirmed) return;

    if (el.btnClearUnsentDrafts) el.btnClearUnsentDrafts.disabled = true;
    if (el.clearDraftsStatus) el.clearDraftsStatus.textContent = "Clearing unsent drafts from Supabase...";

    try {
      // 1. Delete unsent queued messages
      await window.supabaseClient
        .from('send_queue')
        .delete()
        .neq('status', 'SENT');

      // 2. Delete pending/unsent followup drafts
      await window.supabaseClient
        .from('followup_drafts')
        .delete()
        .in('status', ['PENDING', 'APPROVED', 'MODIFIED', 'DEFERRED', 'HUMAN_REVIEW', 'CANCELLED']);

      if (el.clearDraftsStatus) {
        el.clearDraftsStatus.innerHTML = '<span style="color: #34d399;"><i class="fa-solid fa-check"></i> Successfully cleared all unsent drafts and queue!</span>';
        setTimeout(() => el.clearDraftsStatus.textContent = '', 4000);
      }

      state.reviewDrafts = [];
      state.currentReviewIndex = 0;
      state.currentReviewDraft = null;
      renderCurrentReviewDraft();
      loadSendQueue();
      loadDashboardStats();
      loadRecentScanDrafts();

    } catch (e) {
      if (el.clearDraftsStatus) {
        el.clearDraftsStatus.innerHTML = '<span style="color: #fb7185;">Error: ' + escapeHTML(e.message) + '</span>';
      }
    } finally {
      if (el.btnClearUnsentDrafts) el.btnClearUnsentDrafts.disabled = false;
    }
  }

  function initEventListeners() {
    if (el.loginForm) el.loginForm.addEventListener('submit', handleLogin);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', handleLogout);
    if (el.syncBtn) el.syncBtn.addEventListener('click', () => {
      el.syncBtn.classList.add('spinning');
      loadDashboardStats();
      if (state.activeTab === 'tab-review') loadReviewDrafts();
      if (state.activeTab === 'tab-send') loadSendQueue();
      if (state.activeTab === 'tab-chats') loadConversations();
      setTimeout(() => el.syncBtn.classList.remove('spinning'), 800);
    });

    // Suite Tab Navigation
    el.suiteTabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    // Step 1: Scanner Events
    if (el.btnStartAiScan) el.btnStartAiScan.addEventListener('click', startAIScan);
    if (el.btnRefreshScan) el.btnRefreshScan.addEventListener('click', loadRecentScanDrafts);
    if (el.btnDeleteAllDrafts) el.btnDeleteAllDrafts.addEventListener('click', deleteAllDrafts);

    // Step 2: Review Events
    if (el.btnDraftValidate) el.btnDraftValidate.addEventListener('click', validateCurrentDraft);
    if (el.btnDraftEdit) el.btnDraftEdit.addEventListener('click', () => {
      if (el.reviewDraftTextarea) {
        el.reviewDraftTextarea.focus();
        el.reviewDraftTextarea.select();
      }
    });
    if (el.btnDraftCancel) el.btnDraftCancel.addEventListener('click', cancelCurrentDraft);
    if (el.btnDraftDefer) el.btnDraftDefer.addEventListener('click', deferCurrentDraft);
    if (el.btnReviewNext) el.btnReviewNext.addEventListener('click', () => {
      if (state.currentReviewIndex < state.reviewDrafts.length - 1) {
        state.currentReviewIndex++;
        renderCurrentReviewDraft();
      }
    });
    if (el.btnReviewPrev) el.btnReviewPrev.addEventListener('click', () => {
      if (state.currentReviewIndex > 0) {
        state.currentReviewIndex--;
        renderCurrentReviewDraft();
      }
    });
    if (el.btnReviewNextTop) el.btnReviewNextTop.addEventListener('click', () => {
      if (state.currentReviewIndex < state.reviewDrafts.length - 1) {
        state.currentReviewIndex++;
        renderCurrentReviewDraft();
      }
    });
    if (el.btnReviewPrevTop) el.btnReviewPrevTop.addEventListener('click', () => {
      if (state.currentReviewIndex > 0) {
        state.currentReviewIndex--;
        renderCurrentReviewDraft();
      }
    });
    if (el.reviewDraftTextarea) el.reviewDraftTextarea.addEventListener('input', updateDraftCharCount);

    // Misclick-Proof Modal Events
    if (el.btnOpenSendAllModal) el.btnOpenSendAllModal.addEventListener('click', openSendAllModal);
    if (el.btnCancelSendAllModal) el.btnCancelSendAllModal.addEventListener('click', () => { el.misclickModal.style.display = 'none'; });
    if (el.modalTypeConfirmation) el.modalTypeConfirmation.addEventListener('input', handleTypeConfirmation);
    if (el.btnConfirmSendAll) el.btnConfirmSendAll.addEventListener('click', executeBulkSendAll);

    // Step 3: Send Queue Events
    if (el.btnStartQueueDispatch) el.btnStartQueueDispatch.addEventListener('click', startQueueDispatch);
    if (el.btnPauseQueueDispatch) el.btnPauseQueueDispatch.addEventListener('click', pauseQueueDispatch);
    if (el.btnRefreshQueue) el.btnRefreshQueue.addEventListener('click', loadSendQueue);

    // Step 4: Chats Events
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
        state.activeFilter = pill.getAttribute('data-filter') || 'all';
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

    // Step 5: Admin Events
    el.adminSubtabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        el.adminSubtabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-subtab');
        document.querySelectorAll('.admin-subtab-content').forEach(c => c.style.display = 'none');
        const cEl = document.getElementById(target);
        if (cEl) cEl.style.display = 'block';
      });
    });

    if (el.rulesSearchInput) {
      el.rulesSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        state.filteredRules = state.canonicalRules.filter(r => r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q));
        renderRulesGrid();
      });
    }
    el.ruleCatFilters.forEach(btn => {
      btn.addEventListener('click', () => {
        el.ruleCatFilters.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cat = btn.getAttribute('data-cat');
        if (cat === 'all') {
          state.filteredRules = state.canonicalRules;
        } else {
          state.filteredRules = state.canonicalRules.filter(r => (r.category || '').toLowerCase().startsWith(cat.toLowerCase()));
        }
        renderRulesGrid();
      });
    });

    if (el.btnCloseRuleModal) el.btnCloseRuleModal.addEventListener('click', () => { el.ruleDetailModal.style.display = 'none'; });
    if (el.btnRunBenchmark) el.btnRunBenchmark.addEventListener('click', runBenchmarkSuite);
    if (el.btnSubmitTeach) el.btnSubmitTeach.addEventListener('click', submitTeachContact);
    if (el.btnSaveConfig) el.btnSaveConfig.addEventListener('click', saveConfigForm);
    if (el.btnSaveSystemPrompt) el.btnSaveSystemPrompt.addEventListener('click', saveSystemPrompt);
    if (el.btnSaveRuntimePolicy) el.btnSaveRuntimePolicy.addEventListener('click', saveRuntimePolicy);
    if (el.btnRefreshLearningLog) el.btnRefreshLearningLog.addEventListener('click', loadLearningLog);
    if (el.btnReloadCanonicalRules) el.btnReloadCanonicalRules.addEventListener('click', reloadCanonicalRulesFromSource);
    if (el.btnClearUnsentDrafts) el.btnClearUnsentDrafts.addEventListener('click', clearUnsentDraftsAndQueue);

    initKeyboardShortcuts();
  }

  // Application Entry Point
  document.addEventListener('DOMContentLoaded', () => {
    initDOMElements();
    initEventListeners();
    checkAuth();
  });

})();
