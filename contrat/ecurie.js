// =====================================================================
//  HIPPODROME ASE VEGAS v3 — ÉCURIE : les chevaux appartiennent aux joueurs (testnet Asentum)
//  - Acheter un cheval (le prix fixe la classe), 3 max par joueur, avec un nom.
//  - Le nourrir (1 ASE), l'entraîner (2 ASE), l'inscrire à la course du jour (5 ASE).
//  - Une course par jour (19 h Paris, heure posée par le croupier). Places vides :
//    chevaux de la maison (n° ≥ 1 000 000). Pot des inscriptions : 10 % pour la maison,
//    90 % au propriétaire du gagnant (gagnant maison : pot reporté à la course suivante).
//  - Hasard : enveloppes des 2 croupiers. Le contrat des PARIS (paris.js) reçoit les
//    mêmes partants / poids et les mêmes graines : il tire exactement la même arrivée.
//  - Les poids (chances) sont calculés par le croupier à partir de l'état des chevaux
//    (classe, faim, ballonné, entraînement, terrain) avec les réglages de ce contrat.
//  - Tous les réglages : set(clé, valeur), admin uniquement.
//  Après l'objet ({ ... }) : uniquement des déclarations.
// =====================================================================

({
  init(ownerWallet, croupierA, croupierB) {
    assert(!storage.get('cfg'), 'init');
    const A = (n) => (BigInt(n) * ASE).toString();
    const c = {
      admin: lc(msg.sender), owner: addr(ownerWallet), cA: addr(croupierA), cB: addr(croupierB),
      prices: [A(10), A(12), A(15), A(20), A(25), A(35)],   // Outsider, Espoir, Standard, Challenger, Challenger+, Élite
      clsW: [150, 155, 160, 170, 175, 190],                  // chance de base (‰ : 190 = 19 %)
      maxHorses: 3, feed: A(1), train: A(2), entry: A(5), cutBps: 1000, houseWin: 'carry',
      hunger: 20, bloat: 15, trainB: 10, terrB: 5, houseW: 165,   // bonus / malus en ‰ de chance
      feedWin: 86400000, bloatAt: 2, overTrain: 2, injPct: 40, injDays: 3, fallPpm: 1500, overFall: 20000,
      hour: 19, entryLead: 3600000, bond: A(1), timeoutMs: 3600000, paused: false,
    };
    assert(c.cA !== c.cB, 'croupiers');
    save('cfg', c);
    storage.set('carry', '0'); storage.set('nh', '0'); storage.set('current', '1');
    newRace(1n);
    return 'ok';
  },

  // ───────── JOUEURS ─────────
  buy(cls, name) {
    const c = open(), who = lc(msg.sender), k = Number(int(cls));
    assert(k < 6, 'classe');
    const nm = String(name).trim();
    assert(/^[^<>"'`\\]{1,20}$/.test(nm), 'nom');
    pay(c, c.prices[k]);
    const own = list(who);
    assert(own.length < c.maxHorses, 'max ' + c.maxHorses + ' chevaux');
    const id = BigInt(storage.get('nh')) + 1n;
    storage.set('nh', id.toString());
    save('h:' + id, { id: id.toString(), o: who, n: nm, c: k, b: now().toString(), fd: [], tr: [], inj: '0', r: 0, w: 0, l: [], won: '0' });
    own.push(id.toString()); save('own:' + who, own);
    emit('Buy', { horse: id.toString(), owner: who, cls: String(k) });
    return id.toString();
  },
  feed(horseId) {
    const c = open(), h = mine(horseId);
    pay(c, c.feed);
    h.fd = h.fd.concat(now().toString()).slice(-5);
    save('h:' + h.id, h);
    return 'ok';
  },
  train(horseId) {
    const c = open(), h = mine(horseId);
    assert(BigInt(h.inj) <= now(), 'blessé');
    pay(c, c.train);
    h.tr = h.tr.concat(now().toString()).slice(-5);
    save('h:' + h.id, h);
    return 'ok';
  },
  enter(horseId) {
    const c = open(), h = mine(horseId), r = load(cur());
    assert(r.st === 'entry' && !r.set, 'inscriptions fermées');
    assert(r.at === '0' || now() < BigInt(r.at) - BigInt(c.entryLead), 'inscriptions fermées');
    assert(BigInt(h.inj) <= (r.at === '0' ? now() : BigInt(r.at)), 'blessé');
    assert(r.en.length < 6, 'course complète');
    assert(!r.en.some((e) => e.h === h.id), 'déjà inscrit');
    const v = BigInt(msg.value || 0);
    assert(v === BigInt(c.entry), 'inscription : ' + c.entry + ' wei');
    r.en.push({ h: h.id, o: h.o, v: v.toString() });
    r.pot = (BigInt(r.pot) + v).toString();
    saveR(r);
    emit('Enter', { race: r.id, horse: h.id });
    return r.id;
  },

  // ───────── CROUPIERS ─────────
  // Heure de la course (le croupier gère le fuseau de Paris)
  plan(raceId, closeAt) {
    const c = open(), r = load(int(raceId));
    slot(c);
    assert(r.id === cur().toString() && r.st === 'entry' && r.at === '0', 'déjà');
    const t = int(closeAt);
    assert(t > now() + BigInt(c.entryLead) && t < now() + 259200000n, 'heure');
    r.at = t.toString();
    saveR(r);
    return 'ok';
  },
  // Enveloppe (après la clôture des inscriptions). Le premier croupier publie les partants :
  // setup = {horses:[6 n°], w:[6 poids], f:[6 risques de chute ppm], terrain}
  commit(raceId, commitHex, setup) {
    const c = open(), r = load(int(raceId)), s = slot(c), who = lc(msg.sender);
    assert(r.id === cur().toString() && r.st === 'entry' && r.at !== '0', 'course');
    assert(now() >= BigInt(r.at) - BigInt(c.entryLead), 'trop tôt');
    assert(r['c' + s] === '', 'déjà');
    const v = BigInt(msg.value || 0);
    assert(v === BigInt(c.bond), 'caution : ' + c.bond + ' wei');
    r['c' + s] = hex32(commitHex); r['by' + s] = who; r['b' + s] = v.toString();
    if (!r.set) {
      const S = typeof setup === 'string' ? JSON.parse(setup) : setup;
      assert(S && S.horses.length === 6 && S.w.length === 6 && S.f.length === 6, 'setup');
      const hs = S.horses.map((x) => Number(int(x)));
      assert(new Set(hs).size === 6, 'setup');
      for (const e of r.en) assert(hs.includes(Number(e.h)), 'setup');
      for (const x of hs) assert(x >= 1e6 ? x < 1e7 : r.en.some((e) => Number(e.h) === x), 'setup');
      r.set = { horses: hs, w: S.w.map((x) => { const n = Number(int(x)); assert(n >= 1 && n <= 1e9, 'setup'); return n; }),
        f: S.f.map((x) => { const n = Number(int(x)); assert(n <= 50000, 'setup'); return n; }), terrain: Number(int(S.terrain || 0)) };
    }
    if (r.cA !== '' && r.cB !== '') r.st = 'open';
    saveR(r);
    return r.st;
  },
  reveal(raceId, seedHex) {
    const r = load(int(raceId)), who = lc(msg.sender);
    assert(r.st === 'open' && now() >= BigInt(r.at), 'pas ouverte');
    const s = who === r.byA ? 'A' : who === r.byB ? 'B' : null;
    assert(s, 'croupiers');
    assert(r['s' + s] === '', 'déjà');
    const seed = hex32(seedHex);
    assert(sha256hex(seed + BigInt(r.id).toString(16).padStart(16, '0') + who.slice(2)) === r['c' + s], 'graine');
    r['s' + s] = seed;
    const out = new Map(), b = BigInt(r['b' + s]);
    r['b' + s] = '0';
    add(out, who, b);
    if (r.sA !== '' && r.sB !== '') settle(r, out);
    saveR(r);
    if (r.st === 'done') next();
    for (const [to, a] of out) if (a > 0n) transfer(to, a.toString());
    return JSON.stringify({ race: r.id, st: r.st, order: r.order || [] });
  },
  // Croupier absent (délai dépassé) ou décision admin : course annulée, inscriptions remboursées
  cancel(raceId) {
    const c = cfg(), r = load(int(raceId));
    assert(r.id === cur().toString() && (r.st === 'entry' || r.st === 'open'), 'rien');
    assert(lc(msg.sender) === c.admin || (r.at !== '0' && now() > BigInt(r.at) + BigInt(c.timeoutMs)), 'trop tôt');
    const out = new Map();
    for (const e of r.en) add(out, e.o, BigInt(e.v));
    let f = BigInt(r.bA) + BigInt(r.bB);
    for (const k of ['A', 'B']) if (r['b' + k] !== '0' && lc(msg.sender) === c.admin) { add(out, r['by' + k], BigInt(r['b' + k])); f -= BigInt(r['b' + k]); }
    r.bA = r.bB = '0';
    storage.set('carry', (BigInt(storage.get('carry')) + f).toString());
    r.st = 'cancelled';
    saveR(r); next();
    for (const [to, a] of out) if (a > 0n) transfer(to, a.toString());
    emit('Cancel', { race: r.id });
    return 'ok';
  },

  // ───────── ADMIN ─────────
  // set(clé, valeur) : prices [6 wei] · clsW [6] · feed/train/entry/bond (wei) · wallet · croupiers {a,b}
  // · admin · houseWin 'carry'|'owner' · paused · nombres : voir NUM
  set(key, value) {
    const c = cfg(), k = String(key);
    assert(lc(msg.sender) === c.admin, 'admin');
    const v = typeof value === 'string' && /^[\[{"]/.test(value) ? JSON.parse(value) : value;
    if (k === 'prices') { assert(v.length === 6, '6'); c.prices = v.map((x) => int(x).toString()); }
    else if (k === 'clsW') { assert(v.length === 6, '6'); c.clsW = v.map((x) => rng(x, 1, 1000)); }
    else if (k === 'feed' || k === 'train' || k === 'entry' || k === 'bond') c[k] = int(v).toString();
    else if (k === 'wallet') c.owner = addr(v);
    else if (k === 'croupiers') { c.cA = addr(v.a); c.cB = addr(v.b); assert(c.cA !== c.cB, 'croupiers'); }
    else if (k === 'admin') c.admin = addr(v);
    else if (k === 'houseWin') { assert(v === 'carry' || v === 'owner', 'mode'); c.houseWin = v; }
    else if (k === 'paused') c.paused = v === true || v === 'true';
    else { const L = NUM[k]; assert(L, 'réglage'); c[k] = rng(v, L[0], L[1]); }
    save('cfg', c);
    return 'ok';
  },
  ban(list, on) {
    assert(lc(msg.sender) === cfg().admin, 'admin');
    assert(list.length <= 60, '60 max');
    for (const a of list) { if (on === true || on === 'true') storage.set('ban:' + addr(a), '1'); else storage.delete('ban:' + addr(a)); }
    return list.length;
  },

  // ───────── LECTURES ─────────
  info() { const id = cur(); return JSON.stringify({ cfg: cfg(), current: id.toString(), race: load(id), carry: storage.get('carry'), horses: storage.get('nh'), now: now().toString() }); },
  race(raceId) { return JSON.stringify(load(int(raceId))); },
  horse(horseId) { return storage.get('h:' + int(horseId)) || 'null'; },
  stable(owner) { return '[' + list(addr(owner)).map((i) => storage.get('h:' + i)).join(',') + ']'; },
  banned(a) { return !!storage.get('ban:' + addr(a)); },
});

// =====================================================================
const ASE = 1000000000000000000n;
const NUM = { maxHorses: [1, 20], cutBps: [0, 5000], hunger: [0, 500], bloat: [0, 500], trainB: [0, 500], terrB: [0, 500], houseW: [10, 1000],
  feedWin: [3600000, 604800000], bloatAt: [1, 5], overTrain: [1, 5], injPct: [0, 100], injDays: [0, 30], fallPpm: [0, 50000], overFall: [0, 50000],
  hour: [0, 23], entryLead: [600000, 86400000], timeoutMs: [600000, 86400000] };

function lc(a) { return String(a).toLowerCase(); }
function now() { return BigInt(chain.blockTimestamp); }
function cur() { return BigInt(storage.get('current')); }
function save(k, o) { storage.set(k, JSON.stringify(o)); }
function cfg() { const s = storage.get('cfg'); assert(s, 'init'); return JSON.parse(s); }
function int(v) { const s = String(v); assert(/^[0-9]+$/.test(s), 'entier'); return BigInt(s); }
function rng(x, lo, hi) { const n = Number(int(x)); assert(n >= lo && n <= hi, lo + ' à ' + hi); return n; }
function addr(a) { const s = lc(a); assert(/^0x[0-9a-f]{40}$/.test(s), 'adresse'); return s; }
function hex32(v) { const s = lc(v).replace(/^0x/, ''); assert(/^[0-9a-f]{64}$/.test(s), 'hex'); return s; }
function list(who) { return JSON.parse(storage.get('own:' + who) || '[]'); }
function add(m, to, a) { m.set(to, (m.get(to) || 0n) + a); }
// actions des joueurs : pas de pause, pas banni
function open() { const c = cfg(); assert(!c.paused, 'pause'); assert(!storage.get('ban:' + lc(msg.sender)), 'banni'); return c; }
function pay(c, price) {
  const v = BigInt(msg.value || 0);
  assert(v === BigInt(price), 'prix : ' + price + ' wei');
  if (v > 0n) transfer(c.owner, v.toString());
}
function mine(id) { const s = storage.get('h:' + int(id)); assert(s, 'cheval'); const h = JSON.parse(s); assert(h.o === lc(msg.sender), 'pas ton cheval'); return h; }
function slot(c) { const w = lc(msg.sender); const s = w === c.cA ? 'A' : w === c.cB ? 'B' : null; assert(s, 'croupiers'); return s; }

function newRace(id) {
  const r = { id: id.toString(), st: 'entry', at: '0', en: [], pot: '0', cA: '', cB: '', byA: '', byB: '', bA: '0', bB: '0', sA: '', sB: '', set: null };
  saveR(r); return r;
}
function load(id) { const s = storage.get('e:' + id); assert(s, 'course'); return JSON.parse(s); }
function saveR(r) { save('e:' + r.id, r); }
function next() { const n = cur() + 1n; storage.set('current', n.toString()); newRace(n); }
function rnd(h, m) { return BigInt('0x' + h) % BigInt(m); }

// Tirage (identique à paris.js) + prime au propriétaire du gagnant + blessures
function settle(r, out) {
  const c = cfg(), S = r.set, rand = sha256hex(r.sA + r.sB);
  const left = [0, 1, 2, 3, 4, 5], order = [];
  for (let k = 0; k < 5; k++) {
    let W = 0;
    for (const l of left) W += S.w[l];
    let x = Number(rnd(sha256hex(rand + k.toString(16).padStart(2, '0')), W)), p = 0;
    while (x >= S.w[left[p]]) { x -= S.w[left[p]]; p++; }
    order.push(left[p]); left.splice(p, 1);
  }
  order.push(left[0]);
  let fell = -1, u = Number(rnd(sha256hex(rand + 'ff'), 1000000));
  for (let l = 0; l < 6; l++) { if (u < S.f[l]) { fell = l; break; } u -= S.f[l]; }
  if (fell >= 0) { order.splice(order.indexOf(fell), 1); order.push(fell); }
  r.order = order; r.fell = fell; r.rand = rand;

  // pot des inscriptions : part maison, le reste au propriétaire du cheval gagnant
  const tot = BigInt(r.pot) + BigInt(storage.get('carry')), cut = tot * BigInt(c.cutBps) / 10000n, win = S.horses[order[0]];
  storage.set('carry', '0');
  add(out, c.owner, cut);
  const e = r.en.find((x) => Number(x.h) === win);
  if (e) { add(out, e.o, tot - cut); r.prize = (tot - cut).toString(); }
  else if (c.houseWin === 'owner') add(out, c.owner, tot - cut);
  else storage.set('carry', (tot - cut).toString());
  r.win = win; r.inj = [];

  // chevaux des joueurs : places, entraînement consommé, blessures
  for (const x of r.en) {
    const h = JSON.parse(storage.get('h:' + x.h)), lane = S.horses.indexOf(Number(x.h)), pl = order.indexOf(lane) + 1;
    const over = h.tr.filter((t) => BigInt(t) + BigInt(c.feedWin) > BigInt(r.at)).length >= c.overTrain;
    h.r++; if (pl === 1) { h.w++; h.won = (BigInt(h.won) + tot - cut).toString(); }
    h.l = h.l.concat(lane === fell ? 0 : pl).slice(-5);
    h.tr = [];
    if (lane === fell || (over && Number(rnd(sha256hex(rand + 'b' + x.h), 100)) < c.injPct)) {
      h.inj = (now() + BigInt(c.injDays) * 86400000n).toString(); r.inj.push(h.id);
    }
    save('h:' + h.id, h);
  }
  r.st = 'done';
  emit('Result', { race: r.id, order: order.join(','), fell: String(fell), win: String(win) });
}

// SHA-256 (FIPS 180-4) écrit à la main, même code que paris.js
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
  const len = hexStr.length / 2, total = Math.ceil((len + 9) / 64) * 64, m = new Uint8Array(total);
  for (let i = 0; i < len; i++) m[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  m[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  const [K256, H0] = shaK(), H = new Uint32Array(H0), W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) { const p = off + t * 4; W[t] = (m[p] << 24) | (m[p + 1] << 16) | (m[p + 2] << 8) | m[p + 3]; }
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15], y = W[t - 2];
      W[t] = (W[t - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + W[t - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  let o = '';
  for (let i = 0; i < 8; i++) o += H[i].toString(16).padStart(8, '0');
  return o;
}
