// =====================================================================
//  ASE Raffle — logique du site (tout est lu sur la chaîne)
// =====================================================================
import CONFIG from './config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from '../../loto/js/chain.js';
import * as L from '../../loto/js/lotomath.js';
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
  info: null, cfg: null, st: null, clockOffset: 0, qty: 1, busy: false,
  rounds: new Map(), purchases: new Map(), purchasesAt: new Map(),
};
const chainNow = () => Date.now() + S.clockOffset;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Toutes les heures affichées aux joueurs sont en UTC (le panneau admin reste en heure de Paris).
const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
const utcDay = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const utcWeekday = (ms) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Number(ms)).getUTCDay()];
const plural = (n, one, many) => `${Number(n).toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const ase = (w, d) => L.fmtAse(BigInt(w), d ?? (BigInt(w) % L.WEI === 0n ? 0 : 2));
// Lots : « 4 lucky lots of 100 ASE + 1 lot of 50 ASE » (lots pleins puis un dernier lot avec le reste)
function lotsText(lots, lot) {
  const L0 = BigInt(lot || 0), full = lots.filter((x) => BigInt(x) === L0).length, last = lots.find((x) => BigInt(x) !== L0);
  return (full ? `${full} lucky ${full > 1 ? 'lots' : 'lot'} of ${ase(L0)} ASE` : '') + (last !== undefined ? `${full ? ' + ' : ''}1 lucky lot of ${ase(last)} ASE` : '');
}
const tno = (t) => '#' + String(t + 1).padStart(4, '0');
const RANK = ['1st', '2nd', '3rd'];
const rankName = (k) => RANK[k] || 'lucky lot';
// Tombola v4 (3 tirages / semaine, top 3 + lots) ou v3 (1 tirage, 3 gagnants) : le site gère les deux.
const isV4 = () => !!S.cfg && S.cfg.drawDays !== undefined;
// v3 : 50 / 30 / 20 % de la cagnotte. Rangs sans gagnant → 0 (reportés).
const prizesOfPool = (pool, winners = 3) => { const P = BigInt(pool), p1 = P / 2n, p2 = (P * 3n) / 10n; return [p1, p2, P - p1 - p2].map((x, k) => (k < winners ? x : 0n)); };
// v4 : jusqu'à maxLots lots (≤ 40 % de la cagnotte, ≤ tickets − 3), le top 3 prend tout le reste 50/30/20.
function prizesV4(pool, tickets, lot, maxLots) {
  const P = BigInt(pool);
  const Lw = BigInt(lot || 0), nTop = Math.min(3, tickets), lots = [];
  if (Lw > 0n) { const cap = Math.max(0, Math.min(Number(maxLots || 0), 200, tickets - nTop)); let b = (P * 4000n) / 10000n; let r = P; while (lots.length < cap && b >= Lw && r >= Lw * 6n) { lots.push(Lw); b -= Lw; r -= Lw; } const x = b < r / 6n ? b : r / 6n; if (lots.length < cap && x >= 10n ** 16n) lots.push(x); }   // un lot ≤ 3e prix
  const top = lots.reduce((a, x) => a - x, P), p1 = top / 2n, p2 = (top * 3n) / 10n;
  return [p1, p2, top - p1 - p2].slice(0, nTop).concat(lots);
}
// Gagnants d'une tombola tirée : [{ t, i, b }] (v4 : retrouvés depuis les achats).
function winsOf(r) {
  if (!r || !r.win) return [];
  if (typeof r.win[0] !== 'number') return r.win;
  const list = S.purchases.get(r.id) || [];
  return r.win.map((t) => { const p = list.find((x) => x.first <= t && t < x.first + x.n); return { t, i: p ? p.idx : -1, b: p ? p.b : '' }; });
}
const claimArgs = (r, k) => (typeof (r.win || [])[0] === 'number' ? [r.id, k, winsOf(r)[k].i] : [r.id, k]);
const daysText = (mask) => { const d = DAYS.filter((_, k) => (mask >> k) & 1); return d.length === 7 ? 'every day' : d.length > 1 ? d.slice(0, -1).join(', ') + ' and ' + d.at(-1) : d[0]; };
const poolOf = (r) => BigInt(r.carryIn || '0') + BigInt(r.sales) - BigInt(r.commission || '0');

// ------------------------------------------------------------- thème, notifications
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme('dark');   // ASE Vegas est uniquement en mode sombre, comme Asentum
function toast(text, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  if (!ms) { el.title = 'Click to close'; el.style.cursor = 'pointer'; el.onclick = () => el.remove(); }
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
function cleanError(e) { const m = String(e && e.message ? e.message : e); const i = m.lastIndexOf('failed: '); return i >= 0 ? m.slice(i + 8) : m; }

// ------------------------------------------------------------- lectures
const view = (m, a = []) => S.rpc.view(S.contract, m, a);
// Résultats dévoilés à l'heure du tirage (19:00 UTC) : un tirage déjà fait plus tôt sur la chaîne
// (ventes fermées 1 h avant) reste affiché « en cours » jusqu'à son heure, gains compris.
function hideUntilDraw(r) {
  if (!r || r.status !== 'done' || chainNow() >= Number(r.drawTs)) return r;
  return { ...r, status: 'closed', win: null, prizes: null, revealAt: Number(r.drawTs) };
}
async function loadRound(id, force = false) {
  const old = S.rounds.get(id);
  if (old && !force && ['done', 'cancelled'].includes(old.status) && old.claimed.every(Boolean)) return old;
  const r = hideUntilDraw(await view('getRound', [id]));
  if (r) S.rounds.set(id, r);
  return r;
}
async function loadPurchases(id) {
  const r = S.rounds.get(id);
  if (!r || !r.buys) { S.purchases.set(id, []); return []; }
  const age = Date.now() - (S.purchasesAt.get(id) || 0);
  if (S.purchases.has(id) && S.purchases.get(id).length === r.buys && (r.status === 'done' || age < 15000)) return S.purchases.get(id);
  const out = [];
  for (let i = 0; i < r.buys; i += 400) out.push(...(await view('getPurchases', [id, i, 400])));
  S.purchases.set(id, out); S.purchasesAt.set(id, Date.now());
  return out;
}
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }
async function refresh() {
  try {
    const [info, cfg, st] = await Promise.all([view('info'), view('getConfig'), view('getState')]);
    S.info = info; S.cfg = cfg; S.st = st;
    S.clockOffset = Number(info.now) - Date.now();
    const ids = []; for (let id = info.round; id >= Math.max(1, info.round - CONFIG.HISTORY_ROUNDS); id--) ids.push(id);
    await pool(ids, 6, (id) => loadRound(id, id >= info.round - 1));
    await pool(ids, 4, (id) => loadPurchases(id));
    if (S.wallet) S.balance = await S.rpc.balance(S.wallet.address).catch(() => S.balance);
    renderAll();
  } catch (e) { console.error(e); toast('Could not read the chain: ' + cleanError(e), 'err', 8000); }
}

// ------------------------------------------------------------- hero
function renderHero() {
  const i = S.info; if (!i) return;
  const v4 = isV4(), pr = v4 ? prizesV4(i.pot, Math.max(i.tickets, 3 + Number(i.maxLots || 0)), i.lot, Number(i.maxLots || 0)) : prizesOfPool(i.pot);
  $('#pot').textContent = ase(BigInt(i.pot), 0);
  [0, 1, 2].forEach((k) => ($('#prize' + (k + 1)).textContent = ase(pr[k] || 0n) + ' ASE'));
  ['1st', '2nd', '3rd'].forEach((n, k) => ($('#plabel' + (k + 1)).textContent = v4 ? n : `${n} · ${[50, 30, 20][k]}%`));
  const lots = pr.length - 3;
  $('#lotsLine').hidden = !v4;
  if (v4) $('#lotsLine').textContent = lots > 0 ? `+ ${lotsText(pr.slice(3), i.lot)}` : `+ lucky lots of ${ase(i.lot)} ASE as the pot grows`;
  $('#drawWhen').textContent = `Raffle #${i.round}, draw ${utcDay(i.drawTs)} at ${utcTime(i.drawTs)}`;
  const carry = BigInt(i.carryIn || '0');
  $('#rolled').hidden = carry <= 0n;
  $('#rolled').textContent = `Includes ${ase(carry)} ASE carried over`;
  $('#ticketsSold').textContent = i.tickets.toLocaleString('en-GB');
  $('#players').textContent = i.wallets.toLocaleString('en-GB');
  $('#pausedBanner').hidden = !i.paused;
}
function tickCountdown() {
  const i = S.info; if (!i) return;
  const now = chainNow();
  // Tirage fait mais dévoilé à 19:00 : compte à rebours des résultats
  const pend = [...S.rounds.values()].filter((r) => r.status === 'closed' && Number(r.drawTs) > now && now >= Number(r.closeTs)).sort((a, b) => a.id - b.id)[0];
  if (S.revealAt && now >= S.revealAt) { S.revealAt = 0; refresh(); }
  if (pend) {
    S.revealAt = Number(pend.drawTs) + 3000;
    const s = Math.max(0, Math.floor((Number(pend.drawTs) - now) / 1000));
    $('#countdownLabel').textContent = 'Results in';
    $('#countdown').textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
    return;
  }
  const left = Math.floor((Number(i.closeTs) - now) / 1000);
  if (left > 0) {
    const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), x = left % 60;
    $('#countdownLabel').textContent = 'Sales close in';
    $('#countdown').textContent = (d ? d + 'd ' : '') + [h, m, x].map((v) => String(v).padStart(2, '0')).join(':');
  } else { $('#countdownLabel').textContent = 'Sales closed'; $('#countdown').textContent = 'Drawing soon'; }
}
setInterval(tickCountdown, 1000);

