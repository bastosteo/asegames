// =====================================================================
//  ASE Treasure — logique du site (chaîne + service de réponses)
// =====================================================================
import CONFIG from './config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from '../../loto/js/chain.js';
import * as L from '../../loto/js/lotomath.js';
import { startVegas } from '../../vegas.js';
import { verify, answerAt, SIZE, CELLS } from './board.mjs';

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
  info: null, cfg: null, st: null, grid: null, digs: [], answers: new Map(), pending: new Set(),
  past: new Map(), busy: false,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => `${Number(n).toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const ase = (w, d) => L.fmtAse(BigInt(w), d ?? (BigInt(w) % L.WEI === 0n ? 0 : 3)).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
// Heures affichées en UTC
const utcDay = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const utcTime = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';
const ICON = { T: '💰', H: '🔥', C: '❄️' };
const NAME = { T: 'the treasure', H: 'hot', C: 'cold' };
const coord = (c) => `${String.fromCharCode(65 + (c % SIZE))}${Math.floor(c / SIZE) + 1}`;

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
function confetti(n = 110) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti'), colors = ['#F6C25C', '#F8D4A4', '#F09A58', '#FFFFFF', '#FFE68A'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x', (Math.random() * 200 - 100) + 'px');
    c.style.setProperty('--r', (360 + Math.random() * 720) + 'deg');
    c.style.setProperty('--d', (1.2 + Math.random() * 1.4) + 's');
    box.append(c); setTimeout(() => c.remove(), 3500);
  }
}

// ------------------------------------------------------------- réponses (service + preuve)
async function fetchAnswers(grid, cells, all = false) {
  if (S.demo) return S.demo.answers(grid, all ? Array.from({ length: CELLS }, (_, i) => i) : cells);
  const u = new URL(CONFIG.API, location.href);
  u.searchParams.set('grid', grid);
  if (all) u.searchParams.set('all', '1'); else u.searchParams.set('cells', cells.join(','));
  const r = await fetch(u, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'answer service unavailable (HTTP ' + r.status + ')');
  return j;
}
// Ajoute des réponses vérifiées (preuve contre la racine du contrat) pour la grille g.
async function loadAnswers(g, cells) {
  const want = cells.filter((c) => !S.answers.has(c));
  if (!want.length) return [];
  const j = await fetchAnswers(g.id, want);
  const got = [];
  for (const a of j.answers || []) {
    if (!verify(g.root, g.id, a.cell, a.ans, a.salt, a.proof)) { toast(`Answer for ${coord(a.cell)} does not match the map fingerprint!`, 'err', 0); continue; }
    S.answers.set(a.cell, a); got.push(a);
  }
  return got;
}

// ------------------------------------------------------------- lectures
const view = (m, a = []) => S.rpc.view(S.contract, m, a);
async function loadDigs(g) {
  const out = [];
  for (let k = 0; k < g.digs; k += 400) out.push(...(await view('getDigs', [g.id, k, Math.min(400, g.digs - k)])));
  return out;
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [info, cfg, st] = await Promise.all([view('info'), view('getConfig'), view('getState')]);
    S.info = info; S.cfg = cfg; S.st = st;
    const g = st.cur ? await view('getGrid', [st.cur]) : null;
    if (!S.grid || !g || g.id !== S.grid.id) { S.answers = new Map(); S.pending.clear(); }
    S.grid = g;
    if (g) {
      S.digs = await loadDigs(g);
      const missing = S.digs.map((d) => d.c).filter((c) => !S.answers.has(c));
      if (missing.length) await loadAnswers(g, missing).catch((e) => console.warn(e));
    } else S.digs = [];
    for (let id = st.cur - 1; id >= Math.max(1, st.cur - CONFIG.HISTORY); id--) if (!S.past.has(id)) { const p = await view('getGrid', [id]); if (p) S.past.set(id, p); }
    if (S.wallet) S.balance = await S.rpc.balance(S.wallet.address).catch(() => S.balance);
    renderAll();
  } catch (e) { console.error(e); toast('Could not read the chain: ' + cleanError(e), 'err', 8000); }
  finally { refreshing = false; }
}

// ------------------------------------------------------------- en-tête
function myDigs() { return S.wallet ? S.digs.filter((d) => d.b === S.wallet.address) : []; }
function renderHero() {
  const i = S.info, g = S.grid; if (!i) return;
  $('#pot').textContent = g && g.status === 'found' ? ase(g.prize, 2) : ase(i.pot, 2);
  $('#potLabel').textContent = g && g.status === 'found' ? `Map #${g.id}: treasure found!` : 'Treasure to find';
  $('#gridWhen').textContent = !g ? 'The first map opens in a few minutes.'
    : g.status === 'open' ? `Map #${g.id}, opened ${utcDay(g.openTs)} at ${utcTime(g.openTs)}. The treasure grows with every dig.` + (BigInt(g.carryIn || '0') > 0n ? ` Includes ${ase(g.carryIn)} ASE carried over from map #${g.id - 1}.` : '')
    : g.status === 'found' ? `Found by ${L.shortAddr(g.winner)} after ${plural(g.t + 1, 'dig', 'digs')}. A new map opens in a few minutes.`
    : 'A new map opens in a few minutes.';
  $('#digs').textContent = g ? g.digs : '–';
  $('#players').textContent = g ? g.wallets : '–';
  $('#left').textContent = S.wallet && S.cfg ? Math.max(0, S.cfg.maxPerWallet - myDigs().length) : '–';
  $('#pausedBanner').hidden = !i.paused;
  // Dernière fouille du joueur : rappel de la réponse
  const lastMine = myDigs().filter((d) => S.answers.has(d.c)).at(-1), ld = $('#lastDig');
  ld.hidden = !lastMine || !g || g.status !== 'open';
  if (lastMine) {
    const a = S.answers.get(lastMine.c);
    ld.className = 'lastdig ' + (a.ans === 'H' ? 'hot' : a.ans === 'T' ? 'tr' : 'cold');
    ld.innerHTML = `<span class="ld-cell">${coord(lastMine.c)}</span><span>Your last dig at ${coord(lastMine.c)} is <strong>${NAME[a.ans]}</strong>${a.ans === 'H' ? ': the treasure is within 3 cells. Dig around it!' : a.ans === 'C' ? ': the treasure is more than 3 cells away.' : '!'}</span>`;
  }
  const fb = $('#foundBanner');
  const t = [...S.answers.values()].find((a) => a.ans === 'T');
  if (g && g.status === 'open' && t && S.wallet && S.digs.some((d) => d.c === t.cell && d.b === S.wallet.address)) {
    fb.hidden = false;
    const k = S.digs.findIndex((d) => d.c === t.cell), net = BigInt(g.price) - (BigInt(g.price) * 1500n) / 10000n;
    fb.innerHTML = `<span>💰 You found the treasure! ${ase(BigInt(g.carryIn || '0') + net * BigInt(k + 1))} ASE are waiting for you.</span><button class="btn btn-primary" id="claimBtn">Claim the treasure</button>`;
    $('#claimBtn').onclick = () => claimTreasure(t);
  } else if (g && g.status === 'found' && S.wallet && g.winner === S.wallet.address) {
    fb.hidden = false; fb.innerHTML = `<span>💰 You found the treasure of map #${g.id}: ${ase(g.prize)} ASE sent to your wallet.</span>`;
  } else fb.hidden = true;
}

