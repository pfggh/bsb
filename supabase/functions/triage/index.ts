/**
 * triage — decides which live-panel chats (teshrij.xyz/bsb) can be hidden.
 *
 * Only re-checks conversations whose signature changed since their last verdict. Rules in logic.js
 * propose hiding on explicit evidence; a hide happens only if BOTH models confirm nothing is pending.
 * Any error, timeout or doubt leaves the chat visible.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildTranscript,
  deterministic,
  lastCustomerMessages,
  prepareMessages,
  VETO_FOLLOWUP_PROMPT,
  VETO_PROMPT,
  vetoPasses,
} from "./logic.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_MODELS = ["gpt-4.1-mini", "gpt-5.4-mini"];
const TIME_BUDGET_MS = 100_000;
const CHUNK = 20;
const WINDOW_MS = 72 * 3600 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function askModel(model: string, system: string, user: string, apiKey: string) {
  const body: Record<string, unknown> = {
    model,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (model.startsWith("gpt-5")) body.reasoning_effort = "none";
  else body.temperature = 0;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`${model} HTTP ${resp.status}`);
  const data = await resp.json();
  return {
    answer: JSON.parse(data.choices[0].message.content),
    tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0),
  };
}

// deno-lint-ignore no-explicit-any
async function fetchAll(query: () => any) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  // Signed-in agents or server-side callers with the service key (the anon key alone is not enough)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token !== SUPABASE_SERVICE_KEY) {
    const { data: userData } = await sb.auth.getUser(token);
    if (!userData?.user) return json({ error: "Sign in required" }, 401);
  }

  try {
    const { data: cfgRows } = await sb.from("followup_config").select("key, value").in("key", ["openai", "triage"]);
    const cfg = Object.fromEntries((cfgRows || []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
    // deno-lint-ignore no-explicit-any
    const apiKey: string = Deno.env.get("OPENAI_API_KEY") || (cfg.openai as any)?.api_key || "";
    // deno-lint-ignore no-explicit-any
    const models: string[] = (cfg.triage as any)?.models || DEFAULT_MODELS;

    const { data: inbox, error: inboxErr } = await sb.rpc("get_followup_inbox", { hours_lookback: 24, min_hours_old: 2.0 });
    if (inboxErr) throw new Error(inboxErr.message);
    // deno-lint-ignore no-explicit-any
    const stale = (inbox || []).filter((c: any) => !c.triage_fresh);
    const now = Date.now();
    const since = new Date(now - WINDOW_MS).toISOString();
    const stats = { checked: 0, hidden: 0, shown: 0, ai_calls: 0, tokens: 0, remaining: 0 };

    for (let i = 0; i < stale.length; i += CHUNK) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        stats.remaining = stale.length - i;
        break;
      }
      const chunk = stale.slice(i, i + CHUNK);
      // deno-lint-ignore no-explicit-any
      const contacts = chunk.map((c: any) => c.contact);
      const [messages, sent] = await Promise.all([
        fetchAll(() => sb.from("bsb_messages").select("id, contact, direction, message, media_type, timestamp")
          .in("contact", contacts).gte("timestamp", since).order("id", { ascending: true })),
        fetchAll(() => sb.from("send_queue").select("contact, message, sent_at")
          .in("contact", contacts).eq("status", "SENT").gte("sent_at", since).order("id", { ascending: true })),
      ]);

      // deno-lint-ignore no-explicit-any
      const results = await Promise.all(chunk.map(async (c: any) => {
        // deno-lint-ignore no-explicit-any
        const rows = messages.filter((m: any) => m.contact === c.contact)
          .sort((a: any, b: any) => (b.timestamp < a.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : b.id - a.id))
          .slice(0, 30);
        // deno-lint-ignore no-explicit-any
        const msgs = prepareMessages(rows, sent.filter((s: any) => s.contact === c.contact));
        const d = deterministic(msgs, now);
        const row = {
          contact: c.contact,
          signature: c.signature,
          verdict: "SHOW",
          status: d.status,
          reason: d.reason,
          method: "rule",
          votes: null as unknown,
          tokens: 0,
          updated_by: "triage",
          updated_at: new Date().toISOString(),
        };
        if (!d.candidate) return row;

        row.method = "rule+ai";
        if (!apiKey) {
          row.reason += " (kept visible: AI check unavailable)";
          return row;
        }
        const system = d.status === "FOLLOWED_UP" ? VETO_FOLLOWUP_PROMPT : VETO_PROMPT;
        const user = `Transcript (oldest first, Beirut time):\n${buildTranscript(msgs)}\n\nCustomer's latest message(s):\n` +
          lastCustomerMessages(msgs).map((t: string) => `- ${t}`).join("\n");
        const votes = await Promise.all(models.map((model) =>
          askModel(model, system, user, apiKey)
            .then((r) => ({ model, ok: vetoPasses(d.status, r.answer), answer: r.answer, tokens: r.tokens }))
            .catch((e) => ({ model, ok: false, answer: { error: String(e).slice(0, 160) }, tokens: 0 }))
        ));
        stats.ai_calls += votes.length;
        row.tokens = votes.reduce((s, v) => s + v.tokens, 0);
        row.votes = votes;
        if (votes.length >= 2 && votes.every((v) => v.ok)) row.verdict = "HIDE";
        else row.reason += " (kept visible: AI not certain)";
        return row;
      }));

      const { error: upErr } = await sb.from("chat_triage").upsert(results, { onConflict: "contact" });
      if (upErr) throw new Error(upErr.message);
      for (const r of results) {
        stats.checked++;
        stats.tokens += r.tokens;
        if (r.verdict === "HIDE") stats.hidden++;
        else stats.shown++;
      }
    }

    return json({ success: true, ...stats, duration_ms: Date.now() - started });
  } catch (err) {
    console.error("[triage]", err);
    return json({ success: false, error: String((err as Error)?.message || err) }, 500);
  }
});