// ------------------------------------------------------------- achat
function myCount() {
  if (!S.wallet || !S.info) return 0;
  const list = S.purchases.get(S.info.round) || [];
  return list.filter((p) => p.b === S.wallet.address).reduce((a, p) => a + p.n, 0);
}
function renderBuy() {
  const max = S.cfg ? S.cfg.maxPerWallet : 10;
  const room = Math.max(0, max - myCount());
  S.qty = Math.max(1, Math.min(S.qty, room || 1));
  const price = S.info ? BigInt(S.info.price) : 5n * L.WEI;
  $('#qty').textContent = S.qty;
  $('#qtyLabel').textContent = plural(S.qty, 'ticket', 'tickets');
  $('#buyCost').textContent = ase(price * BigInt(S.qty)) + ' ASE';
  $('#minusBtn').disabled = S.qty <= 1 || S.busy;
  $('#plusBtn').disabled = S.qty >= room || S.busy;
  const b = $('#buyBtn');
  if (!S.wallet) { b.textContent = 'Connect wallet to play'; b.disabled = false; }
  else if (!room) { b.textContent = `You hold the maximum (${max} tickets)`; b.disabled = true; }
  else { b.textContent = S.busy ? 'Printing your tickets…' : `Buy ${plural(S.qty, 'ticket', 'tickets')}`; b.disabled = S.busy || (S.info && (S.info.paused || S.info.status === 'closing')); }
  const mine = S.wallet && S.info ? (S.purchases.get(S.info.round) || []).filter((p) => p.b === S.wallet.address) : [];
  const nums = mine.flatMap((p) => Array.from({ length: p.n }, (_, k) => p.first + k));
  // Tickets détenus, choix rapides, chances
  const held = max - room;
  $('#holdLabel').textContent = `You hold ${held} / ${max}`;
  document.querySelectorAll('#qPick [data-q]').forEach((b) => {
    const v = b.dataset.q === 'max' ? room : Number(b.dataset.q);
    b.disabled = !room || v > room || S.busy;
    b.classList.toggle('on', !!room && v === S.qty);
    if (b.dataset.q === 'max') b.textContent = room ? `Max (${room})` : 'Max';
  });
  const tot = S.info ? S.info.tickets : 0, mineAfter = held + (room ? S.qty : 0), all = tot + (room ? S.qty : 0);
  $('#chanceLine').textContent = all ? `With ${room ? 'these' : 'your'} tickets: ${mineAfter} out of ${all} tickets this week (${Math.round((mineAfter * 100) / all)}%).` : '';
  $('#mineNow').textContent = nums.length ? `Your tickets this week: ${nums.map(tno).join(' ')}` : '';
  if (!S.busy) renderPrinterIdle(nums);
}
function renderPrinterIdle(nums) {
  const out = $('#printerOut');
  if (out.dataset.live === '1') return;
  out.innerHTML = nums.length
    ? nums.slice(-3).reverse().map((t) => `<div class="rticket"><span><span class="lbl">ASE RAFFLE</span><br><span class="no">${tno(t)}</span></span><span class="lbl">WEEK<br>${S.info.round}</span></div>`).join('')
    : '<div class="rticket idle"><span class="lbl">YOUR TICKET</span><span class="lbl">?</span></div>';
}
$('#minusBtn').onclick = () => { S.qty--; renderBuy(); };
$('#plusBtn').onclick = () => { S.qty++; renderBuy(); };
document.querySelectorAll('#qPick [data-q]').forEach((b) => (b.onclick = () => { const max = S.cfg ? S.cfg.maxPerWallet : 10; S.qty = b.dataset.q === 'max' ? Math.max(1, max - myCount()) : Number(b.dataset.q); renderBuy(); }));

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function confetti(n = 90) {
  if (reduceMotion) return;
  const box = $('#confetti'), colors = ['#D9C6FF', '#A98BFF', '#F4C542', '#FFFFFF', '#7B5CFF'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x', (Math.random() * 200 - 100) + 'px');
    c.style.setProperty('--r', (360 + Math.random() * 720) + 'deg');
    c.style.setProperty('--d', (1.2 + Math.random() * 1.4) + 's');
    c.style.animationDelay = Math.random() * 0.4 + 's';
    box.append(c);
    setTimeout(() => c.remove(), 3500);
  }
}
async function printTickets(first, n) {
  const out = $('#printerOut');
  out.dataset.live = '1';
  out.innerHTML = '';
  for (let k = 0; k < n; k++) {
    const el = document.createElement('div');
    el.className = 'rticket print';
    el.innerHTML = `<span><span class="lbl">ASE RAFFLE</span><br><span class="no">${tno(first + k)}</span></span><span class="lbl">WEEK<br>${S.info.round}</span>`;
    out.prepend(el);
    while (out.children.length > 4) out.lastChild.remove();
    await sleep(reduceMotion ? 0 : 420);
  }
  confetti();
  setTimeout(() => { out.dataset.live = ''; }, 2500);
}

