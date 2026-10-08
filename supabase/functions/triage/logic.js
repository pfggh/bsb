// Chat triage logic for the follow-up panel (shared by the edge function and the parity tests).
//
// Safety model: deterministic rules may only PROPOSE hiding a chat, and only on explicit evidence
// (the customer's own words, or a follow-up whose text we can read). Every proposal must then be
// confirmed by two independent models. Anything unclear, unreadable or failing stays visible.

export const PLACEHOLDER = "[Outgoing Message]";

const FINAL_RE = /final\s*follow\s*-?\s*up|last\s*follow\s*-?\s*up/i;
const NUDGE_RE = /follow\s*-?\s*up|following up|me[sc]he?\s*e?l\s*hal|wanna activate|still (?:intr?e?s?ted|interested|available)|r u inter|are (?:u|you) inter|^interested\?|were you able|did it work|did the (?:link|access)|2dert tfout|would you like to (?:activate|proceed)|ready to proceed/i;
const GREETING_RE = /^hello! thank you for your message/i;
const BROADCAST_RE = /enjoying your|didn'?t renew|did not renew|subscription has \*?ended|subscription just ended/i;
// The word "paid" is deliberately absent: "I haven't paid yet" must not count as a payment.
const PAID_RE = /whish payment notification|sent the money|ba?3a?tet|hawalet|7awalet|transferred|حولت|بعتت/i;

