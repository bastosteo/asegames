// =====================================================================
//  Loto ASE — logique du site (aucun serveur : tout est lu sur la chaîne)
// =====================================================================
import CONFIG from './config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from './chain.js';
import * as L from './lotomath.js';
import { startVegas } from '../../vegas.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const S = {
  demo: null, rpc: null, contract: '', wallet: null, balance: null,
  info: null, cfg: null, st: null, clockOffset: 0,
  rounds: new Map(), purchases: new Map(), purchasesAt: new Map(),
  rolling: false, cart: store.get('loto.cart', []),
  busy: false, lastAnnounced: store.get('loto.lastAnnounced', 0),
};
const chainNow = () => Date.now() + S.clockOffset;
const ballHtml = (n, cls = '') => `<span class="ball ${cls}">${n}</span>`;
// Toutes les heures affichées aux joueurs sont en UTC (le panneau admin reste en heure de Paris).
const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
const utcDay = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const utcWeekday = (ms) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Number(ms)).getUTCDay()];
const plural = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

// ------------------------------------------------------------- thème
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme('dark');   // ASE Vegas est uniquement en mode sombre, comme Asentum

// ------------------------------------------------------------- notifications
function toast(text, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  if (!ms) { el.title = 'Click to close'; el.style.cursor = 'pointer'; el.onclick = () => el.remove(); }
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
function cleanError(e) {
  const m = String(e && e.message ? e.message : e);
  const i = m.lastIndexOf('failed: ');
  return i >= 0 ? m.slice(i + 8) : m;
}

// ------------------------------------------------------------- lectures
const view = (m, a = []) => S.rpc.view(S.contract, m, a);

async function loadRound(id, force = false) {
  const old = S.rounds.get(id);
  if (old && !force && ['done', 'cancelled', 'empty'].includes(old.status)) return old;
  const r = await view('getRound', [id]);
  if (r) S.rounds.set(id, r);
  return r;
}
async function loadPurchases(id) {
  const r = S.rounds.get(id);
  if (!r || !r.buys) { S.purchases.set(id, []); return []; }
  const fresh = ['open', 'closed', 'tally'].includes(r.status) || id >= S.info.round - 2;
  const age = Date.now() - (S.purchasesAt.get(id) || 0);
  if (S.purchases.has(id) && S.purchases.get(id).length === r.buys && age < (fresh ? 15000 : 120000)) return S.purchases.get(id);
  const out = [];
  for (let i = 0; i < r.buys; i += 400) out.push(...(await view('getPurchases', [id, i, 400])));
  S.purchases.set(id, out); S.purchasesAt.set(id, Date.now());
  return out;
}
async function pool(items, n, fn) {
  const queue = [...items]; const workers = Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); });
  await Promise.all(workers);
}

async function refresh() {
  try {
    const [info, cfg, st] = await Promise.all([view('info'), view('getConfig'), view('getState')]);
    S.info = info; S.cfg = cfg; S.st = st;
    S.clockOffset = Number(info.now) - Date.now();
    const first = Math.max(1, info.round - CONFIG.HISTORY_ROUNDS + 1);
    const ids = []; for (let id = info.round; id >= first; id--) ids.push(id);
    await pool(ids, 6, (id) => loadRound(id, id >= info.round - 2));
    await pool(ids, 4, (id) => loadPurchases(id));
    if (S.wallet) S.balance = await S.rpc.balance(S.wallet.address).catch(() => S.balance);
    renderAll();
  } catch (e) {
    console.error(e);
    toast('Could not read the chain: ' + cleanError(e), 'err', 8000);
  }
}

