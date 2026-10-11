// Liste des participants de l'ASE Airdrop pour une semaine, calculée
// uniquement à partir des données publiques des deux jeux.
// Utilisée par le croupier (pour l'envoyer au contrat) ET par le site
// (pour vérifier que la liste envoyée est la bonne).
//
// Règle : tirages RÉUSSIS (status "done") du loto et de la tombola de la
// « semaine Airdrop » ; 1 grille ou 1 ticket = 1 chance ; cagnotte = somme des
// parts "airdrop" de ces tirages.
// fromTs / toTs = heures de l'Airdrop précédent et de cet Airdrop (lundi). La semaine
// des tickets s'arrête 24 h avant, à la grosse tombola du dimanche :
// tirages dont l'heure est dans ]fromTs − 24 h, toTs − 24 h]
// (tickets achetés après la tombola d'un dimanche jusqu'à la tombola du dimanche suivant).
// estimate: true → ajoute aussi les tirages pas encore faits (estimation affichée avec *).
//
// view(contrat, méthode, args) → Promise de la valeur lue.

async function purchases(view, contract, r) {
  const out = [];
  for (let k = 0; k < r.buys; k += 400) out.push(...(await view(contract, "getPurchases", [r.id, k, Math.min(400, r.buys - k)])));
  return out;
}

export const CUTOFF_MS = 24 * 3600000;
export const airdropShare = (sales) => ((BigInt(sales) * 1500n) / 10000n) / 2n;   // 7,5 % des ventes

export async function buildWeek({ view, loto, raffle, treasure, fromTs, toTs, now, estimate = false }) {
  const from = Number(fromTs) > 0 ? Number(fromTs) - CUTOFF_MS : 0, to = Number(toTs) - CUTOFF_MS, t = Number(now);
  let pending = 0;
  const count = new Map();
  const waiting = [], games = [];
  let pot = 0n;
  const add = (b, n) => count.set(b, (count.get(b) || 0) + n);
  for (const [game, contract] of [['loto', loto], ['raffle', raffle]]) {
    if (!contract) continue;
    const st = await view(contract, 'getState', []);
    for (let id = st.cur; id >= 1; id--) {
      const r = await view(contract, 'getRound', [id]);
      if (!r) continue;
      const d = Number(r.drawTs);
      if (d <= from) break;
      if (d > to) continue;
      if (r.status === 'cancelled' || r.status === 'empty') continue;
      // Fermé mais pas encore « poké » : sans grille (loto) ou avec moins de 3 wallets
      // (tombola, prolongée d'une semaine), ce tirage ne comptera pas ici.
      if (r.status === 'open' && t >= Number(r.closeTs) && (game === 'loto' ? r.grids === 0 : r.wallets < 3)) continue;
      if (r.status !== 'done') {
        waiting.push(`${game} #${id} (${r.status})`);
        if (!estimate) continue;
      }
      let tickets = 0;
      for (const p of await purchases(view, contract, r)) {
        const n = game === 'loto' ? p.g.length : p.n;
        add(String(p.b).toLowerCase(), n);
        tickets += n;
      }
      const share = r.status === 'done' ? BigInt(r.airdrop || '0') : airdropShare(r.sales || '0');
      if (r.status !== 'done') pending += tickets;
      pot += share;
      games.push({ game, id, drawTs: d, tickets, airdrop: share.toString(), done: r.status === 'done' });
    }
  }
  // ASE Treasure : 1 fouille = 1 chance, pour les grilles dont le trésor a été trouvé
  // dans la semaine (fouilles jusqu'au trésor ; celles d'après sont remboursées).
  if (treasure) {
    const st = await view(treasure, 'getState', []);
    for (let id = st.cur; id >= 1; id--) {
      const g = await view(treasure, 'getGrid', [id]);
      if (!g) continue;
      const open = g.status === 'open';
      if (!open && g.endTs <= from) break;
      if (g.status === 'cancelled' || (!open && g.endTs > to) || (open && !estimate)) continue;
      const n = open ? g.digs : g.t + 1;
      for (let k = 0; k < n; k += 400) for (const d of await view(treasure, 'getDigs', [id, k, Math.min(400, n - k)])) add(String(d.b).toLowerCase(), 1);
      const share = open ? airdropShare(g.sales) : BigInt(g.airdrop || '0');
      if (open) pending += n;
      pot += share;
      games.push({ game: 'treasure', id, drawTs: open ? t : g.endTs, tickets: n, airdrop: share.toString(), done: !open });
    }
  }
  const entries = [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ready: waiting.length === 0, waiting, pending, entries, pot: pot.toString(), games: games.sort((a, b) => a.drawTs - b.drawTs), from, to };
}

export function chunks(entries, size = 100) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}