const CHECKIN_RE = /me[sc]he?\s*e?l\s*hal\s*\?|did it work|were you able|2dert|try (?:it )?now|check now|meche l hal\?/i;
const SUPPORT_CHECK_RE = /me[sc]h[ei]?\s*e?l\s*hal\s*\?|did it work|were you able to (?:log|access|open)|2dert tfout|did the (?:link|access) work/i;
const AUTOREPLY_RE = /thank you for contacting|thanks for contacting|we will (?:get back|reply)|this is an automated|let us know how we can help/i;
const THANKS_RE = /thank|merci|mersi|thx|tnx|\bty\b|shukran|shokran|choukran|شكر|يسلم|\[reacted|\[sticker|🙏|👍|❤|🤍|♥|😍|🥰|💙|👌/iu;
const YES_RE = /^\s*(?:yes+|yea+h?|eh+|ee+|aya|ايه|اي)(?![\p{L}\p{N}_])/iu;
const PLEASANTRY_RE = /^\s*(?:(?:ur|you'?re|you are|u r)\s+)?welcome+\s*(?:dear)?[!.\s🙏❤️]*$|^\s*(?:any ?time|enjoy|ok(?:ay)?y* great|great|np|no problem|take care|tc)\s*(?:dear)?[!.\s🙏❤️]*$|^[\s🙏❤️👍]+$/iu;
const DELIVERY_RE = /https?:\/\/|teshrij\.xyz|open\.anghami|ostories|e-?mail\s*:|password|\bcode\b|@[a-z0-9-]+\./i;
const CUST_SALES_RE = /price|how much|\bade\b|adesh|\bcost|\$|dolar|dollar|\bbade\b|\bbde\b|badde|subscri|shar[ei]j|char[ei]j|charge|month|shaher|chhur|\bsene\b|year|activate|offer|\bplan|learn more|more info|\binfo|details|interest|available|shared|private|3andkon|aandkon|3ndkon|do you have|came from Meta ad|عندكم|اسعار|سعر|اشتراك|شهر|معلومات/i;
const OUR_SALES_RE = /\$|dolar|dollar|whish|per month|\b\d+\s*m(?:onths?)?\s*:|\b1\s*y(?:ear)?\s*:|shared account|private or shared|shared or private|which duration|wanna activate|interest|would you like to (?:activate|proceed)|renew/i;
const MEDIA_ONLY_RE = /^\[(?:image|video|document|media|voice note|whish)/;

// --- customer-wording whitelist -------------------------------------------------------------
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}☀-➿️‍]/gu;
const COURTESY = new Set(`thanks thank thankyou thanku thanx thnx thx tnx tx ty tks tq you u yu y merci mersi shukran shokran choukran
ok oki oky okay okey k tm tmm tmam tamam tamem yes yeah yea yep yup eh e yl yala ah aha deal dear habibi bro so much a lot ktir kter very
khalas done perfect great amazing nice cool god awesome wow love it hi hello hey helo bonjour bonsoir marhaba mar7aba salam
شكرا شكراً ميرسي تمام اوكي ok ايه اه مرسي يسلمو كتير`.split(/\s+/));
const GREETINGS = new Set("hi hello hey helo bonjour bonsoir marhaba mar7aba salam".split(" "));
// strong: only ever means "it works"
const SUCCESS = [/\bit (?:works|worked|is working)\b/g, /\bits working\b/g, /\bworks now\b/g, /\bworked\b/g, /\bworks\b/g,
  /\bzabat(?:et|it)?\b/g, /\bfixed\b/g, /\bsolved\b/g, /\bresolved\b/g, /\bfata7\b/g, /\bfete7\b/g, /زبط/g, /اشتغل/g];
// weak: "it works" OR "ok, fine" - only trusted as an answer to our check-in
const WEAK = [/\bm[ae]?[sc]h[aei]{0,2} ?(?:e?l ?)?(?:h|7)[ae]l\b/g, /مشي الحال/g];
const DECLINE = [/\bno,? ?(?:thanks|thank you|thank u|thankyou|thx|tnx|merci|ty)\b/g, /\bno need\b/g, /\bnot interested\b/g,
  /\b(?:i )?changed my mind\b/g, /\bma ?ba?d+e\b/g, /\bla2? merci\b/g, /لا شكرا/g, /نو شكرا/g, /ما بدي/g, /مش مهتم/g];
const SALES_WORDS_RE = /price|how much|ade\b|adesh|\bbade\b|\bbde\b|subscri|sharej|charej|charge|month|shaher|sene|year|activate|offer|plan|اسعار|سعر|اشتراك|شهر/i;

function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function norm(t) {
  t = t.toLowerCase();
  t = t.replace(/\[(?:reacted[^\]]*|sticker)\]/g, " ");
  t = t.replace(EMOJI_RE, " ");
  t = t.replace(/'/g, "").replace(/’/g, "");
  t = t.replace(/([a-z])\1+/g, "$1"); // thankss -> thanks, mercii -> merci
  t = t.replace(/[.,!/\-_*~]+/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** -> "courtesy" | "success" | "weak" | "decline" | "blocker" */
export function classifyMsg(text) {
  if (text == null || text.includes("?") || text.includes("؟")) return "blocker";
  if (MEDIA_ONLY_RE.test(text) || text.includes("Whish payment") || text.includes("http")) return "blocker";
  let n = norm(text);
  let kind = "courtesy";
  for (const [pats, k] of [[DECLINE, "decline"], [SUCCESS, "success"], [WEAK, "weak"]]) {
    for (const p of pats) {
      p.lastIndex = 0;
      if (p.test(n)) {
        p.lastIndex = 0;
        n = n.replace(p, " ");
        kind = k;
        break;
      }
    }
    if (kind !== "courtesy") break;
  }
  const words = n.split(/\s+/).filter(Boolean);
  if (kind === "courtesy" && words.length && words.every((w) => GREETINGS.has(w))) return "blocker"; // a bare greeting opens a new request
  return words.some((w) => !COURTESY.has(w)) ? "blocker" : kind;
}

function blockVerdict(blockTexts, customerTexts, paid, afterCheckin) {
  const kinds = blockTexts.map(classifyMsg);
  if (!kinds.length || kinds.includes("blocker")) return null;
  if (kinds.includes("decline")) return "declined";
  if (kinds.includes("success") || (kinds.includes("weak") && afterCheckin)) {
    // success words can mean "ok, go ahead" in a sale: only trust them if no open sale is possible
    if (paid || !customerTexts.some((t) => SALES_WORDS_RE.test(t || ""))) return "confirmed";
  }
  return null;
}

// --- message normalisation --------------------------------------------------------------------
/** Readable one-line text for a bsb_messages row; null when our outgoing text was not captured. */
export function cleanText(direction, message, mediaType) {
  const t = (message || "").trim();
  const mt = (mediaType || "").toLowerCase();
  const low = t.toLowerCase();
  if (direction === "Outgoing" && (!t || t === PLACEHOLDER)) return null;
  if (low.includes("reaction received")) {
    const m = t.match(/Reaction Received\*?:\s*(\S+)/u);
    return `[reacted ${m ? m[1] : ""}]`.replace(" ]", "]");
  }
  if (low.includes("sticker received")) return "[sticker]";
  if (low.includes("voice message") || mt === "audio") return "[voice note]";
  if (low.includes("whish.money") && low.includes("transfer")) {
    const note = t.match(/Note:\s*([^/\n]+)/);
    return "[Whish payment notification" + (note ? `, note: ${note[1].trim()}` : "") + "]";
  }
  if (t.includes("From Ad/Post")) {
    const head = stripChars(t.split("📢")[0], " /\n");
    const hl = t.match(/Headline\*?:\s*([^/\n]+)/);
    return `${head} [came from Meta ad${hl ? ": " + hl[1].trim() : ""}]`;
  }
  if (t.startsWith("↩️") || t.includes("*Reply*")) {
    const orig = t.match(/Original Message\*?:\s*([\s\S]*?)📝/u);
    const rep = t.match(/📝 \*Reply\*:\s*([\s\S]*?)(?:🔗|$)/u);
    const o = orig ? stripChars(orig[1].replace(/\s+/g, " "), " /") : "";
    const r = rep ? stripChars(rep[1].replace(/\s+/g, " "), " /") : t;
    return `(replying to "${Array.from(o).slice(0, 80).join("")}") ${r}`;
  }
  if (t.includes("Media Received")) {
    const kind = ["image", "video", "document"].includes(mt) ? mt : "media";
    const cap = stripChars(t.replace("📎 *Media Received*", ""), " /");
    return `[${kind}]` + (cap ? ` ${cap}` : "");
  }
  if (["image", "video", "document"].includes(mt) && t) return `[${mt}] ${t}`;
  return t.replace(/\s*\n\s*/g, " / ");
}

/**
 * Build the chronological message list the rules work on.
 * rows: bsb_messages rows {direction, message, media_type, timestamp} (any order, already windowed);
 * sentTexts: [{message, sent_at}] from send_queue, used to recover text of messages sent from this panel.
 */
export function prepareMessages(rows, sentTexts = []) {
  const msgs = rows
    .map((r) => ({ id: r.id, direction: r.direction, ts: new Date(r.timestamp).getTime(), text: cleanText(r.direction, r.message, r.media_type) }))
    .sort((a, b) => a.ts - b.ts || (a.id || 0) - (b.id || 0));
  for (const m of msgs) {
    if (m.direction === "Outgoing" && m.text === null) {
      const s = sentTexts.find((x) => Math.abs(new Date(x.sent_at).getTime() - m.ts) < 180_000);
      if (s) m.text = s.message;
    }
  }
  return msgs;
}

/** Tag each outgoing message as greeting / nudge / reply (works without captured text). */
function mark(msgs) {
  let lastOutTs = null;
  msgs.forEach((m, i) => {
    m.role = null;
    if (m.direction === "Incoming") return;
    const txt = m.text;
    const prev = i > 0 ? msgs[i - 1] : null;
    const sincePrev = prev ? (m.ts - prev.ts) / 1000 : null;
    const sinceOut = lastOutTs !== null ? (m.ts - lastOutTs) / 1000 : null;
    let role;
    if (txt && GREETING_RE.test(txt)) role = "greeting";
    else if (txt == null && prev && prev.direction === "Incoming" && sincePrev <= 90 && (sinceOut === null || sinceOut >= 6 * 3600)) role = "greeting";
    else if (txt && BROADCAST_RE.test(txt) && (!prev || prev.direction === "Outgoing")) role = "nudge";
    else if (prev && prev.direction === "Outgoing" && prev.role !== "greeting" && sincePrev >= 7200) role = "nudge";
    else if (txt && NUDGE_RE.test(txt) && prev && prev.direction === "Outgoing" && prev.role !== "greeting") role = "nudge";
    else role = "reply";
    m.role = role;
    lastOutTs = m.ts;
  });
}

function salesContext(msgs) {
  return msgs.some((m) => (m.direction === "Incoming" && CUST_SALES_RE.test(m.text || "")) ||
    (m.direction === "Outgoing" && OUR_SALES_RE.test(m.text || "")));
}

function ackCandidate(msgs, block, j, prevUs, paid) {
  if (!block.length || !block.every((m) => classifyMsg(m.text) === "courtesy")) return false;
  const texts = block.map((m) => m.text || "");
  const answeredCheckin = !!(prevUs && prevUs.text && CHECKIN_RE.test(prevUs.text) && texts.some((t) => YES_RE.test(t)));
  if (!(texts.some((t) => THANKS_RE.test(t)) || answeredCheckin)) return false; // a bare "ok"/"yes"/"done" is not a confirmation
  if (salesContext(msgs) && !paid) return false; // thanks after prices/info = open sale
  // what we said since the customer's last real request must be readable text (not missing, not voice/media)
  let k = j;
  while (k >= 0 && !(msgs[k].direction === "Incoming" && classifyMsg(msgs[k].text) === "blocker")) k--;
  const ours = msgs.slice(k + 1, j + 1).filter((m) => m.direction === "Outgoing" && m.role !== "greeting");
  if (k < 0 || !ours.length || !ours.every((m) => m.text && !m.text.startsWith("["))) return false;
  // nothing substantive from us after the thanks (only "ur welcome"-type pleasantries, all readable)
  const after = msgs.slice(msgs.indexOf(block[block.length - 1]) + 1).filter((m) => m.direction === "Outgoing" && m.role !== "greeting");
  if (!after.every((m) => m.text && PLEASANTRY_RE.test(m.text))) return false;
  // after a payment, we must visibly have delivered something (link / credentials / code)
  if (paid) {
    let lastPay = -1;
    msgs.forEach((m, i) => { if (m.direction === "Incoming" && PAID_RE.test(m.text || "")) lastPay = i; });
    if (!msgs.slice(lastPay + 1).some((m) => m.direction === "Outgoing" && DELIVERY_RE.test(m.text || ""))) return false;
  }
  return true;
}

/**
 * Deterministic part of the triage.
 * Returns {status, reason, candidate}; candidate=true means a rule proposes hiding (still needs the AI check).
 */
export function deterministic(msgs, nowMs) {
  mark(msgs);
  let lastIn = -1;
  msgs.forEach((m, i) => { if (m.direction === "Incoming") lastIn = i; });
  if (lastIn < 0) return { status: "OPEN", reason: "No customer message in the last 72h", candidate: false };
  const trailing = msgs.slice(lastIn + 1);
  const realAfter = trailing.filter((m) => m.role !== "greeting");
  // customer's latest block (consecutive customer messages, skipping instant auto-greetings)
  const block = [];
  let j = lastIn;
  while (j >= 0 && (msgs[j].direction === "Incoming" || msgs[j].role === "greeting")) {
    if (msgs[j].direction === "Incoming") block.unshift(msgs[j]);
    j--;
  }
  const prevUs = j >= 0 ? msgs[j] : null; // our last message before the customer's block
  const afterCheckin = !!(prevUs && (prevUs.role === "nudge" || (prevUs.text && CHECKIN_RE.test(prevUs.text))));
  const custTexts = msgs.filter((m) => m.direction === "Incoming").map((m) => m.text);
  const paid = custTexts.some((t) => PAID_RE.test(t || ""));
  const hours = Math.round((nowMs - msgs[lastIn].ts) / 360000) / 10;

  // 1) other businesses' auto-replies (every customer message is an auto-reply or a reaction)
  if (custTexts.every((t) => AUTOREPLY_RE.test(t || "") || classifyMsg(t) === "courtesy") && custTexts.some((t) => AUTOREPLY_RE.test(t || ""))) {
    return { status: "NOT_RELEVANT", reason: "Automatic reply from another business", candidate: true };
  }
  // 2) customer explicitly confirmed it works / explicitly declined
  const v = blockVerdict(block.map((m) => m.text), custTexts, paid, afterCheckin);
  if (v === "declined") return { status: "DECLINED", reason: "Customer explicitly declined", candidate: true };
  if (v === "confirmed" && (paid || !salesContext(msgs))) return { status: "CONFIRMED", reason: "Customer confirmed it works", candidate: true };
  // 2b) a bare thanks / reaction - only when everything we said around it is readable
  if (ackCandidate(msgs, block, j, prevUs, paid)) return { status: "ACKNOWLEDGED", reason: "Customer thanked after our answer", candidate: true };
  // 3) a final follow-up whose text we can read, sent after we had really answered the customer's last message
  if (realAfter.length) {
    const isFollowup = (m) => m.text && (FINAL_RE.test(m.text) || SUPPORT_CHECK_RE.test(m.text));
    const firstFollowup = trailing.findIndex(isFollowup);
    if (firstFollowup >= 0) {
      const answeredFirst = block.every((m) => classifyMsg(m.text) === "courtesy") || trailing.slice(0, firstFollowup).some((m) =>
        m.role !== "greeting" && !(m.text && (FINAL_RE.test(m.text) || SUPPORT_CHECK_RE.test(m.text) || NUDGE_RE.test(m.text))));
      const finalText = trailing.some((m) => m.text && FINAL_RE.test(m.text));
      const supportOk = !salesContext(msgs) || paid; // a sales lead only ends with the literal "Final Followup;"
      if (answeredFirst && (finalText || supportOk)) {
        return { status: "FOLLOWED_UP", reason: finalText ? "Final follow-up sent, no reply" : "Support check-in sent, no reply", candidate: true };
      }
    }
  }
  // everything else stays visible
  if (!realAfter.length) {
    if (block.length && block.every((m) => classifyMsg(m.text) !== "blocker")) {
      return { status: "OPEN", reason: "Customer said thanks/ok - check nothing is still pending", candidate: false };
    }
    return { status: "NEEDS_REPLY", reason: `Customer waiting for our reply (${hours}h)`, candidate: false };
  }
  const nudges = trailing.filter((m) => m.role === "nudge").length;
  if (nudges) return { status: "OPEN", reason: `${nudges} follow-up${nudges > 1 ? "s" : ""} sent, no final follow-up yet`, candidate: false };
  return { status: "OPEN", reason: `We replied, customer hasn't confirmed (${hours}h)`, candidate: false };
}

// --- AI confirmation ----------------------------------------------------------------------------
const BEIRUT_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Beirut", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function buildTranscript(msgs) {
  return msgs.map((m) => {
    const ts = BEIRUT_FMT.format(new Date(m.ts)).replace(",", "");
    if (m.direction === "Incoming") return `[${ts}] CUSTOMER: ${(m.text || "").slice(0, 300)}`;
    const tag = m.role === "greeting" ? " (auto-greeting)" : m.role === "nudge" ? " (follow-up nudge)" : "";
    return `[${ts}] US${tag}: ${m.text ? m.text.slice(0, 300) : "(text not captured)"}`;
  }).join("\n");
}

export function lastCustomerMessages(msgs, n = 4) {
  return msgs.filter((m) => m.direction === "Incoming").slice(-n).map((m) => m.text);
}

export const VETO_PROMPT = `You double-check WhatsApp chats of Teshrij, a Lebanese reseller of digital subscriptions (ChatGPT, Netflix, Shahid, Anghami, Spotify, Adobe, Canva, Gemini, CapCut...). Customers write English, Arabic or Lebanese Arabizi ("meshe l hal" = it works OR "ok, fine"; "zabat" = it worked; "ma bade" = I don't want; "b3atet"/"hawalet" = I sent the money; "bkra" = tomorrow).

A rule flagged this chat as finished, so it will be HIDDEN from the human agents. Hiding a chat that still needs anything from us is a serious mistake. Leaving a finished chat visible is harmless. Only answer "no" when you are certain.

"US: (text not captured)" means we sent a message but its text is unknown. So a customer's "ok", "thanks" or "meshe l hal" might be answering a promise such as "it will be ready tomorrow" - if that is possible, answer "unsure".

1. pending: is the customer still waiting, or could they be waiting, for anything from us (an answer, account, link, code, invite, activation, refund, fix, delivery after payment, or help with an earlier unresolved problem)?
2. sale_open: did the customer show interest in buying something that they have neither paid for nor clearly declined? Asking about a product, asking for info/details/prices, or receiving our prices all count as interest. "thanks", "merci", "ok" or a reaction after prices is NOT a decline, so sale_open is "yes".

Reply with JSON only: {"pending": "no|yes|unsure", "sale_open": "no|yes|unsure", "reason": "<= 12 words"}`;

export const VETO_FOLLOWUP_PROMPT = `You double-check WhatsApp chats of Teshrij, a Lebanese reseller of digital subscriptions. Customers write English, Arabic or Lebanese Arabizi.

We already sent our final follow-up in this chat and the customer has not replied since, so the chat will be HIDDEN from the human agents. That is correct ONLY if the customer is not left waiting on us. Hiding a chat where the customer still waits for something from us is a serious mistake; leaving it visible is harmless.

"US: (text not captured)" means we sent a message whose text is unknown; treat it as our answer to the customer's previous message.

Question: before our follow-up, did the customer ask for, report or send something that we never handled - a question we did not answer, a problem we did not address, a payment we did not deliver for, or a request (link, code, account, refund) we did not fulfil? Answer "no" only when you are certain every customer request was handled.

Reply with JSON only: {"unhandled": "no|yes|unsure", "reason": "<= 12 words"}`;

/** True only if the model's answer explicitly says nothing is pending. */
export function vetoPasses(status, answer) {
  if (!answer || typeof answer !== "object") return false;
  return status === "FOLLOWED_UP" ? answer.unhandled === "no" : answer.pending === "no" && answer.sale_open === "no";
}
