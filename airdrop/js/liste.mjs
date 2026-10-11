// Liste des participants de l'ASE Airdrop pour une semaine, calculée
// uniquement à partir des données publiques des deux jeux.
// Utilisée par le croupier (pour l'envoyer au contrat) ET par le site
// (pour vérifier que la liste envoyée est la bonne).
//
// Règle : tirages RÉUSSIS (status "done") du loto et de la tombola dont
// l'heure de tirage est dans ]fromTs, toTs] ; 1 grille ou 1 ticket = 1 chance ;
// cagnotte = somme des parts "airdrop" de ces tirages.
//
// view(contrat, méthode, args) → Promise de la valeur lue.

async function purchases(view, contract, r) {
  const out = [];
  for (let k = 0; k < r.buys; k += 400) out.push(...(await view(contract, 'getPurchases', [r.id, k, 400])));
  return out;
}

export async function buildWeek({ view, loto, raffle, fromTs, toTs, now }) {
  const from = Number(fromTs), to = Number(toTs), t = Number(now);
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
      if (r.status !== 'done') { waiting.push(`${game} #${id} (${r.status})`); continue; }
      let tickets = 0;
      for (const p of await purchases(view, contract, r)) {
        const n = game === 'loto' ? p.g.length : p.n;
        add(String(p.b).toLowerCase(), n);
        tickets += n;
      }
      pot += BigInt(r.airdrop || '0');
      games.push({ game, id, drawTs: d, tickets, airdrop: String(r.airdrop || '0') });
    }
  }
  const entries = [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ready: waiting.length === 0, waiting, entries, pot: pot.toString(), games: games.sort((a, b) => a.drawTs - b.drawTs) };
}

export function chunks(entries, size = 100) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}
