// =====================================================================
//  ASE RAFFLE v4 — tombola, 3 tirages par semaine, testnet Asentum
// =====================================================================
//  Règles :
//   - Un ticket = 5 ASE (réglable). 10 tickets maximum par wallet et par
//     tombola (réglable). Tirages le dimanche, le mardi et le jeudi à 21h00
//     (heure de Paris, heure d'été gérée) ; ventes fermées 10 min avant.
//   - À CHAQUE achat : 15 % de commission versés tout de suite (9 % équipe
//     75/25 + 6 % au contrat ASE Airdrop) ; 85 % vont dans la cagnotte.
//   - Gagnants : jusqu'à 27 LOTS de 100 ASE (sans dépasser 40 % de la
//     cagnotte), puis les 3 premiers se partagent TOUT le reste : 50/30/20 %.
//     Ex. 9 700 ASE → 27 lots + 3 500 / 2 100 / 1 400. Ex. 3 000 → 12 lots.
//   - Chaque TICKET gagne au plus une fois ; un wallet avec plusieurs tickets
//     peut gagner plusieurs prix. Moins de tickets que de prix → les prix sans
//     ticket passent dans la tombola suivante. Aucun ticket → la tombola est
//     reportée au tirage suivant.
//   - Hasard : double secret en chaîne (owner puis collaborateur), révélés
//     APRÈS la fermeture. Tirage k : ticket = SHA-256("ASERAFFLE|tour|sO|sC|
//     empreinte|k") mod nombre de tickets ; ticket déjà tiré → k+1.
//     Ordre : 1er, 2e, 3e, puis les lots.
//   - Les gains se RÉCLAMENT (claim), sans limite de temps.
//   - Lots (montant, nombre max) : réglables par l'admin, fixés dans chaque
//     tombola à son ouverture (un changement ne touche jamais une tombola en cours).
//   - Jamais d'annulation ni de remboursement : un tirage attend ses secrets.
//
//  Sécurité : aucune fonction de retrait ; état enregistré AVANT chaque
//  envoi d'ASE ; montants en BigInt (wei) stockés en texte.
// =====================================================================

const BPS = 10000n;
const SHARE_COMMISSION = 1500n; // 15 % de commission : 9 % équipe (75/25) + 6 % cagnotte ASE Airdrop
const SHARE_DROP = 600n;       // dont 6 % pour l'ASE Airdrop
const OWNER_CUT = 7500n;        // 75 % de la commission pour l'owner
const SPLIT = [5000n, 3000n];   // top 3 : 1er 50 %, 2e 30 %, 3e = le reste (20 %)
const LOT_SHARE = 4000n;        // les lots ne prennent jamais plus de 40 % de la cagnotte
const MAX_LOTS = 200;           // plafond absolu du nombre de lots
const DAY = 86400000;
const HOUR = 3600000;
const MAX_CHAIN_SKIP = 1;      // un secret = exactement le maillon précédent (le collaborateur ne peut pas choisir)
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

// Vérifie que "secret" prolonge la chaîne : SHA256^k(secret) == tip, k ≤ MAX_CHAIN_SKIP.
function chainOk(secret, tip) {
  let h = secret;
  for (let k = 1; k <= MAX_CHAIN_SKIP; k++) {
    h = sha256Bytes(hexToBytes(h));
    if (h === tip) return true;
  }
  return false;
}


// ---------------------------------------------------------------------
//  Heure de Paris (heure d'été UE : dernier dimanche de mars 01:00 UTC
//  → dernier dimanche d'octobre 01:00 UTC). Calcul entier, sans Date.
// ---------------------------------------------------------------------
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
// Année approximative (± 1 jour autour du 1er janvier) : suffit, car l'heure
// d'été ne change qu'en mars et octobre, loin du changement d'année.
function yearOfDays(z) { return Math.floor(z / 365.2425) + 1970; }
function lastSunday(y, m) {
  const last = (m === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, m + 1, 1)) - 1;
  const wd = (((last + 4) % 7) + 7) % 7; // 0 = dimanche (1970-01-01 était un jeudi)
  return last - wd;
}
function parisOffsetMs(utcMs) {
  const y = yearOfDays(Math.floor(utcMs / DAY));
  const start = lastSunday(y, 3) * DAY + HOUR;
  const end = lastSunday(y, 10) * DAY + HOUR;
  return utcMs >= start && utcMs < end ? 2 * HOUR : HOUR;
}

