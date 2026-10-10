// =====================================================================
//  LOTO ASE — loto à numéros, pari mutuel, testnet Asentum
// =====================================================================
//  Règles :
//   - Grille = 5 numéros distincts entre 1 et 18. Prix par défaut : 2 ASE.
//   - Un tirage par jour (21h00 heure de Paris par défaut, heure d'été
//     gérée). Les ventes ferment 10 min avant ; le tour suivant s'ouvre.
//   - Répartition des ventes d'un tour :
//       5 %  commission (80 % owner, 20 % collaborateur)
//       40 % jackpot (5 bons)  + reports des tours précédents
//       20 % rang 4 bons
//       35 % rang 3 bons
//     Chaque rang est partagé à parts égales entre ses gagnants.
//     Rang sans gagnant → sa part s'ajoute au jackpot suivant.
//   - Hasard : double secret en chaîne (owner puis collaborateur),
//     révélés APRÈS la fermeture des ventes. Numéros =
//     SHA-256("LOTOASE|tour|secretOwner|secretCollab|empreinteDesGrilles").
//     Si les secrets ne sont pas révélés à temps → tour annulé, chaque
//     joueur est remboursé à 100 %.
//
//  Sécurité :
//   - Aucune fonction ne permet à l'admin de retirer des fonds. Seule la
//     commission (5 %) est envoyée, automatiquement, à la fin d'un tirage.
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
const MAXN = 18;                // numéros possibles : 1..18
const BPS = 10000n;             // base des pourcentages (10000 = 100 %)
const SHARE_COMMISSION = 500n;  // 5 %
const SHARE_JACKPOT = 4000n;    // 40 %
const SHARE_R4 = 2000n;         // 20 %
const SHARE_R3 = 3500n;         // 35 %
const OWNER_CUT = 8000n;        // 80 % de la commission pour l'owner
const DAY = 86400000;           // un jour en ms
const HOUR = 3600000;
const MAX_GRIDS_HARD = 50;      // plafond absolu de grilles par achat
const MAX_CHAIN_SKIP = 30;      // tours sautés tolérés dans une chaîne de secrets
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
function noValue() { assert(big(msg.value || 0) === 0n, 'pas d\'ASE ici'); }
function sender() { return String(msg.sender).toLowerCase(); }

