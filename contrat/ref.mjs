// Implémentation de RÉFÉRENCE, indépendante du contrat (node:crypto).
// Sert aux tests (recalcul croisé) et au script croupier.
import { createHash, randomBytes } from 'node:crypto';

export const PICK = 5, MAXN = 18;
export const sha = (bufOrText) => createHash('sha256').update(bufOrText).digest('hex');
export const shaHex = (hex) => sha(Buffer.from(hex, 'hex'));

// Chaîne de secrets : x0 aléatoire, x(i+1) = SHA256(x(i)).
// Bout publié = x(n). On révèle x(n-1), puis x(n-2), etc.
export function makeChain(n, x0 = randomBytes(32).toString('hex')) {
  const c = [x0];
  for (let i = 0; i < n; i++) c.push(shaHex(c[c.length - 1]));
  return c; // c[n] = bout ; c[n-1] = 1er secret à révéler…
}
// Trouve dans la chaîne le secret dont l'empreinte (après k pas) vaut "tip".
export function preimageOf(chain, tip) {
  const i = chain.indexOf(tip);
  if (i <= 0) return null;
  return chain[i - 1];
}

export function initialDigest(roundId) { return sha('LOTOASE-ROUND|' + roundId); }
export function nextDigest(prev, buyer, cleanGrids, seed, idx) {
  return sha(prev + '|' + buyer + '|' + JSON.stringify(cleanGrids) + '|' + seed + '|' + idx);
}
export function drawNumbers(roundId, sO, sC, digest) {
  let seed = sha('LOTOASE|' + roundId + '|' + sO + '|' + sC + '|' + digest);
  const nums = [];
  while (nums.length < PICK) {
    for (const b of Buffer.from(seed, 'hex')) {
      if (nums.length >= PICK) break;
      if (b >= 252) continue;
      const n = (b % MAXN) + 1;
      if (!nums.includes(n)) nums.push(n);
    }
    seed = shaHex(seed);
  }
  return nums.sort((a, b) => a - b);
}
export const matches = (g, nums) => g.filter((n) => nums.includes(n)).length;

export function randomGrid(rnd = Math.random) {
  const s = new Set();
  while (s.size < PICK) s.add(1 + Math.floor(rnd() * MAXN));
  return [...s].sort((a, b) => a - b);
}

// Heure de Paris de référence (via Intl, indépendant du contrat).
export function parisHM(ms) {
  const f = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(ms));
}
