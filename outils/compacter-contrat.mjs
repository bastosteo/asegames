// Produit contrat/loto.deploy.js : le contrat compacté pour le déploiement.
// La CLI fixe la limite de gas d'un déploiement à 1000 × la taille du fichier :
// il faut rester sous ~12 Ko pour être inclus dans un bloc (mesuré sur la chaîne).
// Usage : node outils/compacter-contrat.mjs <chemin vers esbuild> [loto|tombola]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const esbuild = process.argv[2] || 'esbuild';
const NAME = process.argv[3] || 'loto';
const src = readFileSync(new URL(`../contrat/${NAME}.js`, import.meta.url), 'utf8');
const i = src.lastIndexOf('\n({');
if (i < 0) throw new Error('objet final introuvable');
// L'objet final devient "return __API__({...})" dans une fonction, pour que le
// minificateur le garde ; on retire ensuite l'enveloppe et le marqueur.
const wrapped = 'globalThis.__W__=function(){' + src.slice(0, i) + '\nreturn __API__(' + src.slice(i + 1).replace(/;\s*$/, '') + ')};';
const out = execFileSync(esbuild, ['--minify', '--loader=js', '--charset=utf8'], { input: wrapped }).toString().trim();
const head = 'globalThis.__W__=function(){';
if (!out.startsWith(head) || !out.endsWith('};')) throw new Error('forme inattendue : ' + out.slice(0, 60) + ' … ' + out.slice(-60));
let body = out.slice(head.length, -2);
const m = body.lastIndexOf('return __API__(');
if (m < 0 || body.indexOf('__API__') !== m + 7) throw new Error('marqueur introuvable ou en double');
body = body.slice(0, m) + '(' + body.slice(m + 'return __API__('.length) + ';';
const header = '';
writeFileSync(new URL(`../contrat/${NAME}.deploy.js`, import.meta.url), header + body + '\n');
console.log(`contrat/${NAME}.deploy.js :`, Buffer.byteLength(header + body), 'octets');
