// =====================================================================
//  LOTO ASE — loto à numéros, pari mutuel, testnet Asentum
// =====================================================================
//  Règles :
//   - Grille = 5 numéros distincts entre 1 et 14 (v6). Prix par défaut : 1 ASE.
//   - Un tirage par jour (21h00 heure de Paris par défaut, heure d'été
//     gérée). Les ventes ferment 10 min avant ; le tour suivant s'ouvre.
//   - Répartition des ventes d'un tour :
//       15 % commission : 7,5 % équipe (75 % owner, 25 % collaborateur)
//                         + 7,5 % envoyés au contrat ASE Airdrop
//       35 % jackpot (5 bons), partagé entre ses gagnants, + reports
//       50 % caisse des gains fixes : 4 bons = 25 mises, 3 bons = 2,5 mises.
//            Si la caisse ne suffit pas, les deux gains baissent dans la
//            même proportion (l'ordre 4 bons > 3 bons est toujours gardé).
//     Pas de gagnant à 5 bons → la moitié des 35 % du tour est versée en
//     bonus aux 4 et 3 bons (en proportion de leur gain fixe).
//     Tout le reste (jackpot non gagné, reste de la caisse) → jackpot suivant.
//     Un gagnant à 4 bons ne touche jamais plus que 80 % d'un 5 bons.
//   - Les gains se RÉCLAMENT (settle de son achat, bouton Claim du site),
//     sans limite de temps ; l'événement "Paid" indique le nombre de bons numéros.
//   - Hasard : double secret en chaîne (owner puis collaborateur),
//     révélés APRÈS la fermeture des ventes. Numéros =
//     SHA-256("LOTOASE|tour|secretOwner|secretCollab|empreinteDesGrilles").
//     Aucun tirage n'est jamais annulé ni remboursé : il attend simplement
//     les deux secrets (le croupier les révèle en quelques minutes).
//
//  Sécurité :
//   - Aucune fonction ne permet à l'admin de retirer des fonds. Seule la
//     commission (15 %) est envoyée, automatiquement, À CHAQUE ACHAT (la part
//     Airdrop arrive donc tout de suite dans la cagnotte Airdrop).
//     fund() permet à n'importe qui d'ajouter de l'ASE au jackpot.
//   - L'état est enregistré AVANT chaque envoi d'ASE.
//   - Montants en BigInt (wei), stockés en texte.
//
//  Faits vérifiés par la sonde (voir RESULTATS-SONDE.md) :
//   - storage ne garde que du texte → JSON.stringify partout.
//   - msg.sender = "0x…" minuscules ; transfer() n'accepte que "0x…".
//   - chain.blockTimestamp en millisecondes (BigInt).
//   - Le calcul est gratuit, les NOUVELLES clés coûtent ~20 000 gas.
// =====================================================================

const PICK = 5;                 // numéros par grille
const MAXN = 14;                // numéros possibles : 1..14 (2 002 grilles différentes)
const NOBIAS = 256 - (256 % MAXN); // 252 = 18 × 14 : octets acceptés pour un tirage sans biais
const BPS = 10000n;             // base des pourcentages (10000 = 100 %)
const SHARE_COMMISSION = 1500n; // 15 % : moitié équipe (75/25), moitié cagnotte ASE Airdrop
const SHARE_JACKPOT = 3500n;    // 35 % (le reste, 50 %, = caisse des gains fixes)
const OWNER_CUT = 7500n;        // 75 % de la commission pour l'owner
const DAY = 86400000;           // un jour en ms
const HOUR = 3600000;
const MAX_GRIDS_HARD = 50;      // plafond absolu de grilles par achat
const MAX_CHAIN_SKIP = 1;       // un secret = exactement le maillon précédent (le collaborateur ne peut pas choisir)
const MAX_BATCH = 400;          // plafond d'éléments lus par appel
const MAX_PAYS = 40;            // plafond d'envois d'ASE par appel (gas < 1 000 000)

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