// ------------------------------------------------------------- rendu : hero
function renderHero() {
  const i = S.info; if (!i) return;
  $('#jackpot').textContent = L.fmtAse(i.jackpotEstimate, 0);
  const closing = i.status === 'closing';
  const price = BigInt(closing ? S.cfg.price : i.price);
  $('#priceLabel').textContent = L.fmtAse(price, price % L.WEI === 0n ? 0 : 2) + ' ASE';
  $('#gridsPlayed').textContent = i.grids.toLocaleString('en-GB');
  $('#drawWhen').textContent = `Draw #${i.round}, ${utcDay(i.drawTs)} at ${utcTime(i.drawTs)}`;
  $('#pausedBanner').hidden = !i.paused;
  const last = [...S.rounds.values()].filter((r) => r.status === 'done').sort((a, b) => b.id - a.id)[0];
  if (last) {
    $('#lastDraw').hidden = false;
    $('#lastDrawId').textContent = `#${last.id}, ${utcDay(last.drawTs)}`;
    const box = $('#lastBalls');
    const html = last.nums.map((n) => ballHtml(n, 'gold')).join('');
    if (box.dataset.id !== String(last.id)) { box.innerHTML = html; box.dataset.id = last.id; box.classList.remove('reveal'); void box.offsetWidth; box.classList.add('reveal'); }
    $('#lastVerify').onclick = () => verifyRound(last.id);
    if (last.cnt[2] > 0 && S.lastAnnounced < last.id) {
      S.lastAnnounced = last.id; store.set('loto.lastAnnounced', last.id);
      toast(`Jackpot won in draw #${last.id}: ${L.fmtAse(BigInt(last.per[2]) * BigInt(last.cnt[2]), 0)} ASE!`, 'ok', 12000);
    }
  }
  tickCountdown();
}
function tickCountdown() {
  const i = S.info; if (!i) return;
  const now = chainNow();
  const close = Number(i.closeTs);
  let label, target;
  if (now < close) { label = 'Sales close in'; target = close; }
  else { label = 'Draw in progress'; target = null; }
  $('#countdownLabel').textContent = label;
  if (target) {
    const s = Math.max(0, Math.floor((target - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    $('#countdown').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  } else $('#countdown').textContent = 'Results soon';
}
setInterval(tickCountdown, 1000);

// ------------------------------------------------------------- dé à 20 faces et panier
// Les numéros sont tirés par le dé (hasard du navigateur, crypto.getRandomValues) :
// le joueur ne choisit pas. Un numéro déjà sorti sur la grille est relancé.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rollD20() {
  const b = new Uint8Array(1);
  for (;;) { crypto.getRandomValues(b); if (b[0] < 240) return (b[0] % 20) + 1; }
}
function renderSlots(nums, active = -1) {
  $('#rollSlots').innerHTML = Array.from({ length: L.PICK }, (_, i) =>
    nums[i] ? ballHtml(nums[i], 'gold') : `<span class="ball slot${i === active ? ' next' : ''}" aria-hidden="true">?</span>`).join('');
}
// ---- Les 5 dés lancés par une main, qui roulent sur le tapis ----
const D20_SVG = (n) => `<svg viewBox="0 0 100 100"><polygon class="d20-body" points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5"/><polygon class="d20-face" points="50,21 79,69 21,69"/><path class="d20-edge" d="M50 3 50 21M91 26.5 50 21M91 26.5 79 69M91 73.5 79 69M50 97 79 69M50 97 21 69M9 73.5 21 69M9 26.5 21 69M9 26.5 50 21"/><text x="50" y="58" text-anchor="middle" dominant-baseline="middle">${n}</text></svg>`;
const frame = () => new Promise((r) => requestAnimationFrame(r));
function makeDice(n) {
  const table = $('#diceTable');
  table.querySelectorAll('.die').forEach((d) => d.remove());
  return Array.from({ length: n }, () => {
    const el = document.createElement('div');
    el.className = 'die'; el.innerHTML = D20_SVG('?');
    table.append(el);
    return { el, txt: el.querySelector('text'), x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0, value: 0 };
  });
}
function place(d) { d.el.style.transform = `translate(${d.x}px, ${d.y}px) rotate(${d.a}deg)`; }
// Simulation : rebonds sur les bords, frottement, chocs entre dés. Les numéros défilent tant que ça roule.
async function simulate(dice, W, H, S, maxMs) {
  const t0 = performance.now(); let last = t0;
  for (;;) {
    await frame();
    const now = performance.now(), dt = Math.min(0.04, (now - last) / 1000); last = now;
    let moving = false;
    for (const d of dice) {
      d.x += d.vx * dt; d.y += d.vy * dt; d.a += d.va * dt;
      const f = Math.exp(-2.4 * dt); d.vx *= f; d.vy *= f; d.va *= f;
      if (d.x < 0) { d.x = 0; d.vx = Math.abs(d.vx) * 0.6; }
      if (d.x > W - S) { d.x = W - S; d.vx = -Math.abs(d.vx) * 0.6; d.va *= -0.8; }
      if (d.y < 0) { d.y = 0; d.vy = Math.abs(d.vy) * 0.6; }
      if (d.y > H - S) { d.y = H - S; d.vy = -Math.abs(d.vy) * 0.6; }
      const sp = Math.hypot(d.vx, d.vy);
      if (sp > 18) moving = true;
      if (sp > 70 && Math.random() < 0.35) d.txt.textContent = 1 + Math.floor(Math.random() * 20);
    }
    for (let i = 0; i < dice.length; i++) for (let j = i + 1; j < dice.length; j++) {
      const p = dice[i], q = dice[j], dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy) || 1;
      if (dist < S * 0.92) {
        const nx = dx / dist, ny = dy / dist, push = (S * 0.92 - dist) / 2;
        p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
        const rel = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
        if (rel < 0) { p.vx += rel * nx * 0.9; p.vy += rel * ny * 0.9; q.vx -= rel * nx * 0.9; q.vy -= rel * ny * 0.9; }
      }
    }
    dice.forEach(place);
    if (!moving || now - t0 > maxMs) break;
  }
  for (const d of dice) { d.txt.textContent = d.value; d.a = Math.round(d.a / 60) * 60; d.txt.setAttribute('transform', `rotate(${-d.a % 360} 50 54)`); d.el.classList.add('landed'); place(d); }   // posé à plat, numéro à l'endroit
}
async function throwTicket(fast) {
  const table = $('#diceTable'), hand = $('#hand');
  const W = table.clientWidth, H = table.clientHeight, S = W < 420 ? 44 : 54;
  $('#tableHint').hidden = true;
  const dice = makeDice(L.PICK);
  const values = [];
  for (const d of dice) { d.value = rollD20(); values.push(d.value); }
  renderSlots([], 0);
  if (reduceMotion) {
    dice.forEach((d, i) => { d.x = 20 + i * (S + 10); d.y = (H - S) / 2; d.txt.textContent = d.value; place(d); });
  } else {
    // La main arrive, prend son élan et lance
    hand.style.setProperty('--throw-ms', (fast ? 420 : 900) + 'ms');
    hand.classList.remove('throw'); void hand.offsetWidth; hand.classList.add('throw');
    dice.forEach((d) => { d.x = W * 0.12; d.y = H / 2 - S / 2; d.el.style.opacity = '0'; place(d); });
    await sleep(fast ? 200 : 480);
    const speed = W * (fast ? 2.4 : 1.7);
    dice.forEach((d, i) => {
      d.el.style.opacity = '1';
      d.x = W * 0.14 + Math.random() * 12; d.y = H / 2 - S / 2 + (i - 2) * S * 0.35;
      d.vx = speed * (0.55 + Math.random() * 0.6); d.vy = (Math.random() - 0.5) * H * 3;
      d.va = (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 700);
    });
    await simulate(dice, W, H, S, fast ? 1100 : 2400);
  }
  // Un numéro déjà sorti ? Ce dé saute et se relance.
  const seen = new Set();
  for (const d of dice) {
    while (seen.has(d.value)) {
      $('#pickCount').textContent = `${d.value} came up twice: re-rolling that die…`;
      d.value = rollD20();
      if (!reduceMotion) {
        d.el.classList.remove('landed'); d.txt.removeAttribute('transform');
        d.vx = (Math.random() - 0.5) * W * 0.8; d.vy = -H * 2.2; d.va = 900;
        await simulate(dice, W, H, S, fast ? 500 : 900);   // les autres dés restent en place mais se poussent
      } else d.txt.textContent = d.value;
    }
    seen.add(d.value);
  }
  const ordered = [...dice].sort((p, q) => p.x - q.x).map((d) => d.value);
  for (let k = 1; k <= L.PICK; k++) { renderSlots(ordered.slice(0, k), k); if (!reduceMotion) await sleep(fast ? 40 : 110); }
  const grid = [...ordered].sort((a, b) => a - b);
  $('#pickCount').textContent = `Your numbers: ${grid.join(' · ')}`;
  addToCart(grid);
  return grid;
}
async function rollTickets(n) {
  if (S.rolling) return;
  S.rolling = true;
  $$('#rollBtn, [data-roll]').forEach((b) => (b.disabled = true));
  try {
    for (let k = 0; k < n; k++) {
      await throwTicket(n > 1);
      if (n > 1) { $('#pickCount').textContent = `Ticket ${k + 1} of ${n} added to your cart`; await sleep(250); }
    }
    if (n === 1) $('#pickCount').textContent += '. Added to your cart!';
  } finally {
    S.rolling = false;
    $$('#rollBtn, [data-roll]').forEach((b) => (b.disabled = false));
    $('#rollBtn').textContent = 'Throw again';
  }
}
function addToCart(grid) {
  if (S.cart.length >= 200) { toast('Cart full (200 tickets).', 'err'); return; }
  S.cart.push(grid); store.set('loto.cart', S.cart); renderCart();
}
$('#rollBtn').onclick = () => rollTickets(1);
$$('[data-roll]').forEach((b) => (b.onclick = () => rollTickets(Number(b.dataset.roll))));

function currentPrice() { return S.info ? BigInt(S.info.status === 'closing' ? S.cfg.price : S.info.price) : 2n * L.WEI; }
function renderCart() {
  const list = $('#cartList');
  list.innerHTML = S.cart.map((g, i) => `<li><span class="idx">${i + 1}</span><span class="balls tiny">${g.map((n) => ballHtml(n)).join('')}</span><button class="rm" data-rm="${i}" aria-label="Remove ticket ${i + 1}">×</button></li>`).join('');
  list.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { S.cart.splice(Number(b.dataset.rm), 1); store.set('loto.cart', S.cart); renderCart(); }));
  $('#cartEmpty').hidden = S.cart.length > 0;
  const n = S.cart.length, cost = currentPrice() * BigInt(n);
  $('#cartCount').textContent = plural(n, 'ticket', 'tickets');
  $('#cartSum').textContent = L.fmtAse(cost, cost % L.WEI === 0n ? 0 : 2) + ' ASE';
  const btn = $('#playBtn');
  const max = S.cfg ? S.cfg.maxGrids : 20;
  const txs = Math.ceil(n / max);
  if (!S.wallet) { btn.textContent = 'Connect wallet to play'; btn.disabled = false; }
  else { btn.textContent = n ? `Play ${plural(n, 'ticket', 'tickets')} (${L.fmtAse(cost, cost % L.WEI === 0n ? 0 : 2)} ASE)` : 'Confirm my tickets'; btn.disabled = !n || S.busy || (S.info && S.info.paused); }
  $('#cartNote').textContent = txs > 1 ? `More than ${max} tickets: ${txs} transactions to approve, one after the other.` : 'One single transaction for the whole cart.';
}

