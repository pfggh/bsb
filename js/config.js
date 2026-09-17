/**
 * Teshrij BSB Configuration
 * Connected to Supabase & BestSMSBulk Messaging API
 */

window.SUPABASE_URL = "https://kfgswynickhywzhneltu.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZ3N3eW5pY2toeXd6aG5lbHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU1MDYwNTMsImV4cCI6MjA1MTA4MjA1M30.3w3jMggAEvcrPKg1k-Bg2JI8J5TX9OSo4fG7sqLOIIE";

// BestSMSBulk WhatsApp API configuration (from ~/Projects/Fady_bot/core/sender.py)
window.BSB_CONFIG = {
  api_endpoint: "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php",
  api_key: "teshrij",
  api_secret: "Teshrij123"
};

// Initialize Supabase Client
if (window.supabase && window.supabase.createClient) {
  window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });
}
