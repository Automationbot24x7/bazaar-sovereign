// Merchant "brains". Each rival runs on a different Claude model that fits its personality
// (Haiku = quick, Sonnet = measured, Opus = deep schemer). All of them share one long,
// static "Bazaar Codex" system block marked for prompt caching, so after the first call the
// rules are read from cache and only the persona + market report are new tokens.
// Falls back to a personality heuristic when no key is set or the API fails.
import { readFileSync } from 'node:fs';
import { GOODS, STANCES, EVENTS, RENT, BAZAAR_TAX, netWorth } from './engine.js';

if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_KEY_FILE) {
  try { process.env.ANTHROPIC_API_KEY = readFileSync(process.env.ANTHROPIC_KEY_FILE, 'utf8').trim(); } catch (e) { console.warn('Could not read ANTHROPIC_KEY_FILE:', e.message); }
}
export const aiOn = () => Boolean(process.env.ANTHROPIC_API_KEY);
export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
export const MODEL_LABEL = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };

// Per-model telemetry shown in the UI (and handy to prove caching works).
export const stats = {};
const track = (model, ms, usage = {}) => {
  const s = (stats[model] ||= { calls: 0, totalMs: 0, lastMs: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
  s.calls++; s.totalMs += ms; s.lastMs = ms;
  s.cacheRead += usage.cache_read_input_tokens || 0; s.cacheWrite += usage.cache_creation_input_tokens || 0;
  s.input += usage.input_tokens || 0; s.output += usage.output_tokens || 0;
};

const DOCTRINE_TOOL = {
  name: 'set_doctrine',
  description: 'Set this merchant\'s trading doctrine for the coming days and say one line out loud in the bazaar.',
  input_schema: {
    type: 'object',
    properties: {
      stance: { type: 'string', enum: STANCES, description: 'See "Doctrines" in the Bazaar Codex.' },
      focus: { type: ['string', 'null'], enum: [...GOODS.map(g => g.id), null], description: 'The good this doctrine concentrates on (required for corner; optional for hoard/premium), or null for all goods.' },
      aggression: { type: 'number', minimum: 0, maximum: 1, description: '0 = timid, 1 = all-in. Scales bid prices, quantities and markups.' },
      bark: { type: 'string', description: 'One short in-character line (max 14 words) shouted in the bazaar for everyone to hear. No hashtags, no emojis, no stage directions.' },
      thought: { type: 'string', description: 'One sentence of private reasoning (never shown to rivals).' },
    },
    required: ['stance', 'focus', 'aggression', 'bark', 'thought'],
  },
};

// ---------- The Bazaar Codex: long, static, cached ----------
const pct = x => `${Math.round(x * 100)}%`;
const CODEX = `# THE BAZAAR CODEX
You are playing a merchant in "Bazaar Sovereign", a trading game set in a desert-city bazaar. Five merchant houses compete: four rivals and the player's house. Every merchant house is a charter (an NFT on the NEAR blockchain) that owns its own wallet. Read this codex carefully; it is the complete rulebook. Each turn you receive a market report and must choose your doctrine with the set_doctrine tool.

## 1. Goods
${GOODS.map(g => `- **${g.name}** (id \`${g.id}\`): base price ${g.base} gold. Daily supply ≈ ${g.supply} units, daily town demand ≈ ${g.demand} units at fair prices. Storage costs ${g.storage} gold per unit per day.${g.spoil ? ` Spoils: loses ${pct(g.spoil)} of stock every day.` : ' Does not spoil.'}`).join('\n')}

Saffron is scarce and valuable; silk is a luxury; tea is cheap but perishable; salt is cheap, plentiful and safe to store.

## 2. A day in the bazaar
1. **Rumors & events.** A rumor heard today becomes a real event tomorrow. Events last a few days.
2. **Wholesale auction.** For each good, suppliers sell the day's supply to merchants, highest bid first, pay-as-bid. Suppliers refuse bids below about 58% of the base price. You can never spend gold you do not have: each merchant keeps two days of rent in reserve.
3. **Retail.** Townsfolk buy from stalls. A small group of loyal regulars buys from each stall that has stock and a sane price (premium stalls keep about twice as many regulars). Everyone else buys from the **cheapest stall with stock first**, then the next cheapest, until demand at that price is satisfied. Demand falls linearly as price rises and reaches zero at about 3.2× base price.
4. **Costs.** Stall rent ${RENT} gold per day (doubled while the Vizier's tax event runs), storage per unit held, ${pct(BAZAAR_TAX)} bazaar tax on every retail sale, and spoilage.
5. **Solvency.** If gold falls below zero, the merchant pawns stock at 45% of base price to cover the debt. If still below zero, the house is **bankrupt**: it stops trading and its charter goes up for takeover.

## 3. Events (announced one day early by rumor)
${EVENTS.map(e => `- **${e.text}** — rumor: "${e.rumor}" Lasts ${e.days} days. Effect: ${[
  ...Object.entries(e.supply || {}).map(([k, v]) => `${k} supply ×${v}`),
  ...Object.entries(e.demand || {}).map(([k, v]) => `${k} demand ×${v}`),
  ...(e.rent ? [`stall rent ×${e.rent}`] : []),
].join(', ')}.`).join('\n')}

How to read them: a supply shock (drought, monsoon) means the few units that reach the market are worth far more, so whoever already holds stock or wins the shrunken auction profits. A demand shock (festival) lifts prices for everything, so stock bought cheaply beforehand sells high. A glut (caravan, salt barges) crashes prices, so sell before it lands and don't hold that good. The tax event punishes merchants with thin cash buffers.

## 4. Doctrines (your strategic stance)
- **steady** — buy a quarter of each good's supply at fair bids, sell at a moderate markup over your average cost. Low risk, low reward. Good default when nothing is happening.
- **undercut** — buy a bit more and always price just below the cheapest rival who has stock. Wins volume, but margins get razor-thin when two merchants undercut each other; dangerous with spoiling tea or during the tax event.
- **corner** — requires a focus good. Outbid everyone for the *entire* supply of that good (paying up to ~1.25–1.85× wholesale depending on aggression), then price like a monopolist once rivals run out. Best when a shortage rumor is out or rivals hold little stock. Very expensive if the shortage never comes or a glut arrives. Uses most of your gold.
- **hoard** — stockpile (optionally one focus good) and only sell into a rising market (about 12% above the current price). Best right before a festival or shortage. Costs storage every day; terrible for tea.
- **premium** — buy little, sell at high margins to loyal rich customers. Stable, slow, resilient to price wars.
- **liquidate** — stop buying and sell everything cheaply for cash. Use when gold is dangerously low or before a glut crushes your stock's value.

**Aggression** scales how hard the doctrine is pursued: bids, quantities and markups.

## 5. Bankruptcy and takeovers
A bankrupt house's charter can be bought by a solvent rival. The buyer pays the takeover price (about half the stock value, minus debts) and absorbs all the bankrupt house's stock. If the player doesn't buy within three days, the richest rival with enough gold usually does. Taking over a fallen rival is a strong move; going bankrupt ends your story.

## 6. How to think
- Read the rumor first. It is the most valuable information in the report.
- Check rivals' doctrines: if someone is already cornering a good, fighting them for it often bankrupts both. If two rivals are undercutting each other, a premium or hoard stance can wait them out.
- Watch your own gold. Below ~80 gold you cannot win auctions; below ~40 consider liquidating.
- Don't change doctrine every turn without reason; consistency compounds. But react decisively to rumors.
- Price trends in the report are the change over the last five days.

## 7. Voice
Your "bark" is heard by the whole bazaar: vivid, short, in character, never more than 14 words. Taunts, boasts, sales pitches and laments are all welcome. Never mention game mechanics, numbers like "aggression 0.8", the codex, or that you are an AI. Your "thought" is private, one sentence, plain reasoning.`;

const ALWAYS_TOOL = '\n\nRespond ONLY by calling the set_doctrine tool exactly once. Do not write any other text.';
const system = role => [
  { type: 'text', text: CODEX, cache_control: { type: 'ephemeral' } }, // shared cached prefix
  { type: 'text', text: role + ALWAYS_TOOL },
];

function snapshot(w, me) {
  return {
    day: w.day,
    prices: w.prices,
    trend5d: Object.fromEntries(GOODS.map(g => { const h = w.history[g.id]; return [g.id, +(h.at(-1) - (h.at(-6) ?? h[0])).toFixed(2)]; })),
    activeEvents: w.active.map(e => `${e.text} (${e.left}d left)`),
    rumor: w.pending ? w.pending.rumor : null,
    me: { gold: me.gold, inventory: me.inventory, avgCost: me.cost, lastPnl: me.lastPnl, doctrine: me.doctrine },
    rivals: w.merchants.filter(m => m !== me).map(m => ({
      name: m.name, bankrupt: m.bankrupt, doctrine: m.doctrine.stance + (m.doctrine.focus ? `:${m.doctrine.focus}` : ''),
      netWorth: Math.round(netWorth(w, m)), stock: m.inventory, lastAsk: m.lastAsk, lastBark: m.bark,
    })),
  };
}

async function callClaude(model, role, user) {
  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 1200, system: system(role),
      tools: [DOCTRINE_TOOL], tool_choice: { type: 'auto' }, // Sonnet/Opus 5.5 don't allow forced tool_choice
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const ms = Date.now() - t0;
  track(model, ms, j.usage);
  const out = j.content.find(c => c.type === 'tool_use')?.input;
  if (!out) throw new Error('Claude returned no doctrine');
  return { out, ms, usage: j.usage };
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
  const model = m.model || DEFAULT_MODEL;
  if (aiOn()) {
    const role = `## Your role\nYou are **${m.name}**. Personality: ${m.persona}\nPlay to win as this character would. Decide with the set_doctrine tool.`;
    try {
      const { out: d, ms, usage } = await callClaude(model, role, `Market report (day ${w.day}):\n${JSON.stringify(snapshot(w, m))}`);
      return { ...clean(d), bark: String(d.bark || '').slice(0, 120) || m.bark, thought: String(d.thought || '').slice(0, 220), engine: 'claude', model, ms, cached: usage?.cache_read_input_tokens || 0 };
    } catch (e) { console.warn(`Claude unavailable for ${m.name} (${model}), using fallback: ${e.message.slice(0, 80)}`); }
  }
  return { ...heuristic(w, m), engine: 'heuristic', model: null, ms: 0 };
}

// ---------- Player's natural-language orders -> doctrine ----------
export async function interpretOrder(w, me, order) {
  const model = process.env.FACTOR_MODEL || 'claude-haiku-5-5';
  if (aiOn()) {
    const role = `## Your role\nYou are the loyal factor (head clerk) of the player's merchant house. Translate the owner's order into a doctrine with set_doctrine. If the order is vague, choose the doctrine that best serves it given the market report. "bark" is your short reply to the owner (max 14 words, deferential and in character, e.g. "At once — every pinch of saffron in town will be ours."). "thought" explains the plan in one sentence, mentioning any risk the owner should know.`;
    try {
      const { out: d, ms } = await callClaude(model, role, `Owner's order: "${order}"\nMarket report (day ${w.day}):\n${JSON.stringify(snapshot(w, me))}`);
      return { ...clean(d), bark: d.bark, thought: d.thought, engine: 'claude', model, ms };
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

export const codexTokensApprox = Math.round(CODEX.length / 4);
