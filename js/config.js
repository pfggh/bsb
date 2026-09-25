/**
 * Teshrij Follow-up Suite Configuration
 * Connected to Supabase PostgreSQL, BestSMSBulk API & OpenAI
 */

window.SUPABASE_URL = "https://kfgswynickhywzhneltu.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZ3N3eW5pY2toeXd6aG5lbHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU1MDYwNTMsImV4cCI6MjA1MTA4MjA1M30.3w3jMggAEvcrPKg1k-Bg2JI8J5TX9OSo4fG7sqLOIIE";

// BestSMSBulk WhatsApp API configuration
window.BSB_CONFIG = {
  api_endpoint: "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php",
  api_key: "teshrij",
  api_secret: "Teshrij123"
};

// OpenAI API configuration (Loaded from localStorage or fetched securely from Supabase followup_config)
window.OPENAI_CONFIG = {
  api_key: localStorage.getItem("fady_openai_key") || "",
  chat_model: localStorage.getItem("fady_chat_model") || "gpt-4o",
  embedding_model: "text-embedding-3-small",
  temperature: 0.7
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

// Initialize Supabase Client
if (window.supabase && window.supabase.createClient) {
  window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });

  // Automatically sync OpenAI key from Supabase followup_config if not yet set in browser
  if (!window.OPENAI_CONFIG.api_key) {
    window.supabaseClient.from('followup_config').select('value').eq('key', 'openai').maybeSingle()
      .then(({ data }) => {
        if (data && data.value && data.value.api_key) {
          window.OPENAI_CONFIG.api_key = data.value.api_key;
          localStorage.setItem("fady_openai_key", data.value.api_key);
        }
      })
      .catch(() => {});
  }
}