async function sendTx(label, method, args, value = 0n) {
  S.busy = true; renderBuy();
  const t1 = toast(S.wallet.kind === 'telegram' ? 'Approve the transaction in Telegram…' : 'Approve the transaction in your wallet…', '', 0);
  try {
    const hash = await S.wallet.call(S.contract, method, args, value);
    t1.textContent = 'Transaction sent, waiting for confirmation (usually 10 to 60 s)…';
    const rc = await S.rpc.waitReceipt(hash);
    t1.remove();
    if (!rc.success) throw new Error(rc.error || 'rejected by the contract');
    document.dispatchEvent(new Event('asevegas:refresh-wins'));   // le bouton « My wins » se met à jour
    if (label) toast(label + ' ✓', 'ok');
    return rc;
  } catch (e) {
    t1.remove(); toast('Failed: ' + cleanError(e), 'err', 10000); return null;
  } finally { S.busy = false; $('#printerLight').classList.remove('on'); }
}
$('#buyBtn').onclick = async () => {
  if (!S.wallet) return openWallet();
  const n = S.qty, cost = BigInt(S.info.price) * BigInt(n);
  if (S.balance !== null && S.balance < cost) { toast(`Insufficient balance: you need ${ase(cost)} ASE plus a little gas.`, 'err'); return; }
  $('#printerLight').classList.add('on');
  const out = $('#printerOut'); out.dataset.live = '1';
  out.innerHTML = '<div class="rticket printing"></div>';
  const rc = await sendTx('', 'buy', [n, L.randomSeedHex()], cost);
  out.dataset.live = '';
  if (!rc) { renderBuy(); return; }
  let rv = rc.returnValue || {};
  S.purchasesAt.delete(S.info.round);
  if (!Number.isInteger(rv.first)) {
    // Reçu sans valeur de retour : on retrouve l'achat dans la liste du contrat.
    await refresh();
    const mine = (S.purchases.get(S.info.round) || []).filter((p) => p.b === S.wallet.address);
    if (mine.length) rv = { first: mine.at(-1).first, n: mine.at(-1).n };
  }
  if (Number.isInteger(rv.first)) await printTickets(rv.first, rv.n || n);
  toast(`🎟️ ${plural(n, 'ticket', 'tickets')} bought${Number.isInteger(rv.first) ? ': ' + Array.from({ length: rv.n || n }, (_, k) => tno(rv.first + k)).join(' ') : ''}. Good luck!`, 'ok', 9000);
  S.qty = 1;
  await refresh();
};

