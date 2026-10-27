// Tests v3 : Écurie (chevaux des joueurs) + Paris, même tirage. node --test test/v3.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chain, ASE } from './simulateur.mjs';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUF = process.env.DEPLOY ? '.deploy.js' : '.js';
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const ADMIN = A(0xad), OWNER = A(0x0e), CRA = A(0xca), CRB = A(0xcb);
const P = Array.from({ length: 10 }, (_, i) => A(0x100 + i));
const H = 3600000n, DAY = 24n * H;
const sha = (h) => crypto.createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
const u64 = (n) => BigInt(n).toString(16).padStart(16, '0');
const commitOf = (seed, id, cr) => sha(seed + u64(id) + cr.slice(2));
const J = (s) => JSON.parse(s);

function world() {
  const e = new Chain(path.join(D, 'ecurie' + SUF)), p = new Chain(path.join(D, 'paris' + SUF));
  p.contract = '0x' + 'bb'.repeat(20);
  for (const c of [e, p]) { for (const a of [ADMIN, CRA, CRB, ...P]) c.fund(a, 100000n * ASE); c.call(ADMIN, 'init', [OWNER, CRA, CRB]); }
  return { e, p };
}
const sync = (w) => { w.p.timestamp = w.e.timestamp; };
const einfo = (w) => J(w.e.view('info'));
// une course complète : heure, clôture, enveloppes sur les 2 contrats, révélations
function race(w, { enter = [], f = [0, 0, 0, 0, 0, 0], bets = [] } = {}) {
  const { e, p } = w;
  let r = einfo(w).race; const id = r.id;
  const at = e.timestamp + 3n * H;
  e.call(CRA, 'plan', [id, at.toString()]);
  for (const [who, h] of enter) e.call(who, 'enter', [h], 5n * ASE);
  e.timestamp = at - H; sync(w);
  r = J(e.view('race', [id]));
  const hs = r.en.map((x) => Number(x.h)); let k = 0; while (hs.length < 6) hs.push(1000000 + k++);
  const setup = { horses: hs, w: hs.map((x, i) => 150 + i * 7), f, terrain: 1 };
  const seeds = { A: crypto.randomBytes(32).toString('hex'), B: crypto.randomBytes(32).toString('hex') };
  const pid = J(p.view('info')).current;
  for (const [cr, s] of [[CRA, 'A'], [CRB, 'B']]) {
    e.call(cr, 'commit', [id, commitOf(seeds[s], id, cr), s === 'A' ? JSON.stringify(setup) : ''], ASE);
    p.call(cr, 'commit', [pid, commitOf(seeds[s], pid, cr), at.toString(), s === 'A' ? JSON.stringify({ ...setup, info: id }) : ''], 10n * ASE);
  }
  for (const [who, t, sel, v] of bets) p.call(who, 'bet', [pid, t, sel], v);
  e.timestamp = at + 60000n; sync(w);
  for (const [cr, s] of [[CRA, 'A'], [CRB, 'B']]) { e.call(cr, 'reveal', [id, seeds[s]]); p.call(cr, 'reveal', [pid, seeds[s]]); }
  return { er: J(e.view('race', [id])), pr: J(p.view('race', [pid])), setup };
}

test('achat : prix = classe, 3 max, nom, argent au owner', () => {
  const w = world(), { e } = w;
  const b0 = e.bal(OWNER);
  assert.equal(e.call(P[0], 'buy', [5, 'Éclair'], 35n * ASE), '1');
  assert.throws(() => e.call(P[0], 'buy', [5, 'X'], 34n * ASE), /prix/);
  assert.throws(() => e.call(P[0], 'buy', [0, '<b>'], 10n * ASE), /nom/);
  e.call(P[0], 'buy', [0, 'Deux'], 10n * ASE); e.call(P[0], 'buy', [2, 'Trois'], 15n * ASE);
  assert.throws(() => e.call(P[0], 'buy', [0, 'Quatre'], 10n * ASE), /max 3/);
  assert.equal(e.bal(OWNER) - b0, 60n * ASE);
  const st = J(e.view('stable', [P[0]]));
  assert.deepEqual(st.map((h) => [h.n, h.c]), [['Éclair', 5], ['Deux', 0], ['Trois', 2]]);
  assert.equal(e.bal(e.contract), 0n);
});

