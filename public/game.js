const $ = s => document.querySelector(s);
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ART = { you: 'player', teodora: 'teodora', kasim: 'kasim', vey: 'vey', ozzo: 'ozzo' };
const STANCE_HINT = {
  steady: 'Fair markup on everything. Safe, slow, steady.',
  undercut: 'Always beat the cheapest rival. Volume over margin — watch your costs.',
  corner: 'Outbid everyone for ALL supply of your focus good, then set the price. Best right before a shortage.',
  hoard: 'Stockpile and only sell into a rising market. Perfect before a festival.',
  premium: 'Few sales, fat margins, loyal rich customers.',
  liquidate: 'Dump stock for cash. Use when you’re about to go under.',
};
const SPEEDS = [1400, 600, 250];
let S = null, speedIdx = 0, prevBarks = {};

// ---------- render ----------
function stalls() {
  $('#stalls').innerHTML = S.merchants.map(m => {
    const pnl = m.lastPnl, chainLink = S.chain.mode === 'testnet' ? `${S.chain.explorer}/address/${m.wallet}` : null;
    const owner = m.ownedBy ? S.merchants.find(x => x.id === m.ownedBy) : null;
    return `<article class="stall ${m.player ? 'me' : ''} ${m.bankrupt ? 'bankrupt' : ''}" style="--c:${m.color}" data-id="${m.id}">
      <div class="portrait" style="background-image:url(/art/${ART[m.id]}.webp)"></div>
      <div>
        <h3>${esc(m.name)}</h3>
        <div class="nw">${m.netWorth.toLocaleString()}<small>g net</small> <span class="pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${pnl}</span></div>
        <span class="stance ${m.doctrine.stance}">${m.doctrine.stance}${m.doctrine.focus ? ' · ' + m.doctrine.focus : ''}</span>
      </div>
      <div class="bark ${m.thinking ? 'thinking' : ''}" title="${esc(m.thought || '')}">${esc(m.bark || (m.player ? 'Awaiting your orders…' : '…'))}</div>
      <div class="charter"><span>NFT ${esc(m.tokenId || '')}</span>${chainLink ? `<a href="${chainLink}" target="_blank" rel="noopener">${esc(m.wallet)}</a>` : `<span>${esc(m.wallet || '')}</span>`}</div>
      ${m.bankrupt && !m.ownedBy && !m.player ? `<button class="primary takeover" data-target="${m.id}">Buy charter · ${m.takeoverPrice}g</button>` : ''}
      ${owner ? `<div class="owned">Charter owned by ${esc(owner.name)}</div>` : ''}
    </article>`;
  }).join('');
  for (const m of S.merchants) {
    if (m.bark && prevBarks[m.id] !== m.bark) document.querySelector(`.stall[data-id="${m.id}"]`)?.classList.add('flash');
    prevBarks[m.id] = m.bark;
  }
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
  }
  for (const g of S.goods) {
    const card = el.querySelector(`[data-g="${g.id}"]`), h = g.history, prev = h.at(-6) ?? h[0], ch = ((g.price - prev) / prev) * 100;
    card.querySelector('.p').textContent = `${g.price.toFixed(1)}g`;
    const d = card.querySelector('.d'); d.textContent = `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(0)}%`; d.className = 'd ' + (ch >= 0 ? 'pnl up' : 'pnl down');
    spark(card.querySelector('canvas'), h, ch >= 0 ? '#6cc483' : '#e0614a');
    const total = S.merchants.reduce((t, m) => t + m.inventory[g.id], 0) || 1;
    card.querySelector('.share').innerHTML = S.merchants.filter(m => m.inventory[g.id]).map(m => `<i style="width:${(m.inventory[g.id] / total) * 100}%;background:${m.color}" title="${esc(m.name)}: ${m.inventory[g.id]}"></i>`).join('');
    const me = S.merchants.find(m => m.player), top = [...S.merchants].sort((a, b) => b.inventory[g.id] - a.inventory[g.id])[0];
    card.querySelector('.meta').innerHTML = `<span>You hold ${me.inventory[g.id]}</span><span>${top.inventory[g.id] ? `${esc(top.name.split(' ').at(-1))} holds ${Math.round((top.inventory[g.id] / total) * 100)}%` : 'no stock in town'}</span>`;
  }
}

