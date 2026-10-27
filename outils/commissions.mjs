// Lecture seule : ce que chaque contrat de jeu a envoyé, et à qui (commissions, part Airdrop, gains).
// L'explorateur n'affiche pas ces envois (ce sont des envois internes aux transactions des joueurs),
// et le nœud ne sait pas relire l'historique des événements (erreur 504). On recalcule donc à partir
// de ce que chaque contrat a enregistré, tirage par tirage / grille par grille, avec exactement la même
// règle que le contrat : 15 % de commission, moitié Airdrop, l'autre moitié 75 % owner / 25 % collaborateur.
//   node outils/commissions.mjs                → contrats trouvés dans les fichiers .xxx-fait
//   node outils/commissions.mjs <contrat> …    → contrats donnés (ase1… ou 0x…)
import { readFileSync, existsSync } from 'node:fs';
import { toHex, toAse1 } from '../site/js/lotomath.js';

const NODES = [(process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, ''), 'https://explorer.asentum.com/rpc'];
const ase = (w) => (Number(BigInt(w) / 10n ** 12n) / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 6 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (x) => BigInt(x || 0);

// Lecture d'une fonction du contrat (gratuite), avec nouvel essai si le nœud répond mal.
async function view(contract, method, args = []) {
  let last;
  for (let k = 0; k < 6; k++) {
    try {
      const r = await fetch(NODES[k % 2] + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: toHex(contract), method, args }) });
      const j = JSON.parse(await r.text());
      return j.ok ? j.returnValue : null;
    } catch (e) { last = e; await sleep(1000 * (k + 1)); }
  }
  throw last;
}

// Part owner / collaborateur / Airdrop d'une commission (même calcul que les contrats).
function split(com, drop) {
  const C = big(com), D = drop === undefined || drop === null ? C / 2n : big(drop);
  const O = ((C - D) * 7500n) / 10000n;
  return { owner: O, collab: C - D - O, drop: D };
}

const markers = [['.loto-v4-fait', 'Loto (v4)'], ['.tombola-v3-fait', 'Raffle (v3)'], ['.tresor-v2-fait', 'Treasure (v2)'],
  ['.loto-ancien', 'Loto (ancien, 2 ASE)'], ['.raffle-ancienne', 'Raffle (ancienne, 5 ASE)'], ['.v5-ancien-tresor', 'Treasure (ancien, 0,5 ASE)'],
  ['.loto-v3-fait', 'Loto (v3, ancien)'], ['.tombola-v2-fait', 'Raffle (v2, ancien)'], ['.tresor-fait', 'Treasure (v1, ancien)']];

// Adresse du contrat EN LIGNE d'un jeu, lue sur le vrai site (asevegas.com) : toujours la bonne,
// quel que soit le dossier d'où le contrat a été déployé. '' si le site ne répond pas.
async function liveContract(game) {
  try {
    const t = await (await fetch(`https://asevegas.com/${game}/js/config.js`, { signal: AbortSignal.timeout(15000) })).text();
    return (t.match(/CONTRACT:\s*'(ase1[0-9a-z]{38})'/) || [])[1] || '';
  } catch { return ''; }
}
let list = process.argv.slice(2).map((c) => [c, c]);
if (!list.length) {
  // d'abord les contrats EN LIGNE (lus sur asevegas.com), puis les anciens trouvés dans les fichiers .xxx-fait
  // (un fichier peut contenir plusieurs adresses séparées par des virgules)
  const seen = new Set();
  for (const [g, n] of [['loto', 'Loto (en ligne)'], ['raffle', 'Raffle (en ligne)'], ['treasure', 'Treasure (en ligne)']]) {
    const a = await liveContract(g);
    if (a && !seen.has(a)) { seen.add(a); list.push([a, n]); }
  }
  for (const [f, n] of markers.filter(([f]) => existsSync(f))) {
    const addrs = readFileSync(f, 'utf8').split(/[\s,]+/).filter((a) => /^ase1[0-9a-z]{38}$/.test(a));
    addrs.forEach((a, i) => { if (!seen.has(a)) { seen.add(a); list.push([a, addrs.length > 1 ? `${n} #${i + 1}` : n]); } });
  }
}
if (!list.length) { console.log('Aucun contrat trouvé : donne une adresse, ex. node outils/commissions.mjs ase1…'); process.exit(1); }

const grand = { owner: 0n, collab: 0n, drop: 0n };
let cfgAll = null;
for (const [contract, name] of list) {
  console.log(`\n=== ${name} : ${toAse1(toHex(contract))}`);
  try {
    const cfg = (await view(contract, 'getConfig')) || {};
    const st = (await view(contract, 'getState')) || {};
    if (!cfgAll && cfg.payOwner) cfgAll = cfg;
    const tot = { owner: 0n, collab: 0n, drop: 0n };
    const add = (s) => { tot.owner += s.owner; tot.collab += s.collab; tot.drop += s.drop; };
    let count = 0;
    const isTreasure = cfg.drawH === undefined;   // le trésor n'a pas d'heure de tirage
    for (let id = 1; id <= Number(st.cur || 0); id++) {
      const x = isTreasure ? await view(contract, 'getGrid', [id]) : await view(contract, 'getRound', [id]);
      if (!x || !x.commission || x.commission === '0') continue;
      add(split(x.commission, x.airdrop));
      count++;
      process.stdout.write('.');
    }
    if (count) process.stdout.write('\n');
    const line = (who, w, addr) => console.log(`  ${who.padEnd(28)} ${ase(w).padStart(12)} ASE${addr ? '   ' + toAse1(addr) : ''}`);
    line('Toi (owner, commission)', tot.owner, cfg.payOwner);
    line('Collaborateur (commission)', tot.collab, cfg.payCollab);
    line('Contrat Airdrop', tot.drop, cfg.payAirdrop);
    if (st.tot) {
      if (st.tot.prizes !== undefined) line('Gains payés aux joueurs', big(st.tot.prizes));
      if (st.tot.refunds && st.tot.refunds !== '0') line('Remboursements (anciennes règles)', big(st.tot.refunds));
    }
    grand.owner += tot.owner; grand.collab += tot.collab; grand.drop += tot.drop;
  } catch (e) { console.log('  Lecture impossible pour l\'instant : ' + e.message); }
}
console.log('\n=== TOTAL, tous jeux confondus');
console.log(`  Toi (owner)        ${ase(grand.owner).padStart(12)} ASE`);
console.log(`  Collaborateur      ${ase(grand.collab).padStart(12)} ASE`);
console.log(`  Contrat Airdrop    ${ase(grand.drop).padStart(12)} ASE`);
