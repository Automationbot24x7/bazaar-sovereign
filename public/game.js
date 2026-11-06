const $ = s => document.querySelector(s);
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STANCE_HINT = {
  steady: 'Fair markup on everything. Safe, slow, steady.',
  undercut: 'Always beat the cheapest rival. Volume over margin — watch your costs.',
  corner: 'Outbid everyone for ALL supply of your focus good, then set the price. Best right before a shortage or to fill a Palace order.',
  hoard: 'Stockpile and only sell into a rising market. Perfect before a festival.',
  premium: 'Few sales, fat margins, loyal rich customers.',
  liquidate: 'Dump stock for cash. Use when you’re about to go under.',
};
const FEED_ICON = { mint: '📜', wallet: '👛', transfer: '↩', goods: '⚖', update: '✎', settle: '🪙', deal: '🤝', pay: '🪙', listed: '🏷', takeover: '♛', loan: '🏦', error: '⚠' };
const SPEEDS = [2500, 1200, 600];
const dh = n => `${Math.round(n).toLocaleString()} coins`;
let S = null, speedIdx = 0, prevBarks = {}, dealWith = null;

const goodName = id => S.goods.find(g => g.id === id)?.name || id;
const unitsOf = id => S.goods.find(g => g.id === id)?.units || 'units';
const unitOf = id => S.goods.find(g => g.id === id)?.unit || 'unit';
const merchant = id => S.merchants.find(m => m.id === id);

