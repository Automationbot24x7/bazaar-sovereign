// Merchant "brains": Claude picks each NPC's doctrine + a line of dialogue.
// Falls back to a personality-driven heuristic when no ANTHROPIC_API_KEY is set.
import { GOODS, STANCES, netWorth } from './engine.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
import { readFileSync } from 'node:fs';
if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_KEY_FILE) {
  try { process.env.ANTHROPIC_API_KEY = readFileSync(process.env.ANTHROPIC_KEY_FILE, 'utf8').trim(); } catch (e) { console.warn('Could not read ANTHROPIC_KEY_FILE:', e.message); }
}
export const aiOn = () => Boolean(process.env.ANTHROPIC_API_KEY);

const DOCTRINE_TOOL = {
  name: 'set_doctrine',
  description: 'Set this merchant\'s trading doctrine for the coming days and say one line out loud in the bazaar.',
  input_schema: {
    type: 'object',
    properties: {
      stance: { type: 'string', enum: STANCES, description: 'steady=fair markup; undercut=beat the cheapest rival; corner=buy up all supply of focus good and set the price; hoard=stockpile and sell only at high prices; premium=low volume, high margin; liquidate=dump stock for cash' },
      focus: { type: ['string', 'null'], enum: [...GOODS.map(g => g.id), null] },
      aggression: { type: 'number', minimum: 0, maximum: 1 },
      bark: { type: 'string', description: 'One short in-character line (max 14 words) shouted in the bazaar. No hashtags, no emojis.' },
      thought: { type: 'string', description: 'One sentence of private reasoning.' },
    },
    required: ['stance', 'focus', 'aggression', 'bark', 'thought'],
  },
};

function snapshot(w, me) {
  return {
    day: w.day,
    prices: w.prices,
    trend: Object.fromEntries(GOODS.map(g => { const h = w.history[g.id]; return [g.id, +(h.at(-1) - (h.at(-6) ?? h[0])).toFixed(2)]; })),
    activeEvents: w.active.map(e => `${e.text} (${e.left}d left)`),
    rumor: w.pending ? w.pending.rumor : null,
    me: { gold: me.gold, inventory: me.inventory, avgCost: me.cost, lastPnl: me.lastPnl, doctrine: me.doctrine },
    rivals: w.merchants.filter(m => m !== me).map(m => ({
      name: m.name, bankrupt: m.bankrupt, doctrine: m.doctrine.stance + (m.doctrine.focus ? `:${m.doctrine.focus}` : ''),
      netWorth: Math.round(netWorth(w, m)), lastAsk: m.lastAsk, lastBark: m.bark,
    })),
  };
}

async function callClaude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, system,
      tools: [DOCTRINE_TOOL], tool_choice: { type: 'tool', name: 'set_doctrine' },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const out = j.content.find(c => c.type === 'tool_use')?.input;
  if (!out) throw new Error('Claude returned no doctrine');
  return out;
}

function clean(d) {
  return {
    stance: STANCES.includes(d.stance) ? d.stance : 'steady',
    focus: GOODS.some(g => g.id === d.focus) ? d.focus : null,
    aggression: Math.min(1, Math.max(0, Number(d.aggression) || 0.5)),
  };
}

// ---------- NPC turn ----------
export async function think(w, m) {
  if (aiOn()) {
    const system = `You are ${m.name}, a merchant in a desert bazaar trading saffron, silk, tea and salt. Personality: ${m.persona}
Your goal: grow your net worth and outlast rivals; a merchant whose gold drops below zero goes bankrupt and their charter can be bought by a rival.
Mechanics: suppliers auction stock each day (highest bid buys first); townsfolk buy from the cheapest stall that has stock; daily stall rent 18 gold plus an 8% bazaar tax on sales plus storage; tea spoils 6%/day. Rumors predict tomorrow's event. Cornering a good means outbidding everyone for supply, then pricing high while you are the only seller.
Stay in character. Decide with the set_doctrine tool.`;
    try {
      const d = await callClaude(system, `Market report:\n${JSON.stringify(snapshot(w, m))}`);
      return { ...clean(d), bark: String(d.bark || '').slice(0, 120), thought: String(d.thought || '').slice(0, 200), engine: 'claude' };
    } catch (e) { console.warn(`Claude unavailable for ${m.name}, using fallback: ${e.message.slice(0, 80)}`); }
  }
  return { ...heuristic(w, m), engine: 'heuristic' };
}

// ---------- Player's natural-language orders -> doctrine ----------
export async function interpretOrder(w, me, order) {
  if (aiOn()) {
    const system = `You are the loyal factor (head clerk) of the player's merchant house in a bazaar game. Translate the owner's order into a trading doctrine using set_doctrine. "bark" is your short reply to the owner (max 14 words, in character, e.g. "At once — every pinch of saffron in town will be ours."). "thought" explains the plan in one sentence.`;
    try {
      const d = await callClaude(system, `Owner's order: "${order}"\nMarket report:\n${JSON.stringify(snapshot(w, me))}`);
      return { ...clean(d), bark: d.bark, thought: d.thought, engine: 'claude' };
    } catch (e) { console.warn(`Claude unavailable for order, using fallback: ${e.message.slice(0, 80)}`); }
  }
  const q = order.toLowerCase();
  const focus = GOODS.find(g => q.includes(g.id))?.id || null;
  const stance = STANCES.find(s => q.includes(s)) || (/monopol|buy (it )?all|corner/.test(q) ? 'corner' : /cheap|beat|undercut/.test(q) ? 'undercut' : /sell|dump|cash/.test(q) ? 'liquidate' : /hold|stock|hoard/.test(q) ? 'hoard' : 'steady');
  return { stance, focus, aggression: /all|every|crush|hard/.test(q) ? 0.9 : 0.6, bark: `As you command — ${stance}${focus ? ' on ' + focus : ''}.`, thought: 'Parsed from keywords (no AI key set).', engine: 'heuristic' };
}

// ---------- fallback brain ----------
function heuristic(w, m) {
  const t = m.persona.toLowerCase();
  if (m.gold < 40) return { stance: 'liquidate', focus: null, aggression: 0.3, bark: 'Everything must go — today only!', thought: 'Low on gold.' };
  if (w.pending?.supply) {
    const [good, mult] = Object.entries(w.pending.supply)[0];
    if (mult < 1 && /bold|greedy|schem/.test(t)) return { stance: 'corner', focus: good, aggression: 0.8, bark: `Buy all the ${good}. Trust me.`, thought: 'Shortage rumor.' };
  }
  if (w.pending?.demand && /patient|cautious/.test(t)) return { stance: 'hoard', focus: null, aggression: 0.5, bark: 'Patience. The festival pays for everything.', thought: 'Festival rumor.' };
  if (/undercut|quick|cheap/.test(t)) return { stance: 'undercut', focus: null, aggression: 0.6, bark: 'Why pay more? Kasim is always cheaper!', thought: 'Default.' };
  if (/premium|silk|noble/.test(t)) return { stance: 'premium', focus: 'silk', aggression: 0.5, bark: 'Quality is never cheap, darling.', thought: 'Default.' };
  return { stance: 'steady', focus: null, aggression: 0.5, bark: 'Fair prices, honest scales.', thought: 'Default.' };
}