// ------------------------------------------------------------- la carte
function buildMap() {
  const m = $('#map');
  const frag = document.createDocumentFragment();
  for (let c = 0; c < CELLS; c++) {
    const b = document.createElement('button');
    b.className = 'cell'; b.dataset.c = c; b.type = 'button';
    b.setAttribute('aria-label', 'Cell ' + coord(c));
    frag.append(b);
  }
  m.append(frag);
  m.addEventListener('click', (e) => { const b = e.target.closest('.cell'); if (b) dig(Number(b.dataset.c)); });
}
function renderMap() {
  const g = S.grid, open = g && g.status === 'open' && !(S.info && S.info.paused);
  const mine = new Set(myDigs().map((d) => d.c));
  const dug = new Set(S.digs.map((d) => d.c));
  $('#map').classList.toggle('locked', !open);
  $$('#map .cell').forEach((b) => {
    const c = Number(b.dataset.c), a = S.answers.get(c), p = S.pending.has(c);
    const cls = ['cell'];
    if (p) cls.push('pending');
    if (a) cls.push('dug', a.ans === 'T' ? 'treasure' : a.ans === 'H' ? 'hot' : 'cold');
    else if (dug.has(c)) cls.push('dug');
    if (mine.has(c)) cls.push('mine');
    if (b.dataset.reveal === '1') { cls.push('reveal'); delete b.dataset.reveal; }
    b.className = cls.join(' ');
    b.textContent = a && !p ? ICON[a.ans] : '';
    b.disabled = !open || dug.has(c) || p;
    b.title = a ? `${coord(c)}: ${NAME[a.ans]}` : dug.has(c) ? `${coord(c)}: dug, answer loading…` : `${coord(c)}: dig for ${S.cfg ? ase(S.cfg.price) : '0.5'} ASE`;
  });
  const hot = [...S.answers.values()].filter((a) => a.ans === 'H').length;
  $('#mapStatus').textContent = g ? `Map #${g.id} · ${plural(g.digs, 'dig', 'digs')} · ${hot} 🔥` : '20 × 20';
}

