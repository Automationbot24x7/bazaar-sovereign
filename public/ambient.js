// The living bazaar: a canvas behind the stalls that redraws the backdrop with a slow camera drift and brings it to life:
// flickering lanterns, drifting spice dust, birds over the palace, townsfolk walking past the stalls, and visitors and
// weather driven by the game itself (the silk caravan, festival sky lanterns, storms and monsoon rain, drought haze,
// the Magnate's gold wagon while he dumps goods). It only reads the game state S; it never changes it.
(() => {
  const stage = document.querySelector('.stage'), stallsEl = document.querySelector('#stalls');
  if (!stage || !stallsEl) return;
  const cv = document.createElement('canvas');
  cv.className = 'ambient'; cv.setAttribute('aria-hidden', 'true');
  stage.prepend(cv);
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });

  const IW = 1600, IH = 893;                         // backdrop size; lantern spots are in its pixels
  const LANTERNS = [[66, 312, 1], [183, 305, .55], [281, 312, 1], [383, 305, 1], [467, 298, .5], [520, 300, 1], [612, 295, .7], [695, 300, .55],
    [185, 410, 1.25], [683, 355, 1.1], [1057, 305, .7], [1100, 315, .7], [1076, 355, 1.2], [1214, 295, .55], [1460, 380, 1.2], [1535, 300, .8], [1590, 300, .7]];
  const HUMAN = { townsfolk: 212, camels: 161, magnate: 160 };   // a grown person's height in each sprite sheet's pixels

  let bg = null, SP = null, W = 0, H = 0, dpr = 1, laneY = 0, onScreen = true, last = 0, t = 0;
  const walkers = [], motes = [], birds = [], drops = [], skyLanterns = [];
  let flash = 0, nextBolt = 0, nextSpawn = 0, nextWagon = 0, lastEvents = '', lastStage = '';

  function size() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = stage.clientWidth; H = stage.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    laneY = stallsEl.offsetTop;                       // the top edge of the stall cards: walkers' feet hide behind them
  }
  // the backdrop is drawn like CSS "cover" at center 30%, with a slow drift and breathing zoom
  function view() {
    const s = Math.max(W / IW, H / IH) * (reduce ? 1 : 1.03 + 0.02 * Math.sin(t / 23));
    const fx = reduce ? 0.5 : 0.5 + 0.06 * Math.sin(t / 31), fy = reduce ? 0.3 : 0.3 + 0.05 * Math.sin(t / 37);
    return { s, ox: (W - IW * s) * fx, oy: (H - IH * s) * fy };
  }

  // ---------- what the game says is happening ----------
  function mood() {
    const st = typeof S !== 'undefined' && S ? S : null;
    const ev = new Set((st?.events || []).map(e => e.id));
    return {
      running: !!st?.running, ev, stage: st?.magnate?.stage || '',
      festival: ev.has('festival'), storm: ev.has('storm'), monsoon: ev.has('monsoon'), drought: ev.has('drought'),
      caravan: ev.has('caravan'), salt: ev.has('salt_glut'), taxman: ev.has('taxman'),
    };
  }

  // ---------- walkers: sprites crossing in front of the painted stalls ----------
  function spawn(sheet, i, opts = {}) {
    const meta = SP?.[sheet]?.[i]; if (!meta || !meta.img) return null;
    if (laneY < 110) return null;                    // phones: the cards fill the stage, no street left to walk on
    const far = opts.far ?? Math.random() < 0.35;
    const v = view(), personH = Math.min((far ? 165 : 200) * v.s, laneY * (far ? 0.95 : 1.1));          // painted townsfolk near the front are ~200 px tall
    const k = personH / HUMAN[sheet], w = meta.w * k, h = meta.h * k;
    const dir = opts.dir ?? (Math.random() < 0.5 ? 1 : -1);
    const speed = personH * (opts.speed ?? rnd(0.26, 0.36));
    const x = opts.x ?? (dir > 0 ? -w - 10 : W + w + 10);
    const wk = { img: far ? meta.dim : meta.img, w, h, x, dir, speed, far, phase: rnd(0, 6), sheet, wheeled: !!opts.wheeled, shade: far ? 0.82 : 1 };
    walkers.push(wk); return wk;
  }
  function dimmed(img) {                            // figures further back sit in the haze: a darker, warmer copy
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(70,40,20,.28)'; x.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function procession(list, dir, gap) {             // a column walking together, the first one leading in from the edge
    let edge = dir > 0 ? -10 : W + 10;              // where the previous figure's trailing side is
    for (const [sheet, i, o] of list) {
      const wk = spawn(sheet, i, { dir, far: false, speed: 0.27, ...o, x: 0 });
      if (!wk) continue;
      wk.x = edge - dir * wk.w / 2;
      edge = wk.x - dir * (wk.w / 2 + gap);
    }
  }
  function caravan() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    procession([['camels', 2], ['camels', 0], ['camels', 0], ['camels', 1]], dir, 18 * view().s);
  }
  function magnateTrain() {
    const dir = -1; // he rolls in from the east
    procession([['magnate', 1], ['magnate', 0, { wheeled: true }], ['magnate', 2, { wheeled: true }]], dir, 30 * view().s);
  }
  function crowdTarget(m) {
    let n = 3 + (m.running ? 2 : 0) + (m.festival ? 3 : 0) + (m.salt ? 1 : 0);
    if (m.storm) n = 1; else if (m.monsoon) n = 2;
    if (m.stage === 'monopoly') n = Math.max(1, n - 3);             // his monopoly empties the street
    return Math.min(n, W < 700 ? 3 : 8);
  }
  function updateWalkers(dt, m) {
    const plain = walkers.filter(w => w.sheet === 'townsfolk').length;
    if (t > nextSpawn && plain < crowdTarget(m)) {
      // porters with sacks when the salt barges are in; otherwise anyone
      const i = m.salt && Math.random() < 0.5 ? 0 : Math.floor(Math.random() * SP.townsfolk.length);
      spawn('townsfolk', i, { speed: m.storm || m.monsoon ? 0.5 : undefined });
      nextSpawn = t + rnd(1.2, 3.5) / (m.running ? 1.4 : 1);
    }
    // events arriving on the street
    const evKey = [...m.ev].sort().join(',');
    if (evKey !== lastEvents) { if (m.caravan && !lastEvents.includes('caravan')) caravan(); lastEvents = evKey; }
    if (m.stage !== lastStage) { if (m.stage === 'dumping' && lastStage) nextWagon = t; lastStage = m.stage; }
    if (['dumping', 'monopoly'].includes(m.stage) && t > nextWagon) { magnateTrain(); nextWagon = t + rnd(24, 34); }
    for (const w of walkers) { w.x += w.dir * w.speed * dt; w.phase += dt * w.speed / (w.h * 0.18); }
    for (let i = walkers.length - 1; i >= 0; i--) { const w = walkers[i]; if ((w.dir > 0 && w.x - w.w > W + 60) || (w.dir < 0 && w.x + w.w < -60)) walkers.splice(i, 1); }
  }
  function drawWalkers() {
    const sorted = [...walkers].sort((a, b) => (a.far === b.far ? 0 : a.far ? -1 : 1));
    for (const w of sorted) {
      // feet always hide behind the stall cards: the painting above them shows awnings and stalls, not ground,
      // so a visible foot line there reads as floating. The back row is smaller and dimmer, heads near the same line.
      const base = laneY + (w.far ? 0.36 : 0.5) * w.h;
      const bob = w.wheeled ? Math.abs(Math.sin(w.phase * 0.7)) * w.h * 0.006 : Math.abs(Math.sin(w.phase)) * w.h * 0.022;
      const tilt = w.wheeled ? 0 : Math.sin(w.phase) * 0.018;
      ctx.save();
      ctx.translate(w.x, base - bob);
      ctx.rotate(tilt);
      if (w.dir < 0) ctx.scale(-1, 1);
      // a soft contact shadow, then the figure
      ctx.globalAlpha = 0.28 * w.shade; ctx.fillStyle = '#1b0f08';
      ctx.beginPath(); ctx.ellipse(0, -w.h * 0.01, w.w * 0.36, w.h * 0.035, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(w.img, -w.w / 2, -w.h, w.w, w.h);
      ctx.restore();
    }
  }

  // ---------- light, dust, sky ----------
  function drawLanterns(v, m) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const boost = m.festival ? 1.6 : m.storm ? 0.6 : m.stage === 'monopoly' ? 0.75 : 1;
    LANTERNS.forEach(([x, y, k], i) => {
      const fl = reduce ? 1 : 0.82 + 0.12 * Math.sin(t * 7.3 + i * 1.7) + 0.08 * Math.sin(t * 13.1 + i * 3.1) + (Math.random() < 0.02 ? -0.2 : 0);
      const px = v.ox + x * v.s, py = v.oy + y * v.s, r = 34 * v.s * k * (0.9 + 0.15 * fl);
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,190,90,${0.42 * k * fl * boost})`);
      g.addColorStop(0.4, `rgba(255,140,40,${0.16 * k * fl * boost})`);
      g.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
    ctx.restore();
  }
  function seedMotes() { motes.length = 0; for (let i = 0; i < 46; i++) motes.push({ x: rnd(0, 1), y: rnd(0, 1), r: rnd(0.6, 2.2), sp: rnd(0.006, 0.02), ph: rnd(0, 6) }); }
  function drawMotes(dt, m) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const wind = m.drought ? 1.8 : 1;
    for (const p of motes) {
      if (!reduce) { p.y -= p.sp * dt * wind; p.x += Math.sin(t * 0.6 + p.ph) * 0.004 * dt + 0.004 * dt * wind; }
      if (p.y < -0.02) { p.y = 1.02; p.x = rnd(0, 1); } if (p.x > 1.02) p.x = -0.02;
      const a = (0.25 + 0.25 * Math.sin(t * 2 + p.ph)) * (m.drought ? 1.4 : 1);
      ctx.fillStyle = `rgba(255,${m.drought ? 170 : 200},120,${a})`;
      ctx.beginPath(); ctx.arc(p.x * W, p.y * laneY, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function seedBirds() { birds.length = 0; for (let i = 0; i < 4; i++) birds.push({ x: rnd(560, 1100), y: rnd(40, 150), vx: rnd(14, 26) * (Math.random() < 0.5 ? 1 : -1), ph: rnd(0, 6), sz: rnd(4, 7) }); }
  function drawBirds(v, dt, m) {
    if (m.storm) return;
    ctx.save(); ctx.strokeStyle = 'rgba(40,24,14,.75)'; ctx.lineCap = 'round';
    for (const b of birds) {
      if (!reduce) { b.x += b.vx * dt; b.y += Math.sin(t * 0.8 + b.ph) * 4 * dt; b.ph += dt * 9; }
      if (b.x < 480 || b.x > 1180) b.vx *= -1;
      const px = v.ox + b.x * v.s, py = v.oy + b.y * v.s, s = b.sz * v.s, f = Math.sin(b.ph) * 0.6;
      ctx.lineWidth = Math.max(1, 1.4 * v.s);
      ctx.beginPath(); ctx.moveTo(px - s, py - s * f); ctx.quadraticCurveTo(px - s * 0.4, py - s * 0.3, px, py); ctx.quadraticCurveTo(px + s * 0.4, py - s * 0.3, px + s, py - s * f); ctx.stroke();
    }
    ctx.restore();
  }
  function drawSkyLanterns(dt, m) {
    if (m.festival && !reduce && skyLanterns.length < 40 && Math.random() < dt * 3) skyLanterns.push({ x: rnd(0.05, 0.95) * W, y: laneY - 20, vy: rnd(18, 34), ph: rnd(0, 6), s: rnd(0.7, 1.3), life: 0 });
    ctx.save();
    for (let i = skyLanterns.length - 1; i >= 0; i--) {
      const l = skyLanterns[i]; l.life += dt; l.y -= l.vy * dt; l.x += Math.sin(t * 0.9 + l.ph) * 8 * dt;
      if (l.y < -30) { skyLanterns.splice(i, 1); continue; }
      const a = Math.min(1, l.life / 1.2) * Math.min(1, (l.y + 30) / 80), w = 13 * l.s, h = 17 * l.s;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, w * 3.4); g.addColorStop(0, `rgba(255,180,70,${0.75 * a})`); g.addColorStop(0.35, `rgba(255,130,40,${0.3 * a})`); g.addColorStop(1, 'rgba(255,110,30,0)');
      ctx.fillStyle = g; ctx.fillRect(l.x - w * 3.4, l.y - w * 3.4, w * 6.8, w * 6.8);
      ctx.globalCompositeOperation = 'source-over';
      const body = ctx.createLinearGradient(l.x, l.y - h / 2, l.x, l.y + h / 2);
      body.addColorStop(0, `rgba(230,120,40,${a})`); body.addColorStop(0.7, `rgba(255,${205 + Math.round(30 * Math.sin(t * 5 + l.ph))},120,${a})`); body.addColorStop(1, `rgba(255,250,210,${a})`);
      ctx.fillStyle = body; ctx.strokeStyle = `rgba(90,40,15,${0.7 * a})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(l.x - w / 2, l.y - h / 2); ctx.lineTo(l.x + w / 2, l.y - h / 2); ctx.lineTo(l.x + w / 2.6, l.y + h / 2); ctx.lineTo(l.x - w / 2.6, l.y + h / 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  function drawWeather(dt, m) {
    // rain
    const rain = m.storm ? 340 : m.monsoon ? 170 : 0;
    while (drops.length < rain) drops.push({ x: rnd(-0.1, 1.1), y: rnd(-0.2, 1), v: rnd(1.1, 1.6), l: rnd(16, 30) });
    if (drops.length > rain) drops.length = rain;
    if (rain && !reduce) {
      ctx.save(); ctx.strokeStyle = m.storm ? 'rgba(215,225,245,.55)' : 'rgba(205,218,240,.45)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const d of drops) {
        d.y += d.v * dt; d.x -= 0.18 * d.v * dt;
        if (d.y > 1.05) { d.y = rnd(-0.2, 0); d.x = rnd(-0.1, 1.2); }
        const x = d.x * W, y = d.y * H; ctx.moveTo(x, y); ctx.lineTo(x - d.l * 0.25, y + d.l);
      }
      ctx.stroke(); ctx.restore();
    }
    // lightning in a storm
    if (m.storm && !reduce) {
      if (t > nextBolt) { flash = 1; nextBolt = t + rnd(3.5, 8); }
      if (flash > 0) { ctx.fillStyle = `rgba(235,240,255,${0.45 * flash * (Math.random() < 0.3 ? 0.4 : 1)})`; ctx.fillRect(0, 0, W, H); flash = Math.max(0, flash - dt * 3.2); }
    }
    // mood of the light
    const tint = m.storm ? 'rgba(25,35,60,.38)' : m.monsoon ? 'rgba(35,50,75,.26)' : m.stage === 'monopoly' ? 'rgba(60,8,20,.26)' : m.drought ? 'rgba(160,70,0,.12)' : m.taxman ? 'rgba(30,20,40,.12)' : null;
    if (tint) { ctx.fillStyle = tint; ctx.fillRect(0, 0, W, H); }
  }

  // ---------- frame ----------
  function frame(now) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now; t += dt;
    if (!bg) return;
    const m = mood(), v = view();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(bg, v.ox, v.oy, IW * v.s, IH * v.s);
    drawBirds(v, dt, m);
    drawSkyLanterns(dt, m);
    drawLanterns(v, m);
    if (SP && !reduce) { updateWalkers(dt, m); drawWalkers(); }
    drawMotes(dt, m);
    drawWeather(dt, m);
  }
  function loop(now) { if (onScreen && !document.hidden) frame(now); else last = 0; if (!reduce) requestAnimationFrame(loop); }

  // a small handle for checking the street by hand (and for the demo capture): bazaarStreet.caravan(), .magnate()
  window.bazaarStreet = { walkers, skyLanterns, caravan: () => caravan(), magnate: () => magnateTrain(), get ready() { return !!SP; } };

  new IntersectionObserver(es => { onScreen = es[0].isIntersecting; }).observe(stage);
  const ro = new ResizeObserver(() => { size(); if (reduce) frame(performance.now()); });
  ro.observe(stage); ro.observe(stallsEl);   // the cards fill in after the first poll: the lane follows their top edge
  size(); seedMotes(); seedBirds();

  (async () => {
    bg = await load('/art/bazaar.webp');
    if (!bg) { cv.remove(); return; }
    stage.classList.add('alive');                   // the canvas now paints the backdrop
    if (reduce) { frame(performance.now()); return; }
    requestAnimationFrame(loop);
    const index = await fetch('/art/sprites/index.json').then(r => r.json()).catch(() => null);
    if (!index) return;
    for (const list of Object.values(index)) await Promise.all(list.map(async s => { s.img = await load(s.src); if (s.img) s.dim = dimmed(s.img); }));
    SP = index;
    // a few townsfolk are already mid-street when the page opens
    for (let i = 0; i < 3; i++) spawn('townsfolk', Math.floor(Math.random() * SP.townsfolk.length), { x: rnd(0.1, 0.9) * W });
  })();
})();
