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
const FEED_ICON = { mint: '📜', wallet: '👛', transfer: '↩', goods: '⚖', update: '✎', settle: '🪙', escrow: '🔒', deal: '🤝', pay: '🪙', listed: '🏷', takeover: '♛', loan: '🏦', error: '⚠' };
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
      ${m.magnateHeld ? `<div class="owned held">🐫 Charter held by ${esc(S.magnate?.name || 'the Magnate')}</div>` : m.bankrupt && !m.ownedBy && !m.player ? `<button class="primary takeover" data-target="${m.id}">Seize charter · ${dh(m.takeoverPrice)}</button>` : ''}
      ${m.trading ? `<div class="goodwill" title="Goodwill: shoppers stay loyal to stalls that trade fairly. Gouging, empty shelves and rats lose it."><span>♥ Goodwill</span><i><b style="width:${Math.round((m.goodwill / 0.8) * 100)}%"></b></i></div>` : ''}
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
    ${me.awning ? '<span>☂ Awning up</span>' : '<button class="ghost" data-up="awning" title="One-time 120 coins: sudden storms will not soak your stock">☂ Buy an awning (120)</button>'}
    ${guildPill()}
    ${S.plot ? (S.me.watch ? `<span>🛡 Night watch hired against ${esc(S.plot.byName)}</span>` : `<button class="ghost danger" data-up="watch" title="${esc(S.plot.byName)} is plotting to set rats on your warehouse tomorrow night">🐀 Hire a night watch (${S.plot.watchCost})</button>`) : ''}`;
  decision();
  coach();
  magnate();
  const b = $('#tableBanner');
  b.hidden = false;
  if (S.table === 'live') { b.className = 'table-banner live'; b.innerHTML = `● <b>Live table${S.liveTables > 1 ? ` ${S.liveTable} of ${S.liveTables}` : ''}.</b> Your game is settling on NEAR testnet — every charter, wallet, sack of goods and payment below is a real transaction. <a href="${S.chain.explorer}/address/${S.chain.contract}" target="_blank" rel="noopener">See the contract ↗</a>`; }
  else {
    b.className = 'table-banner';
    const tables = S.liveTables > 1 ? `All ${S.liveTables} live NEAR tables are` : 'The live NEAR table is';
    const lost = S.seatLost ? 'Your live seat was released while you were away. ' : '';
    b.innerHTML = S.liveBusy ? `<b>Practice table.</b> ${lost}${tables} taken right now. Your game plays exactly the same; its on-chain entries are simulated.`
      : S.liveTables ? `<b>Practice table.</b> ${lost}A live NEAR table is free: start a new season to play on-chain.`
      : '<b>Practice table.</b> On-chain entries are simulated.';
  }
  $('#foot').innerHTML = S.chain.mode === 'testnet' ? `Contract <a href="${S.chain.explorer}/address/${S.chain.contract}" target="_blank" rel="noopener">${S.chain.contract}</a> · Treasury <a href="${S.chain.explorer}/address/${S.chain.treasury}" target="_blank" rel="noopener">${S.chain.treasury}</a> · 1 gold = ${S.chain.goldToNear} NEAR` : 'Bazaar Sovereign · built for NEAR HACKATHON 2026';
}

let endShown = false;
function end() {
  if (!S.over || !S.result) { endShown = false; return; }
  if (endShown) return;
  endShown = true;
  const r = S.result;
  $('#endTitle').textContent = r.reason === 'sovereign' ? '♛ Sovereign of the Bazaar ♛' : r.reason === 'bankrupt' ? 'Your house has fallen' : r.reason === 'magnate' ? '🐫 The Magnate owns the bazaar' : r.win ? 'Richest house in the bazaar!' : 'The season ends';
  $('#endText').textContent = r.reason === 'sovereign' ? `You hold three merchant charters on day ${r.day}. The bazaar is yours.` : r.reason === 'bankrupt' ? 'Your gold ran out. Rivals circle your charter.'
    : r.reason === 'magnate' ? `${S.magnate?.name || 'The Magnate'} still holds his monopoly on ${(r.magnate?.goods || []).map(g => goodName(g).toLowerCase()).join(' and ')}. The houses squabbled while he bought the bazaar; nobody wins this season. (You were #${r.rank} by net worth.)` : `You finished #${r.rank} of ${r.table.length} after ${r.day} days.`;
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

function render(s) { S = s; header(); palace(); stalls(); goods(); race(); feeds(); end(); if (dealWith && $('#deal').open) dealMeta(); if ($('#rivals').open) rivals(); pumpScenes(); }
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
  const call = u === 'awning' ? api('/api/awning', {}) : u === 'borrow' ? api('/api/borrow', {}) : u === 'repay' ? api('/api/repay', {}) : u === 'watch' ? api('/api/watch', {})
    : api('/api/hire', { n: u === 'fire' ? 0 : Math.min(3, (me.helpers || 0) + 1), days: 4 });
  call.then(render).catch(err => alert(err.message));
};
$('#autoPause').onchange = e => api('/api/autopause', { on: e.target.checked }).then(render);
$('#decision').onclick = e => {
  const i = e.target.dataset.i; if (i == null) return;
  mark('decided'); e.target.disabled = true;
  api('/api/decide', { index: Number(i) }).then(s => { render(s); if (s.openDeal) openDeal(s.openDeal); }).catch(err => { alert(err.message); refresh(); });
};
$('#magnate').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  b.disabled = true;
  const call = b.dataset.raid ? api('/api/raid', { good: b.dataset.raid, qty: S.magnate.raidLeft })
    : b.dataset.pact != null ? api('/api/pact', { target: b.dataset.pact || null, pay: !!b.dataset.pay }) : null;
  call?.then(render).catch(err => { alert(err.message); refresh(); });
};
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