// ------------------------------------------------------------- fouiller
async function sendTx(method, args, value = 0n) {
  const t1 = toast(S.wallet.kind === 'telegram' ? 'Approve the transaction in Telegram…' : 'Approve the transaction in your wallet…', '', 0);
  try {
    const hash = await S.wallet.call(S.contract, method, args, value);
    t1.textContent = 'Digging… (waiting for the network, usually 10 to 60 s)';
    const rc = await S.rpc.waitReceipt(hash);
    t1.remove();
    if (!rc.success) throw new Error(rc.error || 'rejected by the contract');
    document.dispatchEvent(new Event('asevegas:refresh-wins'));   // le bouton « My wins » se met à jour
    return rc;
  } catch (e) { t1.remove(); toast('Failed: ' + cleanError(e), 'err', 10000); return null; }
}
async function dig(cell) {
  if (!S.wallet) return openWallet();
  const g = S.grid;
  if (!g || g.status !== 'open' || S.pending.has(cell)) return;
  if (myDigs().length + S.pending.size >= S.cfg.maxPerWallet) return toast(`You already used your ${S.cfg.maxPerWallet} digs on this map. Wait for the next one!`, 'err');
  const price = BigInt(g.price);
  if (S.balance !== null && S.balance < price) return toast(`Insufficient balance: you need ${ase(price)} ASE plus a little gas.`, 'err');
  S.pending.add(cell); renderMap();
  const rc = await sendTx('dig', [g.id, cell], price);
  if (!rc) { S.pending.delete(cell); renderMap(); return; }
  // Réponse : on la demande au service dès la confirmation (quelques essais si le nœud est en retard)
  let a = null;
  for (let k = 0; k < 8 && !a; k++) {
    try { const got = await loadAnswers(g, [cell]); a = got[0] || S.answers.get(cell); } catch (e) { console.warn(e); }
    if (!a) await sleep(1500);
  }
  S.pending.delete(cell);
  const b = $(`#map .cell[data-c="${cell}"]`); if (b) b.dataset.reveal = '1';
  if (!a) { toast('Dig confirmed. The answer is on its way, it will show up in a moment.', '', 8000); await refresh(); return; }
  S.digs.push({ idx: -1, b: S.wallet.address, c: cell, paid: false });
  renderAll();
  if (a.ans === 'T') { confetti(); toast(`💰 ${coord(cell)}: YOU FOUND THE TREASURE!`, 'ok', 0); claimTreasure(a); }
  else toast(`${ICON[a.ans]} ${coord(cell)}: ${a.ans === 'H' ? 'hot! The treasure is within 3 cells.' : 'cold. The treasure is further away.'}`, a.ans === 'H' ? 'ok' : '', 7000);
  refresh();
}
async function claimTreasure(a) {
  const rc = await sendTx('claim', [S.grid.id, a.cell, a.salt, a.proof]);
  if (rc) { toast(`💰 Treasure sent to your wallet!`, 'ok', 10000); confetti(); }
  else toast('The game will send you the treasure automatically within a few minutes.', '', 10000);
  await refresh();
}

