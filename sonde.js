// =====================================================================
//  SONDE ASENTUM — contrat de test jetable (TESTNET UNIQUEMENT)
// =====================================================================
//  But : vérifier sur la vraie chaîne ce que la doc dit de façon
//  contradictoire, AVANT d'écrire le contrat du loto.
//
//  Format utilisé : celui du contrat AuraSwap réellement déployé
//  (ase1v0myp2de3dhj3crvkhxqlnjaw2mvp64a9efkpl) :
//    - fonctions utilitaires en haut du fichier,
//    - le fichier se termine par un objet ({ ... }) dont chaque méthode
//      est appelable de l'extérieur,
//    - globales fournies par la chaîne : storage, msg, chain, emit,
//      assert, transfer, E.
//
//  Ce contrat ne garde que de petites sommes de test. Seul celui qui l'a
//  déployé (l'"owner") peut en retirer les ASE.
// =====================================================================

const MAX_LOOP = 5000000;      // garde-fou pour le test de boucle
const MAX_WRITES = 2000;       // garde-fou pour le test d'écritures
const MAX_VALUE_CHARS = 2000000;

function lc(a) { return String(a).toLowerCase(); }

// Transforme n'importe quelle valeur en texte lisible (BigInt -> "123n").
function show(v) {
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
    } catch (e) { return '[objet non sérialisable]'; }
  }
  return String(v);
}

// Exécute f() et renvoie le résultat en texte, ou "ERR: ..." si ça plante.
function safe(f) {
  try { return show(f()); } catch (e) { return 'ERR: ' + (e && e.message ? e.message : String(e)); }
}

// Liste les propriétés d'un objet, y compris les "getters" du prototype.
function keysOf(o) {
  const out = [];
  try { for (const k of Object.keys(o)) out.push(k); } catch (e) {}
  try {
    const p = Object.getPrototypeOf(o);
    if (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') out.push(k + '*');
    }
  } catch (e) {}
  return out.join(',');
}

// Photo complète de l'environnement d'exécution.
function snapshot() {
  return {
    sender: safe(() => msg.sender),
    senderType: safe(() => typeof msg.sender),
    value: safe(() => msg.value),
    valueType: safe(() => typeof msg.value),
    contractAddress: safe(() => msg.contractAddress),
    msgKeys: safe(() => keysOf(msg)),
    chainType: safe(() => typeof chain),
    chainKeys: safe(() => keysOf(chain)),
    blockTimestamp: safe(() => chain.blockTimestamp),
    blockNumber: safe(() => chain.blockNumber),
    blockHeight: safe(() => chain.blockHeight),
    height: safe(() => chain.height),
    timestamp: safe(() => chain.timestamp),
    msgBlock: safe(() => msg.block),
    globals: {
      cron: safe(() => typeof cron),
      blake3: safe(() => typeof blake3),
      sha256: safe(() => typeof sha256),
      keccak256: safe(() => typeof keccak256),
      hash: safe(() => typeof hash),
      crypto: safe(() => typeof crypto),
      balanceOf: safe(() => typeof balanceOf),
      getBalance: safe(() => typeof getBalance),
      selfBalance: safe(() => typeof selfBalance),
      E: safe(() => typeof E),
      transfer: safe(() => typeof transfer),
      Uint8Array: safe(() => typeof Uint8Array),
      Uint32Array: safe(() => typeof Uint32Array),
      TextEncoder: safe(() => typeof TextEncoder),
      Math_imul: safe(() => typeof Math.imul),
      DateNow: safe(() => Date.now()),
      MathRandom: safe(() => Math.random()),
    },
  };
}

// --------------------------------------------------------------------
//  SHA-256 écrit à la main (aucune librairie n'est disponible on-chain).
//  Entrée : tableau d'octets (nombres 0..255). Sortie : texte hexa (64 car.).
//  Vérifié en local contre les vecteurs officiels NIST (voir tests).
// --------------------------------------------------------------------
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function sha256Bytes(bytes) {
  const len = bytes.length;
  const msgArr = bytes.slice();
  msgArr.push(0x80);
  while (msgArr.length % 64 !== 56) msgArr.push(0);
  // longueur en bits sur 64 bits (big-endian)
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len * 8) >>> 0;
  msgArr.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255);
  msgArr.push((bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let off = 0; off < msgArr.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((msgArr[j] << 24) | (msgArr[j + 1] << 16) | (msgArr[j + 2] << 8) | msgArr[j + 3]) >>> 0;
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
  const s = String(hex).replace(/^0x/, '');
  assert(s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s), 'hexa invalide');
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}
function asciiBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 255);
  return out;
}

function onlyOwner() {
  assert(lc(msg.sender) === storage.get('owner'), 'réservé au propriétaire');
}

