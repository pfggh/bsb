// supabase/functions/scan/index.ts
// Teshrij Follow-up AI Scanner — Edge Function
// Exact port of core/server_scanner.py (= Fady_bot analyzer.py logic) in Deno/TypeScript.
// Triggered via HTTP POST from the web UI or on a schedule.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

// ============================================================================
// Types
// ============================================================================

interface Message {
  direction: string;
  message: string | null;
  timestamp: string;
  status?: string | null;
}

interface AnalysisResult {
  decision: "SEND" | "SKIP";
  send_followup: boolean;
  message: string | null;
  category: string;
  rule_ids: string[];
  internal_reason: string;
  reasoning: string;
  cancel_reason: string;
  context_summary: string;
}

interface ScanStats {
  total_evaluated: number;
  drafts_created: number;
  skipped: number;
  errors: number;
}

// ============================================================================
// Supabase + OpenAI clients
// ============================================================================

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function getOpenAIClientAndModel(): Promise<{ client: OpenAI; model: string; temperature: number }> {
  const sb = getSupabase();
  let apiKey = OPENAI_API_KEY || "";
  let model = "gpt-5.6-terra";
  let temperature = 1.0;

  const { data } = await sb.from("followup_config").select("value").eq("key", "openai").single();
  if (data?.value) {
    if (!apiKey) apiKey = data.value.api_key || "";
    model = data.value.chat_model || "gpt-5.6-terra";
    temperature = parseFloat(data.value.temperature ?? 1.0);
  }
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured.");
  return { client: new OpenAI({ apiKey }), model, temperature };
}

// ============================================================================
// System Prompt (exact port of load_system_prompt)
// ============================================================================

async function loadSystemPrompt(): Promise<string> {
  const sb = getSupabase();
  let policy = "";
  let promptBase = "";

  const { data: rows } = await sb.from("followup_config")
    .select("key, value")
    .in("key", ["system_prompt", "runtime_policy"]);

  for (const r of rows || []) {
    if (r.key === "system_prompt" && r.value?.prompt) promptBase = r.value.prompt;
    if (r.key === "runtime_policy" && r.value?.policy) policy = r.value.policy;
  }

  const parts = [policy, promptBase].filter(Boolean);
  let combined = parts.join("\n\n").trim() || "You are an intelligent WhatsApp follow-up assistant. Respond strictly in valid JSON format.";

  const jsonContract = `

### RESPONSE CONTRACT (OUTPUT JSON SCHEMA):
You must respond strictly with a valid JSON object matching this schema:
{
  "decision": "SEND" | "SKIP",
  "category": "sales" | "support" | "guardrails" | "style",
  "message": "string" or null,
  "rule_ids": ["RULE_ID_1", "RULE_ID_2"],
  "internal_reason": "Detailed explanation of decision"
}

RULES FOR MESSAGE OUTPUT:
- Only 'SEND' may contain a message. For 'SKIP', 'message' MUST be null.
- Always follow up (SEND) with customers who received ChatGPT/Anghami pricing or details without purchasing, unless they opted out or already received the final followup ('Final Followup; ...').
- Messaging is restricted to WhatsApp's 24-hour service window. If problem confirmed resolved, or customer declined/opted out, choose 'SKIP'.
- Keep message short (1-2 sentences), natural Lebanese Arabizi or clean English, at most 1 question mark.
- NEVER include URLs, links, email addresses, or unreplaced placeholder tokens like {price} or {plan}.
- Never make unauthorized operational promises ('I will activate/fix/check').`;

  if (!combined.toLowerCase().includes("output json schema")) {
    combined += jsonContract;
  }
  return combined;
}

// ============================================================================
// 24h Window Check (exact port of check_24h_window_eligibility)
// ============================================================================