// ---------- render ----------
function stalls() {
  $('#stalls').innerHTML = S.merchants.map(m => {
    const pnl = m.lastPnl, owner = m.ownedBy ? merchant(m.ownedBy) : null;
    const tradable = !m.player && m.trading && !m.vassal && !S.over;
    return `<article class="stall ${m.player ? 'me' : ''} ${m.bankrupt ? 'bankrupt' : ''} ${owner ? 'vassal' : ''} ${tradable ? 'clickable' : ''}" style="--c:${m.color}" data-id="${m.id}" ${tradable ? `role="button" tabindex="0" title="Trade with ${esc(m.name)}"` : ''}>
      <div class="portrait" style="background-image:url(/art/${m.art}.webp)"></div>
      <div>
        <h3>${esc(m.name)}${m.charters > 1 ? ` <span class="crowns" title="Charters held">${'♛'.repeat(m.charters)}</span>` : ''}${!m.player && m.mood ? ` <span class="mood ${m.mood.key}" title="Attitude toward you">${m.mood.label}</span>` : ''}</h3>
        <div class="nw">${m.netWorth.toLocaleString()}<small> coins net</small> <span class="pnl ${pnl >= 0 ? 'up' : 'down'}" title="Profit or loss yesterday">${pnl >= 0 ? '+' : ''}${pnl}</span></div>
        <span class="stance ${m.doctrine.stance}">${m.doctrine.stance}${m.doctrine.focus ? ' · ' + m.doctrine.focus : ''}</span>${m.helpers ? ` <span class="perk" title="${m.helpers} hired helper(s), ${m.helperDays} day(s) left">👥${m.helpers}</span>` : ''}${m.awning ? ' <span class="perk" title="Awning: safe from sudden storms">☂</span>' : ''}
        ${S.ai === 'live' && m.modelLabel && !m.vassal ? `<span class="brain" title="${esc(m.player ? 'Your factor' : m.name)} — ${esc(m.modelLabel)}${m.thinkMs ? `, last decision took ${(m.thinkMs / 1000).toFixed(1)}s` : ''}">${m.thinking ? '<i class="dots"></i>' : '✦'} ${esc(m.modelLabel)}${m.thinkMs ? ` · ${(m.thinkMs / 1000).toFixed(1)}s` : ''}</span>` : ''}
      </div>
      ${m.chips?.length ? `<div class="chips">${m.chips.map(c => `<span class="chip ${c.tone}">${esc(c.text)}</span>`).join('')}</div>` : ''}
      <div class="bark ${m.thinking ? 'thinking' : ''}" title="${esc(m.thought || '')}">${esc(m.bark || (m.player ? 'Awaiting your orders…' : '…'))}</div>
      <div class="charter"><span>Charter NFT</span>${m.walletUrl ? `<a href="${m.walletUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="This stall's own NEAR wallet">${esc(m.wallet)} ↗</a>` : `<span title="This stall's own wallet">${esc(m.wallet || '')}</span>`}</div>
      ${m.bankrupt && !m.ownedBy && !m.player ? `<button class="primary takeover" data-target="${m.id}">Seize charter · ${dh(m.takeoverPrice)}</button>` : ''}
      ${owner ? `<div class="owned">♛ Vassal of ${owner.player ? 'your house' : esc(owner.name)} · pays ${owner.player ? 'you' : 'them'} 20% of its profit</div>` : ''}
      ${m.tribute ? `<div class="owned">Vassals have paid ${m.player ? 'you' : 'this house'} ${dh(m.tribute)}</div>` : ''}
    </article>`;
  }).join('');
  for (const m of S.merchants) {
    if (m.bark && prevBarks[m.id] !== m.bark) document.querySelector(`.stall[data-id="${m.id}"]`)?.classList.add('flash');
    prevBarks[m.id] = m.bark;
  }
}

function palace() {
  const c = S.contracts.find(c => c.status === 'open'), el = $('#palace');
  const recent = S.contracts.find(c => c.status !== 'open' && S.day - (c.due ?? 0) <= 1);
  if (!c && !recent) { el.hidden = true; return; }
  el.hidden = false;
  if (!c) { el.innerHTML = `<b>Palace order ${recent.status === 'delivered' ? `filled by ${esc(recent.deliveredByName)}` : 'closed'}</b>`; return; }
  const left = c.due - S.day, mine = c.takenBy === 'you';
  el.innerHTML = `<img src="/art/${c.good}.webp" alt="" />
    <div><b>Palace order</b> · ${c.qty} ${unitsOf(c.good)} of ${goodName(c.good).toLowerCase()} by day ${c.due} <span class="muted">(${left}d left)</span><br/>
    <span class="reward">${dh(c.reward)}</span>
    ${c.takenBy ? `<span class="claimed">${mine ? 'Yours' : 'Claimed by ' + esc(c.takenByName)}${c.progress != null ? ` · ${c.progress}/${c.qty}` : ''}</span><div class="bar"><i style="width:${Math.min(100, (c.progress / c.qty) * 100)}%"></i></div>` : ''}</div>
    ${!c.takenBy && !S.over ? `<button class="primary" id="claim" data-id="${c.id}">Claim it</button>` : ''}`;
}

function spark(canvas, data, color) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr);
  if (data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data), r = max - min || 1;
  const x = i => (i / (data.length - 1)) * w, y = v => h - 4 - ((v - min) / r) * (h - 8);
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
  c.beginPath(); data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)))); c.lineTo(w, h); c.lineTo(0, h); c.fillStyle = g; c.fill();
  c.beginPath(); data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)))); c.strokeStyle = color; c.lineWidth = 2; c.stroke();
}

function goods() {
  const el = $('#goods');
  if (!el.children.length) {
    el.innerHTML = S.goods.map(g => `<div class="good" data-g="${g.id}">
      <img src="/art/${g.id}.webp" alt="${g.name}" />
      <div><div>${g.name}</div><span class="p"></span><span class="d"></span></div>
      <canvas></canvas><div class="share"></div><div class="meta"></div></div>`).join('');
    $('#focus').innerHTML += S.goods.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
    $('#dGood').innerHTML = S.goods.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
  }
  for (const g of S.goods) {
    const card = el.querySelector(`[data-g="${g.id}"]`), h = g.history, prev = h.at(-6) ?? h[0], ch = ((g.price - prev) / prev) * 100;
    card.querySelector('.p').innerHTML = `${g.price.toFixed(1)} <small>coins / ${g.unit}</small>`;
    const d = card.querySelector('.d'); d.textContent = `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(0)}%`; d.className = 'd ' + (ch >= 0 ? 'pnl up' : 'pnl down');
    spark(card.querySelector('canvas'), h, ch >= 0 ? '#6cc483' : '#e0614a');
    const total = S.merchants.reduce((t, m) => t + m.inventory[g.id], 0) || 1;
    card.querySelector('.share').innerHTML = S.merchants.filter(m => m.inventory[g.id]).map(m => `<i style="width:${(m.inventory[g.id] / total) * 100}%;background:${m.color}" title="${esc(m.name)}: ${m.inventory[g.id]}"></i>`).join('');
    const me = S.merchants.find(m => m.player), top = [...S.merchants].sort((a, b) => b.inventory[g.id] - a.inventory[g.id])[0];
    card.querySelector('.meta').innerHTML = `<span>You hold <b>${me.inventory[g.id]}</b> ${g.units}</span><span>${top.inventory[g.id] ? `${esc(top.name)} holds ${Math.round((top.inventory[g.id] / total) * 100)}%` : 'no stock in town'}</span>`;
  }
}

function race() {
  const canvas = $('#race'), dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr);
  const all = S.merchants.flatMap(m => m.netHistory), max = Math.max(...all, 400), min = Math.min(0, ...all);
  c.strokeStyle = '#4a3727'; c.beginPath(); c.moveTo(0, h - 1); c.lineTo(w, h - 1); c.stroke();
  for (const m of S.merchants) {
    const d = m.netHistory; if (d.length < 2) continue;
    c.beginPath(); d.forEach((v, i) => { const x = (i / Math.max(d.length - 1, 1)) * w, y = h - 6 - ((v - min) / (max - min)) * (h - 12); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = m.color; c.lineWidth = m.player ? 3 : 1.6; c.globalAlpha = m.trading ? 1 : 0.35; c.stroke(); c.globalAlpha = 1;
  }
  $('#legend').innerHTML = S.standings.map((r, i) => `<span><i style="background:${merchant(r.id).color}"></i>${i + 1}. ${esc(r.name)} ${r.netWorth.toLocaleString()} coins</span>`).join('');
}

function feeds() {
  $('#news').innerHTML = S.news.map(n => `<li class="${n.kind}"><span class="d">Day ${n.day}</span>${esc(n.text)}</li>`).join('');
  $('#ledger').innerHTML = S.chainFeed.length
    ? S.chainFeed.map(f => `<li class="${f.kind}"><span class="ic">${FEED_ICON[f.kind] || '•'}</span>${esc(f.text)}${f.url ? ` <a href="${f.url}" target="_blank" rel="noopener" title="View the transaction on NearBlocks">tx ↗</a>` : ''}</li>`).join('')
    : '<li class="muted">Every 5 days the bazaar settles on NEAR: profits, stock and charters.</li>';
  $('#chainNote').textContent = S.chain.mode === 'testnet' ? (S.chain.pending ? `· ${S.chain.pending} transactions settling…` : '· live on testnet') : '· practice table, simulated';
}

function header() {
  $('#day').textContent = S.day;
  $('#seasonDays').textContent = S.seasonDays;
  $('#seasonBar').style.width = `${Math.min(100, (S.day / S.seasonDays) * 100)}%`;
  $('#events').innerHTML = S.events.map(e => `<span>${esc(e.text)} · ${e.left}d</span>`).join('');
  const r = $('#rumor'); r.hidden = !S.rumor; r.textContent = S.rumor ? `Rumor: ${S.rumor}` : '';
  $('#play').textContent = S.over ? '🏁 Season over' : S.running ? '⏸ Pause' : '▶ Open the bazaar';
  $('#play').disabled = S.over; $('#sim').disabled = S.over;
  const me = S.merchants.find(m => m.player);
  $('#houseCharter').textContent = `· ${dh(me.gold)} in the till`;
  document.querySelectorAll('#stances button').forEach(btn => btn.classList.toggle('on', btn.dataset.s === me.doctrine.stance));
  if (document.activeElement !== $('#focus')) $('#focus').value = me.doctrine.focus || '';
  if (document.activeElement !== $('#aggr')) $('#aggr').value = me.doctrine.aggression;
  $('#stanceHint').textContent = STANCE_HINT[me.doctrine.stance];
  $('#upgrades').innerHTML = `<span>Serving ${me.servedToday}/${me.capacity} customers today</span>
    ${me.helpers ? `<span>👥 ${me.helpers} helper${me.helpers > 1 ? 's' : ''} · ${me.helperDays}d left <button class="ghost" data-up="fire">Let go</button></span>` : `<button class="ghost" data-up="hire" title="Each helper serves 14 more customers a day for 22 coins/day, for 4 days">👥 Hire a helper</button>`}
    ${me.awning ? '<span>☂ Awning up</span>' : '<button class="ghost" data-up="awning" title="One-time 120 coins: sudden storms will not soak your stock">☂ Buy an awning (120)</button>'}`;
  decision();
  coach();
  const b = $('#tableBanner');
  b.hidden = false;
  if (S.table === 'live') { b.className = 'table-banner live'; b.innerHTML = `● <b>Live table.</b> Your game is settling on NEAR testnet — every charter, wallet, sack of goods and payment below is a real transaction. <a href="${S.chain.explorer}/address/${S.chain.contract}" target="_blank" rel="noopener">See the contract ↗</a>`; }
  else { b.className = 'table-banner'; b.innerHTML = S.liveBusy ? '<b>Practice table.</b> Someone else is playing at the live NEAR table right now. Your game plays exactly the same; its on-chain entries are simulated.' : '<b>Practice table.</b> On-chain entries are simulated.'; }
  $('#foot').innerHTML = S.chain.mode === 'testnet' ? `Contract <a href="${S.chain.explorer}/address/${S.chain.contract}" target="_blank" rel="noopener">${S.chain.contract}</a> · Treasury <a href="${S.chain.explorer}/address/${S.chain.treasury}" target="_blank" rel="noopener">${S.chain.treasury}</a> · 1 gold = ${S.chain.goldToNear} NEAR` : 'Bazaar Sovereign · built for NEAR HACKATHON 2026';
}

let endShown = false;
function end() {
  if (!S.over || !S.result) { endShown = false; return; }
  if (endShown) return;
  endShown = true;
  const r = S.result;
  $('#endTitle').textContent = r.reason === 'sovereign' ? '♛ Sovereign of the Bazaar ♛' : r.reason === 'bankrupt' ? 'Your house has fallen' : r.win ? 'Richest house in the bazaar!' : 'The season ends';
  $('#endText').textContent = r.reason === 'sovereign' ? `You hold three merchant charters on day ${r.day}. The bazaar is yours.` : r.reason === 'bankrupt' ? 'Your gold ran out. Rivals circle your charter.' : `You finished #${r.rank} of ${r.table.length} after ${r.day} days.`;
  $('#endTable').innerHTML = '<tr><th>#</th><th>House</th><th>Net worth</th><th>Charters</th><th>Palace orders</th></tr>' + r.table.map((t, i) => `<tr class="${t.id === 'you' ? 'me' : ''}"><td>${i + 1}</td><td>${esc(t.name)}${t.vassalOf ? ` <span class="muted">(vassal of ${esc(merchant(t.vassalOf).name)})</span>` : t.out ? ' <span class="muted">(bankrupt)</span>' : ''}</td><td>${dh(t.netWorth)}</td><td>${'♛'.repeat(t.charters)}</td><td>${t.contracts}</td></tr>`).join('');
  $('#endProof').innerHTML = S.chain.mode === 'testnet' ? `The final state is settling on NEAR testnet — <a href="${S.chain.explorer}/address/${S.chain.contract}" target="_blank" rel="noopener">see the charters ↗</a>` : '';
  $('#end').showModal();
}

// ---------- key-moment decisions ----------
function decision() {
  const d = S.decision, el = $('#decision');
  el.hidden = !d;
  if (!d) return;
  el.className = `decision ${d.kind}`;
  el.innerHTML = `<div class="dt">${esc(d.title)} <span class="muted">· day ${d.day}, the bazaar waits for you</span></div><p>${esc(d.text)}</p><div class="da">${d.actions.map((a, i) => `<button class="${i === 0 ? 'primary' : 'ghost'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
}

// ---------- coach: one gentle nudge at a time, never twice ----------
const seen = (() => { try { return JSON.parse(localStorage.getItem('bs-coach') || '{}'); } catch { return {}; } })();
function mark(k) { if (seen[k]) return; seen[k] = 1; try { localStorage.setItem('bs-coach', JSON.stringify(seen)); } catch {} }
function coach() {
  const el = $('#coach'); let tip = null;
  if (S.over || S.decision) tip = null;
  else if (!S.running && S.day === 0) tip = 'Press ▶ Open the bazaar to start the first day.';
  else if (!seen.haggled && S.day >= 4) tip = 'Tap any rival’s stall to haggle: buy their stock, or offer to buy their whole house.';
  else if (!seen.rivals && S.day >= 9) tip = 'Rivals learn as the season goes on. Open “Rivals” to see their moods and lessons.';
  else if (!seen.ordered && S.day >= 12) tip = 'You can also give your factor plain-English orders, like “sell everything before the caravan arrives”.';
  el.hidden = !tip; if (tip) el.innerHTML = `💡 ${tip} <button class="ghost" id="coachOk">Got it</button>`;
}
$('#coach').onclick = e => { if (e.target.id === 'coachOk') { const k = !seen.haggled && S.day >= 4 ? 'haggled' : !seen.rivals && S.day >= 9 ? 'rivals' : 'ordered'; mark(k); coach(); } };

// ---------- who's who ----------
function rivals() {
  $('#rivalList').innerHTML = S.merchants.filter(m => !m.player).map(m => `<article class="rival" style="--c:${m.color}">
    <div class="portrait big" style="background-image:url(/art/${m.art}.webp)"></div>
    <div>
      <h3>${esc(m.name)} <span class="muted">· ${esc(m.modelLabel || '')}</span>${m.mood ? ` <span class="mood ${m.mood.key}">${m.mood.label}</span>` : ''}</h3>
      <p>${esc(m.profile?.bio || '')}</p>
      <p class="muted"><b>Opens the season:</b> ${esc(m.profile?.opening || '')}</p>
      <p class="muted"><b>Now:</b> ${m.vassal ? `a vassal stall following ${esc(merchant(m.ownedBy).name)}'s strategy` : m.trading ? `${esc(m.doctrine.stance)}${m.doctrine.focus ? ' on ' + esc(m.doctrine.focus) : ''}${m.thought ? ` — “${esc(m.thought)}”` : ''}` : 'bankrupt'}</p>
      ${m.lessons?.length ? `<div class="lessons"><b>Lessons learned this season</b><ul>${m.lessons.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '<div class="lessons muted">No lessons yet — they learn as the season unfolds.</div>'}
    </div></article>`).join('');
}

function render(s) { S = s; header(); palace(); stalls(); goods(); race(); feeds(); end(); if (dealWith && $('#deal').open) dealMeta(); if ($('#rivals').open) rivals(); }
const refresh = () => api('/api/state').then(render).catch(() => {});

// ---------- deal drawer ----------
function dealMeta() {
  const m = merchant(dealWith);
  $('#dealMeta').innerHTML = `${m.mood ? `<span class="mood ${m.mood.key}">${m.mood.label}</span> · ` : ''}${dh(m.netWorth)} net · stock: ${Object.entries(m.inventory).filter(([, q]) => q).map(([g, q]) => `${q} ${q === 1 ? unitOf(g) : unitsOf(g)} of ${goodName(g).toLowerCase()}`).join(', ') || 'none'}`;
  $('#bHint').textContent = `Their house is worth about ${dh(m.buyoutHint || 0)}. You have ${dh(S.me.gold)}.`;
  const q = Number($('#dQty').value), p = Number($('#dPrice').value);
  const gd = S.goods.find(g => g.id === $('#dGood').value);
  $('#dTotal').textContent = q && p ? `Total ${dh(q * p)} · market ${gd.price.toFixed(1)} a ${gd.unit} · you have ${dh(S.me.gold)}` : '';
}
function openDeal(id) {
  dealWith = id;
  mark('haggled');
  const m = merchant(id);
  $('#dealName').textContent = m.name;
  $('#dealPortrait').style.backgroundImage = `url(/art/${m.art}.webp)`;
  $('#dealPortrait').style.setProperty('--c', m.color);
  const best = Object.entries(m.inventory).sort((a, b) => b[1] - a[1])[0];
  $('#dGood').value = best && best[1] ? best[0] : S.goods[0].id;
  $('#dQty').value = Math.max(1, Math.min(10, best?.[1] || 5));
  $('#dPrice').value = S.goods.find(g => g.id === $('#dGood').value).price.toFixed(1);
  $('#bPrice').value = m.buyoutHint;
  $('#dGood').title = '';
  $('#dealReply').hidden = true;
  dealMeta();
  $('#deal').showModal();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#dealGoods').hidden = b.dataset.tab !== 'goods'; $('#dealBuyout').hidden = b.dataset.tab !== 'buyout';
});
$('#dGood').onchange = () => { $('#dPrice').value = S.goods.find(g => g.id === $('#dGood').value).price.toFixed(1); dealMeta(); };
$('#dQty').oninput = $('#dPrice').oninput = dealMeta;
async function offer(body, btn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = `${merchant(dealWith).name} is thinking…`;
  try {
    const r = await api('/api/offer', { target: dealWith, ...body });
    render(r);
    const rep = r.reply;
    $('#dealReply').hidden = false;
    $('#dealReply').className = 'deal-reply ' + (rep.accept ? 'yes' : 'no');
    const cq = rep.counterQty && body.kind === 'goods' ? rep.counterQty : body.qty;
    const meetLabel = body.kind === 'buyout' ? `Pay ${dh(rep.counter)}` : `Take ${cq} at ${rep.counter} each${cq !== body.qty ? ' (their bulk deal)' : ''}`;
    $('#dealReply').innerHTML = `<b>${rep.accept ? 'Deal!' : 'Refused.'}</b> “${esc(rep.bark)}”${!rep.accept && rep.counter ? `<button type="button" class="ghost" id="meet">${meetLabel}</button>` : ''}`;
    if (!rep.accept && rep.counter) $('#meet').onclick = () => { if (body.kind === 'buyout') { $('#bPrice').value = rep.counter; offer({ kind: 'buyout', price: rep.counter }, $('#dealBuyout button')); } else { $('#dPrice').value = rep.counter; $('#dQty').value = cq; offer({ ...body, qty: cq, price: rep.counter }, $('#dealGoods button')); } };
    if (rep.accept && body.kind === 'buyout') setTimeout(() => $('#deal').close(), 2500);
  } catch (e) {
    $('#dealReply').hidden = false; $('#dealReply').className = 'deal-reply no'; $('#dealReply').textContent = e.message;
  }
  btn.disabled = false; btn.textContent = label;
}
$('#dealGoods').onsubmit = e => { e.preventDefault(); offer({ kind: 'goods', good: $('#dGood').value, qty: Number($('#dQty').value), price: Number($('#dPrice').value) }, e.submitter || $('#dealGoods button')); };
$('#dealBuyout').onsubmit = e => { e.preventDefault(); offer({ kind: 'buyout', price: Number($('#bPrice').value) }, e.submitter || $('#dealBuyout button')); };

// ---------- controls ----------
$('#stances').innerHTML = Object.keys(STANCE_HINT).map(s => `<button type="button" data-s="${s}">${s}</button>`).join('');
const setDoctrine = patch => { const me = S.merchants.find(m => m.player); api('/api/doctrine', { ...me.doctrine, ...patch }).then(render); };
$('#stances').onclick = e => { if (e.target.dataset.s) setDoctrine({ stance: e.target.dataset.s }); };
$('#focus').onchange = e => setDoctrine({ focus: e.target.value || null });
$('#aggr').onchange = e => setDoctrine({ aggression: Number(e.target.value) });
$('#play').onclick = () => api(S.running ? '/api/pause' : '/api/play', {}).then(render);
$('#speed').onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; $('#speed').textContent = ['1×', '2×', '4×'][speedIdx]; api('/api/speed', { ms: SPEEDS[speedIdx] }).then(render); };
$('#upgrades').onclick = e => {
  const u = e.target.dataset.up; if (!u) return;
  const me = S.merchants.find(m => m.player);
  const call = u === 'awning' ? api('/api/awning', {}) : api('/api/hire', { n: u === 'fire' ? 0 : Math.min(3, (me.helpers || 0) + 1), days: 4 });
  call.then(render).catch(err => alert(err.message));
};
$('#autoPause').onchange = e => api('/api/autopause', { on: e.target.checked }).then(render);
$('#decision').onclick = e => { const i = e.target.dataset.i; if (i != null) { mark('decided'); api('/api/decide', { index: Number(i) }).then(render).catch(err => { alert(err.message); refresh(); }); } };
$('#sim').onclick = async e => { const b = e.currentTarget; b.disabled = true; b.textContent = '⏩ …'; const poll = setInterval(refresh, 300); await api('/api/simulate', { days: 10 }).then(render).catch(err => alert(err.message)); clearInterval(poll); b.disabled = S?.over; b.textContent = '⏩ 10 days'; };
$('#reset').onclick = () => confirm('Start a new season?') && api('/api/reset', {}).then(s => { endShown = false; render(s); });
$('#again').onclick = () => api('/api/reset', {}).then(s => { $('#end').close(); endShown = false; render(s); });
$('#help').onclick = () => { mark('rivals'); rivals(); $('#rivals').showModal(); };
$('#stalls').onclick = e => {
  const t = e.target.closest('[data-target]')?.dataset.target;
  if (t) { api('/api/takeover', { target: t }).then(render).catch(err => alert(err.message)); return; }
  const card = e.target.closest('.stall.clickable');
  if (card) openDeal(card.dataset.id);
};
$('#stalls').onkeydown = e => { const card = e.target.closest('.stall.clickable'); if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDeal(card.dataset.id); } };
$('#palace').onclick = e => { if (e.target.id === 'claim') api('/api/contract', { id: e.target.dataset.id }).then(render).catch(err => alert(err.message)); };
$('#orderForm').onsubmit = async e => {
  e.preventDefault();
  const order = $('#order').value.trim(); if (!order) return;
  const btn = $('#orderBtn'); btn.disabled = true; btn.textContent = '…';
  try {
    mark('ordered');
    const r = await api('/api/order', { order });
    render(r);
    $('#reply').hidden = false;
    $('#reply').innerHTML = `<b>Your factor:</b> “${esc(r.reply.bark)}” <span class="muted">→ ${esc(r.reply.stance)}${r.reply.focus ? ' · ' + esc(r.reply.focus) : ''} — ${esc(r.reply.thought)}</span>`;
    $('#order').value = '';
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = 'Send';
};

try { if (!localStorage.getItem('bs-intro-2')) { $('#intro').showModal(); localStorage.setItem('bs-intro-2', '1'); } } catch { $('#intro').showModal(); }
refresh();
setInterval(refresh, 800);
addEventListener('resize', () => S && render(S));