$('#playBtn').onclick = async () => {
  if (!S.wallet) return openWallet();
  if (!S.cart.length || S.busy) return;
  const price = currentPrice();
  const total = price * BigInt(S.cart.length);
  if (S.balance !== null && S.balance < total) { toast(`Insufficient balance: you need ${L.fmtAse(total)} ASE plus a little gas.`, 'err'); return; }
  const max = S.cfg.maxGrids;
  const chunks = []; for (let i = 0; i < S.cart.length; i += max) chunks.push(S.cart.slice(i, i + max));
  for (let k = 0; k < chunks.length; k++) {
    const part = chunks.length > 1 ? ` (${k + 1}/${chunks.length})` : '';
    const ok = await sendTx(`${plural(chunks[k].length, 'ticket registered', 'tickets registered')}${part}`, 'buy', [chunks[k], L.randomSeedHex()], price * BigInt(chunks[k].length));
    if (!ok) return;
    S.cart = S.cart.slice(chunks[k].length); store.set('loto.cart', S.cart); renderCart();
  }
  selectTab('mine');
};

// ------------------------------------------------------------- transactions
async function sendTx(doneLabel, method, args, value = 0n) {
  S.busy = true; renderCart();
  const t1 = toast(S.wallet.kind === 'telegram' ? 'Approve the transaction in Telegram…' : 'Approve the transaction in your wallet…', '', 0);
  try {
    const hash = await S.wallet.call(S.contract, method, args, value);
    t1.textContent = 'Transaction sent, waiting for confirmation (usually 10 to 60 s)…';
    const rc = await S.rpc.waitReceipt(hash);
    t1.remove();
    if (!rc.success) throw new Error(rc.error || 'rejected by the contract');
    document.dispatchEvent(new Event('asevegas:refresh-wins'));   // le bouton « My wins » se met à jour
    toast(doneLabel + ' ✓', 'ok');
    if (method === 'settle') S.purchasesAt.delete(Number(args[0]));   // relire l'achat réglé tout de suite
    await refresh();
    return true;
  } catch (e) {
    t1.remove();
    toast('Failed: ' + cleanError(e), 'err', 10000);
    return false;
  } finally { S.busy = false; renderCart(); }
}

