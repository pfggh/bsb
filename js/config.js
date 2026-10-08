/**
 * Teshrij Follow-up Suite Configuration
 * Connected to Supabase PostgreSQL & BestSMSBulk API
 */

window.SUPABASE_URL = "https://kfgswynickhywzhneltu.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZ3N3eW5pY2toeXd6aG5lbHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU1MDYwNTMsImV4cCI6MjA1MTA4MjA1M30.3w3jMggAEvcrPKg1k-Bg2JI8J5TX9OSo4fG7sqLOIIE";

// BestSMSBulk WhatsApp API configuration
window.BSB_CONFIG = {
  api_endpoint: "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php",
  api_key: "teshrij",
  api_secret: "Teshrij123"
};

// Anti-Ban & System Guardrails
window.SYSTEM_CONFIG = {
  send_delay_seconds: 1.5,
  enforce_beirut_hours: true,
  beirut_hours_start: 9,
  beirut_hours_end: 21,
  min_hours_old: 2.0,
  max_hours_old: 24.0
};

// The OpenAI key used to be cached in the browser for the old bot tabs; remove it
try {
  localStorage.removeItem("fady_openai_key");
  localStorage.removeItem("fady_chat_model");
} catch (e) {}

// Initialize Supabase Client
if (window.supabase && window.supabase.createClient) {
  window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });
}