// Prochain tirage (jours de semaine en masque : bit 0 = dimanche … bit 6 =
// samedi ; heure de Paris h:m) strictement après t (ms UTC).
function nextDrawAfter(t, days, h, m) {
  let d = Math.floor(t / DAY) - 1;
  for (let i = 0; i < 10; i++, d++) {
    if (!((days >> ((((d + 4) % 7) + 7) % 7)) & 1)) continue;     // 1970-01-01 = jeudi
    const local = d * DAY + (h * 60 + m) * 60000;
    const x = local - parisOffsetMs(local - 2 * HOUR);
    if (x > t) return x;
  }
  assert(false, 'date');
}

// ---------------------------------------------------------------------
//  État
//   cfg          réglages        st         état global
//   r:<id>       une tombola     p:<id>:<i> un achat (acheteur, n tickets, 1er numéro)
//   w:<id>:<a>   tickets d'un wallet dans la tombola <id>
// ---------------------------------------------------------------------
function cfg() { return jget('cfg', null); }
function st() { return jget('st', null); }
function getR(id) { const r = jget('r:' + id, null); assert(r, 'unknown raffle'); return r; }
function putR(r) { jset('r:' + r.id, r); }
function getP(id, i) { const p = jget('p:' + id + ':' + i, null); assert(p, 'unknown purchase'); return p; }
function onlyAdmin(c) { assert(sender() === c.admin, 'admin only'); }

function schedule(r, c, after) {
  const offset = c.closeMin * 60000;
  r.drawTs = nextDrawAfter(Math.max(after, nowMs() + offset), c.drawDays, c.drawH, c.drawM);
  r.closeTs = r.drawTs - offset;
}
function newRound(id, c, after) {
  const r = {
    id, status: 'open', price: c.price, revealMin: c.revealMin, drawTs: 0, closeTs: 0,
    sales: '0', tickets: 0, buys: 0, wallets: 0, weeks: 1, carryIn: '0', airdrop: '0',
    digest: sha256Text('ASERAFFLE-ROUND|' + id),
    sO: null, sC: null, win: null, prizes: null, claimed: null, commission: '0',
    lot: c.lot, maxLots: c.maxLots,
  };
  schedule(r, c, after);
  putR(r);
  emit('RoundOpened', { round: String(id), drawTs: String(r.drawTs), closeTs: String(r.closeTs), price: c.price });
  return r;
}

// Ferme la tombola en cours à l'heure (ou la reporte au tirage suivant si elle
// n'a aucun ticket), ouvre la suivante, avance "next".
function sync(c, s) {
  const cur = getR(s.cur);
  if (cur.status === 'open' && nowMs() >= cur.closeTs) {
    if (cur.tickets === 0) {
      schedule(cur, c, cur.drawTs);
      cur.weeks++;
      putR(cur);
      emit('Extended', { round: String(cur.id), drawTs: String(cur.drawTs), wallets: String(cur.wallets) });
    } else {
      cur.status = 'closed';
      putR(cur);
      emit('RoundClosed', { round: String(cur.id), tickets: String(cur.tickets), sales: cur.sales, digest: cur.digest });
      s.cur = cur.id + 1;
      newRound(s.cur, c, cur.drawTs);
    }
  }
  while (s.next < s.cur) {
    const r = getR(s.next);
    if (r.status === 'done') s.next++;
    else break;
  }
  return s;
}

// Prix d'une tombola : [1er, 2e, 3e, lot, lot, …] et le report.
// Lots : jusqu'à maxLots × lot, sans dépasser 40 % de la cagnotte ; le top 3
// prend tout le reste. Moins de tickets que de prix → prix sans ticket reportés.
function prizesOf(r) {
  const pool = big(r.carryIn) + big(r.sales) - big(r.commission), lot = big(r.lot);
  const nTop = Math.min(3, r.tickets);
  let nLots = lot > 0n ? Number((pool * LOT_SHARE) / BPS / lot) : 0;
  nLots = Math.min(nLots, r.maxLots, MAX_LOTS, r.tickets - nTop);
  const top = pool - lot * big(nLots), p1 = (top * SPLIT[0]) / BPS, p2 = (top * SPLIT[1]) / BPS;
  const pr = [p1, p2, top - p1 - p2].slice(0, nTop);
  for (let k = 0; k < nLots; k++) pr.push(lot);
  let paid = 0n;
  for (const x of pr) paid += x;
  return [pr, pool - paid];
}

