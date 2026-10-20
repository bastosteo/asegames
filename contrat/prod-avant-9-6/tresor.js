// =====================================================================
//  ASE TREASURE — chasse au trésor sur une grille 20 × 20, testnet Asentum
// =====================================================================
//  Règles :
//   - Une grille de 400 cases, un trésor caché. Chaque fouille coûte 0,5 ASE
//     (réglable), 5 fouilles maximum par wallet et par grille, une case ne se
//     fouille qu'une fois.
//   - Réponse : trésor, chaud (trésor à 3 cases ou moins, diagonales comprises)
//     ou froid. À CHAQUE fouille : 15 % de commission versés tout de suite
//     (moitié équipe 75/25, moitié contrat ASE Airdrop) ; 85 % vont au trésor.
//   - La position est scellée au départ : l'opérateur publie la racine d'un arbre
//     de Merkle qui fixe les 400 réponses (voir functions/_lib/board.mjs). Le
//     service de réponses donne, pour chaque case fouillée, la réponse et sa
//     preuve ; claim() vérifie la preuve de la case trésor et paie le gagnant.
//   - Trésor = report de la grille précédente + 85 % des fouilles jusqu'à celle
//     du trésor incluse. Les 85 % des fouilles faites après (avant le claim)
//     passent dans la grille suivante. Jamais d'annulation ni de remboursement.
//
//  Sécurité : aucune fonction de retrait ; état enregistré AVANT chaque envoi
//  d'ASE ; montants en BigInt (wei) stockés en texte.
// =====================================================================

const BPS = 10000n;
const SHARE_COMMISSION = 1500n;  // 15 % : moitié équipe (75/25), moitié cagnotte ASE Airdrop
const OWNER_CUT = 7500n;
const SIZE = 20, CELLS = 400, DEPTH = 9;
const MAX_BATCH = 400;

// ---------------------------------------------------------------------
//  Outils de base
// ---------------------------------------------------------------------
function jget(k, d) {
  const v = storage.get(k);
  return v === undefined || v === null || v === '' ? d : JSON.parse(v);
}
function jset(k, v) { storage.set(k, JSON.stringify(v)); }
function big(x) { return BigInt(x); }
function nowMs() { return Number(chain.blockTimestamp); }
function noValue() { assert(big(msg.value || 0) === 0n, 'no ASE accepted here'); }
function sender() { return String(msg.sender).toLowerCase(); }

// --- Adresses : le contrat n'accepte que "0x…" (40 hexa). Le site, le
// croupier et le guide convertissent les adresses "ase1…" avant l'envoi
// (taille du contrat limitée : voir RESULTATS-SONDE.md).
function addr(a) {
  const s = String(a).trim().toLowerCase();
  assert(/^0x[0-9a-f]{40}$/.test(s), '0x address expected: ' + a);
  return s;
}

