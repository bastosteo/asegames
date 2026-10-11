// Liste des participants de l'ASE Airdrop pour une semaine, calculée
// uniquement à partir des données publiques des jeux.
// Utilisée par le croupier (pour l'envoyer au contrat) ET par le site
// (pour vérifier que la liste envoyée est la bonne).
//
// Règle : chaque achat (loto, tombola) et chaque fouille (trésor) est horodaté
// par le contrat. Tout achat fait dans la « semaine Airdrop » compte :
// 1 grille, 1 ticket ou 1 fouille = 1 chance. Cagnotte = somme des parts Airdrop
// (7,5 %) de ces achats, déjà versées au contrat Airdrop au moment de l'achat.
// fromTs / toTs = heures de l'Airdrop précédent et de cet Airdrop (lundi). La semaine
// des tickets s'arrête 24 h avant, à la grosse tombola du dimanche :
// achats dont l'heure est dans ]fromTs − 24 h, toTs − 24 h].
// Le montant est donc exact à tout moment (plus d'estimation).
//
// Anciens contrats (sans horodatage des achats) : on garde l'ancienne règle,
// tirages terminés dont l'heure est dans la semaine. loto / raffle / treasure
// peuvent être une adresse ou une liste d'adresses (ancien + nouveau contrat).
//
// view(contrat, méthode, args) → Promise de la valeur lue.

export const CUTOFF_MS = 24 * 3600000;
export const airdropShare = (amount) => ((BigInt(amount) * 1500n) / 10000n) / 2n;   // 7,5 %

const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).filter(Boolean);
const inWin = (ts, from, to) => ts > from && ts <= to;

async function purchases(view, contract, r) {
  const out = [];
  for (let k = 0; k < r.buys; k += 400) out.push(...(await view(contract, 'getPurchases', [r.id, k, Math.min(400, r.buys - k)])));
  return out;
}

export async function buildWeek({ view, loto, raffle, treasure, fromTs, toTs, now }) {
  const from = Number(fromTs) > 0 ? Number(fromTs) - CUTOFF_MS : 0, to = Number(toTs) - CUTOFF_MS, t = Number(now);
  const count = new Map(), games = [];
  let pot = 0n;
  const add = (b, n) => count.set(String(b).toLowerCase(), (count.get(String(b).toLowerCase()) || 0) + n);

  for (const [game, contracts] of [['loto', loto], ['raffle', raffle]]) {
    for (const contract of list(contracts)) {
      const st = await view(contract, 'getState', []);
      for (let id = st.cur; id >= 1; id--) {
        const r = await view(contract, 'getRound', [id]);
        if (!r) continue;
        if (Number(r.closeTs) <= from && Number(r.drawTs) <= from) break;   // tous ses achats sont avant la semaine
        if (!r.buys) continue;
        const ps = await purchases(view, contract, r);
        const legacy = ps.length && ps[0].t === undefined;
        let tickets = 0, share = 0n;
        if (legacy) {
          if (r.status !== 'done' || !inWin(Number(r.drawTs), from, to)) continue;
          for (const p of ps) { const n = game === 'loto' ? p.g.length : p.n; add(p.b, n); tickets += n; }
          share = BigInt(r.airdrop || '0');
        } else {
          const price = BigInt(r.price);
          for (const p of ps) {
            if (!inWin(Number(p.t), from, to)) continue;
            const n = game === 'loto' ? p.g.length : p.n;
            add(p.b, n); tickets += n;
            share += airdropShare(price * BigInt(n));
          }
        }
        if (!tickets) continue;
        pot += share;
        games.push({ game, id, drawTs: Number(r.drawTs), tickets, airdrop: share.toString(), done: r.status === 'done' });
      }
    }
  }

  // ASE Treasure : 1 fouille = 1 chance.
  for (const contract of list(treasure)) {
    const st = await view(contract, 'getState', []);
    for (let id = st.cur; id >= 1; id--) {
      const g = await view(contract, 'getGrid', [id]);
      if (!g) continue;
      const open = g.status === 'open';
      if (!open && g.endTs <= from) break;
      if (!g.digs) continue;
      const digs = [];
      for (let k = 0; k < g.digs; k += 400) digs.push(...(await view(contract, 'getDigs', [id, k, Math.min(400, g.digs - k)])));
      const legacy = digs[0].t === undefined;
      let n = 0, share = 0n;
      if (legacy) {
        if (g.status !== 'found' || !inWin(Number(g.endTs), from, to)) continue;
        for (const d of digs.slice(0, g.t + 1)) { add(d.b, 1); n++; }
        share = BigInt(g.airdrop || '0');
      } else {
        for (const d of digs) {
          if (!inWin(Number(d.t), from, to)) continue;
          add(d.b, 1); n++;
          share += airdropShare(g.price);
        }
      }
      if (!n) continue;
      pot += share;
      games.push({ game: 'treasure', id, drawTs: open ? t : g.endTs, tickets: n, airdrop: share.toString(), done: !open });
    }
  }

  const entries = [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // La liste est définitive dès que la semaine des tickets est finie.
  const ready = t > to;
  return { ready, waiting: ready ? [] : ['week'], pending: 0, entries, pot: pot.toString(), games: games.sort((a, b) => a.drawTs - b.drawTs), from, to };
}

export function chunks(entries, size = 100) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}