// ------------------------------------------------------------- mes tickets
function renderMine() {
  const box = $('#mineBody');
  if (!S.wallet) { box.innerHTML = '<p class="muted">Connect your wallet to see your tickets.</p>'; return; }
  const me = S.wallet.address;
  const ids = [...S.rounds.keys()].sort((a, b) => b - a);
  let html = '';
  const todo = [];
  for (const id of ids) {
    const r = S.rounds.get(id);
    const mine = (S.purchases.get(id) || []).filter((p) => p.b === me);
    if (!mine.length) continue;
    const nums = mine.flatMap((p) => Array.from({ length: p.n }, (_, k) => p.first + k));
    const W = winsOf(r), winT = W.map((w) => w.t);
    let status = '<span class="tag">Waiting for the draw</span>', right = '';
    if (r.status === 'done') {
      const ks = W.map((w, k) => (w.b === me ? k : -1)).filter((k) => k >= 0);
      if (ks.length) {
        const won = ks.reduce((a, k) => a + BigInt(r.prizes[k]), 0n), open = ks.filter((k) => !r.claimed[k]);
        status = `<span class="tag win">🏆 ${ks.map((k) => (k < 3 ? rankName(k) + ' prize' : '')).filter(Boolean).concat(ks.filter((k) => k >= 3).length ? [`${ks.filter((k) => k >= 3).length} × lucky lot`] : []).join(' + ')}</span>`;
        right = !open.length ? `<span class="tag ok">Claimed</span><span class="amount">+${ase(won)} ASE</span>`
          : `<span class="amount">+${ase(won)} ASE</span><button class="btn btn-primary btn-small" data-claim="${id}:${open.join(',')}">Claim</button>`;
        for (const k of open) todo.push(['claim', id, k, BigInt(r.prizes[k])]);
      } else { status = '<span class="tag">Drawn</span>'; right = '<span class="muted small">Not a winner this time</span>'; }
    } else if (r.status === 'cancelled') {
      status = '<span class="tag warn">Cancelled: 100% refunded</span>';
      const unpaid = mine.filter((p) => !p.paid);
      right = unpaid.length ? `<button class="btn btn-small" data-refund="${id}:${unpaid[0].idx}">Refund me</button>` : '<span class="tag ok">Refunded</span>';
      for (const p of unpaid) todo.push(['refund', id, p.idx, BigInt(r.price) * BigInt(p.n)]);
    } else if (r.weeks > 1) status = `<span class="tag">Moved to ${utcDay(r.drawTs)}</span>`;
    html += `<div class="round-block"><div class="round-head"><h3>Raffle #${id}</h3><span class="muted small">${utcDay(r.drawTs)}</span>${status}</div>
      <div class="ticket"><div class="stubs">${nums.map((t) => `<span class="stub${winT.includes(t) ? ' win' : ''}">${tno(t)}</span>`).join('')}</div><div class="right">${right}</div></div></div>`;
  }
  const total = todo.reduce((a, x) => a + x[3], 0n);
  const head = todo.length ? `<div class="claim-banner"><div><strong>${ase(total)} ASE</strong> to claim <span class="muted small">(no time limit)</span></div><button class="btn btn-primary" id="claimAll">${todo.length > 1 ? 'Claim all' : 'Claim'}</button></div>` : '';
  box.innerHTML = head + (html || '<p class="muted">You have no tickets in recent raffles. Get one just above!</p>');
  const call = (x) => (x[0] === 'claim' ? sendTx(`${rankName(x[2])} prize claimed`, 'claim', claimArgs(S.rounds.get(x[1]), x[2])) : sendTx('Refund received', 'settle', [x[1], x[2], 1]));
  const ca = $('#claimAll');
  if (ca) ca.onclick = async () => { for (const x of todo) { S.purchasesAt.delete(x[1]); if (!(await call(x))) break; } await refresh(); };
  box.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = async () => { const [a, ks] = b.dataset.claim.split(':'), id = Number(a); let any = false; for (const k of ks.split(',').map(Number)) { if (!(await call(['claim', id, k]))) break; any = true; } if (any) { confetti(60); await refresh(); } }));
  box.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = async () => { const [id, i] = b.dataset.refund.split(':').map(Number); S.purchasesAt.delete(id); if (await call(['refund', id, i])) await refresh(); }));
  announceWins();
}
function announceWins() {
  if (!S.wallet) return;
  const me = S.wallet.address, key = 'asegame.raffle.vus.' + me;
  const seen = new Set(store.get(key, []));
  for (const r of S.rounds.values()) {
    if (r.status !== 'done') continue;
    const W = winsOf(r), ks = W.map((w, k) => (w.b === me ? k : -1)).filter((k) => k >= 0);
    if (!ks.length || seen.has(r.id)) continue;
    seen.add(r.id);
    const won = ks.reduce((a, k) => a + BigInt(r.prizes[k]), 0n), open = ks.some((k) => !r.claimed[k]);
    toast(`🏆 You won ${ks.length > 1 ? ks.length + ' prizes' : 'the ' + rankName(ks[0]) + (ks[0] < 3 ? ' prize' : '')} in raffle #${r.id}: ${ase(won)} ASE with ticket ${ks.map((k) => tno(W[k].t)).join(', ')}! ` + (open ? 'Claim it in “My tickets” whenever you like.' : 'Already claimed.'), 'ok', 0);
    if (open) confetti();
  }
  store.set(key, [...seen].slice(-200));
}

