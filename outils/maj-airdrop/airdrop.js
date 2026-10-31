// =====================================================================
//  ASE Airdrop — logique du site (tout est lu sur la chaîne)
// =====================================================================
import CONFIG from './config.js';
import LOTO from '../../loto/js/config.js';
import RAFFLE from '../../raffle/js/config.js';
import TREASURE from '../../treasure/js/config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from '../../loto/js/chain.js';
import * as L from '../../loto/js/lotomath.js';
import { startVegas, myWins } from '../../vegas.js';
import { buildWeek, chunks, CUTOFF_MS } from './liste.mjs';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const S = { rpc: null, contract: '', loto: '', raffle: '', info: null, cfg: null, st: null, week: null, clockOffset: 0, me: '', rounds: new Map() };
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
const RANK = ['1st', '2nd', '3rd'];
const rankName = new Proxy(RANK, { get: (a, k) => (k in a ? a[k] : 'lucky lot') });
const split = (total) => { const T = BigInt(total), p1 = T / 2n, p2 = (T * 3n) / 10n; return [p1, p2, T - p1 - p2]; };
// Airdrop v2 : jusqu'à maxLots lots (≤ 50 % de la cagnotte, ≤ chances − 3), le top 3 prend tout le reste.
const isV2 = () => !!S.cfg && S.cfg.drawDays !== undefined;
function prizesV2(total, chances, lot, maxLots) {
  const T = BigInt(total);
  const Lw = BigInt(lot || 0), nTop = Math.min(3, chances), lots = [];
  if (Lw > 0n) { const cap = Math.max(0, Math.min(Number(maxLots || 0), 300, chances - nTop)); let b = (T * 5000n) / 10000n; let r = T; while (lots.length < cap && b >= Lw && r >= Lw * 6n) { lots.push(Lw); b -= Lw; r -= Lw; } const x = b < r / 6n ? b : r / 6n; if (lots.length < cap && x >= 10n ** 16n) lots.push(x); }   // un lot ≤ 3e prix
  const top = lots.reduce((a, x) => a - x, T), p1 = top / 2n, p2 = (top * 3n) / 10n;
  return [p1, p2, top - p1 - p2].slice(0, nTop).concat(lots);
}
const daysText = (mask) => { const d = DAYS.filter((_, k) => (mask >> k) & 1); return d.length === 7 ? 'every day' : d.length > 1 ? d.slice(0, -1).join(', ') + ' and ' + d.at(-1) : d[0]; };
const myKs = (r) => (r.win || []).map((w, k) => (w.b === S.me ? k : -1)).filter((k) => k >= 0);
const pct = (a, b) => (b ? (a * 100 / b).toLocaleString('en-GB', { maximumFractionDigits: a * 100 / b < 1 ? 2 : 1 }) : '0') + '%';

document.documentElement.dataset.theme = 'dark';
function toast(text, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  if (!ms) { el.title = 'Click to close'; el.style.cursor = 'pointer'; el.onclick = () => el.remove(); }
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
function cleanError(e) { const m = String(e && e.message ? e.message : e); const i = m.lastIndexOf('failed: '); return i >= 0 ? m.slice(i + 8) : m; }
function confetti(n = 90) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti'), colors = ['#B0D6FF', '#3C9EFF', '#F4C542', '#FFFFFF', '#1F6FD1'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x', (Math.random() * 200 - 100) + 'px');
    c.style.setProperty('--r', (360 + Math.random() * 720) + 'deg');
    c.style.setProperty('--d', (1.2 + Math.random() * 1.4) + 's');
    box.append(c);
    setTimeout(() => c.remove(), 3500);
  }
}

