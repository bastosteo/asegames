// =====================================================================
//  ASE AIRDROP — tirage hebdomadaire des frais du loto et de la tombola
// =====================================================================
//  Règles :
//   - Les contrats ASE Loto et ASE Raffle envoient ici la moitié de leur
//     commission (7,5 % des ventes) à chaque tirage réussi.
//   - Chaque dimanche à 21h00 (heure de Paris), tirage au sort de la
//     cagnotte de la semaine : 1er 50 %, 2e 30 %, 3e 20 %, 3 wallets
//     DIFFÉRENTS. Chances : 1 grille de loto ou 1 ticket de tombola de la
//     semaine = 1 chance.
//   - La liste des participants est calculée à partir des données publiques
//     des deux jeux (tirages réussis dont l'heure est dans la semaine) par
//     l'opérateur, puis envoyée ici AVANT les secrets ; le site la recalcule
//     pour que chacun puisse vérifier.
//   - Hasard : double secret en chaîne (owner puis collaborateur), révélés
//     APRÈS la liste. Gagnant k : ticket = SHA-256("ASEDROP|tour|sO|sC|
//     empreinte|k") mod tickets restants (les wallets déjà gagnants sont
//     retirés : jamais deux fois le même wallet).
//   - Les prix sont envoyés directement aux gagnants. Une part sans gagnant
//     (moins de 3 wallets) reste dans la cagnotte pour la semaine suivante.
//   - Tirage non fait en 6 h → annulé ; la semaine est reprise (participants
//     et frais) dans le tirage suivant.
//
//  Sécurité : aucune fonction de retrait ; état enregistré AVANT chaque
//  envoi d'ASE ; montants en BigInt (wei) stockés en texte.
// =====================================================================

const BPS = 10000n;
const SPLIT = [5000n, 3000n];   // 1er 50 %, 2e 30 %, 3e = le reste (20 %)
const WINNERS = 3;
const DAY = 86400000;
const HOUR = 3600000;
const MAX_CHAIN_SKIP = 1;
const MAX_CHUNK = 100;          // participants par envoi de liste

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

// Prochain tirage (jour de semaine wd, 0 = dimanche, heure de Paris h:m)
// strictement après t (ms UTC).
function nextDrawAfter(t, wd, h, m) {
  let d = Math.floor(t / DAY) - 1;
  for (let i = 0; i < 10; i++, d++) {
    if ((((d + 4) % 7) + 7) % 7 !== wd) continue;     // 1970-01-01 = jeudi
    const local = d * DAY + (h * 60 + m) * 60000;
    const x = local - parisOffsetMs(local - 2 * HOUR);
    if (x > t) return x;
  }
  assert(false, 'date');
}

// ---------------------------------------------------------------------
//  État
//   cfg            réglages          st          état global
//   r:<id>         un tirage         e:<id>:<j>  morceau j de la liste
// ---------------------------------------------------------------------
function cfg() { return jget('cfg', null); }
function st() { return jget('st', null); }
function getR(id) { const r = jget('r:' + id, null); assert(r, 'unknown airdrop'); return r; }
function putR(r) { jset('r:' + r.id, r); }
function onlyAdmin(c) { assert(sender() === c.admin, 'admin only'); }
function onlyOperator(c) { assert(sender() === c.operator || sender() === c.admin, 'operator only'); }
function initDigest(id) { return sha256Text('ASEDROP-ROUND|' + id); }

function newRound(id, c, after) {
  const r = {
    id, status: 'open', revealMin: c.revealMin,
    drawTs: nextDrawAfter(Math.max(after, nowMs()), c.drawDay, c.drawH, c.drawM),
    fromTs: 0, pot: '0', carryIn: '0', tickets: 0, wallets: 0, chunks: 0, last: '',
    digest: initDigest(id), sO: null, sC: null, win: null, prizes: null, carryOut: null,
  };
  putR(r);
  emit('RoundOpened', { round: String(id), drawTs: String(r.drawTs) });
  return r;
}

// Ferme le tirage en cours à l'heure, ouvre le suivant, avance "next".
function sync(c, s) {
  for (let k = 0; k < 8; k++) {
    const cur = getR(s.cur);
    if (cur.status !== 'open' || nowMs() < cur.drawTs) break;
    cur.status = 'closed';
    putR(cur);
    emit('RoundClosed', { round: String(cur.id), drawTs: String(cur.drawTs) });
    s.cur = cur.id + 1;
    newRound(s.cur, c, cur.drawTs);
  }
  while (s.next < s.cur) {
    const r = getR(s.next);
    if (r.status === 'done' || r.status === 'cancelled') s.next++;
    else break;
  }
  return s;
}

function deadline(r) { return r.drawTs + r.revealMin * 60000; }