// ------------------------------------------------------------- gagnants
function renderResults() {
  const rows = [...S.rounds.values()].filter((r) => ['done', 'cancelled'].includes(r.status)).sort((a, b) => b.id - a.id);
  if (!rows.length) { $('#resultsBody').innerHTML = '<p class="muted">No raffle drawn yet. The first draw takes place at the time shown at the top of the page.</p>'; return; }
  $('#resultsBody').innerHTML = rows.map((r) => {
    if (r.status === 'cancelled') return `<div class="round-block"><div class="round-head"><h3>Raffle #${r.id}</h3><span class="muted small">${utcDay(r.drawTs)}</span><span class="tag warn">Cancelled, players refunded</span></div></div>`;
    return `<div class="round-block"><div class="round-head"><h3>Raffle #${r.id}</h3><span class="muted small">${utcDay(r.drawTs)} · ${plural(r.tickets, 'ticket', 'tickets')} · ${plural(r.wallets, 'player', 'players')}</span><button class="link-btn" data-verify="${r.id}">Verify</button></div>
      <ol class="winners">${winsOf(r).slice(0, 3).map((w, k) => `<li><span class="medal m${k + 1}">${k + 1}</span><span class="stub win">${tno(w.t)}</span><span class="who">${w.b ? L.shortAddr(w.b) : '…'}</span>${r.claimed[k] ? '<span class="tag ok">Claimed</span>' : '<span class="tag">Not claimed yet</span>'}<span class="amount">${ase(r.prizes[k])} ASE</span></li>`).join('')}</ol>${r.win.length > 3 ? `<p class="small"><strong>${r.win.length - 3} lucky lots of ${ase(r.prizes[3])} ASE</strong>: ${winsOf(r).slice(3).map((w, j) => `<span class="stub win${r.claimed[j + 3] ? '' : ' unclaimed'}" title="${w.b ? L.shortAddr(w.b) : ''}">${tno(w.t)}</span>`).join(' ')}</p>` : ''}${BigInt(r.carryOut || '0') > 0n ? `<p class="muted small">Not enough tickets for every prize: ${ase(r.carryOut)} ASE carried over to raffle #${r.id + 1}.</p>` : ''}</div>`;
  }).join('');
  $$('[data-verify]').forEach((b) => (b.onclick = () => verify(Number(b.dataset.verify))));
}
function drawWinners(id, sO, sC, digest, list) {
  const total = list.reduce((a, p) => a + p.n, 0), win = [], want = Math.min(3, new Set(list.map((p) => p.b)).size);
  for (let k = 0; win.length < want && k < 3000; k++) {
    const h = L.sha256Text('ASERAFFLE|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(total));
    const i = list.findIndex((p) => t >= p.first && t < p.first + p.n);
    if (win.some((w) => w.b === list[i].b)) continue;
    win.push({ t, i, b: list[i].b });
  }
  return win;
}
function drawTicketsV4(id, sO, sC, digest, total, n) {
  const win = [], seen = new Set();
  for (let k = 0; win.length < n && k < 100000; k++) {
    const t = Number(BigInt('0x' + L.sha256Text('ASERAFFLE|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k).slice(0, 13)) % BigInt(total));
    if (seen.has(t)) continue;
    seen.add(t); win.push(t);
  }
  return win;
}
async function verify(id) {
  const body = $('#verifyBody');
  body.innerHTML = '<p class="muted">Recomputing in your browser…</p>';
  $('#dlgVerify').showModal();
  try {
    const r = await loadRound(id, true), list = await loadPurchases(id);
    const steps = [];
    const step = (ok, title, detail) => steps.push(`<div class="verify-step"><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><div><strong>${title}</strong><br><span class="small">${detail}</span></div></div>`);
    let d = L.sha256Text('ASERAFFLE-ROUND|' + id);
    list.forEach((p) => { d = L.sha256Text(d + '|' + p.b + '|' + p.n + '|' + (p.sd || '') + '|' + p.idx); });
    step(d === r.digest, 'Purchase fingerprint', `Recomputed from ${plural(list.length, 'purchase', 'purchases')}: <code>${d.slice(0, 24)}…</code>`);
    const chainCheck = (sec, key) => {
      const prev = [...S.rounds.values()].filter((x) => x.id < id && x[key]).sort((a, b) => b.id - a.id)[0];
      if (!prev) return [true, 'first secret visible here'];
      let h = sec; for (let k = 1; k <= 1; k++) { h = L.sha256Hex(h); if (h === prev[key]) return [true, `SHA-256 of this secret = secret of raffle #${prev.id}`]; }
      return [false, 'does not extend the chain of raffle #' + prev.id];
    };
    const [o1, o2] = chainCheck(r.sO, 'sO'), [c1, c2] = chainCheck(r.sC, 'sC');
    step(o1, 'Operator secret', `<code>${r.sO}</code><br>${o2}`);
    step(c1, 'Collaborator secret', `<code>${r.sC}</code><br>${c2}`);
    if (typeof r.win[0] === 'number') {   // v4
      const pz = prizesV4(poolOf(r), r.tickets, r.lot, r.maxLots);
      step(pz.length === r.prizes.length && pz.every((x, k) => x.toString() === r.prizes[k]), 'Prizes', `${pz.length - 3 > 0 ? lotsText(pz.slice(3), r.lot) + ' (at most 40% of the pot), then ' : ''}the top 3 share the rest 50 / 30 / 20%: ${pz.slice(0, 3).map((x) => ase(x)).join(' / ')} ASE`);
      const tk = drawTicketsV4(id, r.sO, r.sC, d, r.tickets, r.prizes.length);
      step(JSON.stringify(tk) === JSON.stringify(r.win), 'Winning tickets', tk.slice(0, 3).map((x, k) => `${rankName(k)}: ${tno(x)}`).join(', ') + (tk.length > 3 ? `, lots: ${tk.slice(3).map(tno).join(' ')}` : ''));
    } else {
      const w = drawWinners(id, r.sO, r.sC, d, list);
      step(JSON.stringify(w) === JSON.stringify(r.win), 'Winning tickets', w.map((x, k) => `${rankName(k)}: ${tno(x.t)} (${L.shortAddr(x.b)})`).join(', '));
      const pz = prizesOfPool(poolOf(r), r.win.length);
      step(pz.every((x, k) => x.toString() === r.prizes[k]), 'Prizes', `50 / 30 / 20% of the pot (carry-over included): ${pz.map((x) => ase(x)).join(' / ')} ASE` + (r.win.length < 3 ? ' (prizes without a winner carried over)' : ''));
    }
    body.innerHTML = steps.join('') + '<p class="small muted" style="margin-top:12px">Everything is recomputed in your browser from the contract\'s public data.</p>';
  } catch (e) { body.innerHTML = `<p class="error">Verification failed: ${esc(cleanError(e))}</p>`; }
}

// ------------------------------------------------------------- admin
function stat(label, value, alert = false) { return `<dl class="stat${alert ? ' alert' : ''}"><dt>${label}</dt><dd>${value}</dd></dl>`; }
function setIfIdle(sel, v) { const e = $(sel); if (e && !e.dataset.touched && document.activeElement !== e) e.value = v; }
function renderAdmin() {
  const isAdmin = S.wallet && S.cfg && S.wallet.address === S.cfg.admin;
  $('#adminTab').hidden = !isAdmin;
  if (!isAdmin) return;
  const t = S.st.tot;
  $('#adminStats').innerHTML = [
    stat('Total volume', ase(t.sales, 0) + ' ASE'), stat('Commissions paid', ase(t.commission) + ' ASE'),
    stat('Tickets sold', t.tickets.toLocaleString('en-GB')), stat('Prizes owed', ase(S.st.owed) + ' ASE', BigInt(S.st.owed) > 0n),
  ].join('');
  $('#pauseState').textContent = S.cfg.paused ? 'The raffle is paused.' : 'The raffle is open.';
  $('#pauseBtn').textContent = S.cfg.paused ? 'Resume' : 'Pause';
  setIfIdle('#fPrice [name=price]', L.fmtAse(BigInt(S.cfg.price)).replace(/,/g, ''));
  $('#fTime [name=d]').closest('label').hidden = isV4(); $('#dayChecks').hidden = !isV4(); $('#fLots').hidden = !isV4();
  if (isV4()) { $$('#dayChecks input').forEach((x) => { if (!x.dataset.touched) x.checked = !!((S.cfg.drawDays >> Number(x.value)) & 1); }); setIfIdle('#fLots [name=lot]', L.fmtAse(BigInt(S.cfg.lot)).replace(/,/g, '')); setIfIdle('#fLots [name=n]', S.cfg.maxLots); }
  else setIfIdle('#fTime [name=d]', S.cfg.drawDay);
  setIfIdle('#fTime [name=h]', S.cfg.drawH); setIfIdle('#fTime [name=m]', S.cfg.drawM);
  setIfIdle('#fMax [name=w]', S.cfg.maxPerWallet); setIfIdle('#fMax [name=t]', S.cfg.maxRound);
  setIfIdle('#fTimings [name=close]', S.cfg.closeMin); setIfIdle('#fTimings [name=reveal]', S.cfg.revealMin);
}
$$('.admin-box input, .admin-box select').forEach((i) => i.addEventListener('input', () => (i.dataset.touched = '1')));
function adminForm(sel, fn) {
  $(sel).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const [label, method, args] = fn(new FormData(e.target)); if (await sendTx(label, method, args)) { e.target.querySelectorAll('input,select').forEach((i) => delete i.dataset.touched); await refresh(); } } catch (err) { toast(cleanError(err), 'err'); }
  });
}
const cfgArgs = (p) => { const c = { ...S.cfg, ...p }; return [String(c.price), isV4() ? c.drawDays : c.drawDay, c.drawH, c.drawM, c.maxPerWallet, c.closeMin, c.revealMin, c.maxRound]; };
const daysMask = () => $$('#dayChecks input').reduce((a, x) => a | (x.checked ? 1 << Number(x.value) : 0), 0);
adminForm('#fPause', () => [S.cfg.paused ? 'Raffle resumed' : 'Raffle paused', 'setPaused', [!S.cfg.paused]]);
adminForm('#fPrice', (f) => ['Price saved', 'setConfig', cfgArgs({ price: L.parseAse(f.get('price')).toString() })]);
adminForm('#fTime', (f) => ['Draw time saved', 'setConfig', cfgArgs(isV4() ? { drawDays: daysMask(), drawH: Number(f.get('h')), drawM: Number(f.get('m')) } : { drawDay: Number(f.get('d')), drawH: Number(f.get('h')), drawM: Number(f.get('m')) })]);
adminForm('#fLots', (f) => ['Lucky lots saved (next raffles)', 'setLots', [L.parseAse(f.get('lot')).toString(), Number(f.get('n'))]]);
adminForm('#fMax', (f) => ['Limits saved', 'setConfig', cfgArgs({ maxPerWallet: Number(f.get('w')), maxRound: Number(f.get('t')) })]);
adminForm('#fTimings', (f) => ['Timings saved', 'setConfig', cfgArgs({ closeMin: Number(f.get('close')), revealMin: Number(f.get('reveal')) })]);


// ------------------------------------------------------------- onglets, wallet
function selectTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
}
$$('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
function renderWallet() {
  const b = $('#walletBtn');
  b.textContent = S.wallet ? `${L.shortAddr(S.wallet.address)}${S.balance !== null ? ' · ' + L.fmtAse(S.balance) + ' ASE' : ''}` : 'Connect wallet';
}
let pairing = false;
function openWallet() {
  if (S.demo) { toast('Demo mode: you are playing with a mock wallet holding 100,000 ASE.'); return; }
  $('#walletErr').hidden = true; $('#tgPair').hidden = true; $('#dlgWalletTitle').textContent = S.wallet ? 'Your wallet' : 'Connect to Asentum';
  if (S.wallet) { $('#walletConnected').hidden = false; $('#walletChoices').hidden = true; $('#walletAddrFull').textContent = L.toAse1(S.wallet.address); $('#dlgWallet').showModal(); return; }
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
  try { const w = new ExtensionWallet(); await w.connect(); S.wallet = w; store.set('loto.wallet', { kind: 'extension' }); $('#dlgWallet').close(); await refresh(); }
  catch (e) { $('#walletErr').hidden = false; $('#walletErr').textContent = cleanError(e); }
};
$('#useTg').onclick = async () => {
  const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME);
  pairing = true; $('#walletChoices').hidden = true; $('#tgPair').hidden = false; $('#walletErr').hidden = true; $('#tgCode').innerHTML = '<span>·</span>'.repeat(6); $('#tgExpire').textContent = 'Creating a code…'; $('#dlgWalletTitle').textContent = 'Pair Telegram Wallet';
  try { await w.pair(showPairCode, () => !pairing); S.wallet = w; store.set('loto.wallet', { kind: 'telegram', session: w.session }); $('#dlgWallet').close(); await refresh(); }
  catch (e) { clearInterval(pairTimer); if (/cancelled/i.test(String(e && e.message))) return; $('#dlgWalletTitle').textContent = 'Connect to Asentum'; $('#walletErr').hidden = false; $('#walletErr').textContent = cleanError(e); $('#walletChoices').hidden = false; $('#tgPair').hidden = true; }
};
async function restoreWallet() {
  const saved = store.get('loto.wallet', null);   // même wallet que sur ASE Loto
  if (!saved) return;
  if (saved.kind === 'extension') {
    for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await sleep(200);
    if (!ExtensionWallet.available()) return;
    const w = new ExtensionWallet(); if (await w.restore()) S.wallet = w;
  } else if (saved.kind === 'telegram') { const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME); if (await w.restore(saved.session)) S.wallet = w; }
}