// Tire n tickets différents. Tirage k : ticket = SHA-256(…|k) mod tickets.
// (le calcul n'est pas facturé : seul le stockage coûte du gas)
function drawTickets(r, n) {
  const win = [], seen = {};
  for (let k = 0; win.length < n && k < 100000; k++) {
    const h = sha256Text('ASERAFFLE|' + r.id + '|' + r.sO + '|' + r.sC + '|' + r.digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(r.tickets));
    if (seen[t]) continue;
    seen[t] = 1;
    win.push(t);
  }
  assert(win.length === n, 'draw failed');
  return win;
}

// Cagnotte = report reçu + 85 % des ventes (la commission est déjà partie).
function finalize(r, s) {
  const [pr, left] = prizesOf(r);
  r.win = drawTickets(r, pr.length);
  r.prizes = pr.map((x) => x.toString());
  r.claimed = pr.map(() => false);
  r.carryOut = left.toString();
  r.status = 'done';
  putR(r);
  if (left > 0n) {
    const cur = getR(s.cur);
    cur.carryIn = (big(cur.carryIn) + left).toString();
    putR(cur);
  }
  let won = 0n;
  for (const x of pr) won += x;
  s.owed = (big(s.owed) + won).toString();
  s.next = r.id + 1;
  jset('st', s);
  emit('Drawn', { round: String(r.id), tickets: JSON.stringify(r.win), prizes: JSON.stringify(r.prizes), carry: r.carryOut });
}

function batchRange(from, count, total) {
  const a = Number(from), n = Number(count);
  assert(Number.isInteger(a) && a >= 0, 'invalid start');
  assert(Number.isInteger(n) && n > 0 && n <= MAX_BATCH, 'count: 1 to ' + MAX_BATCH);
  return [a, Math.min(total, a + n)];
}