// Liste complète [[adresse, tickets], …] (dans l'ordre des adresses).
function entries(r) {
  const all = [];
  for (let j = 0; j < r.chunks; j++) all.push(...jget('e:' + r.id + ':' + j, []));
  return all;
}

// 3 wallets différents, chances proportionnelles aux tickets ; un gagnant
// est retiré avant le tirage suivant.
function drawWinners(r) {
  const all = entries(r), out = {}, win = [];
  let rem = r.tickets;
  for (let k = 0; k < WINNERS && rem > 0; k++) {
    const h = sha256Text('ASEDROP|' + r.id + '|' + r.sO + '|' + r.sC + '|' + r.digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(rem));
    let x = t;
    for (const e of all) {
      if (out[e[0]]) continue;
      if (x < e[1]) { out[e[0]] = 1; win.push({ b: e[0], n: e[1], t }); rem -= e[1]; break; }
      x -= e[1];
    }
  }
  return win;
}

function finalize(r, s) {
  const total = big(r.pot) + big(s.carry);
  r.carryIn = s.carry;
  const p = [(total * SPLIT[0]) / BPS, (total * SPLIT[1]) / BPS];
  p.push(total - p[0] - p[1]);
  const win = r.tickets > 0 ? drawWinners(r) : [];
  let paid = 0n;
  for (let k = 0; k < win.length; k++) paid += p[k];
  r.win = win;
  r.prizes = p.map(String);
  r.carryOut = (total - paid).toString();
  r.status = 'done';
  putR(r);
  s.carry = r.carryOut;
  s.lastTs = r.drawTs;
  s.next = r.id + 1;
  s.tot.pots = (big(s.tot.pots) + big(r.pot)).toString();
  s.tot.paid = (big(s.tot.paid) + paid).toString();
  s.tot.rounds += 1;
  jset('st', s);
  for (let k = 0; k < win.length; k++) if (p[k] > 0n) transfer(win[k].b, p[k].toString());
  emit('Drawn', { round: String(r.id), winners: JSON.stringify(win), prizes: JSON.stringify(r.prizes), pot: r.pot, carry: r.carryOut });
}