// ---------------------------------------------------------------------
//  SHA-256 écrit à la main (aucune librairie de hash sur Asentum).
//  Validé : vecteurs officiels NIST + comparaison avec node:crypto.
// ---------------------------------------------------------------------
// Constantes de la norme (FIPS 180-4) : 32 premiers bits des parties
// fractionnaires des racines cubiques (K) et carrées (H) des premiers
// nombres premiers, calculées en entiers exacts (plus court qu'un tableau).
function iroot(n, k) {
  let lo = 0n, hi = 1n;
  while (hi ** k <= n) hi *= 2n;
  while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (m ** k <= n) lo = m; else hi = m; }
  return lo;
}
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const K256 = PRIMES.map((p) => Number(iroot(BigInt(p) << 96n, 3n) & 0xffffffffn));
const H256 = PRIMES.slice(0, 8).map((p) => Number(iroot(BigInt(p) << 64n, 2n) & 0xffffffffn));
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function sha256Bytes(bytes) {
  const len = bytes.length;
  const m = bytes.slice();
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  const hi = Math.floor(len / 0x20000000);
  const lo = (len * 8) >>> 0;
  m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  m.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let [h0, h1, h2, h3, h4, h5, h6, h7] = H256;
  const w = new Array(64);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  let hex = '';
  for (const v of [h0, h1, h2, h3, h4, h5, h6, h7]) hex += v.toString(16).padStart(8, '0');
  return hex;
}
function hexToBytes(hex) {
  const s = String(hex);
  assert(s.length % 2 === 0 && /^[0-9a-f]*$/.test(s), 'invalid hex');
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}
function textBytes(str) {
  // Uniquement de l'ASCII ici (adresses, chiffres, hexa, séparateurs).
  const out = [];
  for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 255);
  return out;
}
function sha256Text(str) { return sha256Bytes(textBytes(str)); }
function isSecret(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

// ---------------------------------------------------------------------
//  État
//   cfg, st          réglages, état global
//   g:<id>           une grille          p:<id>:<i>   une fouille (b, c, t)
//   d:<id>:<case>    n° de la fouille de cette case   w:<id>:<a>   fouilles d'un wallet
// ---------------------------------------------------------------------
function cfg() { return jget('cfg', null); }
function st() { return jget('st', null); }
function getG(id) { const g = jget('g:' + id, null); assert(g, 'unknown grid'); return g; }
function putG(g) { jset('g:' + g.id, g); }
function getP(id, i) { const p = jget('p:' + id + ':' + i, null); assert(p, 'unknown dig'); return p; }
function onlyAdmin(c) { assert(sender() === c.admin, 'admin only'); }
function cellOk(cell) { const k = Number(cell); assert(Number.isInteger(k) && k >= 0 && k < CELLS, 'cell: 0 to 399'); return k; }

// La feuille (case, réponse, sel) appartient-elle à l'arbre de racine "root" ?
function merkleOk(root, grid, cell, ans, salt, proof) {
  assert(Array.isArray(proof) && proof.length === DEPTH, 'proof: ' + DEPTH + ' hashes');
  let h = sha256Text('ASETREASURE|' + grid + '|' + cell + '|' + ans + '|' + salt), i = cell;
  for (const s of proof) {
    assert(isSecret(s), 'invalid proof');
    h = i & 1 ? sha256Text(s + h) : sha256Text(h + s);
    i >>= 1;
  }
  return h === root;
}

function batchRange(from, count, total) {
  const a = Number(from), n = Number(count);
  assert(Number.isInteger(a) && a >= 0, 'invalid start');
  assert(Number.isInteger(n) && n > 0 && n <= MAX_BATCH, 'count: 1 to ' + MAX_BATCH);
  return [a, Math.min(total, a + n)];
}
// Part d'une fouille qui va au trésor (85 %).
function netOf(price) { return big(price) - (big(price) * SHARE_COMMISSION) / BPS; }

({
  // INITIALISATION (une fois) : opérateur (publie les grilles, croupier GitHub),
  // wallets de commission et contrat ASE Airdrop.
  init(operator, payOwner, payCollab, payAirdrop) {
    noValue();
    assert(!storage.get('cfg'), 'already initialized');
    const c = {
      admin: sender(), operator: addr(operator), payOwner: addr(payOwner), payCollab: addr(payCollab), payAirdrop: addr(payAirdrop),
      price: (5n * 10n ** 17n).toString(),   // 0,5 ASE
      maxPerWallet: 5, paused: false,
    };
    jset('cfg', c);
    jset('st', { cur: 0, owed: '0', carry: '0', tot: { digs: 0, sales: '0', commission: '0', prizes: '0', refunds: '0', grids: 0 } });
    emit('Init', { admin: c.admin });
    return true;
  },

  // NOUVELLE GRILLE (opérateur) : racine de l'arbre des 400 réponses.
  openGrid(id, root) {
    noValue();
    const c = cfg(), s = st();
    assert(sender() === c.operator || sender() === c.admin, 'operator only');
    assert(Number(id) === s.cur + 1, 'next grid is ' + (s.cur + 1));
    if (s.cur > 0) { const prev = getG(s.cur); assert(prev.status === 'found', 'current grid still open'); }
    const r = String(root).toLowerCase();
    assert(isSecret(r), 'invalid root');
    const g = { id: s.cur + 1, status: 'open', root: r, price: c.price, digs: 0, sales: '0', wallets: 0, openTs: nowMs(), endTs: 0, t: -1, cell: -1, winner: null, prize: '0', airdrop: '0', commission: '0', carryIn: s.carry || '0', carryOut: '0' };
    putG(g);
    s.cur = g.id;
    s.carry = '0';
    jset('st', s);
    emit('GridOpened', { grid: String(g.id), root: r, price: g.price });
    return g.id;
  },

  // FOUILLER une case (joindre le prix). La réponse arrive par le service de réponses.
  dig(id, cell) {
    const c = cfg(), s = st();
    assert(!c.paused, 'game paused');
    const g = getG(Number(id));
    assert(g.id === s.cur && g.status === 'open', 'grid not open');
    const k = cellOk(cell);
    assert(jget('d:' + g.id + ':' + k, -1) < 0, 'cell already dug');
    const who = sender();
    const mine = jget('w:' + g.id + ':' + who, 0);
    assert(mine < c.maxPerWallet, 'max ' + c.maxPerWallet + ' digs per wallet on this grid');
    assert(big(msg.value || 0) === big(g.price), 'wrong amount, expected: ' + g.price + ' wei');
    const i = g.digs;
    jset('p:' + g.id + ':' + i, { b: who, c: k, paid: false, t: nowMs() });
    jset('d:' + g.id + ':' + k, i);
    jset('w:' + g.id + ':' + who, mine + 1);
    if (mine === 0) g.wallets++;
    g.digs = i + 1;
    g.sales = (big(g.sales) + big(g.price)).toString();
    const com = big(g.price) - netOf(g.price), cDrop = com / 2n, cOwner = ((com - cDrop) * OWNER_CUT) / BPS;
    g.commission = (big(g.commission) + com).toString();
    g.airdrop = (big(g.airdrop) + cDrop).toString();
    putG(g);
    s.tot.digs++;
    s.tot.sales = (big(s.tot.sales) + big(g.price)).toString();
    s.tot.commission = (big(s.tot.commission) + com).toString();
    jset('st', s);
    if (cOwner > 0n) transfer(c.payOwner, cOwner.toString());
    if (com - cDrop > cOwner) transfer(c.payCollab, (com - cDrop - cOwner).toString());
    if (cDrop > 0n) transfer(c.payAirdrop, cDrop.toString());
    emit('Dig', { grid: String(g.id), idx: String(i), cell: String(k), by: who });
    return { grid: g.id, idx: i, cell: k };
  },

  // TRÉSOR TROUVÉ : n'importe qui (le gagnant, le site, le croupier) envoie la
  // preuve de la case trésor. Le prix part toujours au wallet qui l'a fouillée.
  claim(id, cell, salt, proof) {
    noValue();
    const s = st();
    const g = getG(Number(id));
    assert(g.status === 'open', 'grid not open');
    const k = cellOk(cell);
    const sl = String(salt).toLowerCase();
    assert(isSecret(sl) && merkleOk(g.root, g.id, k, 'T', sl, proof), 'not the treasure');
    const t = jget('d:' + g.id + ':' + k, -1);
    assert(t >= 0, 'treasure cell not dug yet');
    const p = getP(g.id, t);
    const net = netOf(g.price);
    const prize = big(g.carryIn) + net * big(t + 1);      // report + fouilles jusqu'au trésor inclus
    const after = net * big(g.digs - t - 1);              // fouilles après le trésor → grille suivante
    Object.assign(g, { status: 'found', t, cell: k, winner: p.b, prize: prize.toString(), carryOut: after.toString(), endTs: nowMs() });
    putG(g);
    p.paid = true;
    jset('p:' + g.id + ':' + t, p);
    s.carry = (big(s.carry || '0') + after).toString();
    s.tot.prizes = (big(s.tot.prizes) + prize).toString();
    s.tot.grids++;
    jset('st', s);
    transfer(p.b, prize.toString());
    emit('Found', { grid: String(g.id), cell: String(k), idx: String(t), winner: p.b, prize: g.prize, digs: String(t + 1), carry: g.carryOut });
    return g.prize;
  },

  // ADMIN
  setPaused(on) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.paused = on === true || on === 'true';
    jset('cfg', c);
    emit('Paused', { paused: String(c.paused) });
    return c.paused;
  },
  // prix d'une fouille (wei, pour les grilles suivantes), fouilles max par wallet et par grille
  setConfig(price, maxPerWallet) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const v = big(price), W = Number(maxPerWallet);
    assert(v >= 10n ** 16n && v <= 10n ** 21n, 'price: 0.01 to 1000 ASE');
    assert(Number.isInteger(W) && W >= 1 && W <= 400, 'digs per wallet: 1 to 400');
    c.price = v.toString(); c.maxPerWallet = W;
    jset('cfg', c);
    emit('Config', { key: 'game', value: JSON.stringify([c.price, W]) });
    return true;
  },
  setPayouts(payOwner, payCollab, payAirdrop) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.payOwner = addr(payOwner); c.payCollab = addr(payCollab);
    if (payAirdrop !== undefined && payAirdrop !== null) c.payAirdrop = addr(payAirdrop);
    jset('cfg', c);
    emit('Config', { key: 'payouts', value: c.payOwner + ',' + c.payCollab + ',' + c.payAirdrop });
    return true;
  },
  setOperator(a) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.operator = addr(a);
    jset('cfg', c);
    emit('Config', { key: 'operator', value: c.operator });
    return true;
  },
  setAdmin(a) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.admin = addr(a);
    jset('cfg', c);
    emit('Config', { key: 'admin', value: c.admin });
    return true;
  },

  // LECTURES (gratuites)
  getConfig() { return cfg(); },
  getState() { return st(); },
  getGrid(id) { return jget('g:' + Number(id), null); },
  getDigs(id, from, count) {
    const g = getG(Number(id));
    const [a, b] = batchRange(from, count, g.digs);
    const out = [];
    for (let i = a; i < b; i++) { const p = getP(g.id, i); out.push({ idx: i, b: p.b, c: p.c, paid: p.paid, t: p.t || 0 }); }
    return out;
  },
  cellOf(id, cell) { return jget('d:' + Number(id) + ':' + cellOk(cell), -1); },
  digsOf(id, who) { return jget('w:' + Number(id) + ':' + addr(who), 0); },
  info() {
    const c = cfg(), s = st();
    const g = s.cur ? getG(s.cur) : null;
    return {
      now: String(nowMs()), paused: c.paused, price: c.price, maxPerWallet: c.maxPerWallet, grid: s.cur,
      status: g ? g.status : 'none', digs: g ? g.digs : 0, wallets: g ? g.wallets : 0,
      pot: g && g.status === 'open' ? (big(g.carryIn) + netOf(g.price) * big(g.digs)).toString() : s.carry || '0',
      carry: s.carry || '0', owed: s.owed, totals: s.tot,
    };
  },
});