function renderRulesValues() {
  if (!S.cfg) return;
  { const d = Number((S.cfg && S.cfg.dropBps) || 750), fmt = (b) => (b / 100).toLocaleString('en-GB') + '%';
    document.querySelectorAll('.js-fees').forEach((e) => (e.textContent = `Fees: 15% of every ${'ticket'} paid, sent right away: ${fmt(1500 - d)} to the ASE Vegas team and ${fmt(d)} to the weekly ASE Airdrop pot.`)); }
  $$('.js-price').forEach((e) => (e.textContent = ase(S.info ? S.info.price : S.cfg.price) + ' ASE'));   // prix de la raffle en cours
  $$('.js-max').forEach((e) => (e.textContent = S.cfg.maxPerWallet));
  if (S.info) $$('.js-drawtime').forEach((e) => (e.textContent = `${isV4() ? daysText(S.cfg.drawDays) : utcWeekday(S.info.drawTs)} at ${utcTime(S.info.drawTs)}`));
  $$('.v3only').forEach((e) => (e.hidden = isV4())); $$('.v4only').forEach((e) => (e.hidden = !isV4()));
  if (isV4()) { $$('.js-lot').forEach((e) => (e.textContent = ase(S.cfg.lot) + ' ASE')); $$('.js-lots').forEach((e) => (e.textContent = S.cfg.maxLots)); $$('.js-winners').forEach((e) => (e.textContent = 3 + Number(S.cfg.maxLots))); }
  $$('.js-close').forEach((e) => (e.textContent = plural(S.cfg.closeMin, 'minute', 'minutes')));
  $$('.js-reveal').forEach((e) => (e.textContent = S.cfg.revealMin % 60 === 0 ? plural(S.cfg.revealMin / 60, 'hour', 'hours') : plural(S.cfg.revealMin, 'minute', 'minutes')));
}
function renderAll() { renderWallet(); renderHero(); tickCountdown(); renderBuy(); renderMine(); renderResults(); renderAdmin(); renderRulesValues(); }

(async function start() {
  startVegas();
  const wantDemo = !CONFIG.CONTRACT || new URLSearchParams(location.search).has('demo');
  if (wantDemo) {
    const { startDemo } = await import('./demo.js');
    S.demo = await startDemo(new URL('contrat/tombola.js', document.baseURI));
    S.rpc = S.demo.rpc; S.contract = S.demo.contractAddress; S.wallet = S.demo.wallet;
    $('#demoBar').hidden = false;
    $('#demoWarp').onclick = async () => { S.demo.goToDraw(); await sleep(300); await refresh(); toast('Clock fast-forwarded: the demo croupier just ran the draw.', 'ok'); };
  } else {
    S.rpc = new Rpc(CONFIG.RPC); S.contract = CONFIG.CONTRACT; await restoreWallet();
  }
  const link = $('#contractLink');
  link.textContent = S.demo ? 'local demo' : L.shortAddr(S.contract);
  if (!S.demo) link.href = `${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}`;
  $('#rpcLabel').textContent = S.rpc.url;
  renderBuy();
  await refresh();
  setInterval(refresh, S.demo ? 4000 : 20000);
})();
