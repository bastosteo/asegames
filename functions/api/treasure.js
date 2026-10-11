// =====================================================================
//  ASE Treasure — service de réponses (Cloudflare Pages Function)
//  GET /api/treasure?grid=3&cells=12,250   → réponses des cases DÉJÀ FOUILLÉES
//  GET /api/treasure?grid=3&all=1          → toute la grille, une fois terminée
// =====================================================================
//  La position du trésor ne quitte jamais ce service (graine TREASURE_SEED,
//  secret Cloudflare). Une réponse n'est donnée que pour une case fouillée et
//  payée sur la chaîne : impossible de sonder la grille sans jouer.
//  Chaque réponse est accompagnée de sa preuve (arbre de Merkle) : le site la
//  vérifie avec la racine publiée dans le contrat avant la 1re fouille.
//  Réglages (secrets du projet Cloudflare Pages) : TREASURE_SEED, TREASURE_CONTRACT,
//  RPC_URL (option, https://testnet.asentum.com par défaut).
// =====================================================================
import { boardAsync, CELLS } from '../_lib/board.mjs';

const memo = new Map();   // grilles déjà calculées (le service garde sa mémoire un moment)
async function boardOf(seed, grid) {
  const k = String(grid);
  if (!memo.has(k)) { if (memo.size > 20) memo.clear(); memo.set(k, boardAsync(seed, grid)); }
  return memo.get(k);
}
function reply(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}
async function view(env, method, args) {
  const rpc = (env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
  const r = await fetch(rpc + '/view', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: env.TREASURE_CONTRACT, method, args }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ': ' + (j.reason || 'read failed'));
  return j.returnValue;
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.TREASURE_SEED || !env.TREASURE_CONTRACT) return reply(503, { error: 'treasure service not configured' });
    const u = new URL(request.url);
    const grid = Number(u.searchParams.get('grid'));
    if (!Number.isInteger(grid) || grid < 1) return reply(400, { error: 'grid?' });
    const g = await view(env, 'getGrid', [grid]);
    if (!g) return reply(404, { error: 'unknown grid' });
    const b = await boardOf(env.TREASURE_SEED, grid);
    if (b.root !== g.root) return reply(500, { error: 'board does not match the contract' });
    const closed = g.status === 'found' || g.status === 'cancelled';
    let cells;
    if (u.searchParams.get('all')) {
      if (!closed) return reply(403, { error: 'the grid is still open' });
      cells = Array.from({ length: CELLS }, (_, i) => i);
    } else {
      cells = String(u.searchParams.get('cells') || '').split(',').filter((x) => x !== '').map(Number);
      if (!cells.length || cells.length > CELLS || cells.some((c) => !Number.isInteger(c) || c < 0 || c >= CELLS)) return reply(400, { error: 'cells?' });
      if (!closed) {
        const dug = new Set();
        for (let k = 0; k < g.digs; k += 400) for (const d of await view(env, 'getDigs', [grid, k, Math.min(400, g.digs - k)])) dug.add(d.c);
        cells = cells.filter((c) => dug.has(c));   // jamais de réponse pour une case non fouillée
      }
    }
    return reply(200, { grid, root: b.root, closed, answers: cells.map((c) => b.answer(c)), treasure: closed ? b.treasure : undefined });
  } catch (e) {
    return reply(502, { error: String(e && e.message ? e.message : e) });
  }
}