// ------------------------------------------------------------- lectures
// Ce qui ne change plus (grilles Treasure trouvées, tirages terminés, leurs achats et fouilles) est
// gardé en mémoire ET dans le navigateur : la 2e visite ne relit que la semaine en cours.
// Le testnet limite le nombre de lectures (HTTP 429) : une lecture ratée est réessayée, plus lentement.
const cache = new Map();
const LS_KEY = 'airdrop.cache.v1';
const disk = (() => { try { return new Map(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch { return new Map(); } })();
let diskDirty = false;
setInterval(() => {
  if (!diskDirty) return; diskDirty = false;
  try { const all = [...disk.entries()]; localStorage.setItem(LS_KEY, JSON.stringify(all.slice(-2500))); }
  catch { try { localStorage.removeItem(LS_KEY); } catch {} }
}, 5000);
const FINAL = (m, v) => v && ((m === 'getGrid' && v.status && v.status !== 'open') || (m === 'getRound' && ['done', 'cancelled'].includes(v.status)));
async function rawView(contract, method, args) {
  for (let i = 0; ; i++) {
    try { return await S.rpc.view(contract, method, args); } catch (e) {
      const m = String(e && e.message);
      if (i >= 5 || !/read rejected|not responding|HTTP|fetch|JSON/i.test(m)) throw e;
      await new Promise((ok) => setTimeout(ok, [2000, 4000, 8000, 12000, 16000][i]));
    }
  }
}
async function viewAt(contract, method, args = []) {
  const key = contract + '|' + method + '|' + JSON.stringify(args);
  // fouilles / achats : seulement si la grille / le tirage est déjà connu comme terminé
  const parent = method === 'getDigs' ? contract + '|getGrid|' + JSON.stringify([args[0]]) : method === 'getPurchases' ? contract + '|getRound|' + JSON.stringify([args[0]]) : '';
  const keep = contract !== S.contract && (method === 'getGrid' || method === 'getRound' || (parent && disk.has(parent)));   // jamais le contrat Airdrop lui-même
  if (disk.has(key)) return disk.get(key);
  if (method === 'getPurchases' && cache.has(key)) return cache.get(key);
  const v = await rawView(contract, method, args);
  if (!S.week && contract !== S.contract) { S.reads = (S.reads || 0) + 1; const n = $('#estNote'); if (n) n.textContent = `Counting this week's tickets from Loto, Raffle and Treasure… (${S.reads} reads, the first visit can take a minute or two)`; }
  if (method === 'getPurchases') cache.set(key, v);
  if (keep && (FINAL(method, v) || (parent && disk.has(parent)))) { disk.set(key, v); diskDirty = true; }
  return v;
}
const view = (m, a = []) => viewAt(S.contract, m, a);
async function entriesOf(r) {
  const out = [];
  for (let j = 0; j < r.chunks; j++) out.push(...(await view('getEntries', [r.id, j])));
  return out;
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;          // une lecture complète peut prendre plus de 30 s : pas de lectures en double
  refreshing = true;
  try {
    const [info, cfg, st] = await Promise.all([view('info'), view('getConfig'), view('getState')]);
    S.info = info; S.cfg = cfg; S.st = st;
    S.clockOffset = Number(info.now) - Date.now();
    const ids = []; for (let id = info.round; id >= Math.max(1, info.round - CONFIG.HISTORY_ROUNDS); id--) ids.push(id);
    await Promise.all(ids.map(async (id) => { const old = S.rounds.get(id); if (old && ['done', 'cancelled'].includes(old.status)) return; const r = await view('getRound', [id]); if (r) S.rounds.set(id, r); }));
    // En attendant le décompte complet : montant déjà reçu par le contrat (solde − prix pas encore versés).
    if (!S.week) { try { const est = (await S.rpc.balance(S.contract)) - BigInt(info.owed || 0); if (est >= 0n) $('#pot').textContent = '≈ ' + ase(est, 2); } catch {} }
    // Semaine en cours : depuis le tirage précédent (même s'il est encore en cours de tirage).
    const prev = S.rounds.get(info.round - 1);
    const from = prev && prev.status !== 'cancelled' ? prev.drawTs : info.fromTs;
    // Estimation (*) : on compte aussi les tickets des tirages pas encore faits.
    S.week = await buildWeek({ view: viewAt, loto: S.loto, raffle: S.raffle, treasure: S.treasure, fromTs: from, toTs: info.drawTs, now: Number(info.now), par: 3 });
    renderAll();
  } catch (e) { console.error(e); toast('Could not read the chain: ' + cleanError(e), 'err', 8000); }
  finally { refreshing = false; }
}

// Heure annoncée des résultats : heure de tirage du contrat + délai d'envoi des prix
const resultTs = () => Number(S.info.drawTs) + (CONFIG.RESULT_DELAY_MIN || 0) * 60000;

// ------------------------------------------------------------- en-tête
function renderHero() {
  const i = S.info, w = S.week; if (!i || !w) return;
  const total = BigInt(w.pot) + BigInt(i.carry);
  $('#pot').textContent = ase(total, 2);
  const v2 = isV2(), nCh = w.entries.reduce((a, e) => a + e[1], 0);
  const pr = v2 ? prizesV2(total, Math.max(nCh, 3 + Number(i.maxLots || 0)), i.lot, i.maxLots) : split(total);
  [0, 1, 2].forEach((k) => ($('#prize' + (k + 1)).textContent = ase(pr[k] || 0n) + ' ASE'));
  ['1st', '2nd', '3rd'].forEach((n, k) => { const e = $('#plabel' + (k + 1)); if (e) e.textContent = v2 ? n : `${n}, ${[50, 30, 20][k]}%`; });
  const ll = $('#lotsLine'); if (ll) { ll.hidden = !v2; const n = pr.length - 3; if (v2) ll.textContent = n > 0 ? `+ ${lotsText(pr.slice(3), i.lot)}` : `+ lucky lots of ${ase(i.lot)} ASE as the pot grows`; }
  const cut = Number(i.drawTs) - CUTOFF_MS;
  $('#estNote').textContent = `Exact amount: it is already in the airdrop contract. Tickets count until ${utcWeekday(cut)} at ${utcTime(cut)} (when Raffle sales close).`;
  const pending = [...S.rounds.values()].find((r) => r.id < i.round && (r.status === 'closed' || r.status === 'listed'));
  $('#drawWhen').textContent = `Airdrop #${i.round}, ${utcDay(resultTs())} at ${utcTime(resultTs())}` +
    (BigInt(i.carry) > 0n ? ` · includes ${ase(i.carry)} ASE rolled over` : '') + (pending ? ` · airdrop #${pending.id} is being drawn now` : '');
  $('#chances').textContent = w.entries.reduce((a, e) => a + e[1], 0).toLocaleString('en-GB');
  $('#players').textContent = w.entries.length.toLocaleString('en-GB');
}
function tickCountdown() {
  const i = S.info; if (!i) return;
  // Semaine des tickets : de la tombola d'un dimanche à la tombola du dimanche suivant.
  const cut = Number(i.drawTs) - CUTOFF_MS, start = Number(i.fromTs) > 0 ? Number(i.fromTs) - CUTOFF_MS : cut - 7 * 86400000, span = Math.max(1, cut - start);
  const f = Math.min(1, Math.max(0, (chainNow() - start) / span)), days = Math.max(1, Math.round(span / 86400000));
  $('#weekBar').style.width = (f * 100).toFixed(1) + '%';
  $('#weekPct').textContent = f < 1 ? `Day ${Math.min(days, Math.floor(f * days) + 1)} / ${days}` : 'Closed, new tickets count for the next airdrop';
  const left = Math.floor((resultTs() - chainNow()) / 1000);
  if (left > 0) {
    const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), x = left % 60;
    $('#countdownLabel').textContent = 'Airdrop in';
    $('#countdown').textContent = (d ? d + 'd ' : '') + [h, m, x].map((v) => String(v).padStart(2, '0')).join(':');
  } else { $('#countdownLabel').textContent = 'Week closed'; $('#countdown').textContent = 'Drawing soon'; }
}
setInterval(tickCountdown, 1000);

// ------------------------------------------------------------- mes chances
function renderMine() {
  const box = $('#mineBody');
  if (!S.me) { box.innerHTML = '<p class="muted">Enter a wallet address to see its chances this week.</p>'; return; }
  if (!S.week) return;
  const total = S.week.entries.reduce((a, e) => a + e[1], 0);
  const e = S.week.entries.find((x) => x[0] === S.me);
  const n = e ? e[1] : 0;
  const pot = BigInt(S.week.pot) + BigInt(S.info.carry);
  let html = `<dl class="share"><div><dt>Your chances</dt><dd>${n.toLocaleString('en-GB')}</dd></div><div><dt>Out of</dt><dd>${total.toLocaleString('en-GB')}</dd></div><div><dt>Share</dt><dd>${pct(n, total)}</dd></div></dl>
    <div class="bar" aria-hidden="true"><i style="width:${total ? Math.max(n ? 1 : 0, (n * 100) / total) : 0}%"></i></div>`;
  html += n
    ? `<p>Each of your tickets is one chance at the 1st prize (${ase(split(pot)[0])} ASE so far). The more you play before ${utcWeekday(Number(S.info.drawTs) - CUTOFF_MS)} ${utcTime(Number(S.info.drawTs) - CUTOFF_MS)} (when Raffle sales close), the more chances you get.</p>`
    : `<p class="muted">No chance yet this week for ${esc(L.shortAddr(S.me))}. Play <a href="../loto/">ASE Loto</a>, <a href="../raffle/">ASE Raffle</a> or <a href="../treasure/">ASE Treasure</a>: every ticket or dig this week is one chance.</p>`;
  const won = [...S.rounds.values()].filter((r) => r.status === 'done' && myKs(r).length).sort((a, b) => b.id - a.id);
  if (won.length) html += '<h3>Your airdrop wins</h3><ol class="winners">' + won.map((r) => { const ks = myKs(r), k = ks[0], sum = ks.reduce((a, j) => a + BigInt(r.prizes[j]), 0n); return `<li><span class="medal m${Math.min(k + 1, 3)}">${k < 3 ? k + 1 : '★'}</span>Airdrop #${r.id}${ks.length > 1 ? ` (${ks.length} prizes)` : ''}<span class="muted small">${utcDay(r.drawTs)}</span><span class="tag ok">Sent to your wallet</span><span class="amount">${ase(sum)} ASE</span></li>`; }).join('') + '</ol>';
  box.innerHTML = html;
}
function renderWinBanner() {
  const b = $('#winBanner');
  const last = [...S.rounds.values()].filter((r) => r.status === 'done').sort((a, c) => c.id - a.id)[0];
  const ks = S.me && last ? myKs(last) : [], k = ks.length ? ks[0] : -1;
  b.hidden = k < 0;
  if (k < 0) return;
  const sum = ks.reduce((a, j) => a + BigInt(last.prizes[j]), 0n);
  b.textContent = `🪂 You won ${ks.length > 1 ? ks.length + ' prizes' : 'the ' + rankName[k] + (k < 3 ? ' prize' : '')} in airdrop #${last.id}: ${ase(sum)} ASE, already sent to your wallet!`;
  const seen = store.get('airdrop.seen', []);
  if (!seen.includes(last.id)) { confetti(); store.set('airdrop.seen', [...seen, last.id].slice(-50)); }
}
$('#checkForm').onsubmit = (ev) => {
  ev.preventDefault();
  const v = $('#addr').value.trim();
  try { S.me = v ? L.toHex(v) : ''; store.set('airdrop.addr', v); renderAll(); }
  catch { toast('This address is not valid (ase1… or 0x…).', 'err'); }
};

// ------------------------------------------------------------- joueurs
function renderPlayers() {
  const w = S.week; if (!w) return;
  if (!w.entries.length) { $('#playersBody').innerHTML = '<p class="muted">No player yet this week. Every ticket or dig counts as soon as it is bought.</p>'; return; }
  const total = w.entries.reduce((a, e) => a + e[1], 0);
  const top = [...w.entries].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 50);
  const mine = S.me && !shown.some((e) => e[0] === S.me) ? top.find((e) => e[0] === S.me) : null;
  if (mine) shown.push(mine);
  $('#playersBody').innerHTML = `<p class="muted small">${plural(w.entries.length, 'player', 'players')}, ${plural(total, 'chance', 'chances')} this week.</p>
    <table class="plist"><thead><tr><th>#</th><th>Wallet</th><th class="num">Chances</th><th class="num">Share</th></tr></thead><tbody>${
      shown.map((e) => `<tr class="${e[0] === S.me ? 'me' : ''}"><td>${top.indexOf(e) + 1}</td><td>${esc(L.shortAddr(e[0]))}</td><td class="num">${e[1]}</td><td class="num">${pct(e[1], total)}</td></tr>`).join('')
    }</tbody></table>${top.length > 50 ? `<p class="muted small">Top 50 of ${top.length} shown.</p>` : ''}`;
}

