// =====================================================================
//  HIPPODROME ASE VEGAS v3 — PARIS des spectateurs (pari mutuel). Les chevaux appartiennent aux
//  joueurs : voir ecurie.js. Les deux contrats tirent la MÊME arrivée avec les mêmes graines.
//  Le contrat ne connaît les chevaux que par leur NUMÉRO. Partants, terrain et chances (poids) de
//  chaque course sont calculés HORS chaîne (croupier, mêmes règles que le site, modifiables à tout
//  moment) et publiés avec l'enveloppe AVANT l'ouverture des paris : tout le monde les voit avant de
//  parier. Le contrat vérifie seulement qu'ils sont valides (6 chevaux distincts, chance ≥ minimum).
//  Noms, couleurs, casaques, jockeys, historique, textes et animations : site uniquement.
//  Réglages admin (commission, répartition, wallets, mises par type, types actifs, paris
//  max, écurie, terrains, calcul des chances, accès, bannis, pot sans gagnant) : appliqués
//  à partir de la course SUIVANTE (chaque course garde les règles de son ouverture).
//  (testnet Asentum)
//
//  Format : comme AuraSwap, le fichier se termine par un objet ({ ... })
//  dont les méthodes sont appelables. Globales fournies par la chaîne
//  (mesurées par la sonde) : msg, storage, emit, assert, transfer, chain.
//
//  LE JEU
//  - Écurie de 18 chevaux. Chaque course : 6 partants + 1 terrain
//    (Sec, Souple, Lourd, Sable), tirés à l'ouverture à partir du hasard
//    de la course précédente (personne ne les choisit).
//  - Note d'un cheval (sur 10, au centième) = statut (favori 3 / intermédiaire
//    1,5 / outsider 0, selon ses 5 dernières places) + forme (0-5 : repos +
//    tendance) + terrain (0-2, aptitude au terrain du jour).
//    Chance = 9,5 % + 43 % × part du poids 1000 × e^(0,8 × note).
//  - Paris : Gagnant (W), Couplé ordre (CO), Couplé désordre (CD),
//    Tiercé ordre (TO), Tiercé désordre (TD).
//  - PARI MUTUEL, UN SEUL POT : il n'y a pas de banque. Toutes les mises
//    vont dans le pot de la course ; la maison prend 5 % ; le reste est
//    partagé entre les tickets gagnants, chacun selon
//        sa mise ÷ la probabilité de son pari
//    (un pari 100 fois plus difficile pèse 100 fois plus par ASE misé).
//    Un gagnant récupère toujours au moins sa mise (cote minimum ×1 : la
//    commission est alors réduite). Aucun ticket gagnant : tout le pot
//    part en frais (wallet owner).
//
//  HASARD — deux croupiers, "enveloppes scellées" (comme Jackpot ASE)
//  - Avant l'ouverture, chaque croupier dépose
//      commit = SHA256(graine ‖ n° de course ‖ adresse du croupier) + caution.
//  - Après la fermeture, chacun révèle sa graine. Quand les deux sont là :
//      hasard = SHA256(graineA ‖ graineB ‖ n° de course)
//    et l'ordre d'arrivée complet est tiré, pondéré par les chances.
//  - Pas de révélation dans le délai (en blocs) : course annulée, chaque
//    joueur récupère ses mises, la caution du croupier fautif s'ajoute au
//    pot de la course suivante.
// =====================================================================

