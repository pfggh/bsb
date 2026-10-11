/**
 * Teshrij Follow-up Suite Configuration
 * Only public values live here. Secrets (BestSMSBulk, OpenAI, service role) stay server-side.
 */

// Clickjacking guard: GitHub Pages cannot send X-Frame-Options / frame-ancestors headers,
// so refuse to run when the page is embedded in a frame on another site.
window.__FRAMED__ = false;
try {
  if (window.top !== window.self) {
    window.__FRAMED__ = true;
    document.documentElement.style.display = "none";
    try { window.top.location = window.self.location.href; } catch (e) {}
  }
} catch (e) {
  window.__FRAMED__ = true;
}

window.SUPABASE_URL = "https://kfgswynickhywzhneltu.supabase.co";
// Public "publishable" key (safe to ship in the browser; access is enforced by RLS and
// by the admin session). The variable keeps its historical name so nothing else changes.
window.SUPABASE_ANON_KEY = "sb_publishable_ldEJk9Wd7TNeTEW5m3-N8g_NsrcXUXc";

// Anti-Ban & System Guardrails
window.SYSTEM_CONFIG = Object.freeze({
  send_delay_seconds: 1.5,
  enforce_beirut_hours: true,
  beirut_hours_start: 9,
  beirut_hours_end: 21,
  min_hours_old: 2.0,
  max_hours_old: 24.0
});

// The OpenAI key used to be cached in the browser for the old bot tabs; remove it
try {
  localStorage.removeItem("fady_openai_key");
  localStorage.removeItem("fady_chat_model");
} catch (e) {}

// Initialize Supabase Client
if (!window.__FRAMED__ && window.supabase && window.supabase.createClient) {
  window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });
}
