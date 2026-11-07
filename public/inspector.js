// "Inspect on NEAR": checks every claim on the board against the chain, live, from the visitor's own browser.
// For each house: the charter NFT (owner + its living metadata), the stall wallet's NEAR balance, and the goods it
// holds as NEP-245 tokens, next to what the game shows; plus what that house's mind is thinking right now.
// Reads only (public RPC view calls); nothing is signed here.
(() => {
  const RPC = 'https://rpc.testnet.near.org';
  const GOODS = ['saffron', 'silk', 'tea', 'salt'];
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const rpc = async (params) => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'inspect', method: 'query', params: { finality: 'final', ...params } }) });
    const j = await r.json(); if (j.error || j.result?.error) throw new Error(j.error?.cause?.name || j.result?.error || 'RPC error'); return j.result;
  };
  const view = async (contract, method, args) => JSON.parse(new TextDecoder().decode(new Uint8Array((await rpc({ request_type: 'call_function', account_id: contract, method_name: method, args_base64: b64(args) })).result)));
  const account = id => rpc({ request_type: 'view_account', account_id: id });
  const near = yocto => (Number(BigInt(yocto) / 10n ** 20n) / 1e4).toFixed(3);

  const btn = Object.assign(document.createElement('button'), { id: 'inspect', className: 'ghost', textContent: '⛓ Inspect on NEAR', title: 'Check every charter, wallet and sack of goods straight from NEAR testnet' });
  $('#help')?.before(btn);
  const dlg = document.createElement('dialog'); dlg.id = 'inspector';
  dlg.innerHTML = `<div class="deal-head"><h2>Inspect on NEAR</h2><form method="dialog"><button class="ghost close" aria-label="Close">✕</button></form></div>
    <p class="muted" id="inspNote"></p><div id="inspBody"></div>`;
  document.body.appendChild(dlg);

  async function house(m, chain) {
    const ex = chain.explorer, cell = `insp-${m.id}`;
    const mind = m.player ? 'Your factor follows your orders.' : `${esc(m.modelLabel || 'Offline mind')}${m.thinkMs ? ` · last decision ${(m.thinkMs / 1000).toFixed(1)}s` : ''}${m.mood ? ` · ${esc(m.mood.label)} toward you` : ''}`;
    const row = document.createElement('article'); row.className = 'insp'; row.style.setProperty('--c', m.color); row.id = cell;
    row.innerHTML = `<div class="portrait" style="background-image:url(/art/${m.art}.webp)"></div>
      <div><h3>${esc(m.name)}</h3>
        <div class="insp-mind"><b>Mind:</b> ${mind}${m.thought ? `<br><b>Thinking:</b> “${esc(m.thought)}”` : ''}</div>
        <div class="insp-chain">${chain.contract ? '<i class="dots"></i> reading NEAR testnet…' : 'Practice table: the chain is simulated here.'}</div></div>`;
    $('#inspBody').appendChild(row);
    if (!chain.contract || !m.tokenId || !m.wallet) return;
    const out = row.querySelector('.insp-chain');
    try {
      const [nft, acct, bal, vault, keys] = await Promise.all([
        view(chain.contract, 'nft_token', { token_id: m.tokenId }),
        account(m.wallet),
        view(chain.contract, 'mt_batch_balance_of', { account_id: m.wallet, token_ids: GOODS }),
        view(chain.contract, 'vault_of', { token_id: m.tokenId }).catch(() => '0'),
        view(chain.contract, 'signers_of', { account_id: m.owner || m.wallet }).catch(() => []),
      ]);
      const md = nft?.metadata || {};
      const goods = GOODS.map((g, i) => {
        const onChain = Number(bal[i] || 0), inGame = Math.floor(m.inventory?.[g] || 0);
        return `<span title="On chain ${onChain} · in game now ${inGame} (stock is mirrored to the chain every 5 days)">${g} <b>${onChain}</b>${onChain !== inGame ? `<small> (now ${inGame})</small>` : ''}</span>`;
      }).join(' ');
      if (md.media && /\/charter\//.test(md.media)) row.querySelector('.portrait').outerHTML = `<a href="${esc(md.media)}" target="_blank" rel="noopener" title="The NFT's own image, drawn from its on-chain state"><img class="insp-card" src="${esc(md.media)}" alt="${esc(m.name)} charter card"></a>`;
      out.innerHTML = `<div><b>Charter NFT</b> <a href="${ex}/nft-token/${chain.contract}/${m.tokenId}" target="_blank" rel="noopener">${esc(m.tokenId)} ↗</a> · owner <a href="${ex}/address/${nft?.owner_id}" target="_blank" rel="noopener">${esc(nft?.owner_id || '?')}</a></div>
        <div class="insp-md">“${esc(md.description || md.title || '')}”</div>
        <div><b>Charter vault</b> ${near(vault)} NEAR held by the NFT itself; only its owner can spend it${keys.length ? ` · ${m.player && keys.includes(window.bazaarKey) ? `you sign your side in this browser with <code>${esc(window.bazaarKey.slice(0, 16))}…</code> (the key never leaves it)` : `owner signs intents with <code>${esc(keys.at(-1).slice(0, 16))}…</code>`}` : ''}</div>
        <div><b>Stall wallet</b> <a href="${ex}/address/${m.wallet}" target="_blank" rel="noopener">${esc(m.wallet)} ↗</a> · ${near(acct.amount)} NEAR</div>
        <div><b>Goods on chain (NEP-245)</b> ${goods}</div>`;
    } catch (e) { out.textContent = `Could not read the chain right now (${e.message}).`; }
  }

  btn.onclick = () => {
    const st = typeof S !== 'undefined' ? S : null; if (!st) return;
    const chain = st.chain || {};
    $('#inspNote').innerHTML = chain.contract
      ? `Live table ${chain.table}: read just now from NEAR testnet, contract <a href="${chain.explorer}/address/${chain.contract}" target="_blank" rel="noopener">${esc(chain.contract)} ↗</a>. Each charter's record and stock are written to the chain every 5 days of play; deals and fees settle on chain as they happen. This panel only reads.`
      : 'This is a practice table, so its chain entries are simulated. Start a new season while a live table is free to settle on NEAR testnet. The minds below are real either way.';
    $('#inspBody').innerHTML = '';
    for (const m of st.merchants) house(m, chain);
    dlg.showModal();
  };
})();