({
  // ───────────────────────── INITIALISATION ─────────────────────────
  // ownerWallet : reçoit la commission (5 %) de chaque course.
  // croupierA / croupierB : les deux comptes qui posent les enveloppes.
  // Le compte qui appelle init devient l'admin.
  init(ownerWallet, croupierA, croupierB) {
    assert(!storage.get('cfg'), 'init');
    const c = {
      admin: lc(msg.sender),
      ownerWallet: addr(ownerWallet),
      croupierA: addr(croupierA),
      croupierB: addr(croupierB),
      collabWallet: '', airdropWallet: '',
      commissionBps: '1500',                   // commission : 15 % du pot (en points de base)
      split: { owner: 10000, collab: 0, airdrop: 0 },   // répartition de la commission (sur 10000)
      stakes: { W: [(2n * ASE).toString(), (10n * ASE).toString()],                     // Gagnant : 2 à 10 ASE
        CO: [ASE.toString(), (5n * ASE).toString()], CD: [ASE.toString(), (5n * ASE).toString()],   // Couplé : 1 à 5 ASE
        TO: [ASE.toString(), (5n * ASE).toString()], TD: [ASE.toString(), (5n * ASE).toString()] }, // Tiercé : 1 à 5 ASE
      types: { W: true, CO: true, CD: true, TO: true, TD: true },
      maxBets: '150',                          // paris max par course (limite le gas du paiement)
      minChance: 300,                          // chance minimale d'un partant (bps) : 3 %
      access: 'open', accessOperator: '',      // 'open' (tout le monde) ou 'list' (détenteurs VEGAS, liste tenue par un script)
      noWinner: 'carry',                       // pot sans ticket gagnant : 'carry' (course suivante) ou 'owner'
      bond: (10n * ASE).toString(),            // caution par croupier et par course
      timeoutMs: '3600000',                    // délai de secours : 1 h après la fermeture
      startDelay: '60000',                     // départ de l'animation 60 s après le tirage
      paused: false,
    };
    assert(c.croupierA !== c.croupierB, 'croupiers');
    saveCfg(c);
    storage.set('carry', '0');                 // ajout au pot de la prochaine course (cautions confisquées)
    storage.set('current', '1');
    newRace(1n);
    return 'ok';
  },

  // ───────────────────────── ACTION DU JOUEUR ─────────────────────────
  // type : 'W' (gagnant), 'CO' (couplé ordre), 'CD' (couplé désordre),
  //        'TO' (tiercé ordre), 'TD' (tiercé désordre)
  // sel  : numéros de couloir des chevaux choisis (0 à 5), ex. [2] ou [0, 4, 1]
  // On envoie la mise en ASE avec la transaction (--value).
  bet(raceId, type, sel) {
    const c = cfg();
    assert(!c.paused, 'pause');
    const id = int(raceId);
    assert(id === cur(), 'pas la course en cours');
    const r = loadRace(id);
    assert(r.status === 'open', 'paris fermés');
    assert(now() < BigInt(r.closeAt), 'paris fermés');
    const R = r.rules;                                     // règles figées à l'ouverture de la course
    assert(BigInt(r.nbets) < BigInt(R.maxBets), 'course complète');
    const who0 = lc(msg.sender);
    assert(!storage.get('ban:' + who0), 'banni');
    if (c.access === 'list') assert(storage.get('acc:' + who0), 'réservé VEGAS');

    const t = String(type);
    assert(R.types[t], LABEL[t] ? 'type fermé' : 'type inconnu');
    const s = parseSel(t, sel);
    const stake = BigInt(msg.value || 0);
    const lim = R.stakes[t];
    assert(stake >= BigInt(lim[0]) && stake <= BigInt(lim[1]), 'mise ' + t + ' hors limites');

    // part dans le pot si le pari gagne : mise ÷ probabilité du pari
    const p = probOf(r.w, t, s);
    const share = stake * FP / p;

    // --- mise à jour de l'état ---
    const who = lc(msg.sender);
    const n = BigInt(r.nbets);
    storage.set('b:' + id + ':' + n, JSON.stringify({ who, t, s, stake: stake.toString(), share: share.toString(), paid: '0', refunded: false }));
    r.nbets = (n + 1n).toString();
    r.staked = (BigInt(r.staked) + stake).toString();
    saveRace(r);


    emit('Bet', { race: r.id, player: who });
    return JSON.stringify({ race: r.id, bet: n.toString(), pot: (BigInt(r.staked) + BigInt(r.carry)).toString() });
  },

  // ───────────────────────── CROUPIERS ─────────────────────────
  // Déposer l'enveloppe d'une course (en cours si pas encore ouverte, ou la suivante)
  // + la caution (--value). Le premier croupier fixe l'heure de fermeture des paris.
  // setup (JSON, seulement pour le croupier qui fixe l'heure) : {horses:[6 n°], terrain, w:[6 poids], info:"…"}
  commit(raceId, commitHex, closeAt, setup) {
    const c = cfg();
    assert(!c.paused, 'pause');
    const id = int(raceId);
    assert(id === cur() || id === cur() + 1n, 'course');
    const r = loadOrNewRace(id);
    doCommit(c, r, commitHex, closeAt, BigInt(msg.value || 0), setup);
    maybeOpen(r);
    saveRace(r);
    return JSON.stringify({ race: r.id, status: r.status });
  },

  // Révéler sa graine après la fermeture. Avec les deux graines, la course
  // est tirée et les gagnants payés dans la même transaction. Le croupier
  // peut déposer en même temps l'enveloppe de la course suivante + caution :
  // nextCommit, nextCloseAt (sinon "" et "0").
  reveal(raceId, seedHex) {
    const c = cfg();
    const id = int(raceId);
    const r = loadRace(id);
    assert(r.status === 'open', 'pas ouverte');
    assert(now() >= BigInt(r.closeAt), 'pas fermé');
    const who = lc(msg.sender);
    const slot = who === r.byA ? 'A' : who === r.byB ? 'B' : null;
    assert(slot, 'croupiers');
    assert(r['seed' + slot] === '', 'déjà');
    const seed = hex(seedHex, 32, 'graine');
    assert(commitOf(seed, BigInt(r.id), who) === r['commit' + slot], 'graine');

    r['seed' + slot] = seed;
    const pay = new Map();                                 // paiements regroupés, faits À LA FIN
    const bond = BigInt(r['bond' + slot]);
    r['bond' + slot] = '0';
    if (bond > 0n) addPay(pay, who, bond);                 // caution rendue

    assert(BigInt(msg.value || 0) === 0n, 'ne rien envoyer');
    if (r.seedA !== '' && r.seedB !== '') settle(r, pay);
    saveRace(r);
    advanceIfDone(r);

    for (const [to, amt] of pay) if (amt > 0n) transfer(to, amt.toString());
    return JSON.stringify({ race: r.id, status: r.status, order: r.order });
  },


  // ───────────────────────── REMBOURSEMENT ─────────────────────────
  // Course annulée (pause, croupier défaillant) : le joueur récupère TOUTES
  // ses mises de la course en un appel.
  claimRefund(raceId) {
    const c = cfg();
    const id = int(raceId);
    const r = loadRace(id);
    if (r.status === 'open') {
      assert(now() > BigInt(r.closeAt) + BigInt(c.timeoutMs), 'trop tôt');
      cancelRace(r);
    }
    assert(r.status === 'cancelled', 'rien');
    const who = lc(msg.sender);
    let total = 0n;
    for (let i = 0n; i < BigInt(r.nbets); i++) {
      const k = 'b:' + id + ':' + i;
      const b = JSON.parse(storage.get(k));
      if (b.who !== who || b.refunded) continue;
      b.refunded = true;
      storage.set(k, JSON.stringify(b));
      total += BigInt(b.stake);
    }
    assert(total > 0n, 'rien');
    r.refunded = (BigInt(r.refunded) + total).toString();
    saveRace(r);
    advanceIfDone(r);
    emit('Refund', { race: r.id, player: who });
    transfer(who, total.toString());
    return total.toString();
  },

  // ───────────────────────── ADMIN ─────────────────────────
  // UN SEUL point d'entrée pour les réglages admin : set(clé, valeur JSON). Appliqué à partir de la course
  // suivante (chaque course garde les règles de son ouverture). Clés :
  //  commission {bps, owner, collab, airdrop} · wallets {owner, collab, airdrop} · stakes {t, min, max} (wei)
  //  type {t, on} · maxBets n · minChance bps (chance minimale d'un partant, contrôle du setup)
  //  access {mode: 'open'|'list', operator} · noWinner 'carry'|'owner' · bond wei · timeout blocs
  //  croupiers {a, b} · admin adresse
  set(key, value) {
    const c = admin(), v = typeof value === 'string' && /^[\[{"]/.test(value) ? JSON.parse(value) : value;
    const k = String(key), N = (x, lo, hi) => { const n = Number(int(x)); assert(n >= lo && n <= hi, k + ' : ' + lo + ' à ' + hi); return n; };
    const yes = (x) => x === true || x === 'true' || x === 1;
    if (k === 'commission') {
      const o = N(v.owner, 0, 10000), co = N(v.collab, 0, 10000), a = N(v.airdrop, 0, 10000);
      assert(o + co + a === 10000, 'somme 10000');
      assert((co === 0 || c.collabWallet) && (a === 0 || c.airdropWallet), 'wallet');
      c.commissionBps = String(N(v.bps, 0, 2000)); c.split = { owner: o, collab: co, airdrop: a };
    } else if (k === 'wallets') {
      c.ownerWallet = addr(v.owner); c.collabWallet = v.collab ? addr(v.collab) : ''; c.airdropWallet = v.airdrop ? addr(v.airdrop) : '';
      assert((c.split.collab === 0 || c.collabWallet) && (c.split.airdrop === 0 || c.airdropWallet), 'wallet');
    } else if (k === 'stakes') {
      assert(LABEL[v.t], 'type inconnu'); const a = pos(v.min), b = pos(v.max); assert(a <= b, 'min > max');
      c.stakes[v.t] = [a.toString(), b.toString()];
    } else if (k === 'type') {
      assert(LABEL[v.t], 'type inconnu'); c.types[v.t] = yes(v.on); assert(Object.values(c.types).some(Boolean), 'type');
    } else if (k === 'maxBets') c.maxBets = String(N(v, 1, 400));
    else if (k === 'minChance') c.minChance = N(v, 0, 1500);
    else if (k === 'access') {
      assert(v.mode === 'open' || v.mode === 'list', 'accès'); c.access = v.mode; c.accessOperator = v.operator ? addr(v.operator) : '';
    } else if (k === 'noWinner') { assert(v === 'carry' || v === 'owner', 'mode'); c.noWinner = v; }
    else if (k === 'bond') c.bond = int(v).toString();
    else if (k === 'timeout') c.timeoutMs = pos(v).toString();
    else if (k === 'croupiers') { c.croupierA = addr(v.a); c.croupierB = addr(v.b); assert(c.croupierA !== c.croupierB, 'croupiers'); }
    else if (k === 'admin') c.admin = addr(v);
    else assert(false, 'réglage');
    saveCfg(c);
    return 'ok';
  },
  // Ajouter / retirer des wallets de la liste d'accès (admin ou opérateur d'accès), 60 max par appel
  // Listes : kind 'acc' (accès VEGAS : admin ou opérateur d'accès) ou 'ban' (bannis : admin). 60 adresses max.
  setList(kind, list, on) {
    const c = cfg(), who = lc(msg.sender), k = String(kind);
    assert(k === 'acc' || k === 'ban', 'liste');
    assert(who === c.admin || (k === 'acc' && c.accessOperator === who), 'admin');
    assert(Array.isArray(list) && list.length <= 60, '60 max');
    for (const a of list) { const key = k + ':' + addr(a); if (on === true || on === 'true') storage.set(key, '1'); else storage.delete(key); }
    return list.length;
  },

  // Pause : plus aucun pari ni nouvelle course. Une course déjà fermée est quand même tirée et payée.
  setPaused(on) {
    const c = admin(); c.paused = on === true || on === 'true' || on === 1; saveCfg(c);
    if (!c.paused) { const r = loadRace(cur()); maybeOpen(r); saveRace(r); }
    return c.paused;
  },

  // ───────────────────────── LECTURES (gratuites) ─────────────────────────
  info() {
    const id = cur();
    return JSON.stringify({
      cfg: cfg(), current: id.toString(), race: loadRace(id), carry: storage.get('carry'),
      now: now().toString(),
    });
  },
  race(raceId) { return JSON.stringify(loadRace(int(raceId))); },
  bets(raceId, from, count) {
    const id = int(raceId);
    const r = loadRace(id);
    const out = [];
    let i = int(from), n = int(count);
    if (n > 150n) n = 150n;
    while (i < BigInt(r.nbets) && n > 0n) { out.push(JSON.parse(storage.get('b:' + id + ':' + i))); i += 1n; n -= 1n; }
    return JSON.stringify(out);
  },
});

// =====================================================================
//  Fonctions internes (en dehors de l'objet : non appelables de l'extérieur)
// =====================================================================

const ASE = 1000000000000000000n;
const FP = 1000000000000000000n;           // précision des probabilités (1e18)
// Poids d'un cheval selon sa note (score en centièmes de point, de 0 à 1000) :
//   poids brut = 1000 × e^(0,8 × note)
// puis plancher de chance : chance = 9,5 % + 43 % × (poids brut ÷ total brut)
//   -> aucune cote Gagnant au-dessus de ×10 (0,95 ÷ 9,5 %), favori ≈ ×3.
// Calcul en entiers (série de Taylor en virgule fixe) : résultat identique partout.
// Poids finaux (plancher de 9,5 %) : w' = 95 × total + 430 × w ; la somme vaut 1000 × total.

const LABEL = { W: 1, CO: 2, CD: 2, TO: 3, TD: 3 };   // types de pari -> nombre de chevaux


// ATTENTION : après l'objet ({ ... }), uniquement des DÉCLARATIONS (function/const).
// Une instruction "nue" (boucle, appel…) remplacerait l'objet comme valeur du
// script et le contrat ne serait plus reconnu par la chaîne.

function lc(a) { return String(a).toLowerCase(); }
function now() { return BigInt(chain.blockTimestamp); }
function cur() { return BigInt(storage.get('current')); }
function cfg() { const s = storage.get('cfg'); assert(s, 'init'); return JSON.parse(s); }
function saveCfg(c) { storage.set('cfg', JSON.stringify(c)); }
function admin() { const c = cfg(); assert(lc(msg.sender) === c.admin, 'admin'); return c; }

function int(v) { const s = String(v); assert(/^[0-9]+$/.test(s), 'entier'); return BigInt(s); }
function pos(v) { const n = int(v); assert(n > 0n, '> 0'); return n; }
function addr(a) { const s = lc(a); assert(/^0x[0-9a-f]{40}$/.test(s), 'adresse'); return s; }
function hex(v, bytes, what) {
  let s = lc(v);
  if (s.startsWith('0x')) s = s.slice(2);
  assert(/^[0-9a-f]*$/.test(s) && s.length % 2 === 0, 'hex');
  if (bytes >= 0) assert(s.length === bytes * 2, 'taille');
  return s;
}
function u64hex(n) { return BigInt(n).toString(16).padStart(16, '0'); }
function u8hex(n) { return Number(n).toString(16).padStart(2, '0'); }
function commitOf(seedHex, raceId, croupier) { return sha256hex(seedHex + u64hex(raceId) + croupier.slice(2)); }
function rnd(h, mod) { return BigInt('0x' + h) % BigInt(mod); }

// ── courses ──
function newRace(id) {
  const r = {
    id: id.toString(), status: 'pending', closeAt: '0',
    commitA: '', commitB: '', byA: '', byB: '', bondA: '0', bondB: '0', seedA: '', seedB: '',
    horses: [], info: '', w: [], terrain: 0,
    nbets: '0', staked: '0', carry: '0', refunded: '0', paidOut: '0', fees: '0', winners: '0',
    rand: '', order: [], startAt: '0',
  };
  saveRace(r);
  return r;
}
function loadRace(id) { const s = storage.get('r:' + id.toString()); assert(s, 'course'); return JSON.parse(s); }
function loadOrNewRace(id) { const s = storage.get('r:' + id.toString()); return s ? JSON.parse(s) : newRace(id); }
function saveRace(r) { storage.set('r:' + r.id, JSON.stringify(r)); }

function doCommit(c, r, commitHex, closeAt, value, setup) {
  assert(r.status === 'pending', 'refusé');
  const who = lc(msg.sender);
  let slot = null;
  if (who === c.croupierA) slot = 'A';
  else if (who === c.croupierB) slot = 'B';
  assert(slot, 'croupiers');
  assert(r['commit' + slot] === '', 'déjà');
  assert(value === BigInt(c.bond), 'caution : ' + c.bond + ' wei');
  r['commit' + slot] = hex(commitHex, 32, 'empreinte');
  r['by' + slot] = who;
  r['bond' + slot] = value.toString();
  if (r.closeAt === '0') {
    const t = int(closeAt);
    assert(t >= now() + 600000n && t <= now() + 172800000n, 'fermeture');
    r.closeAt = t.toString();
    // partants, terrain et poids (calculés hors chaîne, publiés avant l'ouverture des paris)
    const S = typeof setup === 'string' ? JSON.parse(setup) : setup;
    assert(S && Array.isArray(S.horses) && S.horses.length === 6 && Array.isArray(S.w) && S.w.length === 6, 'setup');
    const hs = S.horses.map((x) => Number(int(x))), w = S.w.map((x) => Number(int(x)));
    assert(new Set(hs).size === 6 && hs.every((x) => x < 10000000), 'setup');
    let W = 0; for (const x of w) { assert(x >= 1 && x <= 1e9, 'setup'); W += x; }
    for (const x of w) assert(x * 10000 >= W * c.minChance, 'setup');
    r.horses = hs; r.w = w; r.terrain = Number(int(S.terrain || 0)); r.info = String(S.info || '').slice(0, 600);
    // risque de chute de chaque partant, en millionièmes (0 à 5 %) : tiré avec le même hasard que l'arrivée
    if (S.f) { assert(Array.isArray(S.f) && S.f.length === 6, 'setup'); r.f = S.f.map((x) => { const n = Number(int(x)); assert(n <= 50000, 'setup'); return n; }); }
  }
}

// Une course s'ouvre aux paris quand : ses 2 enveloppes sont posées, c'est la
// course en cours et pas de pause. Le report éventuel (cautions confisquées)
// rejoint son pot.
function maybeOpen(r) {
  if (r.status !== 'pending' || r.commitA === '' || r.commitB === '') return;
  if (BigInt(r.id) !== cur()) return;
  const c = cfg();
  if (c.paused) return;
  freezeRules(r, c);
  r.carry = (BigInt(r.carry) + BigInt(storage.get('carry') || '0')).toString();
  storage.set('carry', '0');
  r.status = 'open';
}

// Règles de la course, figées à l'ouverture (un réglage admin ne change jamais une course ouverte)
function freezeRules(r, c) {
  r.rules = { commissionBps: c.commissionBps, split: c.split, wallets: { owner: c.ownerWallet, collab: c.collabWallet, airdrop: c.airdropWallet },
    stakes: c.stakes, types: c.types, maxBets: c.maxBets, noWinner: c.noWinner };
}

// Probabilité d'une arrivée ordonnée (couloirs seq), en virgule fixe 1e18
function pOrdered(w, seq) {
  let W = 0n;
  for (const x of w) W += BigInt(x);
  let num = 1n, den = 1n, rem = W;
  for (const lane of seq) { num *= BigInt(w[lane]); den *= rem; rem -= BigInt(w[lane]); }
  return num * FP / den;
}
function perms(s) {
  if (s.length <= 1) return [s];
  const out = [];
  for (let i = 0; i < s.length; i++) {
    for (const p of perms(s.slice(0, i).concat(s.slice(i + 1)))) out.push([s[i]].concat(p));
  }
  return out;
}
// Probabilité d'un pari (virgule fixe 1e18)
function probOf(w, t, s) {
  if (t === 'W' || t === 'CO' || t === 'TO') return pOrdered(w, s);
  let p = 0n;
  for (const q of perms(s)) p += pOrdered(w, q);
  return p;
}
// Cote de référence en centièmes : 0,95 ÷ probabilité × 100 (indicative)

function parseSel(t, sel) {
  const need = { W: 1, CO: 2, CD: 2, TO: 3, TD: 3 }[t];
  assert(need, 'type inconnu');
  let arr = sel;
  if (typeof arr === 'string') arr = arr.split(/[-,]/);
  assert(Array.isArray(arr) && arr.length === need, 'sélection');
  const s = arr.map((x) => { const n = Number(int(x)); assert(n >= 0 && n <= 5, 'couloir'); return n; });
  assert(new Set(s).size === s.length, 'double');
  if (t === 'CD' || t === 'TD') s.sort((a, b) => a - b);
  return s;
}
function wins(t, s, o) {        // o = [1er, 2e, 3e]
  if (t === 'W') return o[0] === s[0];
  if (t === 'CO') return o[0] === s[0] && o[1] === s[1];
  if (t === 'TO') return o[0] === s[0] && o[1] === s[1] && o[2] === s[2];
  if (t === 'CD') return s.includes(o[0]) && s.includes(o[1]);
  return s.includes(o[0]) && s.includes(o[1]) && s.includes(o[2]);   // TD
}
function addPay(pay, to, amt) { pay.set(to, (pay.get(to) || 0n) + amt); }

// Tirage + paiements (appelé quand les deux graines sont révélées)
function settle(r, pay) {
  const rand = sha256hex(r.seedA + r.seedB);   // v3 : même tirage que le contrat Écurie (mêmes graines)
  // ordre d'arrivée complet, pondéré par les points (tirage sans remise)
  const left = [0, 1, 2, 3, 4, 5], order = [];
  for (let k = 0; k < 5; k++) {
    let W = 0;
    for (const l of left) W += r.w[l];
    let x = Number(rnd(sha256hex(rand + u8hex(k)), W));
    let pick = 0;
    while (x >= r.w[left[pick]]) { x -= r.w[left[pick]]; pick++; }
    order.push(left[pick]);
    left.splice(pick, 1);
  }
  order.push(left[0]);
  // chute (rare) : au plus un cheval, qui finit dernier ; les paris sur lui sont perdus
  r.fell = -1;
  if (r.f) {
    let u = Number(rnd(sha256hex(rand + 'ff'), 1000000));
    for (let l = 0; l < 6; l++) { if (u < r.f[l]) { r.fell = l; break; } u -= r.f[l]; }
    if (r.fell >= 0) { order.splice(order.indexOf(r.fell), 1); order.push(r.fell); }
  }
  r.rand = rand; r.order = order;
  r.startAt = (now() + BigInt(cfg().startDelay)).toString();

  // ── paiements : pari mutuel, un seul pot (règles figées à l'ouverture) ──
  const c = r.rules;
  const top = order.slice(0, 3);
  const pot = BigInt(r.staked) + BigInt(r.carry);
  const net = pot * (10000n - BigInt(c.commissionBps)) / 10000n;
  const win = [];                                   // tickets gagnants
  for (let i = 0n; i < BigInt(r.nbets); i++) {
    const k = 'b:' + r.id + ':' + i;
    const b = JSON.parse(storage.get(k));
    if (wins(b.t, b.s, top)) win.push({ k, b, stake: BigInt(b.stake), share: BigInt(b.share), fixed: false, amt: 0n });
  }
  // partage du pot net au prorata des parts (mise ÷ probabilité) ; un gagnant
  // qui toucherait moins que sa mise est remonté à sa mise (cote minimum ×1)
  // et le reste est repartagé entre les autres
  let avail = net;
  for (let round = 0; round <= win.length; round++) {
    let fixedStake = 0n, S = 0n;
    for (const x of win) { if (x.fixed) fixedStake += x.stake; else S += x.share; }
    avail = net - fixedStake;
    if (S === 0n || avail <= 0n) break;
    let changed = false;
    for (const x of win) if (!x.fixed && avail * x.share / S < x.stake) { x.fixed = true; changed = true; }
    if (!changed) { for (const x of win) if (!x.fixed) x.amt = avail * x.share / S; break; }
  }
  for (const x of win) if (x.fixed || avail <= 0n) x.amt = x.stake;   // au moins la mise
  let paid = 0n;
  for (const x of win) {
    paid += x.amt;
    x.b.paid = x.amt.toString();
    storage.set(x.k, JSON.stringify(x.b));
    addPay(pay, x.b.who, x.amt);
  }
  assert(paid <= pot, 'pot');   // impossible par construction
  let fees = pot - paid;                                 // commission (+ arrondis)
  if (!win.length && c.noWinner === 'carry') {           // aucun gagnant : le pot net passe à la course suivante
    storage.set('carry', (BigInt(storage.get('carry') || '0') + net).toString());
    r.carriedOut = net.toString(); fees = pot - net;
  }
  if (fees > 0n) {                                       // commission répartie owner / collab / airdrop
    const co = fees * BigInt(c.split.collab) / 10000n, ad = fees * BigInt(c.split.airdrop) / 10000n;
    if (co > 0n) addPay(pay, c.wallets.collab, co);
    if (ad > 0n) addPay(pay, c.wallets.airdrop, ad);
    addPay(pay, c.wallets.owner, fees - co - ad);
  }
  r.paidOut = paid.toString();
  r.fees = fees.toString();
  r.winners = win.length.toString();

  r.status = 'done';
  emit('Result', { race: r.id, order: order.join(','), fell: String(r.fell) });
}

function cancelRace(r) {
  // cautions non rendues (confisquées) + report de cette course -> pot de la course suivante
  let forfeit = BigInt(r.carry);
  r.carry = '0';
  for (const k of ['A', 'B']) {
    const b = BigInt(r['bond' + k]);
    if (b > 0n) { forfeit += b; r['bond' + k] = '0'; }
  }
  if (forfeit > 0n) storage.set('carry', (BigInt(storage.get('carry') || '0') + forfeit).toString());
  r.status = 'cancelled';
  emit('Cancel', { race: r.id });
}

function advanceIfDone(r) {
  if (BigInt(r.id) !== cur()) return;
  if (r.status === 'done' || (r.status === 'cancelled' && !cfg().paused)) goNext();
}
function goNext() {
  const nid = cur() + 1n;
  storage.set('current', nid.toString());
  const n = loadOrNewRace(nid);
  maybeOpen(n);
  saveRace(n);
}

// ── statistiques (classements calculés par le site à partir des paris) ──

// =====================================================================
//  SHA-256 (FIPS 180-4), écrit à la main : la chaîne n'en fournit pas.
//  Même code que Jackpot ASE, vérifié avec les vecteurs du NIST.
// =====================================================================
// Constantes SHA-256 (racines cubiques / carrées des premiers nombres premiers), recalculées plutôt
// qu'écrites en dur pour gagner de la place au déploiement (vérifié avec les vecteurs du NIST).
function shaK() {
  const K = [], H = [];
  for (let n = 2; K.length < 64; n++) {
    let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; }
    if (!p) continue;
    if (H.length < 8) H.push((Math.pow(n, 1 / 2) % 1) * 4294967296 | 0);
    K.push((Math.pow(n, 1 / 3) % 1) * 4294967296 | 0);
  }
  return [K, H];
}

function sha256hex(hexStr) {
  const len = hexStr.length / 2;
  // message + 0x80 + zéros + longueur en bits sur 8 octets, multiple de 64 octets
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  for (let i = 0; i < len; i++) m[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  m[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);

  const [K256, H0] = shaK(), H = new Uint32Array(H0);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) {
      const p = off + t * 4;
      W[t] = (m[p] << 24) | (m[p + 1] << 16) | (m[p + 2] << 8) | m[p + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15], y = W[t - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, '0');
  return out;
}
