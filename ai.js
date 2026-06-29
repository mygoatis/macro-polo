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

Today (${dayContext.date}):
Current totals: ${JSON.stringify(dayContext.totals)}
Logged items (id, name, qty x unit, per-unit nutrition):
${dayContext.entries.map((e) => `- ${e.id}: ${e.name} — ${e.qty} x ${e.unit} @ ${JSON.stringify(e.per)}`).join('\n') || '(none)'}

When the user asks you to change the day (e.g. "scale the rice so I hit 2400 kcal", "add a snack to reach 180g protein"), do the math precisely and then, AFTER your short explanation, output a fenced code block labelled tally-actions containing a JSON array of actions. Action shapes:
{"op":"setQty","entryId":"<id>","qty":<number>}
{"op":"delete","entryId":"<id>"}
{"op":"add","meal":"<meal name>","name":"<food>","unit":"<portion>","qty":<number>,"per":{"kcal":n,"protein":n,"carbs":n,"fat":n,"sodium":n,"fiber":n,"sugar":n}}
Only include tally-actions when you are proposing concrete changes. Nutrition values in "per" are per single unit. Round quantities sensibly.`;

  const messages = history.map((m) => ({ role: m.role, content: m.text }));
  const text = await callClaude({ apiKey: settings.apiKey, model: settings.model, system, messages, max_tokens: 1024 });

  let actions = null;
  const block = text.match(/```tally-actions\s*([\s\S]*?)```/);
  if (block) { try { actions = JSON.parse(block[1].trim()); } catch {} }
  const clean = text.replace(/```tally-actions[\s\S]*?```/g, '').trim();
  return { text: clean || 'Done.', actions };
}
