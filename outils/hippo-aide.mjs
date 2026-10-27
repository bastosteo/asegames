// Lectures pour l'installation de l'Hippodrome (aucune transaction ici).
//   node outils/hippo-aide.mjs cfg <contrat>                    → réglages en JSON (vide si pas initialisé)
//   node outils/hippo-aide.mjs attendre <contrat> deploye|initialise|caution <wei>
//   node outils/hippo-aide.mjs graine <fichier>                 → crée une graine secrète de 32 octets (une seule fois)
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const [cmd, a, b, c] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(contract, method, args = []) {
  for (let i = 0; ; i++) {   // le testnet répond parfois une page HTML : on réessaie
    try { const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract, method, args }) }); return JSON.parse(await r.text()); }
    catch (e) { if (i >= 5) throw e; await sleep(5000); }
  }
}
const cfgOf = async (addr) => { const j = await view(addr, 'info').catch(() => ({})); return j.ok ? JSON.parse(j.returnValue).cfg : null; };
if (cmd === 'existe') { const j = await view(a, 'info').catch(() => ({})); console.log(j.ok || (j.reason && !/not a contract/.test(j.reason)) ? 'oui' : 'non'); }
else if (cmd === 'cfg') console.log(JSON.stringify(await cfgOf(a)) === 'null' ? '' : JSON.stringify(await cfgOf(a)));
else if (cmd === 'graine') { if (!existsSync(a)) { writeFileSync(a, randomBytes(32).toString('hex')); chmodSync(a, 0o600); } console.log('ok'); }
else if (cmd === 'attendre') {
  for (let i = 0; i < (b === 'deploye' ? 18 : 60); i++) {
    const j = await view(a, 'info').catch(() => ({}));
    if (b === 'deploye' && (j.ok || (j.reason && !/not a contract/.test(j.reason)))) { console.log('ok'); process.exit(0); }
    if (b === 'initialise' && j.ok) { console.log('ok'); process.exit(0); }
    if (b === 'caution' && j.ok && JSON.parse(j.returnValue).cfg.bond === c) { console.log('ok'); process.exit(0); }
    await sleep(10000);
  }
  console.log(b === 'deploye' ? 'le contrat n\'apparaît pas sur la chaîne après 3 min' : 'pas encore confirmé après 10 min'); process.exit(1);
} else console.log('usage : cfg <contrat> | attendre <contrat> deploye|initialise|caution <wei> | graine <fichier>');