// ------------------------------------------------------------- mes grilles
function renderMine() {
  const box = $('#mineBody');
  if (!S.wallet) { box.innerHTML = '<p class="muted">Connect your wallet to see your tickets.</p>'; return; }
  const me = S.wallet.address;
  const ids = [...S.rounds.keys()].sort((a, b) => b - a);
  let html = '';
  for (const id of ids) {
    const r = S.rounds.get(id);
    const mine = (S.purchases.get(id) || []).filter((p) => p.b === me);
    if (!mine.length) continue;
    const drawn = r.status === 'done' ? r.nums : null;
    let tag = '<span class="tag">Waiting for the draw</span>';
    if (r.status === 'done') tag = `<span class="tag">Drawn: </span><span class="balls tiny">${r.nums.map((n) => ballHtml(n, 'gold')).join('')}</span>`;
    if (r.status === 'cancelled') tag = '<span class="tag warn">Draw cancelled: 100% refunded</span>';
    html += `<div class="round-block"><div class="round-head"><h3>Draw #${id}</h3><span class="muted small">${utcDay(r.drawTs)}</span>${tag}</div>`;
    for (const p of mine) {
      const grids = p.g.map((g) => {
        const k = drawn ? L.matches(g, drawn) : 0;
        return `<div class="balls small" aria-label="Ticket ${g.join(' ')}${drawn ? ', ' + plural(k, 'match', 'matches') : ''}">${g.map((n) => ballHtml(n, drawn ? (drawn.includes(n) ? 'gold' : 'dim') : '')).join('')}</div>`;
      }).join('');
      let right = '';
      if (r.status === 'done') {
        const prize = BigInt(p.prize);
        if (prize > 0n) right = p.paid ? `<span class="tag ok">Claimed</span><span class="amount">+${L.fmtAse(prize)} ASE</span>` : `<span class="amount">+${L.fmtAse(prize)} ASE</span><button class="btn btn-primary btn-small" data-claim="${id}:${p.idx}">Claim</button>`;
        else right = '<span class="muted small">No prize</span>';
      } else if (r.status === 'cancelled') {
        right = p.paid ? '<span class="tag ok">Refunded</span>' : `<button class="btn btn-small" data-refund="${id}:${p.idx}">Refund me</button>`;
      } else right = `<span class="muted small">${plural(p.g.length, 'ticket', 'tickets')}</span>`;
      html += `<div class="ticket"><div class="grids">${grids}</div><div class="right">${right}</div></div>`;
    }
    html += '</div>';
  }
  // Gains à réclamer (sans limite de temps) : bandeau + « tout réclamer »
  const todo = [];
  for (const id of ids) {
    const r = S.rounds.get(id);
    if (r.status !== 'done' && r.status !== 'cancelled') continue;
    for (const p of S.purchases.get(id) || []) if (p.b === me && !p.paid && (r.status === 'cancelled' || p.prize !== '0')) todo.push([id, p.idx, r.status === 'cancelled' ? BigInt(r.price) * BigInt(p.g.length) : BigInt(p.prize)]);
  }
  const total = todo.reduce((a, x) => a + x[2], 0n);
  const head = todo.length ? `<div class="claim-banner"><div><strong>${L.fmtAse(total)} ASE</strong> to claim <span class="muted small">(${plural(todo.length, 'prize', 'prizes')}, no time limit)</span></div><button class="btn btn-primary" id="claimAll">${todo.length > 1 ? 'Claim all' : 'Claim'}</button></div>` : '';
  const oldest = ids.length ? ids[ids.length - 1] : 1;
  const more = oldest > 1 ? `<p class="small muted older">Looking for an older prize? <button class="link-btn" id="olderBtn">Search older draws</button></p>` : '';
  box.innerHTML = head + (html || '<p class="muted">You haven\'t played in recent draws yet. Roll the die just above.</p>') + more;
  const ca = $('#claimAll');
  if (ca) ca.onclick = async () => {
    for (let k = 0; k < todo.length; k++) {
      const [id, i] = todo[k];
      const ok = await sendTx(todo.length > 1 ? `Prize ${k + 1} of ${todo.length} claimed` : 'Prize claimed', 'settle', [id, i, 1]);
      if (!ok) break;
    }
  };
  const ob = $('#olderBtn');
  if (ob) ob.onclick = async () => {
    ob.disabled = true; ob.textContent = 'Searching…';
    const ids2 = []; for (let id = oldest - 1; id >= Math.max(1, oldest - 60); id--) ids2.push(id);
    await pool(ids2, 6, (id) => loadRound(id));
    await pool(ids2, 4, (id) => loadPurchases(id));
    renderAll();
  };
  box.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = () => { const [id, i] = b.dataset.claim.split(':').map(Number); sendTx('Prize claimed', 'settle', [id, i, 1]); }));
  box.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = () => { const [id, i] = b.dataset.refund.split(':').map(Number); sendTx('Refund received', 'settle', [id, i, 1]); }));
  announceWins();
}

