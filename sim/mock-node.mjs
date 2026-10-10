// Faux nœud Asentum LOCAL (pour tester croupier et site sans dépenser d'ASE).
// Expose les mêmes routes que le vrai RPC : /chain, /view, /receipts/:h, /balance/:a,
// plus des routes de contrôle : /__tx (utilisée par la fausse CLI), /__warp, /__alerts.
// Un bloc toutes les BLOCK_MS (réel), qui avance l'horloge de la chaîne de 8 s.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Chain } from './vm-sim.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Décodage des vraies transactions signées (route /tx), avec les paquets installés dans croupier/
const NM = join(dirname(fileURLToPath(import.meta.url)), '..', 'croupier', 'node_modules', '@asentum');
let SDK = null;
async function sdk() {
  if (!SDK) SDK = {
    c: await import(pathToFileURL(join(NM, 'crypto', 'dist', 'index.js')).href),
    t: await import(pathToFileURL(join(NM, 'types', 'dist', 'index.js')).href),
  };
  return SDK;
}

export function startMockNode({ port = 0, blockMs = 100, source, startTs = Date.UTC(2026, 9, 10, 12) } = {}) {
  const chain = new Chain({ startTimestampMs: startTs, blockTimeMs: 8000 });
  const contract = chain.deploy(source, '0x' + 'a'.repeat(40));
  const receipts = new Map();
  const pending = [];          // transactions en attente du prochain bloc
  const busy = new Set();      // comptes ayant une transaction en attente (→ "duplicate nonce")
  const alerts = [];
  let txCount = 0;
  const accounts = new Map();  // nom du compte CLI → adresse 0x
  const nonces = new Map();    // adresse → nombre de transactions signées incluses

  function mineOne() {
    chain.mine(1);
    const batch = pending.splice(0);
    batch.forEach((tx, i) => {
      const r = contract.call(tx.from, tx.method, tx.args, tx.value);
      receipts.set(tx.hash, {
        txHash: tx.hash, blockNumber: String(chain.blockNumber), txIndex: i, sender: tx.from,
        recipient: contract.address, kind: 'call', success: r.success, gasUsed: String(r.gas || 1000000),
        events: r.events || [], returnValue: r.success ? r.returnValue ?? null : null, error: r.success ? undefined : 'contract call failed: ' + r.error,
      });
      busy.delete(tx.from);
      if (tx.signed) nonces.set(tx.from, (nonces.get(tx.from) || 0) + 1);
    });
  }
  const timer = setInterval(mineOne, blockMs);

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d ? JSON.parse(d) : {})); });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return json(res, 200, {});
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/rpc/, '');
      if (p === '/chain') return json(res, 200, { chainId: '1423', height: String(chain.blockNumber), latestHeader: { number: String(chain.blockNumber), timestamp: String(chain.timestampMs) } });
      if (p.startsWith('/receipts/')) { const r = receipts.get(p.split('/')[2]); return json(res, 200, r || { error: 'receipt not found' }); }
      if (p.startsWith('/balance/')) return json(res, 200, { address: p.split('/')[2], balance: chain.balanceOf(p.split('/')[2]).toString(), nonce: String(nonces.get(p.split('/')[2].toLowerCase()) || 0), pendingNonce: String((nonces.get(p.split('/')[2].toLowerCase()) || 0) + (busy.has(p.split('/')[2].toLowerCase()) ? 1 : 0)) });
      if (p === '/view' && req.method === 'POST') {
        const b = await body(req);
        if (b.contract.toLowerCase() !== contract.address) return json(res, 200, { ok: false, reason: 'no contract' });
        try { return json(res, 200, { ok: true, returnValue: contract.view(b.method, b.args || []), gasUsed: '21000', events: [] }); }
        catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      }
      if (p === '/__tx' && req.method === 'POST') {
        const b = await body(req);
        const from = accounts.get(b.from) || b.from;
        if (!/^0x[0-9a-f]{40}$/.test(from)) return json(res, 200, { error: 'unknown account ' + b.from });
        if (busy.has(from)) return json(res, 200, { error: 'call rejected: duplicate nonce' });
        const hash = '0x' + createHash('sha256').update('tx' + txCount++).digest('hex');
        busy.add(from);
        pending.push({ hash, from, method: b.method, args: b.args || [], value: BigInt(b.value || 0) });
        return json(res, 200, { hash });
      }
      if (p === '/tx' && req.method === 'POST') {
        // Vraie transaction signée (même format que le testnet) : décodage, vérification, exécution au prochain bloc
        const { c, t } = await sdk();
        const b = await body(req);
        const stx = t.SignedTransactionSchema.deserialize(Uint8Array.from(Buffer.from(b.rawTx.replace(/^0x/, ''), 'hex')));
        const msgHash = c.blake3(t.TransactionBodySchema.serialize(stx.body));
        if (!c.verify(msgHash, stx.signature, stx.publicKey)) return json(res, 200, { accepted: false, reason: 'bad signature' });
        const from = c.addressFromPublicKey(stx.publicKey).toLowerCase();
        if (BigInt(stx.body.chainId) !== 1423n) return json(res, 200, { accepted: false, reason: 'wrong chainId' });
        if (BigInt(stx.body.nonce) !== BigInt(nonces.get(from) || 0) || busy.has(from)) return json(res, 200, { accepted: false, reason: 'duplicate nonce' });
        const to = '0x' + Buffer.from(stx.body.to).toString('hex');
        if (to !== contract.address) return json(res, 200, { accepted: false, reason: 'unknown target' });
        const d = JSON.parse(new TextDecoder().decode(stx.body.data));
        const hash = '0x' + Buffer.from(msgHash).toString('hex');
        busy.add(from);
        pending.push({ hash, from, method: d.method, args: d.args || [], value: BigInt(stx.body.value), signed: true });
        return json(res, 200, { accepted: true, txHash: hash });
      }
      if (p === '/__warp' && req.method === 'POST') { const b = await body(req); chain.mineUntil(b.to); return json(res, 200, { now: String(chain.timestampMs) }); }
      if (p.startsWith('/__alert')) { const b = await body(req); alerts.push(b.text); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found ' + p });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    ok({
      url, chain, contract, alerts, accounts,
      addAccount: (name, addr) => { accounts.set(name, addr); chain.fund(addr, 10n ** 24n); },
      stop: () => { clearInterval(timer); server.close(); },
    });
  }));
}