// ---------- the Moneylenders' Guild ----------
function guildPill() {
  const me = S.me, g = S.guild;
  const owe = me.bonds.length ? `<span class="guild">🏦 Debt ${dh(me.debt)} <button class="ghost" data-up="repay" title="Repay the oldest bond: ${dh(me.bonds[0].owed)} with fees and interest">Repay ${dh(me.bonds[0].owed)}</button></span>` : '';
  const take = me.canBorrow ? `<button class="ghost" data-up="borrow" title="The Moneylenders' Guild: ${g.bond} coins now, ${Math.round(g.fee * 100)}% fee plus ${Math.round(g.daily * 100)}% a day until repaid. Debt counts against your net worth.">🏦 Borrow ${g.bond}</button>` : '';
  return owe + take;
}

// ---------- the Magnate: boss banner ----------
function magnate() {
  const el = $('#magnate'), mg = S.magnate;
  const show = mg && !S.over && (mg.stage !== 'gone' || S.day - mg.left <= 2);
  el.hidden = !show;
  if (!show) return;
  const gname = g => goodName(g).toLowerCase();
  if (mg.stage === 'coming') {
    el.className = 'magnate coming';
    el.innerHTML = `🐫 <b>A rich outsider is coming.</b> ${esc(mg.title)}'s caravans are camped outside the gates. Tomorrow he opens a stall to sell below cost: keep some coins ready.`;
    return;
  }
  if (mg.stage === 'gone') {
    el.className = 'magnate gone';
    el.innerHTML = `🐫 <b>${esc(mg.name)} has left the bazaar</b> on day ${mg.left}${mg.why === 'bled' ? `, ${dh(mg.loss)} poorer: the bazaar was not worth his gold` : ': nobody would pay his prices'}. Prices of ${mg.goods.map(gname).join(' and ')} can recover now.`;
    return;
  }
  const left = Math.max(0, mg.patience - mg.loss), pct = (left / mg.patience) * 100;
  const rivalsHere = S.merchants.filter(m => !m.player && m.trading && !m.vassal);
  const pact = rivalsHere.map(m => {
    const a = mg.asks[m.id];
    if (mg.allies.includes(m.id)) return `<span class="ally" title="${esc(a?.bark || '')}">✓ ${esc(m.name)}</span>`;
    if (a?.counter) return `<span title="${esc(a.bark)}">${esc(m.name)} wants ${dh(a.counter)} <button class="ghost" data-pact="${m.id}" data-pay="1">Pay</button></span>`;
    if (a && !a.accept) return `<span class="no" title="${esc(a.bark)}">✗ ${esc(m.name)}</span>`;
    return `<button class="ghost" data-pact="${m.id}">Ask ${esc(m.name)}</button>`;
  }).join(' ');
  const unasked = mg.stage === 'dumping' && rivalsHere.some(m => !mg.asks[m.id] && !mg.allies.includes(m.id));
  el.className = `magnate ${mg.stage}`;
  el.innerHTML = `<div class="mh">🐫 <b>${esc(mg.name)}</b> ${mg.stage === 'dumping'
      ? `is dumping ${mg.goods.map(g => `${gname(g)} at <b>${mg.prices[g]}</b>`).join(' and ')} coins, below his own cost.`
      : `owns the ${mg.goods.map(gname).join(' and ')} markets and charges ${mg.goods.map(g => `<b>${mg.prices[g]}</b>`).join(' / ')}. Undercut him and he leaves.`}</div>
    <div class="patience" title="He leaves when his patience runs out. Shoppers who stay loyal to the houses, stock bought off his carts and his overheads wear it down; monopoly profits refill it."><span>Patience</span><div class="bar"><i style="width:${pct}%"></i></div><span>${dh(left)} left${mg.lastLoss > 0 ? ` <em class="hit">−${mg.lastLoss} yesterday</em>` : mg.lastLoss < 0 ? ` <em class="heal">+${-mg.lastLoss} yesterday</em>` : ''}</span></div>
    <div class="patience" title="Share of shoppers for his goods who bought from him yesterday"><span>His shoppers</span><div class="bar share"><i style="width:${Math.round(mg.share * 100)}%"></i></div><span>${Math.round(mg.share * 100)}%${mg.stage === 'dumping' ? ` · at ${Math.round((1 - mg.monopolyAt) * 100)}% for 2 days he takes a monopoly` :` · houses need ${Math.round(mg.breakShare * 100)}% for ${mg.breakDays} days (${mg.back}/${mg.breakDays})`}${mg.charters.length ? ` · holds ${mg.charters.map(esc).join(', ')}` : ''}</span></div>
    ${mg.stage === 'dumping' ? `<div class="mrow"><span class="muted">Buy off his carts (${mg.raidLeft} of ${mg.raidCap} left today, delivered overnight${mg.incoming ? ` · ${mg.incoming} on the way` : ''}):</span>
      ${mg.goods.map(g => { const n = Math.min(mg.raidLeft, Math.floor(S.me.gold / mg.prices[g])); return `<button class="primary" data-raid="${g}" ${n ? '' : 'disabled'} title="${n ? '' : 'Not enough coins in the till: borrow from the Guild below'}">Buy ${n || mg.raidLeft || mg.raidCap} ${gname(g)} · ${dh(mg.prices[g] * (n || mg.raidLeft || mg.raidCap))}</button>`; }).join(' ')}</div>
    <div class="mrow"><span class="muted">Pact:</span> ${pact} ${unasked ? '<button class="ghost" data-pact="">Rally them all</button>' : ''}</div>` : ''}
    ${mg.hits.length ? `<div class="hits">${mg.hits.map(h => `<span>${esc(h.by === 'you' ? 'You' : h.name)} <em class="hit">−${h.hurt}</em></span>`).join('')}</div>` : ''}`;
}


