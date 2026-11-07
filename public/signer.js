// Your side of every deal, signed in your own browser.
// On a live table this page makes an ed25519 key with WebCrypto, keeps it in this browser only, and asks your
// charter's wallet to register its public half on the contract. When a deal or fee involves your house, the
// server hands this page the NEP-413 intent; the page signs it here and sends back only the signature. The
// contract then checks that signature against the key your charter registered.
(() => {
  const STORE = 'bs-intent-key-v1';
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => {
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b) break; out = '1' + out; }
    return out;
  };
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const str = s => { const d = new TextEncoder().encode(s); return [...u32(d.length), ...d]; };

  let key = null, keyFailed = false, sentFor = '';
  const done = new Set();
  async function loadKey() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch {}
    if (saved?.jwk && saved?.pub) {
      const priv = await crypto.subtle.importKey('jwk', saved.jwk, { name: 'Ed25519' }, false, ['sign']);
      return { priv, pub: saved.pub };
    }
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const pub = `ed25519:${b58(raw)}`;
    try { localStorage.setItem(STORE, JSON.stringify({ jwk, pub })); } catch {}
    return { priv: pair.privateKey, pub };
  }
  async function sign(r) {
    // NEP-413: sha256(borsh(2^31 + 413) ++ borsh({ message, nonce[32], recipient, callback_url: None }))
    const bytes = new Uint8Array([...u32(2147484061), ...str(r.message), ...r.nonce, ...str(r.recipient), 0]);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.priv, hash))];
  }
  async function tick() {
    const st = typeof S !== 'undefined' ? S : null;
    if (!st || st.chain?.mode !== 'testnet' || keyFailed) return;
    if (!key) { try { key = await loadKey(); window.bazaarKey = key.pub; } catch { keyFailed = true; return; } }   // no Ed25519 in this browser: the wallet key signs instead
    const tag = `${gameId}|${st.liveTable}`;
    if (sentFor !== tag && st.chain.browserKey?.pk !== key.pub) { sentFor = tag; api('/api/key', { public_key: key.pub }).catch(() => { sentFor = ''; }); }
    for (const r of st.chain.signRequests || []) {
      if (done.has(r.id)) continue;
      done.add(r.id);
      sign(r).then(signature => api('/api/sign', { id: r.id, signature })).then(render).catch(e => console.warn('intent signing failed', e.message));
    }
  }
  setInterval(tick, 700);
})();