function parseTimestamp(ts: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function checkWindowEligibility(
  messages: Message[],
  refNow: Date,
  minHours = 2.0,
  maxHours = 24.0
): { eligible: boolean; reason: string } {
  if (!messages.length) return { eligible: false, reason: "No chat messages found for contact." };

  const incoming = messages.filter(m => m.direction?.toUpperCase() === "INCOMING");
  if (!incoming.length) return { eligible: false, reason: "No incoming customer messages" };

  const lastIncoming = incoming[incoming.length - 1];
  const incDt = parseTimestamp(lastIncoming.timestamp);
  if (incDt) {
    const incHours = (refNow.getTime() - incDt.getTime()) / 3_600_000;
    if (incHours > maxHours || incHours < -24) {
      return { eligible: false, reason: "Customer last message outside 24h window or already responded: 24h window expired" };
    }
  }

  const lastMsg = messages[messages.length - 1];
  const msgDt = parseTimestamp(lastMsg.timestamp);
  if (!msgDt) return { eligible: false, reason: "Invalid timestamp" };

  const hoursAgo = (refNow.getTime() - msgDt.getTime()) / 3_600_000;
  if (hoursAgo > maxHours || hoursAgo < -24) {
    return { eligible: false, reason: "Customer last message outside 24h window or already responded: 24h window expired" };
  }
  if (hoursAgo < minHours) {
    return { eligible: false, reason: `Chat is too recent (< ${minHours}h old, last message was ${hoursAgo.toFixed(1)}h ago)` };
  }
  return { eligible: true, reason: "" };
}

// ============================================================================
// Cancellation Guards (exact port of check_canonical_cancellation_guards)
// ============================================================================

interface GuardResult {
  decision: "SKIP";
  category: string;
  rule_ids: string[];
  cancel_reason: string;
  internal_reason: string;
}

function checkCancellationGuards(messages: Message[], proposedMessage?: string | null): GuardResult | null {
  if (!messages.length) return null;

  const lastIncoming = [...messages].reverse().find(m => m.direction?.toUpperCase() === "INCOMING");
  if (!lastIncoming) return null;

  const lastInText = (lastIncoming.message || "").toLowerCase();

  // GUARD_04: Untranscribed voice message
  if (lastInText.includes("voice message") || lastInText.includes("🎤") || lastInText.includes("[audio]")) {
    return { decision: "SKIP", category: "guardrails", rule_ids: ["GUARD_04"],
      cancel_reason: "GUARD_04: Untranscribed customer voice message (do not guess intent)",
      internal_reason: "GUARD_04: Voice note as latest message requires manual review." };
  }

  // SALES_10/11: Explicit refusal or soft deferral
  const declinePatterns = [
    "bredelkon khabar","breddelkoun khabar","bredelkon","breddelkoun",
    "mish hala2","not at the moment","ma bade","no thanks","anyway thanks",
    "just checking","shway w bshuf","3am bes2al bas","i will check and let you know",
    "i ll check and let you know","not interested","dont want","no need","machi merci"
  ];
  if (declinePatterns.some(p => lastInText.includes(p))) {
    return { decision: "SKIP", category: "sales", rule_ids: ["SALES_10", "SALES_11"],
      cancel_reason: "SALES_10/SALES_11: Customer soft deferral or refusal ends proactive outreach",
      internal_reason: "Customer explicitly deferred or declined further outreach." };
  }

  // GUARD_03: Payment reported
  const paymentPatterns = [
    "paid","w2w","whish transfer","transferred","sent the payment","sent payment",
    "transfer done","check the amount","wselet l payment","dafa3et","hawal","7awal","ba3at","b3at","sent it"
  ];
  if (paymentPatterns.some(p => lastInText.includes(p))) {
    return { decision: "SKIP", category: "guardrails", rule_ids: ["GUARD_03"],
      cancel_reason: "GUARD_03: Payment reported by customer",
      internal_reason: "Customer reported payment; fulfillment owned by operator." };
  }

  // SALES_13: Final Followup already delivered
  let hasFinalOutgoing = false;
  let finalMsgIdx = -1;
  messages.forEach((m, idx) => {
    if (m.direction?.toUpperCase() === "OUTGOING") {
      const otxt = (m.message || "").toLowerCase();
      if (otxt.startsWith("final followup;") || otxt.includes("(last followup)") || otxt.includes("(final followup)") || otxt === "last followup") {
        hasFinalOutgoing = true;
        finalMsgIdx = idx;
      }
    }
  });
  if (hasFinalOutgoing) {
    const subseqCustomer = messages.slice(finalMsgIdx + 1).filter(m => m.direction?.toUpperCase() === "INCOMING");
    if (!subseqCustomer.length) {
      return { decision: "SKIP", category: "sales", rule_ids: ["SALES_13"],
        cancel_reason: "SALES_13: A final sales follow-up was already sent and remained unanswered",
        internal_reason: "Final follow-up already delivered; sequence exhausted." };
    }
    const lastSub = subseqCustomer[subseqCustomer.length - 1];
    const subTxt = (lastSub.message || "").toLowerCase();
    const closureWords = ["thank","merci","thx","ok","machi","done","👍","❤️","🙏🏻"];
    const reopenWords = ["?","price","how much","baddak","bade","wanna buy"];
    if (closureWords.some(t => subTxt.includes(t)) && !reopenWords.some(q => subTxt.includes(q))) {
      return { decision: "SKIP", category: "sales", rule_ids: ["SALES_13"],
        cancel_reason: "SALES_13: Polite closure following delivered final follow-up",
        internal_reason: "Customer acknowledged final follow-up with courtesy; sequence finished." };
    }
  }

  // SUPPORT_06: Implicit resolution (remedy + thanks/reaction)
  let remedyIdx = -1;
  const remedyKeywords = ["teshrij.xyz","tv.ostories.me","email:","password:","workspace","select mavos","anghami.com","try now","jarrib","jarreb","check now"];
  messages.forEach((m, i) => {
    if (m.direction?.toUpperCase() === "OUTGOING") {
      const otxt = (m.message || "").toLowerCase();
      if (remedyKeywords.some(k => otxt.includes(k))) remedyIdx = i;
    }
  });
  if (remedyIdx !== -1) {
    const subsequent = messages.slice(remedyIdx + 1);
    let hasComplaint = false, hasThanks = false;
    for (const sub of subsequent) {
      const stxt = (sub.message || "").toLowerCase();
      const sdir = sub.direction?.toUpperCase();
      if (sdir === "INCOMING") {
        if (["not working","ma am ymche","ma 3am","error","full hyda","ma zaba","problem"].some(e => stxt.includes(e))) hasComplaint = true;
        if (["thank","merci","thx","thanks","done","yes","👍","❤️","🙏🏻","ye","eh"].some(t => stxt.includes(t))) hasThanks = true;
      } else if (sdir === "OUTGOING") {
        if (["welcomee","ur welcome","you're welcome"].some(w => stxt.includes(w))) hasThanks = true;
      }
    }
    if (hasThanks && !hasComplaint) {
      return { decision: "SKIP", category: "support", rule_ids: ["SUPPORT_06"],
        cancel_reason: "SUPPORT_06: Implicit support resolution (customer confirmed via thanks/reaction)",
        internal_reason: "Support remedy implicitly confirmed working; outcome checks cancelled." };
    }
  }

  // SUPPORT_12: Anghami does not use login credentials
  if (proposedMessage) {
    const allConvText = messages.map(m => m.message || "").join(" ").toLowerCase();
    const propLower = proposedMessage.toLowerCase();
    if (allConvText.includes("anghami") || propLower.includes("anghami")) {
      if (["login","log in","fout 3al account","credentials","password"].some(w => propLower.includes(w))) {
        return { decision: "SKIP", category: "support", rule_ids: ["SUPPORT_12"],
          cancel_reason: "SUPPORT_12: Anghami activation does not use account login credentials",
          internal_reason: "Anghami uses family link or profile screenshot, never login credentials." };
      }
    }
  }

  // SUPPORT_01: Repeated unanswered support check
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction?.toUpperCase() === "INCOMING") break;
    if (m.direction?.toUpperCase() === "OUTGOING") {
      const otxt = (m.message || "").toLowerCase();
      if (["did it work","meshe l hal","meche l hal","were you able to log in","2dert tfout","zabat"].some(sc => otxt.includes(sc))) {
        return { decision: "SKIP", category: "support", rule_ids: ["SUPPORT_01"],
          cancel_reason: "SUPPORT_01: Support outcome check already pending",
          internal_reason: "Outcome check already delivered; waiting for customer reply." };
      }
    }
  }

  return null;
}

