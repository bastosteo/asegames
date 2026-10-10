#!/usr/bin/env node
// Fausse CLI "asentum" pour les tests : même syntaxe et même sortie que la
// vraie pour "call", mais envoie la transaction au faux nœud local (MOCK_URL).
const [cmd, contract, method, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd !== 'call') { console.error('fake-asentum : seule la commande "call" est simulée'); process.exit(1); }
const from = opt('from'), args = JSON.parse(opt('args') || '[]');
const value = opt('value') ? BigInt(Math.round(Number(opt('value')) * 1e6)) * 10n ** 12n : 0n;
const r = await fetch(process.env.MOCK_URL + '/__tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, method, args, value: value.toString() }) }).then((x) => x.json());
if (r.error) { console.log(`error: ${r.error}`); process.exit(1); }
console.log(`call submitted: ${method}()\n  contract: ${contract}\n  from:     ${from}\n  tx hash:  ${r.hash}\n  wait for the next block (~6s) for the call to land.`);
