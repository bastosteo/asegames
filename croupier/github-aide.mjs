// Petits outils pour l'installation des croupiers sur GitHub (utilisé par outils/installer-github.sh).
// Rien ici n'envoie de transaction ; les graines ne sont affichées que pour être passées à "gh secret set".
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { generateKeypair, addressFromPublicKey } from '@asentum/crypto';
import { toAse1, toHex } from '../site/js/lotomath.js';

const RPC = (process.env.RPC_URL || 'https://testnet.asentum.com').replace(/\/$/, '');
const [cmd, ...a] = process.argv.slice(2);
const addrOf = (seed) => addressFromPublicKey(generateKeypair(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey).toLowerCase();
const sha = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex'); // même calcul que le croupier
const chainOf = (file) => {
  const v = JSON.parse(readFileSync(file, 'utf8')).values;
  for (let i = 1; i < v.length; i++) if (sha(v[i - 1]) !== v[i]) throw new Error(`chaîne abîmée dans ${file} (élément ${i})`);
  return v;
};
const view = async (method, args = []) => {
  const r = await fetch(RPC + '/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: process.env.CONTRACT, method, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error('lecture du contrat impossible : ' + (j.reason || r.status));
  return j.returnValue;
};

switch (cmd) {
  case 'signers': { // crée (une seule fois) les deux comptes signataires, et affiche leurs adresses
    const f = a[0];
    if (!existsSync(f)) {
      writeFileSync(f, JSON.stringify({ created: new Date().toISOString(), owner: randomBytes(32).toString('hex'), collab: randomBytes(32).toString('hex') }, null, 1));
      chmodSync(f, 0o600);
    }
    const s = JSON.parse(readFileSync(f, 'utf8'));
    for (const r of ['owner', 'collab']) console.log(r, toAse1(addrOf(s[r])));
    break;
  }
  case 'seed': console.log(JSON.parse(readFileSync(a[0], 'utf8'))[a[1]]); break;   // pour gh secret set
  case 'chainseed': console.log(chainOf(a[0])[0]); break;                         // pour gh secret set
  case 'check': { // les chaînes du PC correspondent-elles au contrat ?
    const st = await view('getState');
    const o = chainOf(a[0]).indexOf(st.tipO), c = chainOf(a[1]).indexOf(st.tipC);
    if (o < 1) throw new Error("la chaîne owner du PC ne correspond pas au contrat");
    if (c < 1) throw new Error("la chaîne collaborateur du PC ne correspond pas au contrat");
    console.log(`chaînes OK (owner : ${o} secrets restants, collaborateur : ${c})`);
    break;
  }
  case 'balance': { // solde en ASE (nombre décimal)
    const r = await (await fetch(RPC + '/balance/' + toHex(a[0]))).json();
    console.log((Number(BigInt(r.balance || 0) / 10n ** 14n) / 10000).toString());
    break;
  }
  default: console.log('usage : signers <fichier> | seed <fichier> owner|collab | chainseed <chaîne.json> | check <owner.json> <collab.json> | balance <adresse>');
}
