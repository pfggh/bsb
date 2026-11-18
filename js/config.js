/* Teshrij Desk — public configuration only. Secrets stay in the edge functions. */
(function () {
  'use strict';
  // Clickjacking guard (GitHub Pages cannot send frame-ancestors headers).
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = 'none';
      window.top.location = window.self.location.href;
    }
  } catch (e) {
    document.documentElement.style.display = 'none';
  }

  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  window.DESK = Object.freeze({
    // The local demo (demo/run.sh) serves this page and the API itself (same tokens, sending simulated).
    demo: local && !/[?&]prod\b/.test(location.search),
    supabaseUrl: 'https://kfgswynickhywzhneltu.supabase.co',
    version: 202611190300, // same stamp as the ?v= in index.html; the desk asks for a reload when the server names a newer one
    pollMs: 8000,
    pollHiddenMs: 30000,
    threadPollMs: 4000,
    undoMs: 5000,
  });
})();