// ============================================================================
// Dispatch Gate (exact port of validate_dispatch_gate)
// ============================================================================

function validateDispatchGate(decision: string, message: string | null): { decision: string; message: string; issue: string | null } {
  let dec = (decision || "SKIP").toUpperCase();
  if (["YES","TRUE","FOLLOW_UP","FOLLOWUP","SEND_FOLLOWUP","REPLY"].includes(dec)) dec = "SEND";
  else if (!["SEND","SKIP"].includes(dec)) dec = "SKIP";

  if (dec !== "SEND") return { decision: dec, message: "", issue: null };

  const msg = (message || "").trim();
  if (!msg || ["null","none"].includes(msg.toLowerCase())) {
    return { decision: "SKIP", message: "", issue: "SEND decision missing message body" };
  }

  const issues: string[] = [];
  if (/https?\s*:\s*\/\/|www\.|\b[a-z0-9.-]+\.(?:com|xyz|net|org)(?:\/|\b)/i.test(msg)) issues.push("URL or domain name detected");
  if (/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/.test(msg)) issues.push("Email address detected");
  if (msg.includes("{") || msg.includes("}") || /\[(?:ACCOUNT|PHONE|CREDENTIAL|SECRET|ACCESS|IDENTIFIER)/.test(msg)) issues.push("Unresolved placeholder detected");
  if ((msg.split("?").length - 1) + (msg.split("؟").length - 1) > 1) issues.push("More than one question mark");
  if (/[\u0600-\u06ff]/.test(msg) && /[A-Za-z]/.test(msg)) issues.push("Mixed script detected");
  if (/\b(?:we(?:'re| are| will| have)|i(?:'m| am| will| have))\s+(?:now\s+)?(?:fix|activat|refund|cancel|replac|send|check)/i.test(msg)) issues.push("Unauthorized operational claim");
  if (/\b(?:sending you(?: the)?|bebaatlik|wselek l refund|fixed it from the system|manager will contact|okay check now)\b/i.test(msg)) issues.push("Unauthorized operational claim");
  if (/\b(?:zero limits|last chance|guaranteed no issues)\b/i.test(msg)) issues.push("Unsupported pressure claim");

  if (issues.length) return { decision: "SKIP", message: "", issue: issues.join("; ") };
  return { decision: "SEND", message: msg, issue: null };
}

// ============================================================================
// Transcript formatting (exact port of format_chat_transcript)
// ============================================================================

function formatTranscript(messages: Message[], maxTokens = 4000): string {
  if (!messages.length) return "";
  const charBudget = maxTokens * 4;
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const dir = (m.direction || "").toUpperCase();
    const sender = dir === "INCOMING" ? "Customer" : "Support/Business";
    const text = (m.message || "").trim();
    if (!text) continue;
    const line = `[${m.timestamp}] ${sender}: ${text}`;
    if (totalChars + line.length + 1 > charBudget && lines.length) { truncated = true; break; }
    lines.push(line);
    totalChars += line.length + 1;
  }
  lines.reverse();
  if (truncated) lines.unshift("[... Earlier conversation history truncated to preserve token budget ...]");
  return lines.join("\n");
}

