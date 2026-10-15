// Implémentation de RÉFÉRENCE, indépendante du contrat (node:crypto).
// Sert aux tests (recalcul croisé) et au script croupier.
import { createHash, randomBytes } from 'node:crypto';

// MAXN : 14 depuis le loto v6 (LOTO_MAXN=20 pour tester les anciennes versions).
export const PICK = 5, MAXN = Number(process.env.LOTO_MAXN || 14);
const NOBIAS = 256 - (256 % MAXN);
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
      if (b >= NOBIAS) continue;   // multiple de MAXN : pas de biais
      const n = (b % MAXN) + 1;
      if (!nums.includes(n)) nums.push(n);
    }
    seed = shaHex(seed);
  }
  return nums.sort((a, b) => a - b);
}
// Règles de gains (écrites indépendamment du contrat, en BigInt) :
// 15 % commission (moitié équipe, moitié Airdrop), 35 % jackpot, 50 % caisse des gains fixes (4 bons = 25 mises,
// 3 bons = 2,5 mises, réduits ensemble si la caisse ne suffit pas). Sans gagnant
// à 5 bons : bonus = moitié des 35 % du tour, au prorata des gains fixes.
// Un 4 bons touche au plus 80 % d'un 5 bons. Le reste → jackpot suivant.
// skim = [seuil, montant] du prélèvement maison (loto v5) : si pas de 5 bons et report > seuil.
export function payouts(sales, price, jackpotIn, [n3, n4, n5], skim = [0n, 0n]) {
  const S = BigInt(sales), P = BigInt(price), J = BigInt(jackpotIn);
  const N3 = BigInt(n3), N4 = BigInt(n4), N5 = BigInt(n5);
  const commission = S * 15n / 100n;
  const pj = S * 35n / 100n;
  const caisse = S - commission - pj;
  let g3 = P * 25n / 10n, g4 = P * 25n, g5 = 0n;
  const du = N3 * g3 + N4 * g4;
  if (du > caisse) { g3 = g3 * caisse / du; g4 = g4 * caisse / du; }
  const fixe = N3 * g3 + N4 * g4;
  if (N5 > 0n) {
    g5 = (pj + J) / N5;
    if (5n * g4 > 4n * g5) { g3 = g3 * g5 * 4n / (g4 * 5n); g4 = g5 * 4n / 5n; }
  } else if (fixe > 0n) {
    g3 = g3 + g3 * pj / (2n * fixe);
    g4 = g4 + g4 * pj / (2n * fixe);
  }
  const verse = N3 * g3 + N4 * g4 + N5 * g5;
  const airdrop = commission / 2n;
  const brut = J + S - commission - verse;
  const pris = N5 === 0n && BigInt(skim[1]) > 0n && brut > BigInt(skim[0]) ? BigInt(skim[1]) : 0n;
  return { per: [g3, g4, g5], commission, airdrop, owner: (commission - airdrop) * 3n / 4n, carry: brut - pris, skim: pris };
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

// --------------------------- TOMBOLA (ASE Raffle) ---------------------------
export const raffleInitialDigest = (id) => sha('ASERAFFLE-ROUND|' + id);
export const raffleNextDigest = (prev, buyer, n, seed, idx) => sha(prev + '|' + buyer + '|' + n + '|' + seed + '|' + idx);
// purchases : [{ b, n, first }] dans l'ordre ; renvoie 3 gagnants { t, i, b }
export function raffleWinners(id, sO, sC, digest, purchases) {
  const total = purchases.reduce((a, p) => a + p.n, 0);
  const win = [], want = Math.min(3, new Set(purchases.map((p) => p.b)).size);
  for (let k = 0; win.length < want && k < 3000; k++) {
    const h = sha('ASERAFFLE|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(total));
    const i = purchases.findIndex((p) => t >= p.first && t < p.first + p.n);
    if (win.some((w) => w.b === purchases[i].b)) continue;
    win.push({ t, i, b: purchases[i].b });
  }
  return win;
}
// Prix d'une tombola (v3) : cagnotte = report + ventes − commission ;
// rangs sans gagnant (moins de 3 wallets) → 0, leur part = "carry" pour la suivante.
export function rafflePrizes(sales, carryIn = 0n, winners = 3) {
  const S = BigInt(sales), commission = S * 15n / 100n, pool = BigInt(carryIn) + S - commission, airdrop = commission / 2n;
  const p1 = pool / 2n, p2 = pool * 3n / 10n, all = [p1, p2, pool - p1 - p2];
  const prizes = all.map((x, k) => (k < winners ? x : 0n));
  return { commission, airdrop, owner: (commission - airdrop) * 3n / 4n, prizes, carry: all.reduce((a, x, k) => a + (k < winners ? 0n : x), 0n) };
}

// --------------------------- ASE AIRDROP ---------------------------
export const airdropInitialDigest = (id) => sha('ASEDROP-ROUND|' + id);
export const airdropNextDigest = (prev, chunk) => sha(prev + '|' + JSON.stringify(chunk));
// entries : [[adresse, tickets], …] triés ; renvoie jusqu'à 3 gagnants { b, n, t }
export function airdropWinners(id, sO, sC, digest, entries) {
  const out = new Set(), win = [];
  let rem = entries.reduce((a, e) => a + e[1], 0);
  for (let k = 0; k < 3 && rem > 0; k++) {
    const h = sha('ASEDROP|' + id + '|' + sO + '|' + sC + '|' + digest + '|' + k);
    const t = Number(BigInt('0x' + h.slice(0, 13)) % BigInt(rem));
    let x = t;
    for (const [b, n] of entries) {
      if (out.has(b)) continue;
      if (x < n) { out.add(b); win.push({ b, n, t }); rem -= n; break; }
      x -= n;
    }
  }
  return win;
}
export function airdropPrizes(total) {
  const T = BigInt(total), p1 = T / 2n, p2 = T * 3n / 10n;
  return [p1, p2, T - p1 - p2];
}