function race() {
  const canvas = $('#race'), dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = 150;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr);
  const all = S.merchants.flatMap(m => m.netHistory), max = Math.max(...all, 400), min = Math.min(0, ...all);
  c.strokeStyle = '#4a3727'; c.beginPath(); c.moveTo(0, h - 1); c.lineTo(w, h - 1); c.stroke();
  for (const m of S.merchants) {
    const d = m.netHistory; if (d.length < 2) continue;
    c.beginPath(); d.forEach((v, i) => { const x = (i / (d.length - 1)) * w, y = h - 6 - ((v - min) / (max - min)) * (h - 12); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = m.color; c.lineWidth = m.player ? 3 : 1.6; c.globalAlpha = m.bankrupt ? 0.35 : 1; c.stroke(); c.globalAlpha = 1;
  }
  $('#legend').innerHTML = S.merchants.map(m => `<span><i style="background:${m.color}"></i>${esc(m.name)}</span>`).join('');
}

function feeds() {
  $('#news').innerHTML = S.news.map(n => `<li class="${n.kind}"><b>Day ${n.day}</b> · ${esc(n.text)}</li>`).join('');
  $('#ledger').innerHTML = S.chainFeed.length ? S.chainFeed.map(f => `<li class="${f.kind}"><span class="k">${f.kind}</span>${esc(f.text)} ${f.url ? `<a href="${f.url}" target="_blank" rel="noopener">${f.hash.slice(0, 8)}…↗</a>` : `<span class="muted">${esc(f.hash || '')}</span>`}</li>`).join('') : '<li>Settlements post every 5 days.</li>';
  $('#chainNote').textContent = S.chain.mode === 'testnet' ? 'NEAR testnet · real transactions' : 'simulated (set NEAR keys for testnet)';
}

function header() {
  $('#day').textContent = S.day;
  $('#events').innerHTML = S.events.map(e => `<span>${esc(e.text)} · ${e.left}d</span>`).join('');
  const r = $('#rumor'); r.hidden = !S.rumor; r.textContent = S.rumor ? `Rumor: ${S.rumor}` : '';
  $('#play').textContent = S.running ? '⏸ Pause' : '▶ Open the bazaar';
  const b = $('#chainBadge');
  b.textContent = S.chain.mode === 'testnet' ? `● NEAR testnet · ${S.chain.root}` : '○ mock chain';
  b.className = 'chain ' + (S.chain.mode === 'testnet' ? '' : 'mock');
  b.href = S.chain.mode === 'testnet' ? `${S.chain.explorer}/address/${S.chain.contract}` : '#';
  const me = S.merchants.find(m => m.player);
  $('#houseCharter').textContent = `· ${me.gold}g in the till · ${me.tokenId || ''}`;
  document.querySelectorAll('#stances button').forEach(btn => btn.classList.toggle('on', btn.dataset.s === me.doctrine.stance));
  if (document.activeElement !== $('#focus')) $('#focus').value = me.doctrine.focus || '';
  if (document.activeElement !== $('#aggr')) $('#aggr').value = me.doctrine.aggression;
  $('#stanceHint').textContent = STANCE_HINT[me.doctrine.stance];
}

function render(s) { S = s; header(); stalls(); goods(); race(); feeds(); }
const refresh = () => api('/api/state').then(render).catch(() => {});

// ---------- controls ----------
$('#stances').innerHTML = Object.keys(STANCE_HINT).map(s => `<button type="button" data-s="${s}">${s}</button>`).join('');
const setDoctrine = patch => {
  const me = S.merchants.find(m => m.player);
  api('/api/doctrine', { ...me.doctrine, ...patch }).then(render);
};
$('#stances').onclick = e => { if (e.target.dataset.s) setDoctrine({ stance: e.target.dataset.s }); };
$('#focus').onchange = e => setDoctrine({ focus: e.target.value || null });
$('#aggr').onchange = e => setDoctrine({ aggression: Number(e.target.value) });
$('#play').onclick = () => api(S.running ? '/api/pause' : '/api/play', {}).then(render);
$('#speed').onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; $('#speed').textContent = ['1×', '3×', '6×'][speedIdx]; api('/api/speed', { ms: SPEEDS[speedIdx] }).then(render); };
$('#sim').onclick = async e => { e.target.disabled = true; e.target.textContent = '⏩ simulating…'; const poll = setInterval(refresh, 300); await api('/api/simulate', { days: 30 }).then(render).catch(alert); clearInterval(poll); e.target.disabled = false; e.target.textContent = '⏩ 30 days'; };
$('#reset').onclick = () => confirm('Start a new game?') && api('/api/reset', { seed: Math.floor(Math.random() * 1e6) }).then(render);
$('#stalls').onclick = e => { const t = e.target.dataset.target; if (t) api('/api/takeover', { target: t }).then(render).catch(err => alert(err.message)); };
$('#orderForm').onsubmit = async e => {
  e.preventDefault();
  const order = $('#order').value.trim(); if (!order) return;
  const btn = $('#orderBtn'); btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('/api/order', { order });
    render(r);
    $('#reply').hidden = false;
    $('#reply').innerHTML = `<b>Your factor:</b> “${esc(r.reply.bark)}” <span class="muted">→ ${esc(r.reply.stance)}${r.reply.focus ? ' · ' + esc(r.reply.focus) : ''} — ${esc(r.reply.thought)}</span>`;
    $('#order').value = '';
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = 'Send';
};

try { if (!localStorage.getItem('bs-intro')) { $('#intro').showModal(); localStorage.setItem('bs-intro', '1'); } } catch { $('#intro').showModal(); }
refresh();
setInterval(refresh, 700);
addEventListener('resize', () => S && render(S));
