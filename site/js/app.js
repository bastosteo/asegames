// =====================================================================
//  Loto ASE — logique du site (aucun serveur : tout est lu sur la chaîne)
// =====================================================================
import CONFIG from './config.js';
import { Rpc, ExtensionWallet, TelegramWallet } from './chain.js';
import * as L from './lotomath.js';

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
  selected: new Set(), cart: store.get('loto.cart', []),
  busy: false, lastAnnounced: store.get('loto.lastAnnounced', 0),
};
const chainNow = () => Date.now() + S.clockOffset;
const ballHtml = (n, cls = '') => `<span class="ball ${cls}">${n}</span>`;
const parisTime = (ms) => new Date(Number(ms)).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
const parisDay = (ms) => new Date(Number(ms)).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const plural = (n, one, many) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

// ------------------------------------------------------------- thème
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(store.get('asegame.theme', null));
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : !matchMedia('(prefers-color-scheme: light)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next); store.set('asegame.theme', next);
};

// ------------------------------------------------------------- notifications
function toast(text, kind = '', ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
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
    toast('Lecture impossible : ' + cleanError(e), 'err', 8000);
  }
}

// ------------------------------------------------------------- rendu : hero
function renderHero() {
  const i = S.info; if (!i) return;
  $('#jackpot').textContent = L.fmtAse(i.jackpotEstimate, 0);
  const closing = i.status === 'closing';
  const price = BigInt(closing ? S.cfg.price : i.price);
  $('#priceLabel').textContent = L.fmtAse(price, price % L.WEI === 0n ? 0 : 2) + ' ASE';
  $('#gridsPlayed').textContent = i.grids.toLocaleString('fr-FR');
  $('#drawWhen').textContent = `Tirage n°${i.round}, ${parisDay(i.drawTs)} à ${parisTime(i.drawTs)}`;
  $('#pausedBanner').hidden = !i.paused;
  const last = [...S.rounds.values()].filter((r) => r.status === 'done').sort((a, b) => b.id - a.id)[0];
  if (last) {
    $('#lastDraw').hidden = false;
    $('#lastDrawId').textContent = `n°${last.id}, ${parisDay(last.drawTs)}`;
    const box = $('#lastBalls');
    const html = last.nums.map((n) => ballHtml(n, 'gold')).join('');
    if (box.dataset.id !== String(last.id)) { box.innerHTML = html; box.dataset.id = last.id; box.classList.remove('reveal'); void box.offsetWidth; box.classList.add('reveal'); }
    $('#lastVerify').onclick = () => verifyRound(last.id);
    if (last.cnt[2] > 0 && S.lastAnnounced < last.id) {
      S.lastAnnounced = last.id; store.set('loto.lastAnnounced', last.id);
      toast(`Jackpot remporté au tirage n°${last.id} : ${L.fmtAse(BigInt(last.per[2]) * BigInt(last.cnt[2]), 0)} ASE !`, 'ok', 12000);
    }
  }
  tickCountdown();
}
function tickCountdown() {
  const i = S.info; if (!i) return;
  const now = chainNow();
  const close = Number(i.closeTs);
  let label, target;
  if (now < close) { label = 'Fin des ventes dans'; target = close; }
  else { label = 'Tirage en cours'; target = null; }
  $('#countdownLabel').textContent = label;
  if (target) {
    const s = Math.max(0, Math.floor((target - now) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    $('#countdown').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  } else $('#countdown').textContent = 'Résultats bientôt';
}
setInterval(tickCountdown, 1000);

// ------------------------------------------------------------- grille et panier
function buildGrid() {
  const g = $('#grid18');
  g.innerHTML = '';
  for (let n = 1; n <= L.MAXN; n++) {
    const b = document.createElement('button');
    b.className = 'ball'; b.type = 'button'; b.textContent = n;
    b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Numéro ' + n);
    b.onclick = () => {
      if (S.selected.has(n)) S.selected.delete(n);
      else if (S.selected.size < L.PICK) S.selected.add(n);
      renderPicker();
    };
    g.append(b);
  }
}
function renderPicker() {
  const full = S.selected.size >= L.PICK;
  $$('#grid18 .ball').forEach((b, i) => {
    const on = S.selected.has(i + 1);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = full && !on;
  });
  $('#pickCount').textContent = `${S.selected.size} sur ${L.PICK}`;
  $('#addBtn').disabled = !full;
}
function addToCart(grid) {
  if (S.cart.length >= 200) { toast('Panier plein (200 grilles).', 'err'); return; }
  S.cart.push(grid); store.set('loto.cart', S.cart); renderCart();
}
$('#flashBtn').onclick = () => { S.selected = new Set(L.flashGrid()); renderPicker(); };
$('#clearBtn').onclick = () => { S.selected.clear(); renderPicker(); };
$('#addBtn').onclick = () => { addToCart([...S.selected].sort((a, b) => a - b)); S.selected.clear(); renderPicker(); };
$$('[data-flash]').forEach((b) => (b.onclick = () => { for (let k = 0; k < Number(b.dataset.flash); k++) addToCart(L.flashGrid()); }));

function currentPrice() { return S.info ? BigInt(S.info.status === 'closing' ? S.cfg.price : S.info.price) : 2n * L.WEI; }
function renderCart() {
  const list = $('#cartList');
  list.innerHTML = S.cart.map((g, i) => `<li><span class="idx">${i + 1}</span><span class="balls tiny">${g.map((n) => ballHtml(n)).join('')}</span><button class="rm" data-rm="${i}" aria-label="Retirer la grille ${i + 1}">×</button></li>`).join('');
  list.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { S.cart.splice(Number(b.dataset.rm), 1); store.set('loto.cart', S.cart); renderCart(); }));
  $('#cartEmpty').hidden = S.cart.length > 0;
  const n = S.cart.length, cost = currentPrice() * BigInt(n);
  $('#cartCount').textContent = plural(n, 'grille', 'grilles');
  $('#cartSum').textContent = L.fmtAse(cost, cost % L.WEI === 0n ? 0 : 2) + ' ASE';
  const btn = $('#playBtn');
  const max = S.cfg ? S.cfg.maxGrids : 20;
  const txs = Math.ceil(n / max);
  if (!S.wallet) { btn.textContent = 'Connecter mon wallet pour jouer'; btn.disabled = false; }
  else { btn.textContent = n ? `Jouer ${plural(n, 'grille', 'grilles')} (${L.fmtAse(cost, cost % L.WEI === 0n ? 0 : 2)} ASE)` : 'Valider mes grilles'; btn.disabled = !n || S.busy || (S.info && S.info.paused); }
  $('#cartNote').textContent = txs > 1 ? `Plus de ${max} grilles : ${txs} transactions à valider, l'une après l'autre.` : 'Une seule transaction pour tout le panier.';
}