// ------------------------------------------------------------- gagnants
function renderResults() {
  const rows = [...S.rounds.values()].filter((r) => r.id < S.info.round || r.status !== 'open').sort((a, b) => b.id - a.id);
  if (!rows.length) { $('#resultsBody').innerHTML = '<p class="muted">No airdrop yet. The first one takes place at the time shown at the top of the page.</p>'; return; }
  $('#resultsBody').innerHTML = rows.map((r) => {
    const head = `<div class="round-head"><h3>Airdrop #${r.id}</h3><span class="muted small">${utcDay(r.drawTs)}${r.wallets ? ' · ' + plural(r.wallets, 'player', 'players') + ' · ' + plural(r.tickets, 'chance', 'chances') : ''}</span>`;
    if (r.status === 'cancelled') return `<div class="round-block">${head}<span class="tag warn">Not drawn in time: the week is carried into the next airdrop</span></div></div>`;
    if (r.status !== 'done') return `<div class="round-block">${head}<span class="tag">Drawing in progress</span></div></div>`;
    const total = BigInt(r.pot) + BigInt(r.carryIn);
    if (!r.win.length) return `<div class="round-block">${head}<span class="tag">No player: ${ase(total)} ASE rolled over</span></div></div>`;
    return `<div class="round-block">${head}<button class="link-btn" data-verify="${r.id}">Verify</button></div>
      <ol class="winners">${r.win.slice(0, 3).map((w, k) => `<li><span class="medal m${k + 1}">${k + 1}</span><span class="who">${esc(L.shortAddr(w.b))}</span>${w.n ? `<span class="muted small">${plural(w.n, 'chance', 'chances')}</span>` : ''}<span class="tag ok">${typeof r.paid === 'number' && k >= r.paid ? 'Sending…' : 'Sent'}</span><span class="amount">${ase(r.prizes[k])} ASE</span></li>`).join('')}</ol>
      ${r.win.length > 3 ? `<p class="small"><strong>${r.win.length - 3} lucky lots of ${ase(r.prizes[3])} ASE</strong>: ${r.win.slice(3).map((w) => esc(L.shortAddr(w.b))).join(' · ')}</p>` : ''}
      ${BigInt(r.carryOut) > 0n ? `<p class="muted small">${ase(r.carryOut)} ASE rolled over to the next airdrop.</p>` : ''}</div>`;
  }).join('');
  $$('[data-verify]').forEach((b) => (b.onclick = () => verify(Number(b.dataset.verify))));
}
function drawWinners(id, sO, sC, digest, entries) {
  const out = new Set(), win = [];
  let rem = entries.reduce((a, e) => a + e[1], 0);
  for (let k = 0; k < 3 && rem > 0; k++) {
    const h = L.sha256Text('ASEDROP|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(rem));
    let x = t;
    for (const [b, n] of entries) {
      if (out.has(b)) continue;
      if (x < n) { out.add(b); win.push({ b, n, t }); rem -= n; break; }
      x -= n;
    }
  }
  return win;
}
function drawWinnersV2(id, sO, sC, digest, entries, n) {
  const total = entries.reduce((a, e) => a + e[1], 0), ts = [], seen = new Set();
  for (let k = 0; ts.length < n && k < 100000; k++) {
    const t = Number(BigInt('0x' + L.sha256Text('ASEDROP|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k).slice(0, 13)) % BigInt(total));
    if (seen.has(t)) continue;
    seen.add(t); ts.push(t);
  }
  return ts.map((t) => { let x = t; for (const [b, m] of entries) { if (x < m) return { b, t }; x -= m; } return null; });
}
async function verify(id) {
  const body = $('#verifyBody');
  body.innerHTML = '<p class="muted">Rebuilding the list from ASE Loto and ASE Raffle, then redoing the draw in your browser…</p>';
  $('#dlgVerify').showModal();
  try {
    const r = await view('getRound', [id]);
    const stored = await entriesOf(r);
    const wk = await buildWeek({ view: viewAt, loto: S.loto, raffle: S.raffle, treasure: S.treasure, fromTs: r.fromTs, toTs: r.drawTs, now: chainNow(), par: 3 });
    const steps = [];
    const step = (ok, title, detail) => steps.push(`<div class="verify-step"><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><div><strong>${title}</strong><br><span class="small">${detail}</span></div></div>`);
    step(JSON.stringify(wk.entries) === JSON.stringify(stored), 'List of players',
      `Rebuilt from ${plural(wk.games.length, 'game round', 'game rounds')} (${wk.games.map((g) => ({ loto: 'Loto', raffle: 'Raffle', treasure: 'Treasure' }[g.game]) + ' #' + g.id).join(', ') || 'none'}): ${plural(wk.entries.length, 'player', 'players')}, ${plural(wk.entries.reduce((a, e) => a + e[1], 0), 'chance', 'chances')}`);
    step(wk.pot === r.pot, 'Pot of the week', `${ase(wk.pot)} ASE, from those draws`);
    let d = L.sha256Text('ASEDROP-ROUND|' + id);
    for (const c of chunks(stored)) d = L.sha256Text(d + '|' + JSON.stringify(c));
    step(d === r.digest, 'List fingerprint', `<code>${d.slice(0, 24)}…</code>`);
    const prev = [...S.rounds.values()].filter((x) => x.id < id && x.sO && x.sC).sort((a, b) => b.id - a.id)[0];
    const ext = (sec, key) => (!prev ? [true, 'first secret visible here'] : L.sha256Hex(sec) === prev[key] ? [true, `SHA-256 of this secret = secret of airdrop #${prev.id}`] : [false, 'does not extend the chain of airdrop #' + prev.id]);
    const [o1, o2] = ext(r.sO, 'sO'), [c1, c2] = ext(r.sC, 'sC');
    step(o1, 'Operator secret', `<code>${r.sO}</code><br>${o2}`);
    step(c1, 'Collaborator secret', `<code>${r.sC}</code><br>${c2}`);
    if (r.lot !== undefined) {   // v2 : top 3 + lots
      const pz = prizesV2(BigInt(r.pot) + BigInt(r.carryIn), r.tickets, r.lot, r.maxLots);
      step(pz.length === r.prizes.length && pz.every((x, k) => x.toString() === r.prizes[k]), 'Prizes', `${pz.length > 3 ? lotsText(pz.slice(3), r.lot) + ' (at most 50% of the pot), then ' : ''}the top 3 share the rest 50 / 30 / 20%: ${pz.slice(0, 3).map((x) => ase(x)).join(' / ')} ASE`);
      const w = drawWinnersV2(id, r.sO, r.sC, d, stored, pz.length);
      step(JSON.stringify(w) === JSON.stringify(r.win), 'Winners', w.slice(0, 3).map((x, k) => `${rankName[k]}: ${esc(L.shortAddr(x.b))}`).join(', ') + (w.length > 3 ? ` + ${w.length - 3} lucky lots` : ''));
    } else {
      const w = drawWinners(id, r.sO, r.sC, d, stored);
      step(JSON.stringify(w) === JSON.stringify(r.win), 'Winners', w.map((x, k) => `${rankName[k]}: ${esc(L.shortAddr(x.b))} (${plural(x.n, 'chance', 'chances')})`).join(', '));
      const pz = split(BigInt(r.pot) + BigInt(r.carryIn));
      step(pz.every((x, k) => x.toString() === r.prizes[k]), 'Prizes', `50 / 30 / 20% of ${ase(BigInt(r.pot) + BigInt(r.carryIn))} ASE: ${pz.map((x) => ase(x)).join(' / ')} ASE`);
    }
    body.innerHTML = steps.join('') + '<p class="small muted" style="margin-top:12px">Everything is recomputed in your browser from the public data of the three contracts.</p>';
  } catch (e) { body.innerHTML = `<p class="error">Verification failed: ${esc(cleanError(e))}</p>`; }
}

// ------------------------------------------------------------- onglets, règles
function selectTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
}
$$('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
function renderRulesValues() {
  if (!S.cfg) return;
  if (S.info) $$('.js-drawtime').forEach((e) => (e.textContent = `${isV2() ? daysText(S.cfg.drawDays) : utcWeekday(resultTs())} at ${utcTime(resultTs())}`));
  $$('.v1only').forEach((e) => (e.hidden = isV2())); $$('.v2only').forEach((e) => (e.hidden = !isV2()));
  if (isV2() && S.info) { $$('.js-lot').forEach((e) => (e.textContent = ase(S.info.lot) + ' ASE')); $$('.js-lots').forEach((e) => (e.textContent = S.info.maxLots)); }
  $$('.js-reveal').forEach((e) => (e.textContent = S.cfg.revealMin % 60 === 0 ? plural(S.cfg.revealMin / 60, 'hour', 'hours') : plural(S.cfg.revealMin, 'minute', 'minutes')));
}
function renderChanceCard() {
  if (!S.week) return;
  const total = S.week.entries.reduce((a, e) => a + e[1], 0);
  const e = S.me ? S.week.entries.find((x) => x[0] === S.me) : null, n = e ? e[1] : 0;
  $('#ccMine').textContent = S.me ? n : '–';
  $('#ccAll').textContent = total;
  $('#ccBar').style.width = (total && S.me ? Math.max(n ? 2 : 0, (n * 100) / total) : 0) + '%';
  $('#ccText').textContent = !S.me ? 'Connect your wallet (top right) to see your chances.'
    : n ? `About ${Math.min(99, Math.round(100 * (1 - Math.pow(1 - n / Math.max(total, 1), 3))))}% chance to win one of the 3 prizes. Each ticket or dig adds one chance.`
    : 'No chance yet this week: play Loto, Raffle or Treasure, every ticket or dig is one free chance.';
}
function renderAll() { renderChanceCard(); renderHero(); tickCountdown(); renderMine(); renderPlayers(); renderResults(); renderWinBanner(); renderRulesValues(); }

async function restoreWallet() {
  const saved = store.get('loto.wallet', null);   // même wallet que sur ASE Loto et ASE Raffle
  try {
    if (saved && saved.kind === 'extension') {
      for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await new Promise((r) => setTimeout(r, 200));
      if (ExtensionWallet.available()) { const w = new ExtensionWallet(); if (await w.restore()) return w.address; }
    } else if (saved && saved.kind === 'telegram') { const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME); if (await w.restore(saved.session)) return w.address; }
  } catch {}
  return '';
}

(async function start() {
  startVegas({ walletButton: true });
  // Wallet connecté depuis l'en-tête : on affiche ses chances
  document.addEventListener('asevegas:wins', () => {
    const w = myWins().wallet;
    if (w && !store.get('airdrop.addr', '') && S.me !== w.address) { S.me = w.address; $('#addr').value = L.toAse1(w.address); renderAll(); }
  });
  S.rpc = new Rpc(CONFIG.RPC);
  $('#rpcLabel').textContent = S.rpc.url;
  const typed = store.get('airdrop.addr', '');
  if (typed) { $('#addr').value = typed; try { S.me = L.toHex(typed); } catch {} }
  if (!CONFIG.CONTRACT) {
    $('#soonBanner').hidden = false;
    $('#pot').textContent = '0'; $('#drawWhen').textContent = 'Every Monday at 19:00 UTC';
    $('#countdown').textContent = 'soon'; $('#resultsBody').innerHTML = $('#playersBody').innerHTML = '<p class="muted">The ASE Airdrop is launching soon.</p>';
    $('#contractLink').textContent = 'coming soon';
    return;
  }
  S.contract = L.toHex(CONFIG.CONTRACT);
  const both = (a, b) => [a, b].flatMap((v) => String(v || '').split(',')).map((v) => v.trim()).filter(Boolean).map((x) => L.toHex(x));   // ancien(s) contrat(s) : liste séparée par des virgules
  S.loto = both(LOTO.CONTRACT, CONFIG.OLD_LOTO);
  S.raffle = both(RAFFLE.CONTRACT, CONFIG.OLD_RAFFLE);
  S.treasure = both(TREASURE.CONTRACT, CONFIG.OLD_TREASURE);
  const link = $('#contractLink');
  link.textContent = L.shortAddr(S.contract);
  link.href = `${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}`;
  if (!S.me) { const a = await restoreWallet(); if (a) { S.me = a; $('#addr').value = L.toAse1(a); } }
  await refresh();
  setInterval(refresh, 30000);
})();