({
  // INITIALISATION (une fois) : opérateur (envoie la liste de la semaine),
  // wallet du collaborateur (gère SA chaîne), bouts des deux chaînes.
  init(operator, collabAdmin, tipOwner, tipCollab) {
    noValue();
    assert(!storage.get('cfg'), 'already initialized');
    assert(isSecret(tipOwner) && isSecret(tipCollab) && tipOwner !== tipCollab, 'invalid tips');
    const c = {
      admin: sender(), operator: addr(operator), collabAdmin: addr(collabAdmin),
      drawDay: 0, drawH: 21, drawM: 0,         // dimanche 21h00 Paris
      revealMin: 360,
    };
    jset('cfg', c);
    const s = { cur: 1, next: 1, carry: '0', lastTs: 0, tipO: tipOwner, tipC: tipCollab, tot: { pots: '0', paid: '0', funded: '0', rounds: 0 } };
    newRound(1, c, 0);
    jset('st', s);
    emit('Init', { admin: c.admin });
    return true;
  },

  // Ajout volontaire d'ASE à la cagnotte (bonus, promotion…).
  fund() {
    const v = big(msg.value || 0);
    assert(v > 0n, 'send some ASE');
    const s = st();
    s.carry = (big(s.carry) + v).toString();
    s.tot.funded = (big(s.tot.funded) + v).toString();
    jset('st', s);
    emit('Funded', { from: sender(), value: v.toString() });
    return s.carry;
  },

  poke() {
    noValue();
    const s = sync(cfg(), st());
    jset('st', s);
    return { cur: s.cur, next: s.next };
  },

  // LISTE DE LA SEMAINE (opérateur), par morceaux de 100 participants au plus.
  // idx = n° du morceau (0 = recommencer la liste). entries = [[0x…, tickets], …]
  // triés par adresse. final = dernier morceau, avec pot = frais reçus (wei).
  submit(roundId, idx, entries, final, pot) {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    onlyOperator(c);
    const r = getR(Number(roundId));
    assert(r.id === s.next, 'draw first round ' + s.next);
    assert(r.status === 'closed', 'status: ' + r.status);
    assert(nowMs() < deadline(r), 'too late');
    const j = Number(idx);
    if (j === 0) { r.chunks = 0; r.tickets = 0; r.wallets = 0; r.last = ''; r.digest = initDigest(r.id); }
    assert(j === r.chunks, 'expected chunk ' + r.chunks);
    assert(Array.isArray(entries) && entries.length <= MAX_CHUNK, 'chunk: up to ' + MAX_CHUNK + ' entries');
    const clean = entries.map((e) => {
      assert(Array.isArray(e) && e.length === 2, 'entry: [address, tickets]');
      const a = addr(e[0]), n = Number(e[1]);
      assert(a > r.last, 'addresses must be sorted and unique');
      assert(Number.isInteger(n) && n >= 1 && n <= 1000000, 'invalid tickets');
      r.last = a; r.tickets += n; r.wallets++;
      return [a, n];
    });
    if (clean.length) {
      jset('e:' + r.id + ':' + j, clean);
      r.chunks = j + 1;
      r.digest = sha256Text(r.digest + '|' + JSON.stringify(clean));
    }
    r.fromTs = s.lastTs;
    if (final === true || final === 'true') {
      const P = big(pot);
      assert(P >= 0n && P <= 10n ** 27n, 'invalid pot');
      r.pot = P.toString();
      emit('Listed', { round: String(r.id), wallets: String(r.wallets), tickets: String(r.tickets), pot: r.pot, digest: r.digest, fromTs: String(r.fromTs) });
      if (r.tickets === 0) { finalize(r, s); return true; }
      r.status = 'listed';
    }
    putR(r);
    jset('st', s);
    return { chunks: r.chunks, wallets: r.wallets, tickets: r.tickets };
  },

  // TIRAGE (croupier) : reveal('owner', …) puis reveal('collab', …).
  reveal(who, roundId, secret) {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    const r = getR(Number(roundId));
    const o = who === 'owner';
    assert(o || who === 'collab', 'who: owner or collab');
    assert(r.id === s.next, 'draw first round ' + s.next);
    assert(r.status === 'listed', 'status: ' + r.status);
    assert(nowMs() < deadline(r), 'too late');
    assert(o ? !r.sO : r.sO && !r.sC, o ? 'already revealed' : 'owner first, or already revealed');
    const sec = String(secret).toLowerCase();
    assert(isSecret(sec) && chainOk(sec, o ? s.tipO : s.tipC), 'invalid secret');
    if (o) { r.sO = sec; s.tipO = sec; putR(r); jset('st', s); }
    else { r.sC = sec; s.tipC = sec; finalize(r, s); }
    emit('Reveal', { round: String(r.id), who, secret: sec });
    return true;
  },

  // Tirage non fait à temps : annulé, la semaine passe au tirage suivant.
  cancelExpired(roundId) {
    noValue();
    const c = cfg();
    const s = sync(c, st());
    const r = getR(Number(roundId));
    assert(r.status === 'closed' || r.status === 'listed', 'status: ' + r.status);
    assert(nowMs() >= deadline(r), 'too early');
    r.status = 'cancelled';
    putR(r);
    emit('Cancelled', { round: String(r.id), reason: 'timeout' });
    jset('st', sync(c, s));
    return true;
  },

  // ADMIN
  // jour (0 = dimanche … 6), heure, minute (Paris), délai du tirage (min).
  setConfig(drawDay, drawH, drawM, revealMin) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const D = Number(drawDay), H = Number(drawH), M = Number(drawM), B = Number(revealMin);
    const ok = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    assert(ok(D, 0, 6) && ok(H, 6, 23) && ok(M, 0, 59), 'day 0-6, time 06:00 to 23:59');
    assert(ok(B, 60, 2880), 'draw delay: 60 to 2880 min');
    Object.assign(c, { drawDay: D, drawH: H, drawM: M, revealMin: B });
    jset('cfg', c);
    const s = sync(c, st());
    const r = getR(s.cur);
    const prev = s.cur > 1 ? getR(s.cur - 1).drawTs : 0;
    r.drawTs = nextDrawAfter(Math.max(prev, nowMs()), D, H, M);
    r.revealMin = B;
    putR(r);
    jset('st', s);
    emit('Config', { key: 'schedule', value: JSON.stringify([D, H, M, B]) });
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
  setAdmin(newAdmin) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    c.admin = addr(newAdmin);
    jset('cfg', c);
    emit('Config', { key: 'admin', value: c.admin });
    return true;
  },
  // Correction (baisse seulement) de la cagnotte reportée.
  lowerCarry(amount) {
    noValue();
    const c = cfg(); onlyAdmin(c);
    const s = st();
    const v = big(amount);
    assert(v >= 0n && v < big(s.carry), 'can only lower');
    s.carry = v.toString();
    jset('st', s);
    emit('Config', { key: 'carry', value: s.carry });
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
  getEntries(roundId, chunk) { return jget('e:' + Number(roundId) + ':' + Number(chunk), []); },
  info() {
    const c = cfg();
    const s = st();
    const r = getR(s.cur);
    const t = nowMs();
    return {
      now: String(t), round: r.id, status: t >= r.drawTs ? 'closing' : r.status, drawTs: String(r.drawTs),
      fromTs: String(s.lastTs), carry: s.carry, nextToDraw: s.next, revealMin: c.revealMin, totals: s.tot,
    };
  },
});