// Message « Tu as gagné » : une fois par gain, quand le wallet du gagnant est connecté.
function announceWins() {
  if (!S.wallet) return;
  const me = S.wallet.address, key = 'asegame.loto.vus.' + me;
  const seen = new Set(store.get(key, []));
  for (const [id, list] of S.purchases) {
    const r = S.rounds.get(id);
    if (!r || r.status !== 'done') continue;
    for (const p of list) {
      if (p.b !== me || p.prize === '0' || seen.has(id + ':' + p.idx)) continue;
      seen.add(id + ':' + p.idx);
      const best = Math.max(...p.g.map((g) => L.matches(g, r.nums)));
      toast(`🎉 You won ${L.fmtAse(p.prize)} ASE with ${plural(best, 'match', 'matches')} in draw #${id}! ` +
        (p.paid ? 'Already claimed.' : 'Claim it in “My tickets” whenever you like, it never expires.'), 'ok', 0);
    }
  }
  store.set(key, [...seen].slice(-300));
}

// ------------------------------------------------------------- résultats
function renderResults() {
  const rows = [...S.rounds.values()].filter((r) => ['done', 'cancelled'].includes(r.status)).sort((a, b) => b.id - a.id);
  if (!rows.length) { $('#resultsBody').innerHTML = '<p class="muted">No completed draws yet. The first one takes place at the time shown at the top of the page.</p>'; return; }
  const winCell = (r, k) => (r.cnt[k] ? `${r.cnt[k]} × ${L.fmtAse(r.per[k])}` : `<span class="muted">${k === 2 ? 'rolled over' : '–'}</span>`);
  $('#resultsBody').innerHTML = `<div style="overflow-x:auto"><table class="res-table">
    <thead><tr><th scope="col">Draw</th><th scope="col">Numbers</th><th scope="col" class="num">Tickets</th><th scope="col" class="num">5 matches</th><th scope="col" class="num">4 matches</th><th scope="col" class="num">3 matches</th><th scope="col" class="num">Rollover</th><th scope="col"></th></tr></thead>
    <tbody>${rows.map((r) => r.status === 'cancelled'
      ? `<tr><td>#${r.id}<br><span class="muted small">${utcDay(r.drawTs)}</span></td><td colspan="6"><span class="tag warn">Cancelled, players refunded</span></td><td></td></tr>`
      : `<tr><td>#${r.id}<br><span class="muted small">${utcDay(r.drawTs)}</span></td><td><span class="balls tiny">${r.nums.map((n) => ballHtml(n, 'gold')).join('')}</span></td><td class="num">${r.grids}</td><td class="num">${winCell(r, 2)}</td><td class="num">${winCell(r, 1)}</td><td class="num">${winCell(r, 0)}</td><td class="num">${L.fmtAse(r.carryOut, 0)}</td><td><button class="link-btn" data-verify="${r.id}">Verify</button></td></tr>`).join('')}
    </tbody></table></div><p class="muted small">Amounts in ASE, per winning ticket. “Rollover” = amount carried into the next jackpot.</p>`;
  $$('#resultsBody [data-verify]').forEach((b) => (b.onclick = () => verifyRound(Number(b.dataset.verify))));
}

// ------------------------------------------------------------- classement
function renderRanking() {
  const wins = [], grids = new Map();
  for (const [id, list] of S.purchases) {
    for (const p of list) {
      grids.set(p.b, (grids.get(p.b) || 0) + p.g.length);
      if (BigInt(p.prize) > 0n) wins.push({ b: p.b, prize: BigInt(p.prize), id });
    }
  }
  wins.sort((a, b) => (b.prize > a.prize ? 1 : b.prize < a.prize ? -1 : 0));
  const me = S.wallet?.address;
  const who = (a) => (a === me ? '<strong>you</strong>' : esc(L.shortAddr(a)));
  $('#rankWins').innerHTML = wins.slice(0, 10).map((w) => `<li><strong>${L.fmtAse(w.prize)} ASE</strong> <span>by</span> ${who(w.b)} <span>(draw #${w.id})</span></li>`).join('') || '<li class="muted">No wins yet.</li>';
  $('#rankGrids').innerHTML = [...grids].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a, n]) => `<li>${who(a)} <span>with</span> <strong>${n.toLocaleString('en-GB')}</strong> <span>${n === 1 ? 'ticket' : 'tickets'}</span></li>`).join('') || '<li class="muted">Nobody has played yet.</li>';
  $('#rankScope').textContent = `Over the last ${plural(S.rounds.size, 'draw', 'draws')}.`;
}