test('nourrir / entraîner : prix, propriétaire, blessé', () => {
  const w = world(), { e } = w;
  e.call(P[0], 'buy', [1, 'A'], 12n * ASE);
  assert.throws(() => e.call(P[1], 'feed', [1], ASE), /pas ton cheval/);
  e.call(P[0], 'feed', [1], ASE); e.call(P[0], 'train', [1], 2n * ASE);
  const h = J(e.view('horse', [1]));
  assert.equal(h.fd.length, 1); assert.equal(h.tr.length, 1);
});

test('course : même arrivée sur les 2 contrats, prime 90 % au propriétaire, 10 % maison', () => {
  for (let n = 0; n < 15; n++) {
    const w = world(), { e, p } = w;
    e.call(P[0], 'buy', [5, 'Top'], 35n * ASE); e.call(P[1], 'buy', [0, 'Low'], 10n * ASE); e.call(P[2], 'buy', [3, 'Mid'], 20n * ASE);
    const o0 = e.bal(OWNER), b = [P[0], P[1], P[2]].map((x) => e.bal(x));
    const { er, pr, setup } = race(w, { enter: [[P[0], 1], [P[1], 2], [P[2], 3]], bets: [[P[5], 'W', [0], 2n * ASE]] });
    assert.deepEqual(er.order, pr.order);
    assert.equal(er.st, 'done'); assert.equal(pr.status, 'done');
    const win = setup.horses[er.order[0]];
    assert.equal(er.win, win);
    if (win < 4) {
      assert.equal(e.bal(OWNER) - o0, 15n * ASE / 10n);
      assert.equal(e.bal(P[win - 1]) - b[win - 1], 15n * ASE - 5n * ASE - 15n * ASE / 10n);
      assert.equal(J(e.view('horse', [win])).w, 1);
    } else assert.equal(einfo(w).carry, (135n * ASE / 10n).toString());   // gagnant maison : reporté
    assert.equal(e.bal(e.contract), BigInt(einfo(w).carry));
    assert.equal(einfo(w).current, '2'); assert.equal(einfo(w).race.st, 'entry');
  }
});

test('inscriptions : propriétaire, une fois, fermées avant la course, 6 max', () => {
  const w = world(), { e } = w;
  for (let i = 0; i < 7; i++) e.call(P[i], 'buy', [0, 'H' + i], 10n * ASE);
  assert.throws(() => e.call(P[1], 'enter', [1], 5n * ASE), /pas ton cheval/);
  e.call(P[0], 'enter', [1], 5n * ASE);
  assert.throws(() => e.call(P[0], 'enter', [1], 5n * ASE), /déjà inscrit/);
  for (let i = 1; i < 6; i++) e.call(P[i], 'enter', [i + 1], 5n * ASE);
  assert.throws(() => e.call(P[6], 'enter', [7], 5n * ASE), /complète/);
  const w2 = world();
  w2.e.call(P[0], 'buy', [0, 'X'], 10n * ASE);
  w2.e.call(CRA, 'plan', ['1', (w2.e.timestamp + 3n * H).toString()]);
  w2.e.timestamp += 2n * H + 1n;
  assert.throws(() => w2.e.call(P[0], 'enter', [1], 5n * ASE), /fermées/);
});

test('setup : doit contenir tous les inscrits, sinon refusé', () => {
  const w = world(), { e } = w;
  e.call(P[0], 'buy', [0, 'X'], 10n * ASE); e.call(P[0], 'enter', [1], 5n * ASE);
  const at = e.timestamp + 3n * H; e.call(CRA, 'plan', ['1', at.toString()]);
  assert.throws(() => e.call(CRA, 'commit', ['1', 'ab'.repeat(32), '{}'], ASE), /trop tôt/);
  e.timestamp = at - H;
  const bad = { horses: [1000000, 1000001, 1000002, 1000003, 1000004, 1000005], w: [1, 1, 1, 1, 1, 1], f: [0, 0, 0, 0, 0, 0] };
  assert.throws(() => e.call(CRA, 'commit', ['1', 'ab'.repeat(32), JSON.stringify(bad)], ASE), /setup/);
  bad.horses[0] = 1; e.call(CRA, 'commit', ['1', 'ab'.repeat(32), JSON.stringify(bad)], ASE);
});

