// =====================================================================
//  ASE Treasure — la grille secrète d'une chasse (partagé par le croupier,
//  le service de réponses Cloudflare et le site).
// =====================================================================
//  Tout se déduit d'une graine secrète (TREASURE_SEED, 64 hexa) :
//   - case du trésor de la grille g : SHA-256(graine|cell|g) mod 400
//   - sel de la case i              : SHA-256(graine|salt|g|i)
//   - réponse de la case i          : T (trésor), H (chaud : à 3 cases ou moins,
//                                     diagonales comprises), C (froid)
//   - feuille i  = SHA-256("ASETREASURE|g|i|réponse|sel")
//   - racine     = arbre de Merkle sur 512 feuilles (les 112 dernières = bourrage),
//                  nœud = SHA-256(gauche + droite) en texte hexa
//  Seule la racine est publiée dans le contrat au départ : aucune réponse ne peut
//  plus changer, et chaque réponse donnée se vérifie avec sa preuve.
// =====================================================================
export const SIZE = 20, CELLS = SIZE * SIZE, DEPTH = 9, HOT = 3;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256Bytes(bytes) {
  const len = bytes.length;
  const m = Array.from(bytes);
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  const hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
  m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) { const j = off + i * 4; w[i] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) >>> 0; }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}
const hexToBytes = (hex) => { const o = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
export const sha256Text = (s) => sha256Bytes([...s].map((c) => c.charCodeAt(0) & 255));


export const PAD = sha256Text('ASETREASURE-PAD');
export const answerAt = (cell, treasure) => {
  const d = Math.max(Math.abs((cell % SIZE) - (treasure % SIZE)), Math.abs(Math.floor(cell / SIZE) - Math.floor(treasure / SIZE)));
  return d === 0 ? 'T' : d <= HOT ? 'H' : 'C';
};
export const leafOf = (grid, cell, ans, salt) => sha256Text('ASETREASURE|' + grid + '|' + cell + '|' + ans + '|' + salt);

// Racine et preuve à partir des 400 feuilles.
export function tree(leaves) {
  const levels = [leaves.concat(Array(512 - leaves.length).fill(PAD))];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1), up = [];
    for (let i = 0; i < l.length; i += 2) up.push(sha256Text(l[i] + l[i + 1]));
    levels.push(up);
  }
  return levels;
}
export function proofOf(levels, idx) {
  const p = [];
  for (let k = 0, i = idx; k < DEPTH; k++, i >>= 1) p.push(levels[k][i ^ 1]);
  return p;
}
export function verify(root, grid, cell, ans, salt, proof) {
  if (!Array.isArray(proof) || proof.length !== DEPTH) return false;
  let h = leafOf(grid, cell, ans, salt), i = cell;
  for (const s of proof) { h = i & 1 ? sha256Text(s + h) : sha256Text(h + s); i >>= 1; }
  return h === root;
}

// La grille complète (secrète !) d'une chasse, à partir de la graine.
export function board(seed, grid) {
  const s = String(seed).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('TREASURE_SEED : 64 caractères hexa attendus');
  const treasure = Number(BigInt('0x' + sha256Text(s + '|cell|' + grid)) % BigInt(CELLS));
  const cells = [];
  for (let i = 0; i < CELLS; i++) {
    const salt = sha256Text(s + '|salt|' + grid + '|' + i), ans = answerAt(i, treasure);
    cells.push({ ans, salt, leaf: leafOf(grid, i, ans, salt) });
  }
  const levels = tree(cells.map((c) => c.leaf));
  return { grid, treasure, cells, levels, root: levels.at(-1)[0], answer: (i) => ({ cell: i, ans: cells[i].ans, salt: cells[i].salt, proof: proofOf(levels, i) }) };
}

// Même grille, calculée avec le SHA-256 natif (Web Crypto) : beaucoup plus rapide,
// pour le service de réponses Cloudflare (temps de calcul limité).
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const shaA = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export async function boardAsync(seed, grid) {
  const s = String(seed).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('TREASURE_SEED : 64 caractères hexa attendus');
  const treasure = Number(BigInt('0x' + (await shaA(s + '|cell|' + grid))) % BigInt(CELLS));
  const salts = await Promise.all(Array.from({ length: CELLS }, (_, i) => shaA(s + '|salt|' + grid + '|' + i)));
  const cells = salts.map((salt, i) => ({ ans: answerAt(i, treasure), salt }));
  const leaves = await Promise.all(cells.map((c, i) => shaA('ASETREASURE|' + grid + '|' + i + '|' + c.ans + '|' + c.salt)));
  const levels = [leaves.concat(Array(512 - leaves.length).fill(PAD))];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1), up = [];
    for (let i = 0; i < l.length; i += 2) up.push(shaA(l[i] + l[i + 1]));
    levels.push(await Promise.all(up));
  }
  cells.forEach((c, i) => (c.leaf = leaves[i]));
  return { grid, treasure, cells, levels, root: levels.at(-1)[0], answer: (i) => ({ cell: i, ans: cells[i].ans, salt: cells[i].salt, proof: proofOf(levels, i) }) };
}