function summarizeTranscript(transcript: string): string {
  const lines = transcript.split("\n").filter(l => l.trim() && !l.startsWith("[... Earlier"));
  if (!lines.length) return "Empty conversation";
  return "Recent messages: " + lines.slice(-3).join(" | ");
}

// ============================================================================
// Model utility
// ============================================================================

function isFixedTemperatureModel(model: string): boolean {
  const m = model.toLowerCase();
  const base = m.split("/").pop()!.split("\\").pop()!;
  return base.startsWith("o1") || base.startsWith("o2") || base.startsWith("o3") ||
    base.startsWith("o4") || base.startsWith("gpt-5") || base.includes("gpt-5") ||
    base.includes("-o1") || base.includes("-o3") || base.includes("-o4");
}

// ============================================================================
// OpenAI call with retry (exact port of execute_chat_completion_with_retry)
// ============================================================================

async function chatWithRetry(
  client: OpenAI,
  params: Record<string, unknown>,
  maxRetries = 3,
  initialDelay = 1000
): Promise<unknown> {
  if (isFixedTemperatureModel(params.model as string)) delete params.temperature;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // @ts-ignore dynamic params
      return await client.chat.completions.create(params);
    } catch (e: unknown) {
      const msg = String(e).toLowerCase();

      if (msg.includes("temperature") && (msg.includes("unsupported") || msg.includes("not support") || msg.includes("allowed"))) {
        delete params.temperature;
        continue;
      }
      if (msg.includes("response_format") && (msg.includes("unsupported") || msg.includes("not support") || msg.includes("not valid"))) {
        delete params.response_format;
        continue;
      }

      const is429 = msg.includes("429") || msg.includes("rate limit") || msg.includes("ratelimit");
      if (is429 && attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Max retries exceeded");
}

// ============================================================================
// Single contact analysis (exact port of analyze_contact_thread)
// ============================================================================

async function analyzeContact(
  contact: string,
  profileName: string,
  client: OpenAI,
  model: string,
  temperature: number,
  systemPrompt: string,
  refNow: Date
): Promise<AnalysisResult> {
  const sb = getSupabase();

  // Fetch ALL messages ASC (same as Fady_bot)
  const { data: msgs } = await sb.from("bsb_messages")
    .select("direction, message, timestamp, status")
    .eq("contact", contact)
    .order("timestamp", { ascending: true })
    .order("id", { ascending: true });

  const messages: Message[] = msgs || [];

  if (!messages.length) {
    return { decision: "SKIP", send_followup: false, message: null, category: "guardrails",
      rule_ids: ["GUARD_01"], internal_reason: "No messages.", reasoning: "No chat messages found.",
      cancel_reason: "No chat messages found.", context_summary: "" };
  }

  // === STEP 1: 24h window ===
  const { eligible, reason: windowReason } = checkWindowEligibility(messages, refNow);
  if (!eligible) {
    return { decision: "SKIP", send_followup: false, message: null, category: "guardrails",
      rule_ids: ["GUARD_01"], internal_reason: windowReason, reasoning: windowReason,
      cancel_reason: windowReason, context_summary: "" };
  }

  // === STEP 2: Transcript + summary ===
  const transcript = formatTranscript(messages);
  const contextSummary = summarizeTranscript(transcript);
  const retrievalQuery = `${contextSummary}\n${transcript}`;

  // === STEP 3: RAG — canonical rules ===
  let queryVector: number[] | null = null;
  try {
    const embResp = await client.embeddings.create({ input: [retrievalQuery.slice(-1500)], model: "text-embedding-3-small" });
    queryVector = embResp.data[0].embedding;
  } catch { /* embedding optional */ }

  let canonicalText = "";
  if (queryVector) {
    try {
      const { data: rules } = await sb.rpc("match_canonical_rules", {
        query_vector: queryVector, match_threshold: 0.25, match_count: 6
      });
      if (rules?.length) {
        const lines = rules.map((r: Record<string, unknown>) => {
          const pref = (r.preferred_messages as Record<string, unknown>) || {};
          const arabizi = Array.isArray(pref.lebanese_arabizi) ? pref.lebanese_arabizi : [];
          const arabiziTxt = arabizi.length ? ` (Preferred Arabizi: ${JSON.stringify(arabizi)})` : "";
          return `- [${r.id}] ${r.title}: ${r.reason}${arabiziTxt}`;
        });
        canonicalText = "### CANONICAL KNOWLEDGE RULES (v2.0):\n" + lines.join("\n");
      }
    } catch { /* rag optional */ }
  }

  // === STEP 4: RAG — feedback/corrections ===
  let feedbackText = "";
  if (queryVector) {
    try {
      const { data: fb } = await sb.rpc("match_feedback_learning", {
        query_vector: queryVector, match_threshold: 0.35, match_count: 5
      });
      if (fb?.length) {
        const lines = fb.map((r: Record<string, unknown>) => {
          const act = r.review_action || "OPERATOR";
          const summary = r.context_summary || "";
          if (act === "CANCELLED") return `- [DO NOT MESSAGE] Context: '${summary}' -> Human operator cancelled. Decision: SKIP.`;
          if (act === "MODIFIED") return `- [HUMAN CORRECTION] Context: '${summary}'. Operator sent: '${r.final_msg}'.`;
          if (act === "APPROVED") return `- [APPROVED EXAMPLE] Context: '${summary}'. Sent: '${r.final_msg || r.original_draft}'.`;
          return "";
        }).filter(Boolean);
        feedbackText = "### DYNAMIC OPERATOR REVIEWS & CORRECTIONS:\n" + lines.join("\n");
      }
    } catch { /* rag optional */ }
  }

  // === STEP 5: Build system message ===
  const sections = [systemPrompt, feedbackText, canonicalText, "Respond strictly with a valid JSON object matching the requested schema."].filter(Boolean);
  const systemMessage = sections.join("\n\n");

  const userMessage = `Customer Phone: ${contact}\nProfile Name: ${profileName}\n\n` +
    `System Precondition: WhatsApp 24h session window eligibility, timing cadence, and safety dispatch gates are already verified by the host system.\n\n` +
    `Full Conversation History:\n${transcript}\n\n` +
    `Analyze this conversation and generate follow-up decision according to guidelines. Output must be a valid JSON object.`;

  // === STEP 6: OpenAI call ===
  const params: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ],
    response_format: { type: "json_object" }
  };
  if (temperature !== 1.0 && !isFixedTemperatureModel(model)) params.temperature = temperature;

  // @ts-ignore
  const response = await chatWithRetry(client, params) as { choices: Array<{ message: { content: string } }> };
  const content = response.choices[0].message.content || "{}";

  let rawResult: Record<string, unknown> = {};
  try { rawResult = JSON.parse(content); } catch { rawResult = {}; }

  // === STEP 7: Parse response ===
  let rawDecision = String(rawResult.decision || "").toUpperCase();
  let rawMsg = (rawResult.message as string | null) ?? (rawResult.followup_message as string | null) ?? null;

  let rule_ids: string[] = [];
  const ri = rawResult.rule_ids;
  if (Array.isArray(ri)) rule_ids = ri.map(String);
  else if (typeof ri === "string") { try { rule_ids = JSON.parse(ri); } catch { rule_ids = ri ? [ri] : []; } }

  if (rawResult.send_followup !== undefined && !rawResult.decision) {
    rawDecision = rawResult.send_followup ? "SEND" : "SKIP";
  }

  // Normalize legacy
  if (["NO_MESSAGE","DEFER","HUMAN_REVIEW"].includes(rawDecision)) rawDecision = "SKIP";

  // Anghami login restriction
  if (rawMsg && (retrievalQuery.toLowerCase().includes("anghami") || rawMsg.toLowerCase().includes("anghami"))) {
    if (["login","log in","fout 3al account"].some(w => (rawMsg as string).toLowerCase().includes(w))) {
      rawDecision = "SKIP"; rawMsg = null;
    }
  }

  // === STEP 8: Cancellation guards (post-LLM) ===
  let gateIssue: string | null = null;
  if (rawDecision === "SEND") {
    const guard = checkCancellationGuards(messages, rawMsg);
    if (guard) {
      rawDecision = "SKIP"; rawMsg = null;
      gateIssue = guard.cancel_reason;
      rule_ids = guard.rule_ids;
    }
  }

  // === STEP 9: Dispatch gate ===
  const gateResult = validateDispatchGate(rawDecision, rawMsg);
  if (gateResult.issue && !gateIssue) {
    gateIssue = gateResult.issue;
    if (!rule_ids.includes("GUARD_02")) rule_ids.push("GUARD_02");
  }

  const category = String(rawResult.category || rawResult.intent || "sales");
  const internal_reason = String(rawResult.internal_reason || rawResult.explanation || rawResult.reasoning || "");
  const sendFollowup = gateResult.decision === "SEND" && !!gateResult.message;
  const finalMsg = sendFollowup ? gateResult.message : null;

  const reasoning = internal_reason
    ? (category && !internal_reason.toLowerCase().includes(category.toLowerCase()) ? `[${category}] ${internal_reason}` : internal_reason)
    : category || "AI determined follow-up decision";

  const cancelReason = sendFollowup ? "" : (gateIssue ? `Safety gate issue: ${gateIssue}` : reasoning || "AI determined no follow-up needed");

  return {
    decision: sendFollowup ? "SEND" : "SKIP",
    send_followup: sendFollowup,
    message: finalMsg,
    category,
    rule_ids,
    internal_reason,
    reasoning,
    cancel_reason: cancelReason,
    context_summary: contextSummary
  };
}