// ---------- story scenes and music: voiced, skippable ----------
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let SCENES = null, lastScene = null, sceneQueue = [], scenePlaying = false, userActed = false, resumeAfter = false;
let soundOn = store.get('bs-sound') !== '0', skipScenes = store.get('bs-skip-scenes') === '1';
const voice = new Audio(), music = new Audio();
music.loop = true; music.volume = 0.3;
fetch('/scenes.json').then(r => r.json()).then(d => { SCENES = d; pumpScenes(); }).catch(() => {});
$('#sound').textContent = soundOn ? '🔊' : '🔇';
$('#sceneOff').checked = skipScenes;

function musicFor() {
  if (!S) return null;
  if (S.over) return 'finale';
  return ['dumping', 'monopoly'].includes(S.magnate?.stage) ? 'magnate' : 'bazaar';
}
function syncMusic() {
  const want = soundOn && userActed ? musicFor() : null;
  if (!want) { music.pause(); return; }
  const src = `/audio/music/${want}.mp3`;
  if (!music.src.endsWith(src)) { music.src = src; music.loop = want !== 'finale'; }
  music.volume = scenePlaying ? 0.1 : 0.3;
  if (music.paused) music.play().catch(() => {});
}

// the bazaar waits while a scene plays (even if it was started a moment after the scene began)
function holdForScene() {
  if (!scenePlaying || !S?.running) return;
  resumeAfter = true;
  api('/api/pause', {}).then(render).catch(() => {});
}