// ------------------------------------------------------------- mes fouilles, historique
function renderMine() {
  const box = $('#mineBody');
  if (!S.wallet) { box.innerHTML = '<p class="muted">Connect your wallet to see your digs.</p>'; return; }
  const mine = myDigs();
  let html = mine.length
    ? '<ol class="winners">' + mine.map((d) => { const a = S.answers.get(d.c); return `<li><span class="stub">${coord(d.c)}</span>${a ? `${ICON[a.ans]} ${NAME[a.ans]}` : '<span class="muted">answer loading…</span>'}</li>`; }).join('') + '</ol>'
    : `<p class="muted">No dig yet on this map. Click a cell on the map: ${S.cfg ? ase(S.cfg.price) : '0.5'} ASE per dig, ${S.cfg ? S.cfg.maxPerWallet : 5} digs per map.</p>`;
  const wins = [...S.past.values(), S.grid].filter((g) => g && g.status === 'found' && g.winner === S.wallet.address);
  if (wins.length) html += '<h3>Your treasures</h3><ol class="winners">' + wins.map((g) => `<li>💰 Map #${g.id}<span class="muted small">${utcDay(g.endTs)}</span><span class="amount">${ase(g.prize)} ASE</span></li>`).join('') + '</ol>';
  box.innerHTML = html;
}
function renderResults() {
  const rows = [...S.past.values()].filter((g) => g.status !== 'open').sort((a, b) => b.id - a.id);
  if (!rows.length) { $('#resultsBody').innerHTML = '<p class="muted">No finished map yet.</p>'; return; }
  $('#resultsBody').innerHTML = rows.map((g) => g.status === 'cancelled'
    ? `<div class="past"><div><h3>Map #${g.id}</h3><span class="tag warn">Cancelled, digs refunded</span></div></div>`
    : `<div class="past"><div class="mini" data-mini="${g.id}">${'<i></i>'.repeat(CELLS)}</div><div><h3>Map #${g.id}</h3>
       <p class="muted small">${utcDay(g.endTs)} · found at ${coord(g.cell)} after ${plural(g.t + 1, 'dig', 'digs')}</p>
       <p>💰 ${esc(L.shortAddr(g.winner))} won <strong>${ase(g.prize)} ASE</strong></p>${BigInt(g.carryOut || '0') > 0n ? `<p class="muted small">Digs made after the treasure: ${ase(g.carryOut)} ASE carried over to map #${g.id + 1}.</p>` : ''}<button class="link-btn" data-verify="${g.id}">Verify</button></div></div>`).join('');
  $$('[data-verify]').forEach((b) => (b.onclick = () => verifyGrid(Number(b.dataset.verify))));
  rows.forEach((g) => { if (g.status === 'found') drawMini(g); });
}
const minis = new Map();
async function drawMini(g) {
  const el = $(`[data-mini="${g.id}"]`); if (!el) return;
  try {
    if (!minis.has(g.id)) {
      const digs = await (async () => { const out = []; for (let k = 0; k < g.digs; k += 400) out.push(...(await view('getDigs', [g.id, k, Math.min(400, g.digs - k)]))); return out; })();
      minis.set(g.id, { dug: new Set(digs.map((d) => d.c)), treasure: g.cell });
    }
    const m = minis.get(g.id);
    [...el.children].forEach((i, c) => { i.className = c === m.treasure ? 't' : m.dug.has(c) ? (answerAt(c, m.treasure) === 'H' ? 'h' : 'c') : ''; });
  } catch {}
}
async function verifyGrid(id) {
  const body = $('#verifyBody');
  body.innerHTML = '<p class="muted">Checking the whole map in your browser…</p>';
  $('#dlgVerify').showModal();
  try {
    const g = await view('getGrid', [id]);
    const j = await fetchAnswers(id, [], true);
    const steps = [];
    const step = (ok, title, detail) => steps.push(`<div class="verify-step"><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><div><strong>${title}</strong><br><span class="small">${detail}</span></div></div>`);
    const all = j.answers || [];
    const proofs = all.filter((a) => verify(g.root, id, a.cell, a.ans, a.salt, a.proof)).length;
    step(all.length === CELLS && proofs === CELLS, 'All 400 answers match the fingerprint', `Fingerprint stored before the first dig: <code>${g.root.slice(0, 24)}…</code>`);
    const ts = all.filter((a) => a.ans === 'T');
    step(ts.length === 1 && ts[0].cell === g.cell, 'Exactly one treasure', ts.length === 1 ? `At ${coord(ts[0].cell)}, the cell the contract paid for` : `${ts.length} treasure cells`);
    const coherent = ts.length === 1 && all.every((a) => a.ans === answerAt(a.cell, ts[0].cell));
    step(coherent, 'Hot and cold are consistent', 'Every “hot” cell is within 3 cells of the treasure, every “cold” cell is further away');
    body.innerHTML = steps.join('') + '<p class="small muted" style="margin-top:12px">Nobody could move the treasure or change an answer once the map was opened.</p>';
  } catch (e) { body.innerHTML = `<p class="error">Verification failed: ${esc(cleanError(e))}</p>`; }
}

// ------------------------------------------------------------- admin
function stat(label, value) { return `<dl class="stat"><dt>${label}</dt><dd>${value}</dd></dl>`; }
function setIfIdle(sel, v) { const e = $(sel); if (e && !e.dataset.touched && document.activeElement !== e) e.value = v; }
function renderAdmin() {
  const isAdmin = S.wallet && S.cfg && S.wallet.address === S.cfg.admin;
  $('#adminTab').hidden = !isAdmin;
  if (!isAdmin) return;
  const t = S.st.tot;
  $('#adminStats').innerHTML = [stat('Total digs', t.digs.toLocaleString('en-GB')), stat('Volume', ase(t.sales, 2) + ' ASE'), stat('Commissions', ase(t.commission, 3) + ' ASE'), stat('Treasures found', t.grids)].join('');
  $('#pauseState').textContent = S.cfg.paused ? 'The game is paused.' : 'The game is open.';
  $('#pauseBtn').textContent = S.cfg.paused ? 'Resume' : 'Pause';
  setIfIdle('#fCfg [name=price]', L.fmtAse(BigInt(S.cfg.price), 3).replace(/,/g, ''));
  setIfIdle('#fCfg [name=w]', S.cfg.maxPerWallet);
}
$$('.admin-box input').forEach((i) => i.addEventListener('input', () => (i.dataset.touched = '1')));
function adminForm(sel, fn) {
  $(sel).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const [label, method, args] = fn(new FormData(e.target)); if (await sendTx(method, args)) { toast(label + ' ✓', 'ok'); e.target.querySelectorAll('input').forEach((i) => delete i.dataset.touched); await refresh(); } } catch (err) { toast(cleanError(err), 'err'); }
  });
}
adminForm('#fPause', () => [S.cfg.paused ? 'Game resumed' : 'Game paused', 'setPaused', [!S.cfg.paused]]);
adminForm('#fCfg', (f) => ['Settings saved', 'setConfig', [L.parseAse(f.get('price')).toString(), Number(f.get('w'))]]);