({
  // 1) Appelé au déploiement (ou juste après). Mémorise le propriétaire.
  init() {
    assert(!storage.get('owner'), 'déjà initialisé');
    storage.set('owner', lc(msg.sender));
    storage.set('self', lc(msg.contractAddress));
    const snap = snapshot();
    storage.set('snap:init', JSON.stringify(snap));
    emit('ProbeInit', { owner: lc(msg.sender), snap: JSON.stringify(snap) });
    return snap;
  },

  // 2) Photo de l'environnement lors d'une TRANSACTION (envoyer 0.01 ASE avec).
  inspect() {
    const snap = snapshot();
    storage.set('snap:tx', JSON.stringify(snap));
    const n = BigInt(storage.get('inspectCount') || '0') + 1n;
    storage.set('inspectCount', n.toString());
    emit('ProbeInspect', { n: n.toString(), value: show(msg.value) });
    return snap;
  },

  // 3) Même photo, mais en lecture gratuite (view) : msg.sender existe-t-il ?
  inspectView() {
    return snapshot();
  },

  // 4) Relire les photos enregistrées.
  getSnap(name) {
    return storage.get('snap:' + name) || null;
  },

  // 5) Quels types reçoit-on pour les arguments ? (nombres, textes, tableaux…)
  echo(a, b, c) {
    return { a: show(a) + ' :' + typeof a, b: show(b) + ' :' + typeof b, c: show(c) + ' :' + typeof c };
  },

  // 6) Quels types peut-on ranger dans storage ? (texte, nombre, BigInt, objet)
  storeTypes() {
    const r = {};
    r.str = safe(() => { storage.set('t:str', 'abc'); return 'ok'; });
    r.num = safe(() => { storage.set('t:num', 42); return 'ok'; });
    r.big = safe(() => { storage.set('t:big', 42n); return 'ok'; });
    r.obj = safe(() => { storage.set('t:obj', { a: 1 }); return 'ok'; });
    r.arr = safe(() => { storage.set('t:arr', [1, 2]); return 'ok'; });
    storage.set('t:result', JSON.stringify(r));
    return r;
  },
  readTypes() {
    const r = {};
    for (const k of ['str', 'num', 'big', 'obj', 'arr']) {
      r[k] = safe(() => { const v = storage.get('t:' + k); return typeof v + ' = ' + show(v); });
    }
    r.missing = safe(() => typeof storage.get('t:absent') + ' = ' + show(storage.get('t:absent')));
    r.hasFn = safe(() => typeof storage.has);
    r.delFn = safe(() => typeof storage.delete);
    r.write = storage.get('t:result') || null;
    return r;
  },

  // 7) Envoi d'ASE natif depuis le contrat (propriétaire uniquement).
  //    amountWei = texte, ex. "10000000000000000" pour 0,01 ASE.
  payout(to, amountWei) {
    onlyOwner();
    const amt = BigInt(amountWei);
    assert(amt > 0n, 'montant nul');
    const r = transfer(lc(to), amt.toString());
    emit('ProbePayout', { to: lc(to), amount: amt.toString(), result: show(r) });
    return { transferReturned: show(r), type: typeof r };
  },

  // 8) Que se passe-t-il si on envoie plus que le solde ? (doit échouer)
  //    On écrit AVANT l'envoi pour vérifier que l'écriture est annulée.
  payoutTooMuch() {
    onlyOwner();
    storage.set('rollbackTest', 'ÉCRIT AVANT ÉCHEC');
    const r = safe(() => transfer(lc(msg.sender), '1000000000000000000000000000'));
    storage.set('rollbackTransferResult', r);
    return r;
  },
  // 9) Une exception annule-t-elle bien TOUT ? (doit échouer)
  failAfterWrite() {
    storage.set('rollbackTest2', 'ÉCRIT AVANT EXCEPTION');
    throw new Error('échec volontaire');
  },
  readRollback() {
    return {
      rollbackTest: storage.get('rollbackTest') || null,
      rollbackTransferResult: storage.get('rollbackTransferResult') || null,
      rollbackTest2: storage.get('rollbackTest2') || null,
    };
  },

  // 10) Limite de boucle / de gas : n itérations simples.
  loop(n) {
    const k = Number(n);
    assert(k > 0 && k <= MAX_LOOP, 'n hors limites');
    let acc = 0;
    for (let i = 0; i < k; i++) acc = (acc + i * 7) % 1000003;
    storage.set('loop:last', k + ':' + acc);
    return acc;
  },

  // 11) Coût du SHA-256 maison : n hachages en chaîne.
  hashBench(n) {
    const k = Number(n);
    assert(k > 0 && k <= 100000, 'n hors limites');
    let h = sha256Bytes(asciiBytes('asentum'));
    for (let i = 1; i < k; i++) h = sha256Bytes(hexToBytes(h));
    storage.set('hash:last', k + ':' + h);
    return h;
  },
  // Contrôle des vecteurs officiels, exécuté ON-CHAIN (view gratuite).
  hashSelfTest() {
    return {
      empty: sha256Bytes([]) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      abc: sha256Bytes(asciiBytes('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      long448: sha256Bytes(asciiBytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) ===
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    };
  },

  // 12) Limites de stockage : n écritures de "len" caractères chacune.
  bulkWrite(n, len) {
    const k = Number(n), L = Number(len);
    assert(k > 0 && k <= MAX_WRITES, 'n hors limites');
    assert(L > 0 && L <= MAX_VALUE_CHARS, 'len hors limites');
    const chunk = 'x'.repeat(L);
    for (let i = 0; i < k; i++) storage.set('bulk:' + i, chunk);
    storage.set('bulk:last', k + 'x' + L);
    return k * L;
  },
  readBulk(i) {
    const v = storage.get('bulk:' + Number(i));
    return { last: storage.get('bulk:last') || null, len: v ? v.length : 0 };
  },

  // 13) Événements avec plusieurs champs (pour voir comment ils remontent).
  events() {
    emit('ProbeEventA', { s: 'texte', n: '123', who: lc(msg.sender) });
    emit('ProbeEventB', { list: JSON.stringify([1, 2, 3]) });
    return true;
  },

  // 14) Infos simples.
  owner() { return storage.get('owner') || null; },
  self() { return storage.get('self') || null; },
});