// called on every render: queue scenes the server announced since we last looked
function pumpScenes() {
  holdForScene();
  if (!S || !SCENES) return;
  const list = S.scenes || [];
  if (lastScene === null) {
    // on (re)load only the opening of a fresh season plays; older scenes are history
    lastScene = S.day === 0 ? Math.max(0, ...list.filter(s => s.id !== 'opening').map(s => s.seq)) : Math.max(0, ...list.map(s => s.seq));
  }
  for (const s of list) if (s.seq > lastScene) { lastScene = s.seq; if (!skipScenes && SCENES.scenes[s.id]) sceneQueue.push(s.id); }
  syncMusic();
  if (!scenePlaying && userActed && sceneQueue.length) playScene(sceneQueue.shift());
}

let advance = null, sceneToken = 0;
async function playScene(id) {
  const token = ++sceneToken;
  scenePlaying = true;
  resumeAfter = false;
  holdForScene();
  $('#scene').hidden = false; $('#scene').dataset.scene = id;
  syncMusic();
  const lines = SCENES.scenes[id];
  for (let i = 0; i < lines.length; i++) {
    if (token !== sceneToken) return; // skipped
    const line = lines[i], who = SCENES.cast[line.who], text = line.text.replace(/<[^>]+>\s*/g, '');
    $('#scenePortrait').style.backgroundImage = who.art ? `url(/art/${who.art}.webp)` : 'url(/art/ruin.webp)';
    $('#sceneName').textContent = who.name;
    const p = $('#sceneLine'); p.textContent = '';
    let shown = 0;
    const typer = setInterval(() => { shown = Math.min(text.length, shown + 2); p.textContent = text.slice(0, shown); if (shown >= text.length) clearInterval(typer); }, 28);
    await new Promise(done => {
      let finished = false;
      advance = () => { if (finished) return; finished = true; clearInterval(typer); if (token === sceneToken) p.textContent = text; voice.onended = voice.onerror = null; voice.pause(); advance = null; done(); };
      const later = ms => setTimeout(() => { if (!finished) advance(); }, ms);
      if (soundOn) {
        voice.onended = () => later(450);
        voice.onerror = () => later(1200 + text.length * 45);
        voice.src = `/audio/lines/${id}-${i + 1}.mp3`;
        voice.play().catch(() => later(1200 + text.length * 45));
      } else later(1200 + text.length * 45);
    });
  }
  if (token === sceneToken) finishScene();
}
function finishScene() {
  scenePlaying = false;
  $('#scene').hidden = true;
  if (sceneQueue.length && !skipScenes) return playScene(sceneQueue.shift());
  syncMusic();
  // carry on where we were, unless a decision is waiting for the player
  if (resumeAfter && S && !S.decision && !S.over) api('/api/play', {}).then(render).catch(() => {});
  resumeAfter = false;
}
function skipScene() {
  if (!scenePlaying) return;
  sceneToken++; // the running scene stops at its next step
  advance?.();
  finishScene();
}
$('#sceneNext').onclick = () => advance?.();
$('#sceneSkip').onclick = skipScene;
$('#sceneOff').onchange = e => { skipScenes = e.target.checked; store.set('bs-skip-scenes', skipScenes ? '1' : '0'); if (skipScenes) { sceneQueue = []; skipScene(); } };
addEventListener('keydown', e => {
  if ($('#scene').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); skipScene(); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance?.(); }
});
$('#sound').onclick = () => {
  soundOn = !soundOn; store.set('bs-sound', soundOn ? '1' : '0');
  $('#sound').textContent = soundOn ? '🔊' : '🔇';
  if (!soundOn) voice.pause();
  syncMusic();
};
// browsers only allow sound after the player interacts with the page
addEventListener('pointerdown', () => { if (userActed) return; userActed = true; setTimeout(pumpScenes, 50); }, { capture: true });