$('#playBtn').onclick = async () => {
  if (!S.wallet) return openWallet();
  if (!S.cart.length || S.busy) return;
  const price = currentPrice();
  const total = price * BigInt(S.cart.length);
  if (S.balance !== null && S.balance < total) { toast(`Solde insuffisant : il faut ${L.fmtAse(total)} ASE plus un peu de gas.`, 'err'); return; }
  const max = S.cfg.maxGrids;
  const chunks = []; for (let i = 0; i < S.cart.length; i += max) chunks.push(S.cart.slice(i, i + max));
  for (let k = 0; k < chunks.length; k++) {
    const part = chunks.length > 1 ? ` (${k + 1}/${chunks.length})` : '';
    const ok = await sendTx(`${plural(chunks[k].length, 'grille enregistrée', 'grilles enregistrées')}${part}`, 'buy', [chunks[k], L.randomSeedHex()], price * BigInt(chunks[k].length));
    if (!ok) return;
    S.cart = S.cart.slice(chunks[k].length); store.set('loto.cart', S.cart); renderCart();
  }
  selectTab('mine');
};

// ------------------------------------------------------------- transactions
async function sendTx(doneLabel, method, args, value = 0n) {
  S.busy = true; renderCart();
  const t1 = toast(S.wallet.kind === 'telegram' ? 'Valide la transaction dans Telegram…' : 'Valide la transaction dans ton wallet…', '', 0);
  try {
    const hash = await S.wallet.call(S.contract, method, args, value);
    t1.textContent = 'Transaction envoyée, confirmation en cours (souvent 10 à 60 s)…';
    const rc = await S.rpc.waitReceipt(hash);
    t1.remove();
    if (!rc.success) throw new Error(rc.error || 'refusée par le contrat');
    toast(doneLabel + ' ✓', 'ok');
    await refresh();
    return true;
  } catch (e) {
    t1.remove();
    toast('Échec : ' + cleanError(e), 'err', 10000);
    return false;
  } finally { S.busy = false; renderCart(); }
}