// ------------------------------------------------------------- onglets, wallet
function selectTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
}
$$('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
function renderWallet() {
  $('#walletBtn').textContent = S.wallet ? `${L.shortAddr(S.wallet.address)}${S.balance !== null ? ' · ' + L.fmtAse(S.balance) + ' ASE' : ''}` : 'Connect wallet';
}
let pairing = false, pairTimer = null;
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
  const saved = store.get('loto.wallet', null);   // même wallet que sur les autres jeux
  if (!saved) return;
  if (saved.kind === 'extension') {
    for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await sleep(200);
    if (!ExtensionWallet.available()) return;
    const w = new ExtensionWallet(); if (await w.restore()) S.wallet = w;
  } else if (saved.kind === 'telegram') { const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME); if (await w.restore(saved.session)) S.wallet = w; }
}
function renderRulesValues() {
  if (!S.cfg) return;
  $$('.js-price').forEach((e) => (e.textContent = ase(S.grid ? S.grid.price : S.cfg.price) + ' ASE'));
  $$('.js-max').forEach((e) => (e.textContent = S.cfg.maxPerWallet));
  $$('.js-grow').forEach((e) => (e.textContent = ase((BigInt(S.grid ? S.grid.price : S.cfg.price) * 85n) / 100n) + ' ASE'));
}
function renderAll() { renderWallet(); renderHero(); renderMap(); renderMine(); renderResults(); renderAdmin(); renderRulesValues(); }

(async function start() {
  startVegas();
  buildMap();
  const wantDemo = !CONFIG.CONTRACT || new URLSearchParams(location.search).has('demo');
  if (wantDemo) {
    const { startDemo } = await import('./demo.js');
    S.demo = await startDemo(new URL('contrat/tresor.js', document.baseURI));
    S.rpc = S.demo.rpc; S.contract = S.demo.contractAddress; S.wallet = S.demo.wallet;
    $('#demoBar').hidden = false;
  } else {
    S.rpc = new Rpc(CONFIG.RPC); S.contract = CONFIG.CONTRACT; await restoreWallet();
  }
  const link = $('#contractLink');
  link.textContent = S.demo ? 'local demo' : L.shortAddr(S.contract);
  if (!S.demo) link.href = `${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}`;
  $('#rpcLabel').textContent = S.rpc.url;
  await refresh();
  setInterval(refresh, S.demo ? 3000 : 8000);
})();