// ------------------------------------------------------------- vérification
async function verifyRound(id) {
  const dlg = $('#dlgVerify'), body = $('#verifyBody');
  body.innerHTML = '<p class="muted">Recomputing in your browser…</p>';
  dlg.showModal();
  try {
    const r = await loadRound(id, true);
    const list = await loadPurchases(id);
    const steps = [];
    const step = (ok, title, detail) => steps.push(`<div class="verify-step"><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><div><strong>${title}</strong><br><span class="small">${detail}</span></div></div>`);
    // 1) Empreinte des grilles
    let d = L.initialDigest(id);
    list.forEach((p) => { d = L.nextDigest(d, p.b, p.g, p.s || '', p.idx); });
    step(d === r.digest, 'Ticket fingerprint', `Recomputed from ${plural(list.length, 'purchase', 'purchases')}: <code>${d.slice(0, 24)}…</code>`);
    // 2) Chaînes de secrets
    const chainCheck = (sec, key) => {
      const prev = [...S.rounds.values()].filter((x) => x.id < id && x[key]).sort((a, b) => b.id - a.id)[0];
      if (!prev) return [true, 'first secret visible here (older draws are not loaded)'];
      let h = sec;
      for (let k = 1; k <= 30; k++) { h = L.sha256Hex(h); if (h === prev[key]) return [true, `SHA-256${k > 1 ? ' ×' + k : ''} of this secret = secret of draw #${prev.id}`]; }
      return [false, 'does not extend the chain of draw #' + prev.id];
    };
    const [o1, o2] = chainCheck(r.sO, 'sO'), [c1, c2] = chainCheck(r.sC, 'sC');
    step(o1, 'Operator secret', `<code>${r.sO}</code><br>${o2}`);
    step(c1, 'Collaborator secret', `<code>${r.sC}</code><br>${c2}`);
    // 3) Numéros
    const nums = L.drawNumbers(id, r.sO, r.sC, d);
    step(JSON.stringify(nums) === JSON.stringify(r.nums), 'Numbers drawn', `SHA-256("LOTOASE|${id}|operator secret|collaborator secret|fingerprint") gives <span class="balls tiny" style="display:inline-flex;vertical-align:middle">${nums.map((n) => ballHtml(n, 'gold')).join('')}</span>`);
    // 4) Gagnants
    const cnt = [0, 0, 0];
    for (const p of list) for (const g of p.g) { const k = L.matches(g, nums); if (k >= 3) cnt[k - 3]++; }
    step(JSON.stringify(cnt) === JSON.stringify(r.cnt), 'Number of winners', `5 matches: ${cnt[2]}, 4 matches: ${cnt[1]}, 3 matches: ${cnt[0]}`);
    // 5) Répartition
    const { per, commission: C } = L.payouts(r.sales, r.price, r.jackpotIn, cnt);
    step(per.every((x, k) => x.toString() === r.per[k]) && C.toString() === r.commission, 'Prize distribution', `Commission ${L.fmtAse(C)} ASE (15%, half of it to the ASE Airdrop). Prize per ticket: 5 matches ${L.fmtAse(per[2])}, 4 matches ${L.fmtAse(per[1])}, 3 matches ${L.fmtAse(per[0])} ASE.`);
    body.innerHTML = steps.join('') + `<p class="small muted" style="margin-top:12px">Everything is recomputed here, in your browser, from the contract's public data. <a href="${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}" target="_blank" rel="noopener">Contract source code</a>.</p>`;
  } catch (e) { body.innerHTML = `<p class="error">Verification failed: ${esc(cleanError(e))}</p>`; }
}