// ------------------------------------------------------------- mes grilles
function renderMine() {
  const box = $('#mineBody');
  if (!S.wallet) { box.innerHTML = '<p class="muted">Connecte ton wallet pour voir tes grilles.</p>'; return; }
  const me = S.wallet.address;
  const ids = [...S.rounds.keys()].sort((a, b) => b - a);
  let html = '';
  for (const id of ids) {
    const r = S.rounds.get(id);
    const mine = (S.purchases.get(id) || []).filter((p) => p.b === me);
    if (!mine.length) continue;
    const drawn = r.status === 'done' ? r.nums : null;
    let tag = '<span class="tag">En attente du tirage</span>';
    if (r.status === 'done') tag = `<span class="tag">Tiré : </span><span class="balls tiny">${r.nums.map((n) => ballHtml(n, 'gold')).join('')}</span>`;
    if (r.status === 'cancelled') tag = '<span class="tag warn">Tirage annulé : remboursé à 100 %</span>';
    html += `<div class="round-block"><div class="round-head"><h3>Tirage n°${id}</h3><span class="muted small">${parisDay(r.drawTs)}</span>${tag}</div>`;
    for (const p of mine) {
      const grids = p.g.map((g) => {
        const k = drawn ? L.matches(g, drawn) : 0;
        return `<div class="balls small" aria-label="Grille ${g.join(' ')}${drawn ? ', ' + k + ' bons numéros' : ''}">${g.map((n) => ballHtml(n, drawn ? (drawn.includes(n) ? 'gold' : 'dim') : '')).join('')}</div>`;
      }).join('');
      let right = '';
      if (r.status === 'done') {
        const prize = BigInt(p.prize);
        if (prize > 0n) right = p.paid ? `<span class="tag ok">Payé</span><span class="amount">+${L.fmtAse(prize)} ASE</span>` : `<span class="amount">+${L.fmtAse(prize)} ASE</span><button class="btn btn-primary btn-small" data-claim="${id}:${p.idx}">Réclamer</button>`;
        else right = '<span class="muted small">Pas de gain</span>';
      } else if (r.status === 'cancelled') {
        right = p.paid ? '<span class="tag ok">Remboursé</span>' : `<button class="btn btn-small" data-refund="${id}:${p.idx}">Me faire rembourser</button>`;
      } else right = `<span class="muted small">${plural(p.g.length, 'grille', 'grilles')}</span>`;
      html += `<div class="ticket"><div class="grids">${grids}</div><div class="right">${right}</div></div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html || '<p class="muted">Tu n\'as pas encore joué sur les derniers tirages. Choisis tes numéros juste au-dessus.</p>';
  box.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = () => { const [id, i] = b.dataset.claim.split(':').map(Number); sendTx('Gain reçu', 'claim', [id, i]); }));
  box.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = () => { const [id, i] = b.dataset.refund.split(':').map(Number); sendTx('Remboursement reçu', 'claim', [id, i]); }));
}

// ------------------------------------------------------------- résultats
function renderResults() {
  const rows = [...S.rounds.values()].filter((r) => ['done', 'cancelled'].includes(r.status)).sort((a, b) => b.id - a.id);
  if (!rows.length) { $('#resultsBody').innerHTML = '<p class="muted">Aucun tirage terminé pour l\'instant. Le premier a lieu à l\'heure indiquée en haut de la page.</p>'; return; }
  const winCell = (r, k) => (r.cnt[k] ? `${r.cnt[k]} × ${L.fmtAse(r.per[k])}` : '<span class="muted">reporté</span>');
  $('#resultsBody').innerHTML = `<div style="overflow-x:auto"><table class="res-table">
    <thead><tr><th scope="col">Tirage</th><th scope="col">Numéros</th><th scope="col" class="num">Grilles</th><th scope="col" class="num">5 bons</th><th scope="col" class="num">4 bons</th><th scope="col" class="num">3 bons</th><th scope="col" class="num">Report</th><th scope="col"></th></tr></thead>
    <tbody>${rows.map((r) => r.status === 'cancelled'
      ? `<tr><td>n°${r.id}<br><span class="muted small">${parisDay(r.drawTs)}</span></td><td colspan="6"><span class="tag warn">Annulé, joueurs remboursés</span></td><td></td></tr>`
      : `<tr><td>n°${r.id}<br><span class="muted small">${parisDay(r.drawTs)}</span></td><td><span class="balls tiny">${r.nums.map((n) => ballHtml(n, 'gold')).join('')}</span></td><td class="num">${r.grids}</td><td class="num">${winCell(r, 2)}</td><td class="num">${winCell(r, 1)}</td><td class="num">${winCell(r, 0)}</td><td class="num">${L.fmtAse(r.carryOut, 0)}</td><td><button class="link-btn" data-verify="${r.id}">Vérifier</button></td></tr>`).join('')}
    </tbody></table></div><p class="muted small">Montants en ASE, par grille gagnante. « Report » = montant qui part dans le jackpot suivant.</p>`;
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
  const who = (a) => (a === me ? '<strong>toi</strong>' : esc(L.shortAddr(a)));
  $('#rankWins').innerHTML = wins.slice(0, 10).map((w) => `<li><strong>${L.fmtAse(w.prize)} ASE</strong> <span>par</span> ${who(w.b)} <span>(tirage n°${w.id})</span></li>`).join('') || '<li class="muted">Pas encore de gain.</li>';
  $('#rankGrids').innerHTML = [...grids].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a, n]) => `<li>${who(a)} <span>avec</span> <strong>${n}</strong> <span>${n > 1 ? 'grilles' : 'grille'}</span></li>`).join('') || '<li class="muted">Personne n\'a encore joué.</li>';
  $('#rankScope').textContent = `Sur les ${S.rounds.size} derniers tirages.`;
}

// ------------------------------------------------------------- vérification
async function verifyRound(id) {
  const dlg = $('#dlgVerify'), body = $('#verifyBody');
  body.innerHTML = '<p class="muted">Recalcul en cours dans ton navigateur…</p>';
  dlg.showModal();
  try {
    const r = await loadRound(id, true);
    const list = await loadPurchases(id);
    const steps = [];
    const step = (ok, title, detail) => steps.push(`<div class="verify-step"><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><div><strong>${title}</strong><br><span class="small">${detail}</span></div></div>`);
    // 1) Empreinte des grilles
    let d = L.initialDigest(id);
    list.forEach((p) => { d = L.nextDigest(d, p.b, p.g, p.s || '', p.idx); });
    step(d === r.digest, 'Empreinte des grilles', `Recalculée à partir des ${list.length} achats : <code>${d.slice(0, 24)}…</code>`);
    // 2) Chaînes de secrets
    const chainCheck = (sec, key) => {
      const prev = [...S.rounds.values()].filter((x) => x.id < id && x[key]).sort((a, b) => b.id - a.id)[0];
      if (!prev) return [true, 'premier secret visible ici (les tirages plus anciens ne sont pas chargés)'];
      let h = sec;
      for (let k = 1; k <= 30; k++) { h = L.sha256Hex(h); if (h === prev[key]) return [true, `SHA-256${k > 1 ? ' ×' + k : ''} de ce secret = secret du tirage n°${prev.id}`]; }
      return [false, 'ne prolonge pas la chaîne du tirage n°' + prev.id];
    };
    const [o1, o2] = chainCheck(r.sO, 'sO'), [c1, c2] = chainCheck(r.sC, 'sC');
    step(o1, 'Secret de l\'opérateur', `<code>${r.sO}</code><br>${o2}`);
    step(c1, 'Secret du collaborateur', `<code>${r.sC}</code><br>${c2}`);
    // 3) Numéros
    const nums = L.drawNumbers(id, r.sO, r.sC, d);
    step(JSON.stringify(nums) === JSON.stringify(r.nums), 'Numéros tirés', `SHA-256("LOTOASE|${id}|secret opérateur|secret collaborateur|empreinte") donne <span class="balls tiny" style="display:inline-flex;vertical-align:middle">${nums.map((n) => ballHtml(n, 'gold')).join('')}</span>`);
    // 4) Gagnants
    const cnt = [0, 0, 0];
    for (const p of list) for (const g of p.g) { const k = L.matches(g, nums); if (k >= 3) cnt[k - 3]++; }
    step(JSON.stringify(cnt) === JSON.stringify(r.cnt), 'Nombre de gagnants', `5 bons : ${cnt[2]}, 4 bons : ${cnt[1]}, 3 bons : ${cnt[0]}`);
    // 5) Répartition
    const Sales = BigInt(r.sales), C = (Sales * 500n) / 10000n;
    const pools = [(Sales * 3500n) / 10000n, (Sales * 2000n) / 10000n];
    pools.push(Sales - C - pools[0] - pools[1] + BigInt(r.jackpotIn));
    const per = pools.map((p, k) => (cnt[k] ? p / BigInt(cnt[k]) : 0n));
    step(per.every((x, k) => x.toString() === r.per[k]) && C.toString() === r.commission, 'Répartition des gains', `Commission ${L.fmtAse(C)} ASE (5 %). Gain par grille : 5 bons ${L.fmtAse(per[2])}, 4 bons ${L.fmtAse(per[1])}, 3 bons ${L.fmtAse(per[0])} ASE.`);
    body.innerHTML = steps.join('') + `<p class="small muted" style="margin-top:12px">Tout est recalculé ici, dans ton navigateur, à partir des données publiques du contrat. <a href="${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}" target="_blank" rel="noopener">Code source du contrat</a>.</p>`;
  } catch (e) { body.innerHTML = `<p class="error">Vérification impossible : ${esc(cleanError(e))}</p>`; }
}

// ------------------------------------------------------------- admin
function renderAdmin() {
  const isAdmin = S.wallet && S.cfg && S.wallet.address === S.cfg.admin;
  $('#adminTab').hidden = !isAdmin;
  if (!isAdmin) { if ($('#adminTab').getAttribute('aria-selected') === 'true') selectTab('mine'); return; }
  const players = new Set(); for (const l of S.purchases.values()) for (const p of l) players.add(p.b);
  const now = chainNow();
  let croupier = 'En attente du prochain tirage', alert = false;
  const pend = S.rounds.get(S.st.next);
  if (pend && ['closed', 'tally'].includes(pend.status)) {
    const late = Math.round((now - Number(pend.closeTs)) / 60000);
    croupier = `Tirage n°${pend.id} : ${!pend.sO ? 'secret opérateur attendu' : !pend.sC ? 'secret collaborateur attendu' : 'comptage en cours'} (${late} min)`;
    alert = late > 15;
  } else {
    const last = [...S.rounds.values()].filter((r) => r.status === 'done').sort((a, b) => b.id - a.id)[0];
    if (last) croupier = `Dernier tirage n°${last.id} terminé`;
  }
  const t = S.st.tot;
  const stat = (label, val, a = false) => `<dl class="stat ${a ? 'alert' : ''}"><dt>${label}</dt><dd>${val}</dd></dl>`;
  $('#adminStats').innerHTML = [
    stat('Volume total', L.fmtAse(t.sales, 0) + ' ASE'),
    stat('Commissions versées', L.fmtAse(t.commission) + ' ASE'),
    stat('Joueurs uniques', `${players.size} <span class="small muted">(${S.rounds.size} tirages)</span>`),
    stat('Jackpot reporté', L.fmtAse(S.st.jackpot, 0) + ' ASE'),
    stat('Grilles vendues', t.grids.toLocaleString('fr-FR')),
    stat('Gains versés', L.fmtAse(t.prizes, 0) + ' ASE'),
    stat('Gains à verser', L.fmtAse(S.st.owed) + ' ASE', BigInt(S.st.owed) > 0n),
    stat('Croupier', croupier, alert),
  ].join('');
  $('#pauseState').textContent = S.cfg.paused ? 'Le jeu est en pause.' : 'Le jeu est ouvert.';
  $('#pauseBtn').textContent = S.cfg.paused ? 'Reprendre le jeu' : 'Mettre en pause';
  const setIfIdle = (sel, v) => { const el = $(sel); if (document.activeElement !== el && !el.dataset.touched) el.value = v; };
  setIfIdle('#fPrice [name=price]', L.fmtAse(S.cfg.price, 4).replace(/ /g, '').replace(/,?0+$/, ''));
  setIfIdle('#fTime [name=h]', S.cfg.drawH); setIfIdle('#fTime [name=m]', S.cfg.drawM);
  setIfIdle('#fMax [name=n]', S.cfg.maxGrids);
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
adminForm('#fPause', () => [S.cfg.paused ? 'Jeu repris' : 'Jeu en pause', 'setPaused', [!S.cfg.paused]]);
// Le contrat reçoit tous les réglages du jeu en un seul appel : on renvoie
// les valeurs actuelles avec seulement celle(s) modifiée(s).
const gameArgs = (patch) => { const c = { ...S.cfg, ...patch }; return [String(c.price), c.drawH, c.drawM, c.maxGrids, c.closeMin, c.revealMin]; };
adminForm('#fPrice', (f) => ['Prix enregistré', 'setConfig', gameArgs({ price: L.parseAse(f.get('price')).toString() })]);
adminForm('#fTime', (f) => ['Heure enregistrée', 'setConfig', gameArgs({ drawH: Number(f.get('h')), drawM: Number(f.get('m')) })]);
adminForm('#fMax', (f) => ['Plafond enregistré', 'setConfig', gameArgs({ maxGrids: Number(f.get('n')) })]);
adminForm('#fTimings', (f) => ['Délais enregistrés', 'setConfig', gameArgs({ closeMin: Number(f.get('close')), revealMin: Number(f.get('reveal')) })]);
adminForm('#fPayouts', (f) => ['Wallets enregistrés', 'setPayouts', [L.toHex(f.get('o')), L.toHex(f.get('c'))]]);
let cancelArmed = 0;
adminForm('#fCancel', () => {
  const id = S.st.next < S.st.cur ? S.st.next : S.info.round;
  const btn = $('#fCancel button');
  if (Date.now() - cancelArmed > 8000) {
    cancelArmed = Date.now();
    btn.textContent = `Confirmer : annuler le tirage n°${id}`;
    setTimeout(() => { if (Date.now() - cancelArmed >= 8000) btn.textContent = 'Annuler et rembourser'; }, 8100);
    throw new Error(`Clique encore une fois dans les 8 s pour annuler le tirage n°${id}.`);
  }
  cancelArmed = 0; btn.textContent = 'Annuler et rembourser';
  return ['Tirage annulé, remboursements disponibles', 'emergencyCancel', [id]];
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
  if (!S.wallet) { b.textContent = 'Connecter mon wallet'; return; }
  b.textContent = `${L.shortAddr(S.wallet.address)}${S.balance !== null ? ' · ' + L.fmtAse(S.balance) + ' ASE' : ''}`;
}
let pairing = false;
function openWallet() {
  if (S.demo) { toast('Mode démo : tu joues avec un wallet fictif de 100 000 ASE.'); return; }
  $('#walletErr').hidden = true; $('#tgPair').hidden = true;
  if (S.wallet) {
    $('#walletConnected').hidden = false; $('#walletChoices').hidden = true;
    $('#walletAddrFull').textContent = L.toAse1(S.wallet.address);
    $('#dlgWallet').showModal();
    return;
  }
  $('#walletConnected').hidden = true; $('#walletChoices').hidden = false;
  $('#useExt').disabled = !ExtensionWallet.available();
  $('#extHint').textContent = ExtensionWallet.available() ? 'Détectée dans ce navigateur' : 'Non détectée : installe-la ou utilise Telegram';
  $('#dlgWallet').showModal();
}
$('#dlgWallet').addEventListener('close', () => { pairing = false; });
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
  $('#walletChoices').hidden = true; $('#tgPair').hidden = false; $('#walletErr').hidden = true;
  try {
    await w.pair((code) => ($('#tgCode').textContent = code), () => !pairing);
    S.wallet = w; store.set('loto.wallet', { kind: 'telegram', session: w.session });
    $('#dlgWallet').close(); await refresh();
  } catch (e) { $('#walletErr').hidden = false; $('#walletErr').textContent = cleanError(e); $('#walletChoices').hidden = false; $('#tgPair').hidden = true; }
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
  $$('.js-drawtime').forEach((e) => (e.textContent = `${S.cfg.drawH}h${String(S.cfg.drawM).padStart(2, '0')}`));
  $$('.js-close').forEach((e) => (e.textContent = plural(S.cfg.closeMin, 'minute', 'minutes')));
  $$('.js-reveal').forEach((e) => (e.textContent = S.cfg.revealMin % 60 === 0 ? plural(S.cfg.revealMin / 60, 'heure', 'heures') : plural(S.cfg.revealMin, 'minute', 'minutes')));
}
function renderAll() {
  renderWallet(); renderHero(); renderCart(); renderMine(); renderResults(); renderRanking(); renderAdmin(); renderRulesValues();
}

// ------------------------------------------------------------- démarrage
(async function start() {
  buildGrid(); renderPicker(); renderCart();
  const wantDemo = !CONFIG.CONTRACT || new URLSearchParams(location.search).has('demo');
  if (wantDemo) {
    const { startDemo } = await import('./demo/demo.js');
    S.demo = await startDemo(new URL('contrat/loto.js', document.baseURI));
    S.rpc = S.demo.rpc; S.contract = S.demo.contractAddress; S.wallet = S.demo.wallet;
    $('#demoBar').hidden = false;
    $('#demoWarp').onclick = async () => { S.demo.goToDraw(); await refresh(); toast('Horloge avancée : le croupier démo vient de faire le tirage.', 'ok'); };
    S.wallet.address = S.wallet.address.toLowerCase();
  } else {
    S.rpc = new Rpc(CONFIG.RPC);
    S.contract = CONFIG.CONTRACT;
    await restoreWallet();
  }
  const link = $('#contractLink');
  link.textContent = S.demo ? 'démo locale' : L.shortAddr(S.contract);
  if (!S.demo) link.href = `${CONFIG.EXPLORER}/address/${L.toAse1(S.contract)}`;
  $('#rpcLabel').textContent = S.rpc.url;
  await refresh();
  setInterval(refresh, S.demo ? 4000 : 20000);
})();