// --- Adresses : le contrat n'accepte que "0x…" (40 hexa). Le site, le
// croupier et le guide convertissent les adresses "ase1…" avant l'envoi
// (taille du contrat limitée : voir RESULTATS-SONDE.md).
function addr(a) {
  const s = String(a).trim().toLowerCase();
  assert(/^0x[0-9a-f]{40}$/.test(s), 'adresse 0x attendue : ' + a);
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
  assert(s.length % 2 === 0 && /^[0-9a-f]*$/.test(s), 'hexa invalide');
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

// Numéros gagnants : 5 numéros distincts dans 1..18, tirage uniforme
// (on rejette les octets ≥ 252 = 14 × 18 pour éviter tout biais).
function drawNumbers(roundId, sO, sC, digest) {
  let seed = sha256Text('LOTOASE|' + roundId + '|' + sO + '|' + sC + '|' + digest);
  const nums = [];
  while (nums.length < PICK) {
    const bytes = hexToBytes(seed);
    for (const b of bytes) {
      if (nums.length >= PICK) break;
      if (b >= 252) continue;
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

// Vérifie une grille : 5 entiers distincts entre 1 et 18 → triée.
function cleanGrid(g) {
  assert(Array.isArray(g) && g.length === PICK, 'une grille = ' + PICK + ' numéros');
  const out = [];
  for (const x of g) {
    const n = Number(x);
    assert(Number.isInteger(n) && n >= 1 && n <= MAXN, 'numéro hors plage (1 à ' + MAXN + ') : ' + x);
    assert(out.indexOf(n) < 0, 'numéro en double : ' + n);
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
function yearOfDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const y = yoe + era * 400;
  return mp >= 10 ? y + 1 : y;
}
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
function getR(id) { const r = jget('r:' + id, null); assert(r, 'tour inconnu'); return r; }
function putR(r) { jset('r:' + r.id, r); }
function getP(id, i) { const p = jget('p:' + id + ':' + i, null); assert(p, 'achat inconnu'); return p; }
function onlyAdmin(c) { assert(sender() === c.admin, 'réservé à l\'admin'); }

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
    jackpotIn: null, carryOut: null, commission: null,
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
    if (r.status === 'empty' || r.status === 'done' || r.status === 'cancelled') s.next++;
    else break;
  }
  return s;
}

// Calcule les rangs et paie la commission, une fois tous les achats comptés.
function finalize(r, c, s) {
  const S = big(r.sales);
  const commission = (S * SHARE_COMMISSION) / BPS;
  const cOwner = (commission * OWNER_CUT) / BPS;
  const cCollab = commission - cOwner;
  const jackpotIn = big(s.jackpot);
  const p4 = (S * SHARE_R4) / BPS;
  const p3 = (S * SHARE_R3) / BPS;
  const pj = (S * SHARE_JACKPOT) / BPS;
  const rest = S - commission - pj - p4 - p3;           // arrondis → jackpot
  const pools = [p3, p4, pj + rest + jackpotIn];        // rangs 3, 4, 5 bons
  let carry = 0n, owed = 0n;
  const per = [];
  for (let k = 0; k < 3; k++) {
    const n = big(r.cnt[k]);
    if (n > 0n) {
      const each = pools[k] / n;
      per.push(each.toString());
      owed += each * n;
      carry += pools[k] - each * n;                    // poussière d'arrondi
    } else {
      per.push('0');
      carry += pools[k];                               // rang sans gagnant
    }
  }
  r.per = per;
  r.jackpotIn = jackpotIn.toString();
  r.carryOut = carry.toString();
  r.commission = commission.toString();
  r.status = 'done';
  putR(r);
  s.jackpot = carry.toString();
  s.owed = (big(s.owed) + owed).toString();
  s.tot.commission = (big(s.tot.commission) + commission).toString();
  s.next = r.id + 1;
  jset('st', s);
  // Envois APRÈS l'enregistrement de l'état.
  if (cOwner > 0n) transfer(c.payOwner, cOwner.toString());
  if (cCollab > 0n) transfer(c.payCollab, cCollab.toString());
  emit('Finalized', {
    round: String(r.id), nums: JSON.stringify(r.nums), counts: JSON.stringify(r.cnt), per: JSON.stringify(per),
    jackpotIn: r.jackpotIn, carryOut: r.carryOut, commission: r.commission,
    toOwner: cOwner.toString(), toCollab: cCollab.toString(),
  });
}

// Gain total d'un achat (somme sur ses grilles).
function prizeOfPurchase(r, p) {
  let total = 0n;
  for (const g of p.g) {
    const k = matches(g, r.nums);
    if (k >= 3) total += big(r.per[k - 3]);
  }
  return total;
}

// Paie un achat gagnant d'un tour terminé. Renvoie le montant payé.
function payOne(r, i, s) {
  const p = getP(r.id, i);
  if (p.paid) return 0n;
  const prize = prizeOfPurchase(r, p);
  if (prize === 0n) return 0n;
  p.paid = true;
  jset('p:' + r.id + ':' + i, p);
  s.owed = (big(s.owed) - prize).toString();
  s.tot.prizes = (big(s.tot.prizes) + prize).toString();
  transfer(p.b, prize.toString());
  emit('Paid', { round: String(r.id), idx: String(i), to: p.b, amount: prize.toString() });
  return prize;
}

// Rembourse un achat d'un tour annulé. Renvoie le montant remboursé.
function refundOne(r, i, s) {
  const p = getP(r.id, i);
  if (p.paid) return 0n;
  const amount = big(r.price) * big(p.g.length);
  p.paid = true;
  jset('p:' + r.id + ':' + i, p);
  s.owed = (big(s.owed) - amount).toString();
  s.tot.refunds = (big(s.tot.refunds) + amount).toString();
  transfer(p.b, amount.toString());
  emit('Refunded', { round: String(r.id), idx: String(i), to: p.b, amount: amount.toString() });
  return amount;
}

function cancelRound(r, s, reason) {
  r.status = 'cancelled';
  putR(r);
  s.owed = (big(s.owed) + big(r.sales)).toString();
  emit('Cancelled', { round: String(r.id), reason, sales: r.sales });
}

function batchRange(from, count, total) {
  const a = Number(from), n = Number(count);
  assert(Number.isInteger(a) && a >= 0, 'début invalide');
  assert(Number.isInteger(n) && n > 0 && n <= MAX_BATCH, 'nombre : 1 à ' + MAX_BATCH);
  return [a, Math.min(total, a + n)];
}

({
  // ===================================================================
  //  INITIALISATION (une seule fois, via --init-args au déploiement)
  //  payOwner / payCollab : wallets qui reçoivent la commission
  //  collabAdmin          : wallet du collaborateur (gère SA chaîne)
  //  tipOwner / tipCollab : bouts des deux chaînes de secrets (64 hexa)
  // ===================================================================
  init(payOwner, payCollab, collabAdmin, tipOwner, tipCollab) {
    noValue();
    assert(!storage.get('cfg'), 'déjà initialisé');
    assert(isSecret(tipOwner) && isSecret(tipCollab), 'bouts invalides');
    assert(tipOwner !== tipCollab, 'bouts identiques');
    const c = {
      admin: sender(),
      payOwner: addr(payOwner), payCollab: addr(payCollab), collabAdmin: addr(collabAdmin),
      price: (2n * 10n ** 18n).toString(),   // 2 ASE
      maxGrids: 20, drawH: 21, drawM: 0,     // 21h00 Paris
      closeMin: 10, revealMin: 120,          // fermeture 10 min avant, 2 h pour révéler
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
    assert(c, 'non initialisé');
    assert(!c.paused, 'jeu en pause');
    s = sync(c, s);
    const r = getR(s.cur);
    assert(r.status === 'open' && nowMs() < r.closeTs, 'ventes fermées');
    assert(Array.isArray(grids) && grids.length >= 1, 'aucune grille');
    assert(grids.length <= c.maxGrids && grids.length <= MAX_GRIDS_HARD, 'trop de grilles (max ' + c.maxGrids + ')');
    const clean = grids.map(cleanGrid);
    const cost = big(r.price) * big(clean.length);
    assert(big(msg.value || 0) === cost, 'montant attendu : ' + cost.toString() + ' wei');
    const sd = seed === undefined || seed === null ? '' : String(seed).toLowerCase();
    assert(/^[0-9a-f]{0,64}$/.test(sd), 'graine invalide');
    const who = sender();
    const i = r.buys;
    jset('p:' + r.id + ':' + i, { b: who, g: clean, s: sd, paid: false });
    r.digest = sha256Text(r.digest + '|' + who + '|' + JSON.stringify(clean) + '|' + sd + '|' + i);
    r.buys = i + 1;
    r.grids += clean.length;
    r.sales = (big(r.sales) + cost).toString();
    putR(r);
    s.tot.sales = (big(s.tot.sales) + cost).toString();
    s.tot.grids += clean.length;
    s.tot.buys += 1;
    jset('st', s);
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
    assert(o || who === 'collab', 'who : owner ou collab');
    assert(r.id === s.next, 'tirer d\'abord le tour ' + s.next);
    assert(r.status === 'closed', 'statut : ' + r.status);
    assert(nowMs() < r.closeTs + r.revealMin * 60000, 'délai dépassé');
    assert(o ? !r.sO : r.sO && !r.sC, o ? 'déjà révélé' : 'owner d\'abord, ou déjà révélé');
    const sec = String(secret).toLowerCase();
    assert(isSecret(sec) && chainOk(sec, o ? s.tipO : s.tipC), 'secret invalide');
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
    assert(r.status === 'tally', 'statut : ' + r.status);
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

  // Annule un tour dont les secrets n'ont pas été révélés à temps.
  // Appelable par TOUT LE MONDE → les joueurs ne dépendent pas du croupier.
  cancelExpired(roundId) {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    const r = getR(Number(roundId));
    assert(r.status === 'closed', 'statut : ' + r.status);
    assert(nowMs() >= r.closeTs + r.revealMin * 60000, 'trop tôt');
    cancelRound(r, s, 'timeout');
    sync(c, s);
    jset('st', s);
    return true;
  },

  // ===================================================================
  //  PAIEMENTS
  // ===================================================================
  // Le croupier (ou n'importe qui) règle un tour par paquets : paie les
  // gagnants d'un tour tiré, ou rembourse les joueurs d'un tour annulé.
  // Reprendre à "next" tant que next < total.
  settle(roundId, from, count) {
    noValue();
    const s = st();
    const r = getR(Number(roundId));
    const pay = r.status === 'done';
    assert(pay || r.status === 'cancelled', 'rien à régler');
    const [a, b] = batchRange(from, count, r.buys);
    let total = 0n, n = 0, i = a;
    for (; i < b && n < MAX_PAYS; i++) {
      const x = pay ? payOne(r, i, s) : refundOne(r, i, s);
      if (x > 0n) { total += x; n++; }
    }
    jset('st', s);
    return { amount: total.toString(), next: i, total: r.buys };
  },
  // Un joueur réclame son gain, ou son remboursement si le tour est annulé.
  // L'argent va toujours à l'acheteur, quel que soit l'appelant.
  claim(roundId, idx) {
    noValue();
    const s = st();
    const r = getR(Number(roundId));
    const pay = r.status === 'done';
    assert(pay || r.status === 'cancelled', 'rien à réclamer');
    const x = pay ? payOne(r, Number(idx), s) : refundOne(r, Number(idx), s);
    assert(x > 0n, 'rien à réclamer');
    jset('st', s);
    return x.toString();
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
  setConfig(price, drawH, drawM, maxGrids, closeMin, revealMin) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const v = big(price), H = Number(drawH), M = Number(drawM), G = Number(maxGrids), A = Number(closeMin), B = Number(revealMin);
    const ok = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    assert(v >= 10n ** 16n && v <= 10n ** 21n, 'prix : 0,01 à 1000 ASE');
    assert(ok(H, 6, 23) && ok(M, 0, 59), 'heure : 6h00 à 23h59');
    assert(ok(G, 1, MAX_GRIDS_HARD), 'grilles par achat : 1 à ' + MAX_GRIDS_HARD);
    assert(ok(A, 2, 60), 'fermeture : 2 à 60 min');
    assert(ok(B, 30, 1440), 'révélation : 30 à 1440 min');
    Object.assign(c, { price: v.toString(), drawH: H, drawM: M, maxGrids: G, closeMin: A, revealMin: B });
    jset('cfg', c);
    // Si personne n'a encore joué le tour en cours, il prend les nouveaux
    // réglages tout de suite (horaire, prix, délais) ; sinon au tour suivant.
    const s = sync(c, st());
    const r = getR(s.cur);
    if (r.status === 'open' && r.grids === 0) newRound(r.id, c, 0);
    jset('st', s);
    emit('Config', { key: 'game', value: JSON.stringify([c.price, H, M, G, A, B]) });
    return true;
  },
  setPayouts(payOwner, payCollab) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.payOwner = addr(payOwner);
    c.payCollab = addr(payCollab);
    jset('cfg', c);
    emit('Config', { key: 'payouts', value: c.payOwner + ',' + c.payCollab });
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
  // Annulation d'urgence (avec remboursement) : seulement AVANT toute
  // révélation, donc quand PERSONNE ne peut connaître le résultat.
  emergencyCancel(roundId) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    let s = st();
    const r = getR(Number(roundId));
    assert(r.status === 'open' || r.status === 'closed', 'statut : ' + r.status);
    assert(!r.sO && !r.sC, 'secret déjà révélé');
    cancelRound(r, s, 'admin');
    if (r.id === s.cur) { s.cur = r.id + 1; newRound(s.cur, c, r.drawTs); }
    s = sync(c, s);
    jset('st', s);
    return true;
  },
  // Renouveler une chaîne de secrets (épuisée ou compromise) : seulement
  // quand aucun tour n'attend de révélation. Chacun gère SA chaîne.
  setTipOwner(tip) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const s = sync(c, st());
    assert(getR(s.next).status === 'open', 'tirage en attente');
    assert(isSecret(tip) && tip !== s.tipC, 'bout invalide');
    s.tipO = tip;
    jset('st', s);
    emit('Config', { key: 'tipOwner', value: tip });
    return true;
  },
  setTipCollab(tip) {
    noValue();
    const c = cfg();
    assert(sender() === c.collabAdmin, 'réservé au collaborateur');
    const s = sync(c, st());
    assert(getR(s.next).status === 'open', 'tirage en attente');
    assert(isSecret(tip) && tip !== s.tipO, 'bout invalide');
    s.tipC = tip;
    jset('st', s);
    emit('Config', { key: 'tipCollab', value: tip });
    return true;
  },
  setCollabAdmin(newAddr) {
    noValue();
    const c = cfg();
    assert(sender() === c.collabAdmin, 'réservé au collaborateur');
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
      const prize = r.status === 'done' ? prizeOfPurchase(r, p).toString() : '0';
      out.push({ idx: i, b: p.b, g: p.g, s: p.s || '', paid: p.paid, prize });
    }
    return out;
  },
  // Résumé pour la page d'accueil.
  info() {
    const c = cfg();
    const s = st();
    const r = getR(s.cur);
    const t = nowMs();
    let pending = 0n;     // 40 % des tours fermés pas encore tirés (part jackpot)
    for (let id = s.next; id < s.cur; id++) {
      const x = getR(id);
      if (x.status === 'closed' || x.status === 'tally') pending += (big(x.sales) * SHARE_JACKPOT) / BPS;
    }
    const jackpotNow = big(s.jackpot) + pending + (big(r.sales) * SHARE_JACKPOT) / BPS;
    return {
      now: String(t), paused: c.paused, round: r.id, status: t >= r.closeTs ? 'closing' : r.status,
      drawTs: String(r.drawTs), closeTs: String(r.closeTs), price: r.price, maxGrids: c.maxGrids,
      grids: r.grids, sales: r.sales, jackpotCarried: s.jackpot, jackpotEstimate: jackpotNow.toString(),
      nextToDraw: s.next, owed: s.owed, totals: s.tot,
    };
  },
});