// ------------------------------------------------------------- admin
function renderAdmin() {
  const isAdmin = S.wallet && S.cfg && S.wallet.address === S.cfg.admin;
  $('#adminTab').hidden = !isAdmin;
  if (!isAdmin) { if ($('#adminTab').getAttribute('aria-selected') === 'true') selectTab('mine'); return; }
  const players = new Set(); for (const l of S.purchases.values()) for (const p of l) players.add(p.b);
  const now = chainNow();
  let croupier = 'Waiting for the next draw', alert = false;
  const pend = S.rounds.get(S.st.next);
  if (pend && ['closed', 'tally'].includes(pend.status)) {
    const late = Math.round((now - Number(pend.closeTs)) / 60000);
    croupier = `Draw #${pend.id}: ${!pend.sO ? 'waiting for operator secret' : !pend.sC ? 'waiting for collaborator secret' : 'counting in progress'} (${late} min)`;
    alert = late > 15;
  } else {
    const last = [...S.rounds.values()].filter((r) => r.status === 'done').sort((a, b) => b.id - a.id)[0];
    if (last) croupier = `Last draw #${last.id} completed`;
  }
  const t = S.st.tot;
  const stat = (label, val, a = false) => `<dl class="stat ${a ? 'alert' : ''}"><dt>${label}</dt><dd>${val}</dd></dl>`;
  $('#adminStats').innerHTML = [
    stat('Total volume', L.fmtAse(t.sales, 0) + ' ASE'),
    stat('Commissions paid', L.fmtAse(t.commission) + ' ASE'),
    stat('Unique players', `${players.size} <span class="small muted">(${plural(S.rounds.size, 'draw', 'draws')})</span>`),
    stat('Jackpot rollover', L.fmtAse(S.st.jackpot, 0) + ' ASE'),
    stat('Tickets sold', t.grids.toLocaleString('en-GB')),
    stat('Prizes paid', L.fmtAse(t.prizes, 0) + ' ASE'),
    stat('Prizes owed', L.fmtAse(S.st.owed) + ' ASE', BigInt(S.st.owed) > 0n),
    stat('Croupier', croupier, alert),
  ].join('');
  $('#pauseState').textContent = S.cfg.paused ? 'The game is paused.' : 'The game is open.';
  $('#pauseBtn').textContent = S.cfg.paused ? 'Resume game' : 'Pause game';
  const setIfIdle = (sel, v) => { const el = $(sel); if (document.activeElement !== el && !el.dataset.touched) el.value = v; };
  setIfIdle('#fPrice [name=price]', L.fmtAse(S.cfg.price, 4).replace(/,/g, '').replace(/\.?0+$/, ''));
  setIfIdle('#fTime [name=h]', S.cfg.drawH); setIfIdle('#fTime [name=m]', S.cfg.drawM);
  setIfIdle('#fMax [name=n]', S.cfg.maxGrids);
  setIfIdle('#fMax [name=t]', S.cfg.maxRound);
  setIfIdle('#fTimings [name=close]', S.cfg.closeMin); setIfIdle('#fTimings [name=reveal]', S.cfg.revealMin);
  setIfIdle('#fPayouts [name=o]', L.toAse1(S.cfg.payOwner)); setIfIdle('#fPayouts [name=c]', L.toAse1(S.cfg.payCollab));
}
$$('.admin-box input').forEach((i) => i.addEventListener('input', () => (i.dataset.touched = '1')));
function adminForm(sel, fn) {
  $(sel).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const [label, method, args] = fn(new FormData(e.target));
      if (await sendTx(label, method, args)) e.target.querySelectorAll('input').forEach((i) => delete i.dataset.touched);
    } catch (err) { toast(cleanError(err), 'err'); }
  });
}
adminForm('#fPause', () => [S.cfg.paused ? 'Game resumed' : 'Game paused', 'setPaused', [!S.cfg.paused]]);
// Le contrat reçoit tous les réglages du jeu en un seul appel : on renvoie
// les valeurs actuelles avec seulement celle(s) modifiée(s).
const gameArgs = (patch) => { const c = { ...S.cfg, ...patch }; return [String(c.price), c.drawH, c.drawM, c.maxGrids, c.closeMin, c.revealMin, c.maxRound]; };
adminForm('#fPrice', (f) => ['Price saved', 'setConfig', gameArgs({ price: L.parseAse(f.get('price')).toString() })]);
adminForm('#fTime', (f) => ['Draw time saved', 'setConfig', gameArgs({ drawH: Number(f.get('h')), drawM: Number(f.get('m')) })]);
adminForm('#fMax', (f) => ['Limits saved', 'setConfig', gameArgs({ maxGrids: Number(f.get('n')), maxRound: Number(f.get('t')) })]);
adminForm('#fTimings', (f) => ['Timings saved', 'setConfig', gameArgs({ closeMin: Number(f.get('close')), revealMin: Number(f.get('reveal')) })]);
adminForm('#fPayouts', (f) => ['Wallets saved', 'setPayouts', [L.toHex(f.get('o')), L.toHex(f.get('c'))]]);
let cancelArmed = 0;
adminForm('#fCancel', () => {
  const id = S.st.next < S.st.cur ? S.st.next : S.info.round;
  const btn = $('#fCancel button');
  if (Date.now() - cancelArmed > 8000) {
    cancelArmed = Date.now();
    btn.textContent = `Confirm: cancel draw #${id}`;
    setTimeout(() => { if (Date.now() - cancelArmed >= 8000) btn.textContent = 'Cancel and refund'; }, 8100);
    throw new Error(`Click again within 8 s to cancel draw #${id}.`);
  }
  cancelArmed = 0; btn.textContent = 'Cancel and refund';
  return ['Draw cancelled, refunds available', 'emergencyCancel', [id]];
});