// ============================================================================
// Save draft
// ============================================================================

async function saveDraft(contact: string, profileName: string, analysis: AnalysisResult) {
  const sb = getSupabase();
  await sb.from("followup_drafts").insert({
    contact,
    profile_name: profileName,
    drafted_msg: analysis.send_followup ? analysis.message : null,
    reasoning: analysis.reasoning,
    decision: analysis.decision,
    category: analysis.category,
    rule_ids: analysis.rule_ids,
    internal_reason: analysis.internal_reason,
    status: analysis.send_followup ? "PENDING" : "CANCELLED"
  });
}

// ============================================================================
// Main Edge Function Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const limit: number | null = body.limit ?? null;
    const jobId: number | null = body.job_id ?? null;

    const sb = getSupabase();

    if (jobId) {
      await sb.from("scan_jobs").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", jobId);
    }

    console.log("[EDGE SCAN] Querying eligible contacts via get_eligible_scan_contacts RPC...");

    // 1. Fetch eligible contacts directly via fast SQL function
    const { data: eligibleContacts, error: rpcErr } = await sb.rpc("get_eligible_scan_contacts", {
      p_hours_lookback: 24,
      p_min_hours_old: 2.0
    });

    if (rpcErr) {
      console.error("[EDGE SCAN RPC ERROR]", rpcErr);
      throw rpcErr;
    }

    let eligible = (eligibleContacts || []).map((c: Record<string, unknown>) => ({
      contact: String(c.contact),
      profile_name: String(c.profile_name || ""),
      last_ts: String(c.last_ts || "")
    }));

    if (limit && limit > 0) {
      eligible = eligible.slice(0, limit);
    }

    const total = eligible.length;
    console.log(`[EDGE SCAN] Found ${total} eligible contacts to evaluate.`);

    if (total === 0) {
      if (jobId) {
        await sb.from("scan_jobs").update({
          status: "COMPLETED", completed_at: new Date().toISOString(),
          total_contacts: 0, total_evaluated: 0, drafts_created: 0, skipped: 0, human_review: 0,
          current_contact: ""
        }).eq("id", jobId);
      }
      return new Response(JSON.stringify({ total_evaluated: 0, drafts_created: 0, skipped: 0 }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (jobId) {
      await sb.from("scan_jobs").update({
        status: "RUNNING", started_at: new Date().toISOString(), total_contacts: total,
        total_evaluated: 0, drafts_created: 0, skipped: 0, human_review: 0
      }).eq("id", jobId);
    }

    const { client, model, temperature } = await getOpenAIClientAndModel();
    const systemPrompt = await loadSystemPrompt();
    const refNow = new Date();

    const stats: ScanStats = { total_evaluated: 0, drafts_created: 0, skipped: 0, errors: 0 };

    // Asynchronous worker processor
    const runProcessing = async () => {
      const CONCURRENCY = 6;
      for (let i = 0; i < eligible.length; i += CONCURRENCY) {
        const batch = eligible.slice(i, i + CONCURRENCY);
        const batchDrafts: Array<Record<string, unknown>> = [];

        await Promise.all(batch.map(async (c) => {
          try {
            const analysis = await analyzeContact(c.contact, c.profile_name, client, model, temperature, systemPrompt, refNow);
            batchDrafts.push({
              contact: c.contact,
              profile_name: c.profile_name,
              drafted_msg: analysis.send_followup ? analysis.message : null,
              reasoning: analysis.reasoning,
              decision: analysis.decision,
              category: analysis.category,
              rule_ids: analysis.rule_ids,
              internal_reason: analysis.internal_reason,
              status: analysis.send_followup ? "PENDING" : "CANCELLED"
            });

            stats.total_evaluated++;
            if (analysis.decision === "SEND") stats.drafts_created++;
            else stats.skipped++;

            console.log(`[${stats.total_evaluated}/${total}] ${c.contact} -> ${analysis.decision}`);
          } catch (e) {
            stats.errors++;
            stats.total_evaluated++;
            console.error(`[ERROR] ${c.contact}: ${e}`);
          }
        }));

        // Check job status in Supabase before processing to allow Pause/Stop/Cancel
        if (jobId) {
          try {
            const { data: jobRow } = await sb.from("scan_jobs").select("status").eq("id", jobId).single();
            const currentStatus = (jobRow?.status || "").toUpperCase();
            if (currentStatus === "STOPPED" || currentStatus === "CANCELLED" || currentStatus === "STOP") {
              console.log(`[EDGE SCAN] Job #${jobId} was stopped by user. Halting scan immediately.`);
              return;
            }
            if (currentStatus === "PAUSED") {
              console.log(`[EDGE SCAN] Job #${jobId} is paused. Waiting for resume or stop...`);
              let isStillPaused = true;
              while (isStillPaused) {
                await new Promise(r => setTimeout(r, 2000));
                const { data: refreshedJob } = await sb.from("scan_jobs").select("status").eq("id", jobId).single();
                const refreshedStatus = (refreshedJob?.status || "").toUpperCase();
                if (refreshedStatus === "STOPPED" || refreshedStatus === "CANCELLED" || refreshedStatus === "STOP") {
                  console.log(`[EDGE SCAN] Job #${jobId} stopped during pause. Halting.`);
                  return;
                }
                if (refreshedStatus === "RUNNING") {
                  console.log(`[EDGE SCAN] Job #${jobId} resumed. Continuing scan.`);
                  isStillPaused = false;
                }
              }
            }
          } catch (_) {}
        }

        // Batch insert drafts to minimize DB roundtrips
        if (batchDrafts.length > 0) {
          try {
            const { error: insErr } = await sb.from("followup_drafts").insert(batchDrafts);
            if (insErr) console.error("[DRAFT INSERT ERROR]", insErr);
          } catch (e) {
            console.error("[DRAFT INSERT EXCEPTION]", e);
          }
        }

        // Update scan_jobs progress
        if (jobId) {
          const lastContact = batch[batch.length - 1]?.contact || "";
          try {
            await sb.from("scan_jobs").update({
              status: "RUNNING",
              total_evaluated: stats.total_evaluated,
              drafts_created: stats.drafts_created,
              skipped: stats.skipped,
              human_review: 0,
              current_contact: lastContact
            }).eq("id", jobId);
          } catch (_) {
            // Non-fatal progress update failure
          }
        }
      }

      if (jobId) {
        await sb.from("scan_jobs").update({
          status: "COMPLETED", completed_at: new Date().toISOString(),
          total_evaluated: stats.total_evaluated, drafts_created: stats.drafts_created,
          skipped: stats.skipped, human_review: 0, current_contact: ""
        }).eq("id", jobId);
      }

      console.log(`[EDGE SCAN COMPLETE] Evaluated: ${stats.total_evaluated}, Drafts: ${stats.drafts_created}, Skipped: ${stats.skipped}`);
    };

    // If invoked with a jobId from UI, execute worker with EdgeRuntime.waitUntil if available or await it
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil && jobId) {
      // @ts-ignore
      EdgeRuntime.waitUntil(runProcessing());
      return new Response(JSON.stringify({ status: "ACCEPTED", job_id: jobId, total_contacts: total }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } else {
      await runProcessing();
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

  } catch (err) {
    console.error("[EDGE SCAN ERROR]", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
});