({
  // INITIALISATION (une fois) : wallets de commission, wallet du
  // collaborateur (gère SA chaîne), bouts des deux chaînes de secrets.
  init(payOwner, payCollab, collabAdmin, tipOwner, tipCollab, payAirdrop) {
    noValue();
    assert(!storage.get('cfg'), 'already initialized');
    assert(isSecret(tipOwner) && isSecret(tipCollab) && tipOwner !== tipCollab, 'invalid tips');
    const c = {
      admin: sender(), dropBps: 600, payOwner: addr(payOwner), payCollab: addr(payCollab), collabAdmin: addr(collabAdmin), payAirdrop: addr(payAirdrop),
      price: (5n * 10n ** 18n).toString(),     // 5 ASE
      maxPerWallet: 10, maxRound: 10000,
      drawDays: 21, drawH: 21, drawM: 0,       // dimanche + mardi + jeudi (1 + 4 + 16), 21h00 Paris
      lot: (100n * 10n ** 18n).toString(), maxLots: 27,   // jusqu'à 27 lots de 100 ASE
      closeMin: 10, revealMin: 120, paused: false,
    };
    jset('cfg', c);
    const s = {
      cur: 1, next: 1, owed: '0', tipO: tipOwner, tipC: tipCollab,
      tot: { sales: '0', tickets: 0, buys: 0, commission: '0', prizes: '0', refunds: '0' },
    };
    newRound(1, c, 0);
    jset('st', s);
    emit('Init', { admin: c.admin });
    return true;
  },

  // ACHETER n tickets (joindre prix × n). seed = graine du joueur (hexa, option).
  buy(n, seed) {
    const c = cfg();
    let s = st();
    assert(c, 'not initialized');
    assert(!c.paused, 'game paused');
    s = sync(c, s);
    const r = getR(s.cur);
    assert(r.status === 'open' && nowMs() < r.closeTs, 'sales closed');
    const k = Number(n);
    const who = sender();
    const mine = jget('w:' + r.id + ':' + who, 0);
    assert(Number.isInteger(k) && k >= 1, 'invalid ticket count');
    assert(mine + k <= c.maxPerWallet, 'max ' + c.maxPerWallet + ' tickets per wallet (you have ' + mine + ')');
    assert(r.tickets + k <= c.maxRound, 'raffle full');
    const cost = big(r.price) * big(k);
    assert(big(msg.value || 0) === cost, 'wrong amount, expected: ' + cost.toString() + ' wei');
    const sd = seed === undefined || seed === null ? '' : String(seed).toLowerCase();
    assert(/^[0-9a-f]{0,64}$/.test(sd), 'invalid seed');
    const i = r.buys;
    jset('p:' + r.id + ':' + i, { b: who, n: k, s: r.tickets, sd, paid: false, t: nowMs() });
    jset('w:' + r.id + ':' + who, mine + k);
    if (mine === 0) r.wallets++;
    r.digest = sha256Text(r.digest + '|' + who + '|' + k + '|' + sd + '|' + i);
    const first = r.tickets;
    r.tickets += k;
    r.buys = i + 1;
    r.sales = (big(r.sales) + cost).toString();
    const com = (cost * SHARE_COMMISSION) / BPS, cDrop = (com * SHARE_DROP) / SHARE_COMMISSION, cOwner = ((com - cDrop) * OWNER_CUT) / BPS;
    r.commission = (big(r.commission) + com).toString();
    r.airdrop = (big(r.airdrop) + cDrop).toString();
    putR(r);
    s.tot.sales = (big(s.tot.sales) + cost).toString();
    s.tot.commission = (big(s.tot.commission) + com).toString();
    s.tot.tickets += k;
    s.tot.buys += 1;
    jset('st', s);
    if (cOwner > 0n) transfer(c.payOwner, cOwner.toString());
    if (com - cDrop > cOwner) transfer(c.payCollab, (com - cDrop - cOwner).toString());
    if (cDrop > 0n) transfer(c.payAirdrop, cDrop.toString());
    emit('Buy', { round: String(r.id), idx: String(i), buyer: who, first: String(first), n: String(k), seed: sd, value: cost.toString() });
    return { round: r.id, idx: i, first, n: k };
  },

  poke() {
    noValue();
    const s = sync(cfg(), st());
    jset('st', s);
    return { cur: s.cur, next: s.next };
  },

  // TIRAGE (croupier) : reveal('owner', …) puis reveal('collab', …).
  // Le 2e secret désigne les gagnants. Pas de date limite : le tirage attend.
  reveal(who, roundId, secret) {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    const r = getR(Number(roundId));
    const o = who === 'owner';
    assert(o || who === 'collab', 'who: owner or collab');
    assert(r.id === s.next, 'draw first round ' + s.next);
    assert(r.status === 'closed', 'status: ' + r.status);
    assert(o ? !r.sO : r.sO && !r.sC, o ? 'already revealed' : 'owner first, or already revealed');
    const sec = String(secret).toLowerCase();
    assert(isSecret(sec) && chainOk(sec, o ? s.tipO : s.tipC), 'invalid secret');
    if (o) { r.sO = sec; s.tipO = sec; putR(r); jset('st', s); }
    else { r.sC = sec; s.tipC = sec; finalize(r, s); }
    emit('Reveal', { round: String(r.id), who, secret: sec });
    return true;
  },

  // RÉCLAMER un prix (rang 0 = 1er, 1 = 2e, 2 = 3e, 3… = lots). idx = n° de
  // l'achat qui contient le ticket gagnant. L'argent va toujours à son acheteur.
  claim(roundId, rank, idx) {
    noValue();
    const s = st();
    const r = getR(Number(roundId));
    const k = Number(rank);
    assert(r.status === 'done', 'not drawn');
    assert(Number.isInteger(k) && k >= 0 && k < r.win.length, 'no prize at this rank');
    assert(!r.claimed[k], 'already claimed');
    const p = getP(r.id, Number(idx)), t = r.win[k];
    assert(p.s <= t && t < p.s + p.n, 'ticket not in this purchase');
    const amount = big(r.prizes[k]);
    r.claimed[k] = true;
    putR(r);
    s.owed = (big(s.owed) - amount).toString();
    s.tot.prizes = (big(s.tot.prizes) + amount).toString();
    jset('st', s);
    transfer(p.b, amount.toString());
    emit('Claimed', { round: String(r.id), rank: String(k + 1), ticket: String(t), to: p.b, amount: amount.toString() });
    return amount.toString();
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
  // prix (wei), jours de tirage (masque : 1 = dimanche, 2 = lundi, 4 = mardi, 8 = mercredi,
  // 16 = jeudi, 32 = vendredi, 64 = samedi ; ex. 21 = dim + mar + jeu), heure, minute,
  // tickets max par wallet, fermeture (min avant), revealMin (sans effet), tickets max par tombola.
  // Prix et horaire : tout de suite si la tombola en cours n'a encore aucun ticket.
  setConfig(price, drawDays, drawH, drawM, maxPerWallet, closeMin, revealMin, maxRound) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const v = big(price), D = Number(drawDays), H = Number(drawH), M = Number(drawM), W = Number(maxPerWallet), A = Number(closeMin), B = Number(revealMin), T = Number(maxRound);
    const ok = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    assert(v >= 10n ** 16n && v <= 10n ** 21n, 'price: 0.01 to 1000 ASE');
    assert(ok(D, 1, 127) && ok(H, 6, 23) && ok(M, 0, 59), 'days 1-127, time 06:00 to 23:59');
    assert(ok(W, 1, 100), 'tickets per wallet: 1 to 100');
    assert(ok(A, 2, 60), 'closing: 2 to 60 min');
    assert(ok(B, 30, 1440), 'reveal: 30 to 1440 min');
    assert(ok(T, 3, 100000), 'tickets per raffle: 3 to 100000');
    Object.assign(c, { price: v.toString(), drawDays: D, drawH: H, drawM: M, maxPerWallet: W, closeMin: A, revealMin: B, maxRound: T });
    jset('cfg', c);
    const s = sync(c, st());
    const r = getR(s.cur);
    if (r.status === 'open' && r.tickets === 0) { r.price = c.price; schedule(r, c, 0); putR(r); }
    jset('st', s);
    emit('Config', { key: 'game', value: JSON.stringify([c.price, D, H, M, W, A, B, T]) });
    return true;
  },
  // Lots : montant (wei, 0 = aucun lot) et nombre maximum. Pour les PROCHAINES tombolas.
  setLots(lot, maxLots) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const v = big(lot), n = Number(maxLots);
    assert(v >= 0n && v <= 10n ** 22n, 'lot: 0 to 10000 ASE');
    assert(Number.isInteger(n) && n >= 0 && n <= MAX_LOTS, 'lots: 0 to ' + MAX_LOTS);
    c.lot = v.toString(); c.maxLots = n;
    jset('cfg', c);
    emit('Config', { key: 'lots', value: c.lot + ',' + n });
    return true;
  },
  setPayouts(payOwner, payCollab, payAirdrop) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.payOwner = addr(payOwner);
    c.payCollab = addr(payCollab);
    if (payAirdrop !== undefined && payAirdrop !== null) c.payAirdrop = addr(payAirdrop);
    jset('cfg', c);
    emit('Config', { key: 'payouts', value: c.payOwner + ',' + c.payCollab + ',' + c.payAirdrop });
    return true;
  },
  setAdmin(newAdmin) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.admin = addr(newAdmin);
    jset('cfg', c);
    emit('Config', { key: 'admin', value: c.admin });
    return true;
  },
  setTipOwner(tip) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const s = sync(c, st());
    assert(getR(s.next).status === 'open', 'draw pending');
    assert(isSecret(tip) && tip !== s.tipC, 'invalid tip');
    s.tipO = tip;
    jset('st', s);
    emit('Config', { key: 'tipOwner', value: tip });
    return true;
  },
  setTipCollab(tip) {
    noValue();
    const c = cfg();
    assert(sender() === c.collabAdmin, 'collaborator only');
    const s = sync(c, st());
    assert(getR(s.next).status === 'open', 'draw pending');
    assert(isSecret(tip) && tip !== s.tipO, 'invalid tip');
    s.tipC = tip;
    jset('st', s);
    emit('Config', { key: 'tipCollab', value: tip });
    return true;
  },
  setCollabAdmin(newAddr) {
    noValue();
    const c = cfg();
    assert(sender() === c.collabAdmin, 'collaborator only');
    c.collabAdmin = addr(newAddr);
    jset('cfg', c);
    emit('Config', { key: 'collabAdmin', value: c.collabAdmin });
    return true;
  },

  // LECTURES (gratuites)
  getConfig() { return cfg(); },
  getState() { return st(); },
  getRound(roundId) { return jget('r:' + Number(roundId), null); },
  getPurchases(roundId, from, count) {
    const r = getR(Number(roundId));
    const [a, b] = batchRange(from, count, r.buys);
    const out = [];
    for (let i = a; i < b; i++) { const p = getP(r.id, i); out.push({ idx: i, b: p.b, n: p.n, first: p.s, sd: p.sd, paid: p.paid, prize: '0', t: p.t || 0 }); }
    return out;
  },
  getWallet(roundId, who) { return jget('w:' + Number(roundId) + ':' + addr(who), 0); },
  info() {
    const c = cfg();
    const s = st();
    const r = getR(s.cur);
    const t = nowMs();
    return {
      now: String(t), paused: c.paused, round: r.id, status: t >= r.closeTs ? 'closing' : r.status,
      drawTs: String(r.drawTs), closeTs: String(r.closeTs), price: r.price, maxPerWallet: c.maxPerWallet,
      tickets: r.tickets, wallets: r.wallets, sales: r.sales, weeks: r.weeks, lot: r.lot, maxLots: r.maxLots, drawDays: c.drawDays,
      pot: (big(r.carryIn) + big(r.sales) - big(r.commission)).toString(), carryIn: r.carryIn,
      nextToDraw: s.next, owed: s.owed, totals: s.tot,
    };
  },
});