// ------------------------------------------------------------- onglets
function selectTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
}
$$('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

// ------------------------------------------------------------- wallet
function renderWallet() {
  const b = $('#walletBtn');
  if (!S.wallet) { b.textContent = 'Connect wallet'; return; }
  b.textContent = `${L.shortAddr(S.wallet.address)}${S.balance !== null ? ' · ' + L.fmtAse(S.balance) + ' ASE' : ''}`;
}
let pairing = false;
function openWallet() {
  if (S.demo) { toast('Demo mode: you are playing with a mock wallet holding 100,000 ASE.'); return; }
  $('#walletErr').hidden = true; $('#tgPair').hidden = true; $('#dlgWalletTitle').textContent = S.wallet ? 'Your wallet' : 'Connect to Asentum';
  if (S.wallet) {
    $('#walletConnected').hidden = false; $('#walletChoices').hidden = true;
    $('#walletAddrFull').textContent = L.toAse1(S.wallet.address);
    $('#dlgWallet').showModal();
    return;
  }
  $('#walletConnected').hidden = true; $('#walletChoices').hidden = false;
  $('#useExt').disabled = !ExtensionWallet.available();
  $('#extHint').textContent = ExtensionWallet.available() ? 'Use the wallet you already have installed.' : 'Not detected in this browser: install the Asentum Wallet extension, or use Telegram.';
  $('#dlgWallet').showModal();
}
$('#dlgWallet').addEventListener('close', () => { pairing = false; clearInterval(pairTimer); });
// Code d'appairage Telegram : une case par caractère + compte à rebours (5 min)
let pairTimer = null;
function showPairCode(code) {
  $('#tgCode').innerHTML = String(code).split('').map((c) => `<span>${esc(c)}</span>`).join('');
  const end = Date.now() + 5 * 60000;
  clearInterval(pairTimer);
  const tick = () => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); $('#tgExpire').textContent = s ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Code expired'; if (!s) clearInterval(pairTimer); };
  tick(); pairTimer = setInterval(tick, 1000);
}
$('#tgBack').onclick = () => { $('#dlgWalletTitle').textContent = 'Connect to Asentum'; pairing = false; clearInterval(pairTimer); $('#tgPair').hidden = true; $('#walletChoices').hidden = false; $('#walletErr').hidden = true; };
$('#walletBtn').onclick = openWallet;
$('#disconnectBtn').onclick = () => { S.wallet.disconnect(); S.wallet = null; S.balance = null; store.del('loto.wallet'); $('#dlgWallet').close(); renderAll(); };
$('#useExt').onclick = async () => {
  try {
    const w = new ExtensionWallet(); await w.connect();
    S.wallet = w; store.set('loto.wallet', { kind: 'extension' });
    $('#dlgWallet').close(); await refresh();
  } catch (e) { $('#walletErr').hidden = false; $('#walletErr').textContent = cleanError(e); }
};
$('#useTg').onclick = async () => {
  const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME);
  pairing = true;
  $('#walletChoices').hidden = true; $('#tgPair').hidden = false; $('#walletErr').hidden = true; $('#tgCode').innerHTML = '<span>·</span>'.repeat(6); $('#tgExpire').textContent = 'Creating a code…'; $('#dlgWalletTitle').textContent = 'Pair Telegram Wallet';
  try {
    await w.pair(showPairCode, () => !pairing);
    S.wallet = w; store.set('loto.wallet', { kind: 'telegram', session: w.session });
    $('#dlgWallet').close(); await refresh();
  } catch (e) { clearInterval(pairTimer); if (/cancelled/i.test(String(e && e.message))) return; $('#dlgWalletTitle').textContent = 'Connect to Asentum'; $('#walletErr').hidden = false; $('#walletErr').textContent = cleanError(e); $('#walletChoices').hidden = false; $('#tgPair').hidden = true; }
};
async function restoreWallet() {
  const saved = store.get('loto.wallet', null);
  if (!saved) return;
  if (saved.kind === 'extension') {
    // L'extension peut s'injecter un peu après le chargement.
    for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await new Promise((ok) => setTimeout(ok, 200));
    if (!ExtensionWallet.available()) return;
    const w = new ExtensionWallet(); if (await w.restore()) S.wallet = w;
  } else if (saved.kind === 'telegram') {
    const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME); if (await w.restore(saved.session)) S.wallet = w;
  }
}

// ------------------------------------------------------------- rendu global
function renderRulesValues() {
  if (!S.cfg) return;
  const p = BigInt(S.cfg.price);
  $$('.js-price').forEach((e) => (e.textContent = L.fmtAse(p, p % L.WEI === 0n ? 0 : 2) + ' ASE'));
  if (S.info) $$('.js-drawtime').forEach((e) => (e.textContent = utcTime(S.info.drawTs)));
  $$('.js-close').forEach((e) => (e.textContent = plural(S.cfg.closeMin, 'minute', 'minutes')));
  $$('.js-reveal').forEach((e) => (e.textContent = S.cfg.revealMin % 60 === 0 ? plural(S.cfg.revealMin / 60, 'hour', 'hours') : plural(S.cfg.revealMin, 'minute', 'minutes')));
  const amount = (x) => L.fmtAse(x, x % L.WEI === 0n ? 0 : 2) + ' ASE';
  $$('.js-g4').forEach((e) => (e.textContent = amount(p * 25n)));
  $$('.js-g3').forEach((e) => (e.textContent = amount((p * 5n) / 2n)));
}
function renderAll() {
  renderWallet(); renderHero(); renderCart(); renderMine(); renderResults(); renderRanking(); renderAdmin(); renderRulesValues();
}

// ------------------------------------------------------------- démarrage
(async function start() {
  startVegas();
  renderSlots([]); renderCart();
  const wantDemo = !CONFIG.CONTRACT || new URLSearchParams(location.search).has('demo');
  if (wantDemo) {
    const { startDemo } = await import('./demo/demo.js');
    S.demo = await startDemo(new URL('contrat/loto.js', document.baseURI));
    S.rpc = S.demo.rpc; S.contract = S.demo.contractAddress; S.wallet = S.demo.wallet;
    $('#demoBar').hidden = false;
    $('#demoWarp').onclick = async () => { S.demo.goToDraw(); await refresh(); toast('Clock fast-forwarded: the demo croupier just ran the draw.', 'ok'); };
    S.wallet.address = S.wallet.address.toLowerCase();
  } else {
    S.rpc = new Rpc(CONFIG.RPC);
    S.contract = CONFIG.CONTRACT;
    await restoreWallet();
  }
  const link = $('#contractLink');
  link.textContent = S.demo ? 'local demo' : L.shortAddr(S.contract);
  if (!S.demo) link.href = `${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}`;
  $('#rpcLabel').textContent = S.rpc.url;
  await refresh();
  setInterval(refresh, S.demo ? 4000 : 20000);
})();
