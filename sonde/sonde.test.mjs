// Tests locaux de la sonde : node sonde/sonde.test.mjs
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Chain } from '../sim/vm-sim.mjs';

const src = readFileSync(new URL('./sonde.js', import.meta.url), 'utf8');
let ok = 0, ko = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  ✓', name); } else { ko++; console.log('  ✗', name, extra); }
};

const OWNER = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);
const ASE = 10n ** 18n;
const chain = new Chain();
chain.fund(OWNER, 100n * ASE);
chain.fund(OTHER, 100n * ASE);
const c = chain.deploy(src, OWNER);

console.log('Sonde — tests locaux');
let r = c.call(OWNER, 'init');
t('init réussit', r.success, r.error);
t('owner enregistré en hexa minuscule', c.view('owner') === OWNER);
t('double init refusé', !c.call(OWNER, 'init').success);

// SHA-256 : vecteurs NIST officiels
const st = c.view('hashSelfTest');
t('SHA-256 vecteur "" (NIST)', st.empty);
t('SHA-256 vecteur "abc" (NIST)', st.abc);
t('SHA-256 vecteur 448 bits (NIST)', st.long448);

// SHA-256 : comparaison avec node:crypto sur des entrées aléatoires de tailles variées
let allMatch = true;
// Extraction de sha256Bytes pour un test direct
const shaOnly = new Function('assert', src.slice(src.indexOf('const K256'), src.indexOf('function onlyOwner')) +
  '\nreturn { sha256Bytes, hexToBytes, asciiBytes };')((c2, m) => { if (!c2) throw new Error(m); });
for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 100000]) {
  for (let i = 0; i < 5; i++) {
    const buf = randomBytes(len);
    if (shaOnly.sha256Bytes([...buf]) !== createHash('sha256').update(buf).digest('hex')) allMatch = false;
  }
}
t('SHA-256 identique à node:crypto (60 entrées aléatoires, 0 à 100 000 octets)', allMatch);
const million = 'a'.repeat(1000000);
t('SHA-256 vecteur NIST 1 million de "a"',
  shaOnly.sha256Bytes(shaOnly.asciiBytes(million)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

const h1 = c.call(OWNER, 'hashBench', ['3']);
let expect = createHash('sha256').update('asentum').digest('hex');
for (let i = 1; i < 3; i++) expect = createHash('sha256').update(Buffer.from(expect, 'hex')).digest('hex');
t('hashBench(3) chaîné correct', h1.success && h1.returnValue === expect);

// Envoi d'ASE
r = c.call(OTHER, 'inspect', [], ASE / 100n);
t('inspect avec 0,01 ASE réussit', r.success, r.error);
t('le contrat a reçu 0,01 ASE', chain.balanceOf(c.address) === ASE / 100n);
r = c.call(OTHER, 'payout', [OTHER, '1000']);
t('payout refusé à un non-propriétaire', !r.success);
const before = chain.balanceOf(OTHER);
r = c.call(OWNER, 'payout', [OTHER, '1000']);
t('payout propriétaire réussit', r.success, r.error);
t('le destinataire reçoit exactement 1000 wei', chain.balanceOf(OTHER) - before === 1000n);

// Annulation complète en cas d'échec
r = c.call(OWNER, 'failAfterWrite');
t('failAfterWrite échoue', !r.success);
t('écriture annulée après exception', c.view('readRollback').rollbackTest2 === null);

// Boucles, écritures, events
t('loop(1000) réussit', c.call(OWNER, 'loop', ['1000']).success);
t('bulkWrite(10, 100) réussit', c.call(OWNER, 'bulkWrite', ['10', '100']).success);
t('readBulk renvoie la bonne taille', c.view('readBulk', ['3']).len === 100);
r = c.call(OWNER, 'events');
t('events émet 2 événements', r.success && r.events.length === 2);
t('echo renvoie les types', c.view('echo', ['1', 2, [3]]).b === '2 :number');

console.log(`\n${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
