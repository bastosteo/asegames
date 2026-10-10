// Calculs partagés par le site : SHA-256, tirage, empreinte des grilles,
// conversion d'adresses. Mêmes règles que le contrat (vérifié par les tests).

export const PICK = 5, MAXN = 18;

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
export const hexToBytes = (hex) => { const o = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
export const sha256Text = (s) => sha256Bytes([...s].map((c) => c.charCodeAt(0) & 255));
export const sha256Hex = (h) => sha256Bytes(hexToBytes(h));

export const initialDigest = (roundId) => sha256Text('LOTOASE-ROUND|' + roundId);
export const nextDigest = (prev, buyer, grids, seed, idx) => sha256Text(prev + '|' + buyer + '|' + JSON.stringify(grids) + '|' + seed + '|' + idx);

export function drawNumbers(roundId, sO, sC, digest) {
  let seed = sha256Text('LOTOASE|' + roundId + '|' + sO + '|' + sC + '|' + digest);
  const nums = [];
  while (nums.length < PICK) {
    for (const b of hexToBytes(seed)) {
      if (nums.length >= PICK) break;
      if (b >= 252) continue;
      const n = (b % MAXN) + 1;
      if (!nums.includes(n)) nums.push(n);
    }
    seed = sha256Hex(seed);
  }
  return nums.sort((a, b) => a - b);
}
export const matches = (g, nums) => g.filter((n) => nums.includes(n)).length;

// Numéros "flash" : tirage aléatoire côté navigateur (crypto.getRandomValues).
export function flashGrid() {
  const s = new Set();
  const buf = new Uint8Array(32);
  while (s.size < PICK) {
    crypto.getRandomValues(buf);
    for (const b of buf) { if (s.size >= PICK) break; if (b < 252) s.add((b % MAXN) + 1); }
  }
  return [...s].sort((a, b) => a - b);
}
export function randomSeedHex() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// --- Adresses ase1 (bech32) ⇄ 0x ---
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
const hrpExp = () => { const h = [...'ase'].map((c) => c.charCodeAt(0)); return [...h.map((c) => c >> 5), 0, ...h.map((c) => c & 31)]; };
function convert(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  return out;
}
export function toHex(a) {
  const s = String(a || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(s)) return s;
  if (!s.startsWith('ase1')) throw new Error('adresse invalide');
  const d = [...s.slice(4)].map((c) => B32.indexOf(c));
  if (d.some((x) => x < 0) || polymod([...hrpExp(), ...d]) !== 1) throw new Error('adresse ase1 invalide (faute de frappe ?)');
  const bytes = convert(d.slice(0, -6), 5, 8, false);
  if (bytes.length !== 20) throw new Error('adresse ase1 invalide');
  return '0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function toAse1(a) {
  try {
    const hex = toHex(a);
    const data = convert(hexToBytes(hex.slice(2)), 8, 5, true);
    const pm = polymod([...hrpExp(), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
    const chk = []; for (let i = 0; i < 6; i++) chk.push((pm >> (5 * (5 - i))) & 31);
    return 'ase1' + [...data, ...chk].map((v) => B32[v]).join('');
  } catch { return String(a || ''); }
}
export const shortAddr = (a) => { const s = toAse1(a); return s.length > 16 ? s.slice(0, 9) + '…' + s.slice(-5) : s; };

// --- Montants ---
export const WEI = 10n ** 18n;
export function fmtAse(wei, digits = 2) {
  const w = BigInt(wei || 0);
  const neg = w < 0n; const a = neg ? -w : w;
  const scaled = (a * 10n ** BigInt(digits) + WEI / 2n) / WEI;
  const ip = scaled / 10n ** BigInt(digits), fp = scaled % 10n ** BigInt(digits);
  const ips = ip.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + ips + (digits ? ',' + fp.toString().padStart(digits, '0') : '');
}
export function parseAse(str) {
  const s = String(str).trim().replace(',', '.');
  if (!/^\d+(\.\d{0,18})?$/.test(s)) throw new Error('montant invalide');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
