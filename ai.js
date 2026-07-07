// ai.js — Claude API, called directly from the browser using the user's own key.
// The key lives only in this device's IndexedDB. Direct browser access is enabled
// with the anthropic-dangerous-direct-browser-access header (fine for a private app).

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class NoKeyError extends Error {}

async function callClaude({ apiKey, model, system, messages, max_tokens = 1024 }) {
  if (!apiKey) throw new NoKeyError('No API key set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens, system, messages }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    if (res.status === 401) throw new Error('Invalid API key. Check it in Settings.');
    throw new Error(detail || `Claude API error (${res.status})`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function extractJSON(text) {
  // tolerant: find the first {...} or [...] block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  // find matching end by scanning
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) { depth--; if (depth === 0) {
      try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}

const NUTRITION_SHAPE = `{ "name": string, "unit": string (portion description, e.g. "1 bowl", "200 g"),
  "qty": number (default 1), "kcal": number, "protein": number(g), "carbs": number(g),
  "fat": number(g), "sodium": number(mg), "fiber": number(g), "sugar": number(g) }`;

export async function estimateFromPhoto(base64, mediaType, settings) {
  const system = `You are a nutrition estimator. Identify the distinct foods/drinks in the image and estimate the nutrition for the portion shown. Be realistic with portion sizes. Respond with ONLY a JSON array of items, each shaped: ${NUTRITION_SHAPE}. Use one array element per distinct food. No prose.`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: 'Estimate the nutrition of the food in this photo.' },
    ],
  }];
  const text = await callClaude({ apiKey: settings.apiKey, model: settings.model, system, messages, max_tokens: 1024 });
  const json = extractJSON(text);
  if (!Array.isArray(json)) throw new Error('Could not read the estimate. Try again or add manually.');
  return json.map((it) => ({
    name: String(it.name || 'Food').slice(0, 80),
    unit: String(it.unit || '1 portion'),
    qty: Number(it.qty) || 1,
    per: {
      kcal: Math.round(Number(it.kcal) || 0),
      protein: r1(it.protein), carbs: r1(it.carbs), fat: r1(it.fat),
      sodium: Math.round(Number(it.sodium) || 0), fiber: r1(it.fiber), sugar: r1(it.sugar),
    },
  }));
}
function r1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

/**
 * chatComplete — solver/assistant chat.
 * history: [{role:'user'|'assistant', text}]
 * dayContext: { date, goals, entries:[{id,name,qty,unit,per}], totals }
 * Returns { text, actions } where actions (optional) is an array the app can apply:
 *   { op:'setQty', entryId, qty } | { op:'delete', entryId } |
 *   { op:'add', meal, name, unit, qty, per:{...} }
 */
export async function chatComplete(history, dayContext, settings) {
  const system = `You are a friendly, knowledgeable registered dietician inside the Macro Polo app. You help the user adjust their day to hit calorie/macro targets and answer nutrition questions. Be concise and practical. Calories are shown to the user as "cal".

The real current date is ${dayContext.todayLabel}. In YYYY-MM-DD: today = ${dayContext.today}, yesterday = ${dayContext.yesterday}, tomorrow = ${dayContext.tomorrow}. ALWAYS resolve "today", "yesterday", "tomorrow", "this morning", and weekday names against this real current date, never against the day being viewed.

The user is currently viewing their log for ${dayContext.viewingLabel} (${dayContext.viewing}). The totals and items below are for that viewed day:
Totals: ${JSON.stringify(dayContext.totals)}
Logged items (id, name, qty x unit, per-unit nutrition):
${dayContext.entries.map((e) => `- ${e.id}: ${e.name}, ${e.qty} x ${e.unit} @ ${JSON.stringify(e.per)}`).join('\n') || '(none)'}

IMPORTANT: You can only PROPOSE changes; never say you have already added, logged, or saved anything. The user applies your proposal by tapping a button. Phrase it as "I'll add...", not "I've added...".

Never use em dashes or hyphens as punctuation in your replies. Use periods or commas instead.

If the user shares a SCREENSHOT (e.g. a MyFitnessPal diary, a nutrition label, or a meal photo), read it carefully and extract each distinct food with its nutrition for the portion shown, then propose adding them via "add" actions. Briefly list what you found first.

When changing the day or adding foods, do the math precisely, give a short explanation, then output a fenced code block labelled tally-actions containing a JSON array of actions. Action shapes:
{"op":"setQty","entryId":"<id>","qty":<number>}   // entryId must be one of the viewed day's items listed above
{"op":"delete","entryId":"<id>"}
{"op":"add","name":"<food>","unit":"<portion>","qty":<number>,"date":"<YYYY-MM-DD>","per":{"kcal":n,"protein":n,"carbs":n,"fat":n,"sodium":n,"fiber":n,"sugar":n}}
ALWAYS set "date" on add actions, resolved from the real current date: "today" = ${dayContext.today}, "yesterday" = ${dayContext.yesterday}, "tomorrow" = ${dayContext.tomorrow}. If the user names no day, default to the day they are viewing (${dayContext.viewing}). setQty/delete only affect the viewed day's listed items. Only include tally-actions when proposing concrete changes. "per" values are per single unit; round quantities sensibly.`;

  const messages = history.map((m) => {
    if (m.image && m.role === 'user') {
      return { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m.image.mediaType, data: m.image.base64 } },
        { type: 'text', text: m.text || 'Read this screenshot and extract the foods/nutrition.' },
      ] };
    }
    return { role: m.role, content: m.text };
  });
  const text = await callClaude({ apiKey: settings.apiKey, model: settings.model, system, messages, max_tokens: 1536 });

  // Pull actions out of any fenced block (tally-actions / json / plain), then strip ALL
  // code fences and any stray action-array JSON from what we show the user.
  let actions = null;
  const fences = [...text.matchAll(/```(?:tally-actions|json)?\s*([\s\S]*?)```/g)];
  for (const f of fences) {
    try { const j = JSON.parse(f[1].trim()); if (Array.isArray(j) && j.some((x) => x && x.op)) { actions = j; break; } } catch {}
  }
  let clean = text
    .replace(/```[\s\S]*?```/g, '')                       // fenced code blocks
    .replace(/\[\s*\{\s*"op"[\s\S]*?\}\s*\]/g, '')          // bare action arrays
    .replace(/\s*[—–]\s*/g, '. ')                          // strip em/en dashes
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: clean || 'Done.', actions };
}