test('chute = blessure ; entraînement consommé ; surentraîné → blessure possible', () => {
  const w = world(), { e } = w;
  e.call(P[0], 'buy', [0, 'X'], 10n * ASE);
  e.call(P[0], 'train', [1], 2n * ASE); e.call(P[0], 'train', [1], 2n * ASE);
  const { er } = race(w, { enter: [[P[0], 1]], f: [50000, 0, 0, 0, 0, 0] });
  const h = J(e.view('horse', [1]));
  assert.equal(h.tr.length, 0); assert.equal(h.r, 1);
  if (er.fell === 0) { assert.equal(h.l[0], 0); assert.ok(BigInt(h.inj) > e.timestamp); }
  // forcer la chute : 1 chance sur 20, on rejoue jusqu'à la voir
  let seen = false;
  for (let n = 0; n < 200 && !seen; n++) {
    const w2 = world(); w2.e.call(P[0], 'buy', [0, 'X'], 10n * ASE);
    const { er: r2 } = race(w2, { enter: [[P[0], 1]], f: [50000, 0, 0, 0, 0, 0] });
    if (r2.fell === 0) {
      seen = true; const h2 = J(w2.e.view('horse', [1]));
      assert.equal(r2.order[5], 0); assert.deepEqual(r2.inj, ['1']);
      assert.throws(() => w2.e.call(P[0], 'train', [1], 2n * ASE), /blessé/);
      assert.throws(() => w2.e.call(P[0], 'enter', [1], 5n * ASE), /blessé/);
      w2.e.timestamp = BigInt(h2.inj) + 1n; w2.e.call(P[0], 'enter', [1], 5n * ASE);
    }
  }
  assert.ok(seen);
});

test('annulation (croupier absent) : inscriptions remboursées, course suivante', () => {
  const w = world(), { e } = w;
  e.call(P[0], 'buy', [0, 'X'], 10n * ASE); e.call(P[0], 'enter', [1], 5n * ASE);
  const at = e.timestamp + 3n * H; e.call(CRA, 'plan', ['1', at.toString()]);
  e.timestamp = at + 30n * 60000n;
  assert.throws(() => e.call(P[3], 'cancel', ['1']), /trop tôt/);
  e.timestamp = at + 2n * H;
  const b = e.bal(P[0]); e.call(P[3], 'cancel', ['1']);
  assert.equal(e.bal(P[0]) - b, 5n * ASE);
  assert.equal(einfo(w).current, '2');
});

test('admin : réglages, pause, bannis', () => {
  const w = world(), { e } = w;
  assert.throws(() => e.call(P[0], 'set', ['entry', '1']), /admin/);
  e.call(ADMIN, 'set', ['entry', (3n * ASE).toString()]);
  e.call(ADMIN, 'set', ['prices', JSON.stringify(['1', '2', '3', '4', '5', '6'])]);
  e.call(ADMIN, 'set', ['hour', '20']); e.call(ADMIN, 'set', ['cutBps', '1500']);
  assert.throws(() => e.call(ADMIN, 'set', ['hour', '25']), /0 à 23/);
  assert.throws(() => e.call(ADMIN, 'set', ['zzz', '1']), /réglage/);
  const c = einfo(w).cfg; assert.equal(c.hour, 20); assert.equal(c.entry, (3n * ASE).toString());
  e.call(P[0], 'buy', [0, 'X'], 1n);
  e.call(ADMIN, 'set', ['paused', 'true']);
  assert.throws(() => e.call(P[0], 'feed', [1], ASE), /pause/);
  e.call(ADMIN, 'set', ['paused', 'false']);
  e.call(ADMIN, 'ban', [[P[0]], true]);
  assert.throws(() => e.call(P[0], 'feed', [1], ASE), /banni/);
});