// Numéros gagnants : 5 numéros distincts dans 1..MAXN, tirage uniforme
// (on rejette les octets ≥ NOBIAS pour éviter tout biais).
function drawNumbers(roundId, sO, sC, digest) {
  let seed = sha256Text('LOTOASE|' + roundId + '|' + sO + '|' + sC + '|' + digest);
  const nums = [];
  while (nums.length < PICK) {
    const bytes = hexToBytes(seed);
    for (const b of bytes) {
      if (nums.length >= PICK) break;
      if (b >= NOBIAS) continue;
      const n = (b % MAXN) + 1;
      if (nums.indexOf(n) < 0) nums.push(n);
    }
    seed = sha256Bytes(hexToBytes(seed));
  }
  return nums.sort((a, b) => a - b);
}

function matches(grid, nums) {
  let k = 0;
  for (const n of grid) if (nums.indexOf(n) >= 0) k++;
  return k;
}

// Vérifie une grille : 5 entiers distincts entre 1 et MAXN → triée.
function cleanGrid(g) {
  assert(Array.isArray(g) && g.length === PICK, 'a ticket = ' + PICK + ' numbers');
  const out = [];
  for (const x of g) {
    const n = Number(x);
    assert(Number.isInteger(n) && n >= 1 && n <= MAXN, 'number out of range (1 to ' + MAXN + '): ' + x);
    assert(out.indexOf(n) < 0, 'duplicate number: ' + n);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
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
// Premier tirage (heure de Paris h:m) strictement après t (ms UTC).
function nextDrawAfter(t, h, m) {
  let d = Math.floor(t / DAY) - 1;
  for (let i = 0; i < 5; i++, d++) {
    const local = d * DAY + (h * 60 + m) * 60000;
    const x = local - parisOffsetMs(local - 2 * HOUR);
    if (x > t) return x;
  }
  assert(false, 'date');
}

// ---------------------------------------------------------------------
//  État
//   cfg            réglages (admin, adresses de paiement, prix, horaire…)
//   st             état global (tour courant, jackpot reporté, dettes…)
//   r:<id>         un tour
//   p:<id>:<i>     un achat (acheteur + ses grilles)
// ---------------------------------------------------------------------
function cfg() { return jget('cfg', null); }
function st() { return jget('st', null); }
function getR(id) { const r = jget('r:' + id, null); assert(r, 'unknown draw'); return r; }
function putR(r) { jset('r:' + r.id, r); }
function getP(id, i) { const p = jget('p:' + id + ':' + i, null); assert(p, 'unknown purchase'); return p; }
function onlyAdmin(c) { assert(sender() === c.admin, 'admin only'); }

function newRound(id, c, prevDrawTs) {
  const offset = c.closeMin * 60000;
  const after = Math.max(prevDrawTs, nowMs() + offset);
  const drawTs = nextDrawAfter(after, c.drawH, c.drawM);
  const r = {
    id, status: 'open', price: c.price,
    drawTs, closeTs: drawTs - offset, revealMin: c.revealMin,
    sales: '0', grids: 0, buys: 0,
    digest: sha256Text('LOTOASE-ROUND|' + id),
    sO: null, sC: null, nums: null, cursor: 0,
    cnt: [0, 0, 0],                 // gagnants à 3, 4, 5 bons
    per: ['0', '0', '0'],           // gain par grille gagnante à 3, 4, 5 bons
    jackpotIn: null, carryOut: null, commission: '0', airdrop: '0',
  };
  putR(r);
  emit('RoundOpened', { round: String(id), drawTs: String(drawTs), closeTs: String(r.closeTs), price: c.price });
  return r;
}

// Fait avancer le temps : ferme le tour courant si l'heure est passée et
// ouvre le suivant ; passe les tours terminés pour le prochain tirage.
function sync(c, s) {
  let cur = getR(s.cur);
  if (cur.status === 'open' && nowMs() >= cur.closeTs) {
    cur.status = cur.grids === 0 ? 'empty' : 'closed';
    putR(cur);
    emit('RoundClosed', { round: String(cur.id), grids: String(cur.grids), sales: cur.sales, digest: cur.digest });
    s.cur = cur.id + 1;
    newRound(s.cur, c, cur.drawTs);
  }
  while (s.next < s.cur) {
    const r = getR(s.next);
    if (r.status === 'empty' || r.status === 'done') s.next++;
    else break;
  }
  return s;
}

// Calcule les gains et paie la commission, une fois tous les achats comptés.
function finalize(r, c, s) {
  const S = big(r.sales), P = big(r.price), J = big(s.jackpot);
  const [n3, n4, n5] = r.cnt.map(big);
  const commission = big(r.commission);              // déjà versée, achat par achat
  const pj = (S * SHARE_JACKPOT) / BPS;               // part jackpot du tour
  const F = S - commission - pj;                      // caisse des gains fixes (50 %)
  let g3 = (P * 5n) / 2n, g4 = P * 25n, g5 = 0n;      // gains fixes : 2,5 et 25 mises
  const due = n3 * g3 + n4 * g4;
  if (due > F) { g3 = (g3 * F) / due; g4 = (g4 * F) / due; }   // caisse insuffisante
  const fixed = n3 * g3 + n4 * g4;
  if (n5 > 0n) {
    g5 = (pj + J) / n5;
    // un 4 bons ne touche jamais plus que 80 % d'un 5 bons (petit jackpot)
    if (g4 * 5n > g5 * 4n) { g3 = (g3 * g5 * 4n) / (g4 * 5n); g4 = (g5 * 4n) / 5n; }
  } else if (fixed > 0n) {
    // pas de jackpot gagné : bonus = moitié de la part jackpot du tour
    g3 += (g3 * pj) / (fixed * 2n);
    g4 += (g4 * pj) / (fixed * 2n);
  }
  const per = [g3, g4, g5].map(String);
  const owed = n3 * g3 + n4 * g4 + n5 * g5;
  const carry = J + S - commission - owed;            // tout le reste → jackpot suivant
  r.per = per;
  r.jackpotIn = J.toString();
  r.carryOut = carry.toString();
  r.status = 'done';
  putR(r);
  s.jackpot = carry.toString();
  s.owed = (big(s.owed) + owed).toString();
  s.next = r.id + 1;
  jset('st', s);
  emit('Finalized', {
    round: String(r.id), nums: JSON.stringify(r.nums), counts: JSON.stringify(r.cnt), per: JSON.stringify(per),
    jackpotIn: r.jackpotIn, carryOut: r.carryOut, commission: r.commission, airdrop: r.airdrop,
  });
}

// Gain total d'un achat et nombre de grilles gagnantes à 3, 4, 5 bons.
function prizeOf(r, p) {
  let t = 0n;
  const w = [0, 0, 0];
  for (const g of p.g) {
    const k = matches(g, r.nums);
    if (k >= 3) { t += big(r.per[k - 3]); w[k - 3]++; }
  }
  return [t, w];
}

// Paie un achat gagnant d'un tour terminé. Renvoie le montant payé.
function payOne(r, i, s) {
  const p = getP(r.id, i);
  if (p.paid) return 0n;
  const [prize, w] = prizeOf(r, p);
  if (prize === 0n) return 0n;
  p.paid = true;
  jset('p:' + r.id + ':' + i, p);
  s.owed = (big(s.owed) - prize).toString();
  s.tot.prizes = (big(s.tot.prizes) + prize).toString();
  transfer(p.b, prize.toString());
  // "bons" = meilleur résultat de l'achat ; "wins" = grilles gagnantes à 3, 4, 5 bons
  emit('Paid', { round: String(r.id), idx: String(i), to: p.b, amount: prize.toString(), bons: String(w[2] ? 5 : w[1] ? 4 : 3), wins: JSON.stringify(w) });
  return prize;
}

function batchRange(from, count, total) {
  const a = Number(from), n = Number(count);
  assert(Number.isInteger(a) && a >= 0, 'invalid start');
  assert(Number.isInteger(n) && n > 0 && n <= MAX_BATCH, 'count: 1 to ' + MAX_BATCH);
  return [a, Math.min(total, a + n)];
}

({
  // ===================================================================
  //  INITIALISATION (une seule fois, via --init-args au déploiement)
  //  payOwner / payCollab : wallets qui reçoivent la commission
  //  collabAdmin          : wallet du collaborateur (gère SA chaîne)
  //  tipOwner / tipCollab : bouts des deux chaînes de secrets (64 hexa)
  // ===================================================================
  init(payOwner, payCollab, collabAdmin, tipOwner, tipCollab, payAirdrop) {
    noValue();
    assert(!storage.get('cfg'), 'already initialized');
    assert(isSecret(tipOwner) && isSecret(tipCollab), 'invalid tips');
    assert(tipOwner !== tipCollab, 'identical tips');
    const c = {
      admin: sender(),
      payOwner: addr(payOwner), payCollab: addr(payCollab), collabAdmin: addr(collabAdmin), payAirdrop: addr(payAirdrop),
      price: (10n ** 18n).toString(),        // 1 ASE
      maxGrids: 20, maxRound: 1000,          // grilles max par achat / par tirage (2 002 combinaisons : jamais toutes)
      maxn: MAXN,                            // numéros 1..maxn (lu par le site)
      drawH: 21, drawM: 0,                   // 21h00 Paris
      closeMin: 10, revealMin: 120,          // fermeture 10 min avant ; alerte du croupier si pas révélé en 2 h
      paused: false,
    };
    jset('cfg', c);
    const s = {
      cur: 1, next: 1, jackpot: '0', owed: '0', tipO: tipOwner, tipC: tipCollab,
      tot: { sales: '0', grids: 0, buys: 0, commission: '0', prizes: '0', refunds: '0' },
    };
    newRound(1, c, 0);
    jset('st', s);
    emit('Init', { admin: c.admin, payOwner: c.payOwner, payCollab: c.payCollab, collabAdmin: c.collabAdmin });
    return true;
  },

  // ===================================================================
  //  JOUER : grids = [[5 numéros], …], seed = graine joueur (hexa, option)
  //  Joindre exactement prix × nombre de grilles.
  // ===================================================================
  buy(grids, seed) {
    const c = cfg();
    let s = st();
    assert(c, 'not initialized');
    assert(!c.paused, 'game paused');
    s = sync(c, s);
    const r = getR(s.cur);
    assert(r.status === 'open' && nowMs() < r.closeTs, 'sales closed');
    assert(Array.isArray(grids) && grids.length >= 1, 'no ticket');
    assert(grids.length <= c.maxGrids && grids.length <= MAX_GRIDS_HARD, 'too many tickets (max ' + c.maxGrids + ')');
    assert(r.grids + grids.length <= c.maxRound, 'draw full (' + c.maxRound + ' tickets)');
    const clean = grids.map(cleanGrid);
    const cost = big(r.price) * big(clean.length);
    assert(big(msg.value || 0) === cost, 'wrong amount, expected: ' + cost.toString() + ' wei');
    const sd = seed === undefined || seed === null ? '' : String(seed).toLowerCase();
    assert(/^[0-9a-f]{0,64}$/.test(sd), 'invalid seed');
    const who = sender();
    const i = r.buys;
    jset('p:' + r.id + ':' + i, { b: who, g: clean, s: sd, paid: false, t: nowMs() });
    r.digest = sha256Text(r.digest + '|' + who + '|' + JSON.stringify(clean) + '|' + sd + '|' + i);
    r.buys = i + 1;
    r.grids += clean.length;
    r.sales = (big(r.sales) + cost).toString();
    // Commission prélevée tout de suite : moitié Airdrop, moitié équipe 75/25
    const com = (cost * SHARE_COMMISSION) / BPS, cDrop = com / 2n, cOwner = ((com - cDrop) * OWNER_CUT) / BPS;
    r.commission = (big(r.commission) + com).toString();
    r.airdrop = (big(r.airdrop) + cDrop).toString();
    putR(r);
    s.tot.sales = (big(s.tot.sales) + cost).toString();
    s.tot.commission = (big(s.tot.commission) + com).toString();
    s.tot.grids += clean.length;
    s.tot.buys += 1;
    jset('st', s);
    if (cOwner > 0n) transfer(c.payOwner, cOwner.toString());
    if (com - cDrop > cOwner) transfer(c.payCollab, (com - cDrop - cOwner).toString());
    if (cDrop > 0n) transfer(c.payAirdrop, cDrop.toString());
    emit('Buy', { round: String(r.id), idx: String(i), buyer: who, grids: JSON.stringify(clean), seed: sd, value: cost.toString() });
    return { round: r.id, idx: i };
  },

  // Fait avancer les tours (ferme / ouvre) — appelable par tous.
  poke() {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    jset('st', s);
    return { cur: s.cur, next: s.next };
  },

  // ===================================================================
  //  TIRAGE (croupier) : reveal('owner', …) puis reveal('collab', …),
  //  puis tally(…) jusqu'à la fin. Les révélations ne sont acceptées
  //  qu'APRÈS la fermeture des ventes, et celle du collaborateur
  //  seulement après celle de l'owner.
  // ===================================================================
  reveal(who, roundId, secret) {
    noValue();
    const s = sync(cfg(), st());
    const r = getR(Number(roundId));
    const o = who === 'owner';
    assert(o || who === 'collab', 'who: owner or collab');
    assert(r.id === s.next, 'draw first round ' + s.next);
    assert(r.status === 'closed', 'status: ' + r.status);
    assert(o ? !r.sO : r.sO && !r.sC, o ? 'already revealed' : 'owner first, or already revealed');
    const sec = String(secret).toLowerCase();
    assert(isSecret(sec) && chainOk(sec, o ? s.tipO : s.tipC), 'invalid secret');
    if (o) { r.sO = sec; s.tipO = sec; }
    else { r.sC = sec; s.tipC = sec; r.nums = drawNumbers(r.id, r.sO, sec, r.digest); r.status = 'tally'; }
    putR(r);
    jset('st', s);
    emit('Reveal', { round: String(r.id), who, secret: sec });
    if (!o) emit('Drawn', { round: String(r.id), nums: JSON.stringify(r.nums), digest: r.digest });
    return true;
  },

  // Compte les gagnants par paquets ; finalise quand tout est compté.
  tally(roundId, count) {
    noValue();
    const c = cfg();
    const s = st();
    const r = getR(Number(roundId));
    assert(r.status === 'tally', 'status: ' + r.status);
    const [a, b] = batchRange(r.cursor, count, r.buys);
    for (let i = a; i < b; i++) {
      const p = getP(r.id, i);
      for (const g of p.g) {
        const k = matches(g, r.nums);
        if (k >= 3) r.cnt[k - 3]++;
      }
    }
    r.cursor = b;
    if (b >= r.buys) { finalize(r, c, s); return { done: true }; }
    putR(r);
    return { done: false, cursor: b, total: r.buys };
  },

  // ===================================================================
  //  PAIEMENTS
  // ===================================================================
  // Le croupier (ou n'importe qui) règle un tour par paquets : paie les
  // gagnants d'un tour tiré.
  // Reprendre à "next" tant que next < total. L'argent va toujours à
  // l'acheteur : un joueur peut régler SON achat avec settle(tour, idx, 1).
  settle(roundId, from, count) {
    noValue();
    const s = st();
    const r = getR(Number(roundId));
    assert(r.status === 'done', 'nothing to settle');
    const [a, b] = batchRange(from, count, r.buys);
    let total = 0n, n = 0, i = a;
    for (; i < b && n < MAX_PAYS; i++) {
      const x = payOne(r, i, s);
      if (x > 0n) { total += x; n++; }
    }
    jset('st', s);
    return { amount: total.toString(), next: i, total: r.buys };
  },
  // ===================================================================
  //  ADMIN (owner uniquement). Aucune ne touche aux fonds des joueurs.
  //  Prix et horaires s'appliquent aux tours OUVERTS ENSUITE.
  // ===================================================================
  setPaused(on) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.paused = on === true || on === 'true';
    jset('cfg', c);
    emit('Paused', { paused: String(c.paused) });
    return c.paused;
  },
  // Réglages du jeu en un seul appel (valeurs actuelles pour ce qui ne change pas).
  // S'appliquent au tour en cours s'il n'a encore aucune grille, sinon au suivant.
  // prix en wei, heure/minute du tirage (Paris), plafond de grilles par achat,
  // fermeture des ventes (min avant le tirage), délai de révélation (min).
  setConfig(price, drawH, drawM, maxGrids, closeMin, revealMin, maxRound) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const v = big(price), H = Number(drawH), M = Number(drawM), G = Number(maxGrids), A = Number(closeMin), B = Number(revealMin);
    const T = maxRound === undefined ? c.maxRound : Number(maxRound);
    const ok = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    assert(v >= 10n ** 16n && v <= 10n ** 21n, 'price: 0.01 to 1000 ASE');
    assert(ok(H, 6, 23) && ok(M, 0, 59), 'time: 06:00 to 23:59');
    assert(ok(G, 1, MAX_GRIDS_HARD), 'tickets per purchase: 1 to ' + MAX_GRIDS_HARD);
    assert(ok(A, 2, 60), 'closing: 2 to 60 min');
    assert(ok(B, 30, 1440), 'reveal: 30 to 1440 min');
    assert(ok(T, G, 1500), 'tickets per draw: ' + G + ' to 1500');   // < 2 002 combinaisons
    Object.assign(c, { price: v.toString(), drawH: H, drawM: M, maxGrids: G, closeMin: A, revealMin: B, maxRound: T });
    jset('cfg', c);
    // Si personne n'a encore joué le tour en cours, il prend les nouveaux
    // réglages tout de suite (horaire, prix, délais) ; sinon au tour suivant.
    const s = sync(c, st());
    const r = getR(s.cur);
    if (r.status === 'open' && r.grids === 0) newRound(r.id, c, 0);
    jset('st', s);
    emit('Config', { key: 'game', value: JSON.stringify([c.price, H, M, G, A, B, T]) });
    return true;
  },
  // Ajout volontaire d'ASE au jackpot (promotion…).
  fund() {
    const v = big(msg.value || 0);
    assert(v > 0n, 'send some ASE');
    const s = st();
    s.jackpot = (big(s.jackpot) + v).toString();
    jset('st', s);
    emit('Funded', { from: sender(), value: v.toString() });
    return s.jackpot;
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
  // Renouveler une chaîne de secrets (épuisée ou compromise) : seulement
  // quand aucun tour n'attend de révélation. Chacun gère SA chaîne.
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

  // ===================================================================
  //  LECTURES (gratuites)
  // ===================================================================
  getConfig() { return cfg(); },
  getState() { return st(); },
  getRound(roundId) { return jget('r:' + Number(roundId), null); },
  getPurchases(roundId, from, count) {
    const r = getR(Number(roundId));
    const [a, b] = batchRange(from, count, r.buys);
    const out = [];
    for (let i = a; i < b; i++) {
      const p = getP(r.id, i);
      const [prize, w] = r.status === 'done' ? prizeOf(r, p) : [0n, [0, 0, 0]];
      out.push({ idx: i, b: p.b, g: p.g, s: p.s || '', paid: p.paid, prize: prize.toString(), w, t: p.t || 0 });
    }
    return out;
  },
  // Résumé pour la page d'accueil.
  info() {
    const c = cfg();
    const s = st();
    const r = getR(s.cur);
    const t = nowMs();
    let pending = 0n;     // part jackpot des tours fermés pas encore tirés
    for (let id = s.next; id < s.cur; id++) {
      const x = getR(id);
      if (x.status === 'closed' || x.status === 'tally') pending += (big(x.sales) * SHARE_JACKPOT) / BPS;
    }
    const jackpotNow = big(s.jackpot) + pending + (big(r.sales) * SHARE_JACKPOT) / BPS;
    return {
      now: String(t), paused: c.paused, round: r.id, status: t >= r.closeTs ? 'closing' : r.status,
      drawTs: String(r.drawTs), closeTs: String(r.closeTs), price: r.price, maxGrids: c.maxGrids, maxRound: c.maxRound,
      grids: r.grids, sales: r.sales, jackpotCarried: s.jackpot, jackpotEstimate: jackpotNow.toString(),
      nextToDraw: s.next, owed: s.owed, totals: s.tot,
    };
  },
});
