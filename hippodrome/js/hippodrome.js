// =====================================================================
//  ASE Vegas — Hippodrome (page du jeu)
//  - les partants en 3D (paddock), les paris avec le wallet
//  - la course rejouée en 3D à partir du résultat du contrat (identique pour tous)
//  - mes paris, gains, remboursements des courses annulées
// =====================================================================
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from '../vendor/jsm/RoomEnvironment.js';
import CONFIG from './config.js';
import { HORSES, JOCKEYS, TERRAINS, TERRAIN_ICONS, statsOf, scoreOf, racePlan, prefOf } from './stable.mjs';
import { Rpc, ExtensionWallet, TelegramWallet } from '../../loto/js/chain.js';
import * as L from '../../loto/js/lotomath.js';
import { startVegas } from '../../vegas.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ase = (w, d = 2) => L.fmtAse(BigInt(w), d).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
document.documentElement.dataset.theme = 'dark';
function toast(text, kind = '', ms = 6000) {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = text;
  $('#toasts').append(el); if (ms) setTimeout(() => el.remove(), ms); return el;
}
const cleanError = (e) => { const m = String(e && e.message ? e.message : e); const i = m.lastIndexOf('failed: '); return i >= 0 ? m.slice(i + 8) : m; };
const COATS = [['Bay', '#7b4426', '#160d08'], ['Chestnut', '#a5562a', '#7a3712'], ['Black', '#2f2826', '#0b0807'], ['Grey', '#b9b3ab', '#e8e4de'], ['Palomino', '#d4a256', '#f3e5c3'], ['Brown', '#4f2c1a', '#100907']];
const QUOTES = ['He ate like a horse this morning!', 'We\'re going for first place, nothing less.', 'I like the going today.', 'He was a bit lazy in training…', 'Keep an eye on us in the final stretch.', 'He loves the crowd, it fires him up.'];
const BET_TYPES = { W: ['Win', 1, 'Pick the winner.'], CO: ['Exacta', 2, 'First and second, in order.'], CD: ['Quinella', 2, 'First and second, any order.'], TO: ['Trifecta', 3, 'First three, in order.'], TD: ['Trifecta any order', 3, 'First three, any order.'] };
const TYPE_ORDER = ['W', 'CO', 'CD', 'TO', 'TD'];

let mode = 'paddock';

// ───────── Motifs de casaque ─────────
function silkPattern(name, color) {
  const d = '#0b0f16', l = '#ffffff', P = {
    'losanges':`<path d="M0 10 L10 0 L20 10 L10 20Z" fill="${d}"/>`,'rayures':`<rect width="20" height="7" fill="${d}"/>`,
    'étoile':`<path d="M10 3l2 5h5l-4 3 2 5-5-3-5 3 2-5-4-3h5z" fill="${d}"/>`,'éclair':`<path d="M11 1L4 11h5l-2 8 8-11h-5z" fill="${d}"/>`,
    'chevrons':`<path d="M0 6l10 6 10-6v5l-10 6-10-6z" fill="${d}"/>`,'damier':`<rect width="10" height="10" fill="${d}"/><rect x="10" y="10" width="10" height="10" fill="${d}"/>`,
    'cercles':`<circle cx="10" cy="10" r="5" fill="none" stroke="${d}" stroke-width="3"/>`,'flèche':`<path d="M2 10h11V5l6 5-6 5v-5" fill="${d}"/>`,
    'bandes':`<rect x="0" width="7" height="20" fill="${d}"/>`,'croix':`<rect x="8" width="4" height="20" fill="${d}"/><rect y="8" width="20" height="4" fill="${d}"/>`,
    'pois':`<circle cx="5" cy="5" r="3" fill="${l}"/><circle cx="15" cy="15" r="3" fill="${l}"/>`,'triangles':`<path d="M0 20L10 2 20 20z" fill="${d}"/>`,
    'spirale':`<path d="M10 10m-1 0a1 1 0 1 1 2 0a3 3 0 1 1-6 0a5 5 0 1 1 10 0a7 7 0 1 1-14 0" fill="none" stroke="${d}" stroke-width="2"/>`,
    'vagues':`<path d="M0 10q5-6 10 0t10 0" fill="none" stroke="${d}" stroke-width="3"/>`,'demi-lune':`<path d="M13 3a7 7 0 1 0 0 14a5 5 0 1 1 0-14z" fill="${d}"/>`,
    'étoiles':`<path d="M5 2l1 3h3l-2 2 1 3-3-2-3 2 1-3-2-2h3zM15 11l1 3h3l-2 2 1 3-3-2-3 2 1-3-2-2h3z" fill="${d}"/>`,
    'feuilles':`<path d="M3 17C3 8 10 3 17 3c0 8-5 14-14 14z" fill="${d}"/>`,
    'atomes':`<ellipse cx="10" cy="10" rx="8" ry="3" fill="none" stroke="${d}" stroke-width="1.6"/><ellipse cx="10" cy="10" rx="3" ry="8" fill="none" stroke="${d}" stroke-width="1.6"/><circle cx="10" cy="10" r="2" fill="${d}"/>`};
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><pattern id="s" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="${color}"/>${P[name] || ''}</pattern></defs><rect width="100" height="100" fill="url(#s)"/></svg>`;
}
const loadImg = (svg) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });

// ───────── Scène 3D ─────────
const host = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
scene.background = canvasTex(4, 256, (g) => { const gr = g.createLinearGradient(0, 0, 0, 256); [[0, '#16233f'], [.45, '#3c5482'], [.62, '#c9866a'], [.75, '#f2b77e'], [1, '#f2b77e']].forEach(([o, c]) => gr.addColorStop(o, c)); g.fillStyle = gr; g.fillRect(0, 0, 4, 256); });
scene.fog = new THREE.Fog(0x6a6f88, 1300, 3200);

const camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enablePan: false, enableZoom: false, enableDamping: true, minPolarAngle: 0.9, maxPolarAngle: 1.55 });

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x3a5a2a, 1.1));
const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 300, bottom: -300, near: 10, far: 1400 });
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight(0x9cc4ff, 1.3); scene.add(rim, rim.target);

function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }

// piste (12 000 unités de long, motifs qui se répètent tous les 4 000 → défilement infini au paddock)
const TRACK = 12000;
const grass = canvasTex(512, 512, (g) => {
  for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#3d8a3f' : '#46974a'; g.fillRect(i * 128, 0, 128, 512); }
  for (let i = 0; i < 26000; i++) { g.fillStyle = `hsla(${100 + Math.random() * 25},${35 + Math.random() * 25}%,${20 + Math.random() * 35}%,.35)`; g.fillRect(Math.random() * 512, Math.random() * 512, 1.2, 2.5); }
});
grass.wrapS = grass.wrapT = THREE.RepeatWrapping; grass.repeat.set(TRACK / 250, 3000 / 250); grass.anisotropy = 8;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(TRACK, 3000), new THREE.MeshStandardMaterial({ map: grass, roughness: .95 }));
ground.rotation.x = -Math.PI / 2; ground.position.x = TRACK / 2 - 2000; ground.receiveShadow = true; scene.add(ground);

const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: .4 });
const NP = TRACK / 50, posts = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 62, 4), white, NP);
const mtx = new THREE.Matrix4(); for (let i = 0; i < NP; i++) posts.setMatrixAt(i, mtx.makeTranslation(-2000 + i * 50, 31, -150));
posts.castShadow = true; scene.add(posts);
const bar = new THREE.Mesh(new THREE.BoxGeometry(TRACK, 5, 4), white); bar.position.set(TRACK / 2 - 2000, 62, -150); bar.castShadow = true; scene.add(bar);

const crowd = canvasTex(1024, 256, (g) => {
  g.fillStyle = '#1b2333'; g.fillRect(0, 0, 1024, 256); const cols = ['#f4c542','#ff5d6c','#4da6ff','#57e08a','#b48bff','#e9edf3','#ff9f2e','#d06030'];
  for (let i = 0; i < 2600; i++) { const x = Math.random() * 1024, y = 20 + Math.random() * 220; g.fillStyle = '#d9b48f'; g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill(); g.fillStyle = cols[i % 8]; g.fillRect(x - 3, y + 2, 6, 6); }
});
crowd.wrapS = THREE.RepeatWrapping; crowd.repeat.x = TRACK / 800;
const stand = new THREE.Mesh(new THREE.PlaneGeometry(TRACK, 180), new THREE.MeshStandardMaterial({ map: crowd, roughness: 1 }));
stand.position.set(TRACK / 2 - 2000, 80, -760); stand.rotation.x = -.25; scene.add(stand);
const roof = new THREE.Mesh(new THREE.BoxGeometry(TRACK, 12, 90), new THREE.MeshStandardMaterial({ color: 0x2a3446 })); roof.position.set(TRACK / 2 - 2000, 175, -790); scene.add(roof);
const NL = TRACK / 400, poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(3, 3, 300), new THREE.MeshStandardMaterial({ color: 0x3a4456 }), NL);
const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(60, 18, 6), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }), NL);
for (let i = 0; i < NL; i++) { poles.setMatrixAt(i, mtx.makeTranslation(-2000 + i * 400, 150, -620)); lamps.setMatrixAt(i, mtx.makeTranslation(-2000 + i * 400, 305, -616)); }
scene.add(poles, lamps);

// départ et arrivée (visibles seulement pendant la course)
const D = 7200;                                     // longueur de la course en unités 3D (affichée 1,200 m)
const marks = new THREE.Group(); scene.add(marks);
const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
for (const x of [0, D]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(6, 300), lineMat); l.rotation.x = -Math.PI / 2; l.position.set(x, .5, -10); marks.add(l); }
const finishTex = canvasTex(64, 512, (g) => { for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#d22' : '#fff'; g.fillRect(0, i * 32, 64, 32); } });
const fpole = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 220, 16), new THREE.MeshStandardMaterial({ map: finishTex })); fpole.position.set(D, 110, -150); fpole.castShadow = true; marks.add(fpole);
const disc = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 3, 32), new THREE.MeshStandardMaterial({ color: 0xd22222 })); disc.rotation.x = Math.PI / 2; disc.position.set(D, 230, -150); marks.add(disc);
const gateMat = new THREE.MeshStandardMaterial({ color: 0x2a6fd6, roughness: .5 });
const gate = new THREE.Group(); for (let k = 0; k < 7; k++) { const p = new THREE.Mesh(new THREE.BoxGeometry(10, 120, 10), gateMat); p.position.set(-40, 60, -110 + k * 32); gate.add(p); }
const gtop = new THREE.Mesh(new THREE.BoxGeometry(16, 14, 210), gateMat); gtop.position.set(-40, 126, -14); gate.add(gtop); marks.add(gate);
marks.visible = false;


// ───────── Chevaux et jockeys (géométrie) ─────────
function smoothNormals(geo) {
  const pos = geo.attributes.position, n = pos.count, tri = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i);
  const key = (i) => `${Math.round(pos.getX(i) * 2)},${Math.round(pos.getY(i) * 2)},${Math.round(pos.getZ(i) * 2)}`;
  const acc = new Map(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tri.length; t += 3) {
    a.fromBufferAttribute(pos, tri[t]); b.fromBufferAttribute(pos, tri[t + 1]); c.fromBufferAttribute(pos, tri[t + 2]);
    const f = b.clone().sub(a).cross(c.clone().sub(a));
    for (let k = 0; k < 3; k++) { const kk = key(tri[t + k]); acc.set(kk, (acc.get(kk) || new THREE.Vector3()).add(f)); }
  }
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = acc.get(key(i)).clone().normalize(); arr.set([v.x, v.y, v.z], i * 3); }
  geo.setAttribute('normal', new THREE.BufferAttribute(arr, 3)); delete geo.morphAttributes.normal;
}
function paintCoat(mesh, coat, mane) {
  const col = mesh.geometry.attributes.color, src = mesh.userData.orig, c = new THREE.Color(coat), d = new THREE.Color(mane);
  for (let i = 0; i < col.count; i++) {
    const lum = .3 * src[i * 3] + .59 * src[i * 3 + 1] + .11 * src[i * 3 + 2], k = .62 + lum * .45;
    if (lum < .18) col.setXYZ(i, d.r, d.g, d.b); else col.setXYZ(i, c.r * k, c.g * k, c.b * k);
  }
  col.needsUpdate = true;
}
// Bras posés en direct (épaule → coude → main sur les rênes) : cylindres orientés entre deux points
const AXIS_Y = new THREE.Vector3(0, 1, 0), CYL = new THREE.CylinderGeometry(1, 1, 1, 10), BALL = new THREE.SphereGeometry(1, 10, 8);
function seg(m, A, B, r) { const d = B.clone().sub(A); m.position.copy(A).addScaledVector(d, .5); m.scale.set(r, d.length(), r); m.quaternion.setFromUnitVectors(AXIS_Y, d.normalize()); }
function makeArm(silk) {
  const g = new THREE.Group(), glove = new THREE.MeshStandardMaterial({ color: 0xf6f6f6, roughness: .6 }), leather = new THREE.MeshStandardMaterial({ color: 0x3a2416, roughness: .5 });
  const upper = new THREE.Mesh(CYL, silk), fore = new THREE.Mesh(CYL, silk), elbow = new THREE.Mesh(BALL, silk), shoulder = new THREE.Mesh(BALL, silk), hand = new THREE.Mesh(BALL, glove), rein = new THREE.Mesh(CYL, leather);
  [upper, fore, elbow, shoulder, hand].forEach((m) => { m.castShadow = true; g.add(m); }); g.add(rein);
  return Object.assign(g, { upper, fore, elbow, shoulder, hand, rein });
}
function poseArm(arm, S, H, M, out, r) {
  const E = S.clone().lerp(H, .5).add(out);
  seg(arm.upper, S, E, r); seg(arm.fore, E, H, r * .9);
  arm.elbow.position.copy(E); arm.elbow.scale.setScalar(r); arm.shoulder.position.copy(S); arm.shoulder.scale.setScalar(r * 1.1);
  arm.hand.position.copy(H); arm.hand.scale.setScalar(r * 1.05);
  if (M) { seg(arm.rein, H, M, .45); arm.rein.visible = true; } else arm.rein.visible = false;
}
// Jockey de course : debout dans les étriers, genoux hauts, buste presque à l'horizontale, tête relevée
function buildJockey(silk) {
  const J = new THREE.Group(), body = new THREE.Group(); J.add(body);
  const M = (c, r = .6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const skin = M(0xe0b08a), wht = M(0xf3f0ea, .7), boot = M(0x15100d, .25, .1);
  const limb = (r, len, mat, from, to) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), mat), A = new THREE.Vector3(...from), B = new THREE.Vector3(...to), dd = B.clone().sub(A);
    m.position.copy(A).addScaledVector(dd, .5); m.quaternion.setFromUnitVectors(AXIS_Y, dd.normalize()); m.castShadow = true; body.add(m); return m;
  };
  // repère : origine sur la selle ; fesses juste au-dessus, buste couché vers l'avant, genoux contre le garrot, étriers courts
  const hip = [-2, 7, 0], sh = [17, 13, 0];
  const torso = limb(6, 15, silk, hip, sh); torso.scale.z = .8;
  const seat = new THREE.Mesh(new THREE.SphereGeometry(5.4, 14, 10), wht); seat.position.set(-3, 6, 0); seat.scale.set(1.1, .8, 1); seat.castShadow = true; body.add(seat);
  for (const z of [-1, 1]) {
    limb(3.3, 10, wht, [-2, 6, z * 4], [12, 3, z * 10]);             // cuisse : du siège au genou, vers l'avant
    limb(2.8, 10, boot, [12, 3, z * 10], [4, -11, z * 11.5]);        // botte : du genou à l'étrier, sous le genou
    const iron = new THREE.Mesh(new THREE.TorusGeometry(2.4, .5, 6, 14), new THREE.MeshStandardMaterial({ color: 0xc9c2b8, metalness: .8, roughness: .3 }));
    iron.position.set(4, -13.5, z * 11.5); body.add(iron);
  }
  limb(2.4, 2.5, skin, [sh[0] + 2, sh[1] + 2, 0], [21, 18, 0]);
  const head = new THREE.Mesh(new THREE.SphereGeometry(5, 20, 14), skin); head.position.set(24.5, 20.5, 0); head.castShadow = true; body.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(5.6, 20, 12, 0, Math.PI * 2, 0, Math.PI * .55), silk); helmet.position.set(24, 21.5, 0); helmet.rotation.z = -.5; helmet.castShadow = true; body.add(helmet);
  const peak = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, .8, 14, 1, false, -Math.PI / 2, Math.PI), silk); peak.position.set(28, 20, 0); peak.rotation.z = -.45; body.add(peak);
  const gog = new THREE.Mesh(new THREE.TorusGeometry(5.2, .7, 6, 20, Math.PI * .9), M(0x9fd8ff, .15, .6)); gog.position.set(24.5, 22.5, 0); gog.rotation.set(0, Math.PI / 2, Math.PI * .1); body.add(gog);
  J.userData.shoulders = [new THREE.Vector3(16, 13, -6), new THREE.Vector3(16, 13, 6)];
  J.scale.setScalar(1.3); return J;
}
// Jockey debout (paddock) : origine aux pieds, il regarde vers +z
function buildStandingJockey(silk) {
  const J = new THREE.Group(), body = new THREE.Group(); J.add(body);
  const M = (c, r = .6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const skin = M(0xe0b08a), wht = M(0xf3f0ea, .7), boot = M(0x15100d, .22, .15), glove = M(0xf6f6f6);
  const limb = (r, len, mat, from, to) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), mat), A = new THREE.Vector3(...from), B = new THREE.Vector3(...to), dd = B.clone().sub(A);
    m.position.copy(A).addScaledVector(dd, .5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dd.normalize()); m.castShadow = true; body.add(m); return m;
  };
  for (const x of [-4.2, 4.2]) {
    limb(3, 14, boot, [x, 3, 0], [x, 19, 0]);
    const toe = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 8), boot); toe.scale.set(1, .6, 1.7); toe.position.set(x, 2, 2.5); toe.castShadow = true; body.add(toe);
    limb(3.6, 14, wht, [x, 20, 0], [x * .8, 36, 0]);
  }
  const torso = limb(7.6, 14, silk, [0, 38, 0], [0, 56, 0]); torso.scale.z = .72;
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(7.4, 7.4, 3, 20), wht); belt.scale.z = .74; belt.position.y = 36; body.add(belt);
  limb(2.6, 12, silk, [-9, 58, 0], [-11, 42, 1]); limb(2.3, 9, silk, [-11, 42, 1], [-10, 31, 3]);
  const g1 = new THREE.Mesh(new THREE.SphereGeometry(2.4, 10, 8), glove); g1.position.set(-10, 29, 3.5); body.add(g1);
  limb(2.6, 3, skin, [0, 60, 0], [0, 65, 0]);
  const head = new THREE.Mesh(new THREE.SphereGeometry(5.6, 22, 16), skin); head.scale.set(.92, 1.05, .95); head.position.set(0, 70, .5); head.castShadow = true; body.add(head);
  for (const x of [-2, 2]) { const e = new THREE.Mesh(new THREE.SphereGeometry(.7, 8, 6), M(0x1a1410)); e.position.set(x, 71, 5.6); body.add(e); }
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(6.3, 22, 12, 0, Math.PI * 2, 0, Math.PI * .52), silk); helmet.position.set(0, 71.5, 0); helmet.rotation.x = -.15; helmet.castShadow = true; body.add(helmet);
  const peak = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, .8, 14, 1, false, -Math.PI / 2, Math.PI), silk); peak.rotation.y = -Math.PI / 2; peak.position.set(0, 72, 5.2); body.add(peak);
  const gog = new THREE.Mesh(new THREE.TorusGeometry(6, .8, 6, 24, Math.PI), M(0x9fd8ff, .15, .6)); gog.position.set(0, 74, 0); gog.rotation.set(-Math.PI / 2 + .35, 0, 0); body.add(gog);
  const whip = limb(.5, 26, M(0x111111, .4), [-10, 29, 3.5], [-12, 6, 10]);
  J.userData.shoulder = new THREE.Vector3(9, 58, 0);
  return J;
}
// Tapis et selle : découpés dans la surface du cheval lui-même (mêmes morphs) → ils suivent le corps au galop, rien ne rentre dedans
function shell(mesh, W, box, offWorld, mat) {
  const geo = mesh.geometry, pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count;
  const sc = mesh.matrixWorld.getMaxScaleOnAxis(), off = offWorld / sc;
  const inBox = (i) => W[i].x >= box.x0 && W[i].x <= box.x1 && W[i].y >= box.y0;
  const keep = [];
  const ix = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t < ix.length; t += 3) if (box.any ? (inBox(ix[t]) || inBox(ix[t + 1]) || inBox(ix[t + 2])) : (inBox(ix[t]) && inBox(ix[t + 1]) && inBox(ix[t + 2]))) keep.push(ix[t], ix[t + 1], ix[t + 2]);
  const P = new Float32Array(keep.length * 3), UV = new Float32Array(keep.length * 2), N = new Float32Array(keep.length * 3);
  keep.forEach((i, k) => {
    P[k * 3] = pos.getX(i) + nrm.getX(i) * off; P[k * 3 + 1] = pos.getY(i) + nrm.getY(i) * off; P[k * 3 + 2] = pos.getZ(i) + nrm.getZ(i) * off;
    N.set([nrm.getX(i), nrm.getY(i), nrm.getZ(i)], k * 3);
    const u = (W[i].x - box.x0) / (box.x1 - box.x0);
    UV[k * 2] = u; UV[k * 2 + 1] = (W[i].y - box.y0) / (box.yTop - box.y0);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  const ma = geo.morphAttributes.position;
  if (ma) { g.morphTargetsRelative = geo.morphTargetsRelative;
  g.morphAttributes.position = ma.map((a) => { const A = new Float32Array(keep.length * 3); keep.forEach((i, k) => A.set([a.getX(i), a.getY(i), a.getZ(i)], k * 3)); return new THREE.BufferAttribute(A, 3); }); }
  const m = new THREE.Mesh(g, mat); m.castShadow = true;
  if (ma) { m.morphTargetInfluences = mesh.morphTargetInfluences; m.morphTargetDictionary = mesh.morphTargetDictionary; }
  mesh.add(m); return m;
}


// ───────── Modèle 3D : préparé une fois, puis un cheval par partant ─────────
const LANES = [-104, -72, -40, -8, 24, 56];
let horses = [];                 // les 6 partants affichés (index = couloir)
let ready = false, M = null;     // M : modèle préparé
let AVG = null;

async function prepareModel() {
  const buf = await (await fetch(new URL('../modeles/Horse.glb', import.meta.url))).arrayBuffer();
  const gltf = await new Promise((ok, ko) => new GLTFLoader().parse(buf, '', ok, ko));
  const src = gltf.scene, clip = gltf.animations[0];
  let srcMesh = null; src.traverse((o) => { if (o.isMesh) { smoothNormals(o.geometry); srcMesh = o; } });
  const orig = srcMesh.geometry.attributes.color.array.slice();
  // pose moyenne du galop (cheval presque debout) et repères du corps, calculés une fois
  const root = src.clone(true); let mesh = null; root.traverse((o) => { if (o.isMesh) mesh = o; });
  root.rotation.y = Math.PI / 2; root.scale.setScalar(.62);
  const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(clip); action.play();
  AVG = new Array(mesh.morphTargetInfluences.length).fill(0);
  for (let k = 0; k < 60; k++) { action.time = clip.duration * k / 60; mixer.update(0); mesh.morphTargetInfluences.forEach((w, i) => AVG[i] += w / 60); }
  mixer.stopAllAction(); AVG.forEach((w, i) => mesh.morphTargetInfluences[i] = w);
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3(), W = [];
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) { mesh.getVertexPosition(i, v); mesh.localToWorld(v); W.push(v.clone()); }
  const xs = W.map((p) => p.x), x0 = Math.min(...xs), L = Math.max(...xs) - x0;
  const pick = (a, b) => W.map((p, i) => [i, p]).filter(([, p]) => p.x > x0 + a * L && p.x < x0 + b * L && Math.abs(p.z) < 6).sort((p, q) => q[1].y - p[1].y)[0][0];
  const mid = W.filter((p) => p.x > x0 + .53 * L && p.x < x0 + .60 * L), top = Math.max(...mid.map((p) => p.y)), zMid = mid.reduce((a, p) => a + p.z, 0) / mid.length;
  const belly = Math.min(...W.filter((p) => p.x > x0 + .52 * L && p.x < x0 + .60 * L).map((p) => p.y)) - 2;
  const legOf = (p) => (p.x > x0 + .6 * L ? 2 : 0) + (p.z < zMid ? 1 : 0), lowMin = [1e9, 1e9, 1e9, 1e9];
  W.forEach((p) => { if (p.y < belly) lowMin[legOf(p)] = Math.min(lowMin[legOf(p)], p.y); });
  const topX = [0, 0, 0, 0], topN = [0, 0, 0, 0], botX = [0, 0, 0, 0], botN = [0, 0, 0, 0];
  W.forEach((p) => { if (p.y < belly && p.y > belly - 8) { topX[legOf(p)] += p.x; topN[legOf(p)]++; } if (p.y < lowMin[legOf(p)] + 6) { botX[legOf(p)] += p.x; botN[legOf(p)]++; } });
  const avgLow = lowMin.reduce((a, b) => a + b, 0) / 4, drop = avgLow * .6, HOOF = 7;
  const zC = [0, 0, 0, 0], zN = [0, 0, 0, 0]; W.forEach((p) => { if (p.y < belly) { zC[legOf(p)] += p.z; zN[legOf(p)]++; } });
  const SP = new Float32Array(W.length * 3);
  W.forEach((p, i) => { let x = p.x, y = p.y - drop, z = p.z;
    if (p.y < belly) { const g = legOf(p), d = belly - p.y, len = belly - lowMin[g], newLen = belly - drop, f = d / len;
      y = d >= len - HOOF ? p.y - lowMin[g] : (belly - drop) - d * (newLen - HOOF) / (len - HOOF);
      const ax = topX[g] / topN[g] + (botX[g] / botN[g] - topX[g] / topN[g]) * f;
      x = ax + (x - ax) * 1.25 + (topX[g] / topN[g] - botX[g] / botN[g]) * f * .85;
      z = zC[g] / zN[g] + (z - zC[g] / zN[g]) * 1.2;
      if (d >= len - HOOF) { if (y < 2.5) y = 0; x = ax + (x - ax) * 1.3; z = zC[g] / zN[g] + (z - zC[g] / zN[g]) * 1.25; } }
    SP.set([x, y, z], i * 3); });
  const SW = W.map((p, i) => new THREE.Vector3(SP[i * 3], SP[i * 3 + 1], SP[i * 3 + 2]));
  const lower = (B) => ({ ...B, y0: B.y0 - drop, yTop: B.yTop - drop });
  M = { src, clip, orig, W, SW, SP, x0, L, top, zMid, belly, lower, index: srcMesh.geometry.index,
    back: pick(.58, .63), rump: pick(.48, .53),
    headIdx: W.map((p, i) => [i, p]).filter(([, p]) => p.y > top - 10).sort((a, b) => b[1].x - a[1].x)[0][0],
    neckIdx: W.map((p, i) => [i, p]).filter(([, p]) => p.x > x0 + .70 * L && p.x < x0 + .75 * L && Math.abs(p.z - zMid) < 6).sort((a, b) => b[1].y - a[1].y)[0][0],
    mouth: SW.filter((p) => p.y > top - 10).sort((p, q) => q.x - p.x)[0].clone().add(new THREE.Vector3(-4, -6, 0)) };
}

// h : { id, num, name, color, silk, jockey, coat:[nom, robe, crins] }
async function makeHorse(h) {
  const { W, SW, x0, L, top, zMid, belly, lower } = M;
  const root = M.src.clone(true);
  let mesh = null;
  root.traverse((o) => { if (o.isMesh) { o.geometry = o.geometry.clone(); o.userData.orig = M.orig; o.castShadow = true;
    o.material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .38, sheen: .6, sheenRoughness: .5, sheenColor: new THREE.Color(0xffe6c8), clearcoat: .15, clearcoatRoughness: .6 }); mesh = o; } });
  paintCoat(mesh, h.coat[1], h.coat[2]);
  root.rotation.y = Math.PI / 2; root.scale.setScalar(.62); scene.add(root);
  const mixer = new THREE.AnimationMixer(root), action = mixer.clipAction(M.clip); action.play();
  AVG.forEach((w, i) => mesh.morphTargetInfluences[i] = w);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(M.SP, 3)); sg.setAttribute('color', mesh.geometry.attributes.color.clone()); if (M.index) sg.setIndex(M.index); smoothNormals(sg);
  const stand = new THREE.Mesh(sg, mesh.material); stand.castShadow = true; scene.add(stand);
  const img = await loadImg(silkPattern(h.silk, h.color));
  const st = canvasTex(256, 256, (g) => g.drawImage(img, 0, 0, 256, 256)); st.wrapS = st.wrapT = THREE.RepeatWrapping; st.repeat.set(2, 2);
  const silkMat = new THREE.MeshStandardMaterial({ map: st, roughness: .35, metalness: .05 });
  const ct = canvasTex(512, 256, (g) => {
    g.save(); g.beginPath(); g.roundRect(28, -20, 456, 248, 26); g.clip();
    for (let x = 0; x < 512; x += 128) for (let y = 0; y < 256; y += 128) g.drawImage(img, x, y, 128, 128);
    g.restore(); g.strokeStyle = '#fff'; g.lineWidth = 10; g.beginPath(); g.roundRect(33, -20, 446, 243, 22); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(178, 100, 156, 122, 14); g.fill();
    g.fillStyle = '#111'; g.font = 'bold 112px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(h.num, 256, 164);
  });
  const clothMat = new THREE.MeshStandardMaterial({ map: ct, roughness: .7, transparent: true, alphaTest: .5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  const CB = { x0: x0 + .50 * L, x1: x0 + .69 * L, y0: top - 34, yTop: top + 2, zMid, any: 1 };
  shell(mesh, W, CB, .9, clothMat); shell(stand, SW, lower(CB), .9, clothMat);
  const sd = canvasTex(256, 128, (g) => { const gr = g.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, '#b07a46'); gr.addColorStop(1, '#5a341a'); g.fillStyle = gr; g.beginPath(); g.ellipse(128, 30, 112, 88, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#d9b37b'; g.lineWidth = 4; g.beginPath(); g.ellipse(128, 30, 100, 78, 0, 0, Math.PI * 2); g.stroke(); });
  const SB = { x0: x0 + .555 * L, x1: x0 + .645 * L, y0: top - 10, yTop: top + 1, zMid, any: 1 }, saddleMat = new THREE.MeshStandardMaterial({ map: sd, roughness: .35, transparent: true, alphaTest: .5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 });
  shell(mesh, W, SB, 1.8, saddleMat); shell(stand, SW, lower(SB), 1.8, saddleMat);
  const GB = { x0: x0 + .60 * L, x1: x0 + .625 * L, y0: belly - 4, yTop: top, zMid }, girthMat = new THREE.MeshStandardMaterial({ color: 0x2b1a10, roughness: .5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 });
  shell(mesh, W, GB, 1.2, girthMat); shell(stand, SW, lower(GB), 1.2, girthMat);
  const jockey = buildJockey(silkMat), stander = buildStandingJockey(silkMat), rArms = [makeArm(silkMat), makeArm(silkMat)], sArm = makeArm(silkMat);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(128, 128, (g) => { g.fillStyle = h.color; g.beginPath(); g.roundRect(8, 8, 112, 112, 22); g.fill(); g.lineWidth = 6; g.strokeStyle = '#0a0e13'; g.stroke(); g.fillStyle = '#0a0e13'; g.font = 'bold 84px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(h.num, 64, 70); }), depthTest: false }));
  tag.scale.set(40, 40, 1); tag.renderOrder = 10;
  scene.add(jockey, stander, tag, ...rArms, sArm);
  return { ...h, mouth: M.mouth, headIdx: M.headIdx, neckIdx: M.neckIdx, back: M.back, rump: M.rump, rArms, sArm, stand, root, mesh, mixer, action, jockey, stander, tag, x: 0, z: 0, speed: 0 };
}
function dropHorse(h) {
  for (const o of [h.root, h.stand, h.jockey, h.stander, h.tag, ...h.rArms, h.sArm]) {
    scene.remove(o);
    o.traverse((x) => { if (x.geometry && x.geometry !== CYL && x.geometry !== BALL && x.geometry.attributes?.position?.array !== M.SP) x.geometry.dispose(); if (x.material) [].concat(x.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); });
  }
}
// Affiche les 6 partants d'une course (reconstruit seulement si la liste change)
let runnersKey = '';
async function setRunners(list) {
  const key = list.map((h) => `${h.id}:${h.num}`).join(',');
  if (key === runnersKey) return;
  runnersKey = key;
  horses.forEach(dropHorse); horses = [];
  for (const h of list) horses.push(await makeHorse(h));
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3();
const BASE_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), PIVOT = new THREE.Vector3(30, 30, 0);
function placeHorse(h) {
  h.root.position.set(h.x, h.fy || 0, h.z);
  if (h.fallQ) {                                                    // chute : rotation autour d'un point près des épaules
    h.root.quaternion.copy(h.fallQ).multiply(BASE_Q);
    h.root.position.add(PIVOT).sub(PIVOT.clone().applyQuaternion(h.fallQ));
  } else h.root.quaternion.copy(BASE_Q);
  h.root.updateMatrixWorld(true);
  h.mesh.getVertexPosition(h.back, tmpA); h.mesh.localToWorld(tmpA); h.mesh.getVertexPosition(h.rump, tmpB); h.mesh.localToWorld(tmpB);
  const ang = Math.atan2(tmpA.y - tmpB.y, tmpA.x - tmpB.x);
  h.tag.position.copy(tmpA).add(up.set(0, 78, 0));
  if (h.thrown) { poseThrown(h); return; }
  h.jockey.position.copy(tmpA).add(up.set(-2, 1, 0)); h.jockey.rotation.set(0, 0, Math.max(-.2, Math.min(.2, ang * .3)));
  if (h.fallQ) h.jockey.quaternion.premultiply(h.fallQ);
  h.jockey.updateMatrixWorld(true);
  // mains sur l'encolure, rênes jusqu'à la bouche
  const neck = h.mesh.getVertexPosition(h.neckIdx, new THREE.Vector3()); h.mesh.localToWorld(neck);
  const mouthW = h.mesh.getVertexPosition(h.headIdx, new THREE.Vector3()); h.mesh.localToWorld(mouthW); mouthW.add(up.set(-5, -6, 0));
  h.rArms.forEach((arm, k) => { const sz = k ? 1 : -1;
    poseArm(arm, h.jockey.localToWorld(h.jockey.userData.shoulders[k].clone()), neck.clone().add(new THREE.Vector3(-4, 4, sz * 5)), mouthW.clone().add(new THREE.Vector3(0, 0, sz * 2)), new THREE.Vector3(0, -2, sz * 7), 3.2); });
}
// jockey éjecté : vol, roulade au sol, puis il se relève assis (il va bien)
function poseThrown(h) {
  const j = h.thrown, J = h.jockey;
  J.position.copy(j.pos); J.quaternion.copy(j.q); J.updateMatrixWorld(true);
  h.rArms.forEach((arm, k) => { const sz = k ? 1 : -1, S = J.localToWorld(J.userData.shoulders[k].clone());
    const H = j.state === 'sit' ? J.localToWorld(new THREE.Vector3(22, 0, sz * 8)) : S.clone().add(new THREE.Vector3(Math.cos(j.t * 14 + k) * 9, 6 + Math.sin(j.t * 11 + k) * 7, sz * 8));
    poseArm(arm, S, H, null, new THREE.Vector3(0, -2, sz * 5), 3.2); });
}

const setVisible = (h, on) => { h.root.visible = on && mode === 'race'; h.stand.visible = on && mode === 'paddock'; h.jockey.visible = on && mode === 'race'; h.rArms.forEach((a) => a.visible = on && mode === 'race'); h.sArm.visible = on && mode === 'paddock'; h.tag.visible = on && mode === 'race'; h.stander.visible = on && mode === 'paddock'; };

// ───────── Poussière (chute) ─────────
const dustTex = canvasTex(64, 64, (g) => { const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30); gr.addColorStop(0, 'rgba(214,190,150,.9)'); gr.addColorStop(1, 'rgba(214,190,150,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); });
const dust = [];
function burst(pos, n, power = 1) {
  for (let i = 0; i < n; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: .85 }));
    sp.position.copy(pos).add(new THREE.Vector3((Math.random() - .5) * 40, Math.random() * 10, (Math.random() - .5) * 30));
    sp.userData = { v: new THREE.Vector3((Math.random() - .3) * 120 * power, (20 + Math.random() * 60) * power, (Math.random() - .5) * 80 * power), life: 0, max: 1.2 + Math.random() * .9, s: 14 + Math.random() * 14 };
    scene.add(sp); dust.push(sp);
  }
}
function stepDust(dt) {
  for (let i = dust.length - 1; i >= 0; i--) {
    const d = dust[i], u = d.userData; u.life += dt;
    d.position.addScaledVector(u.v, dt); u.v.multiplyScalar(Math.exp(-2.2 * dt)); u.v.y -= 30 * dt;
    const k = u.life / u.max; d.scale.setScalar(u.s * (1 + k * 2.5)); d.material.opacity = .8 * (1 - k);
    if (k >= 1) { scene.remove(d); d.material.dispose(); dust.splice(i, 1); }
  }
}


// ───────── Course rejouée ─────────
const ramp = (t) => t - .9 * (1 - Math.exp(-t / .9));
function progress(h, t) {
  const tt = ramp(t), Tt = ramp(h.T), u = Math.min(tt / Tt, 1);
  return u + h.a * Math.sin(2 * Math.PI * u + h.ph) / (2 * Math.PI) * (1 - Math.cos(2 * Math.PI * u)) / 2 + h.b * Math.sin(4 * Math.PI * u) / (4 * Math.PI);
}
function raceStep(dt) {
  const r = race;
  if (r.slow > 0) { r.slow -= dt; dt *= .4; }                         // ralenti pendant la chute
  r.t += dt; r.dt = dt;
  const cnt = $('#count');
  if (r.t < 0) { cnt.hidden = false; cnt.textContent = Math.ceil(-r.t) > 3 ? '' : Math.ceil(-r.t); }
  else if (r.t < .6) { cnt.hidden = false; cnt.textContent = 'GO !'; if (!r.said.go) { r.said.go = 1; say('And they\'re off!'); } }
  else cnt.hidden = true;
  const eio = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  for (const h of horses) {
    if (!h.inRace) continue;
    const old = h.x;
    if (h.falls && r.t >= h.fallAt) {
      if (!h.fall) { h.fall = { xf: h.x, v0: Math.max(200, h.speed) }; h.fallen = true; r.slow = 2.6; r.fallCam = 4.5; r.lastSay = r.t; say(`Oh no! ${h.name} has fallen!`); }
      const f = h.fall, sT = r.t - h.fallAt, stop = 1.7;
      const sc = Math.min(sT, stop); h.x = f.xf + f.v0 * (sc - sc * sc / (2 * stop));
      // trébuche (nez vers le sol), roulé-boulé, puis couché sur le flanc
      const pitch = sT < .35 ? -.6 * eio(sT / .35) : sT < 1 ? -.6 - .8 * eio((sT - .35) / .65) : -1.4 * (1 - eio((sT - 1) / .7));
      const roll = Math.PI / 2 * eio((sT - .45) / .85) + (sT > 1.3 ? Math.sin(Math.min(1, (sT - 1.3) / .4) * Math.PI) * .12 : 0);
      h.fallQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -roll).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch));
      h.fy = (sT > .4 && sT < 1.1 ? Math.sin((sT - .4) / .7 * Math.PI) * 22 : 0) + 6 * eio((sT - .9) / .6) - (sT < .4 ? 4 * eio(sT / .4) : 0);
      h.action.timeScale = Math.max(0, 1.6 * (1 - sT / 1.1));
      if (sT > .55 && !f.dust1) { f.dust1 = 1; burst(new THREE.Vector3(h.x + 30, 0, h.z), 26, 1.2); }
      if (sT > 1.2 && !f.dust2) { f.dust2 = 1; burst(new THREE.Vector3(h.x, 0, h.z), 16, .7); }
      // le jockey est projeté vers l'avant
      if (sT > .38 && !h.thrown) h.thrown = { pos: h.jockey.position.clone(), v: new THREE.Vector3(f.v0 * .7, 120, 55), q: h.jockey.quaternion.clone(), state: 'fly', t: 0, spin: new THREE.Vector3(3, 0, -9) };
      if (h.thrown) stepThrown(h, dt, r);
      h.speed = 0; continue;
    }
    if (r.t <= 0) h.x = 0;
    else if (r.t < h.T) h.x = D * progress(h, r.t);
    else { const e = r.t - h.T; h.x = D + (D / ramp(h.T)) * e; /* après la ligne : il continue au galop et sort de l'image */ if (!h.done) { h.done = true; r.finished++; } }
    h.speed = dt > 0 ? (h.x - old) / dt : 0;
    h.action.timeScale = r.t <= 0 ? 0 : Math.min(2.8, Math.max(1.3, h.speed / 150));
  }
  const live = r.P.slice().sort((p, q) => (horses[p].fallen - horses[q].fallen) || (horses[q].done - horses[p].done) || (horses[p].done ? horses[p].T - horses[q].T : horses[q].x - horses[p].x));
  const lead = horses[live[0]];
  $('#order').innerHTML = live.map((i) => horses[i].fallen ? `<span class="out">${horses[i].num}</span>` : `<span style="background:${horses[i].color}">${horses[i].num}</span>`).join('');
  if (r.faller >= 0 && horses[r.faller].thrown?.state === 'sit' && !r.said.ok) { r.said.ok = 1; r.lastSay = r.t; say(`Jockey ${horses[r.faller].jockey} is getting up, he\'s okay 👍`); }
  $('#dist').textContent = r.t <= 0 ? '1,200 m' : lead.x >= D ? 'Finish' : `${Math.max(0, Math.round((D - lead.x) / D * 1200))} m`;
  drawMap(live);
  if (r.t > 2 && lead.x < D && live[0] !== r.leader && r.t - r.lastSay > 2.6) { r.leader = live[0]; r.lastSay = r.t; say(`${lead.name} takes the lead!`); }
  if (lead.x > D * .7 && !r.said.last) { r.said.last = 1; r.lastSay = r.t; say('Final stretch!'); }
  if (r.finished >= 1 && !r.said.win) {
    r.said.win = 1; const w = horses[r.order[0]], gap = horses[r.order[1]].T - w.T;
    say(gap < .25 ? `Photo finish… ${w.name} wins it!` : `${w.name} wins!`);
  }
  if (r.finished === r.order.length && !r.said.res) { r.said.res = 1; setTimeout(showResult, 900); }
  // caméra de côté qui suit la tête de course
  let target = r.t <= 0 ? 0 : Math.min(D + 150, lead.x * .7 + horses[live[Math.min(2, live.length - 1)]].x * .3);
  if (r.fallCam > 0 && r.faller >= 0) { r.fallCam -= dt; target = horses[r.faller].x + 40; }       // la caméra reste sur la chute
  r.camX += (target - r.camX) * Math.min(1, dt * 4);
  // distance calculée pour voir environ 1 000 unités de large (≈ 5 longueurs de cheval) quel que soit l'écran
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect, dist = Math.min(1100, 330 / half);
  camera.position.set(r.camX - 60, 90 + dist * .2, dist); camera.lookAt(r.camX + 40, 45, -30);
  if (r.fallCam > 0 && r.faller >= 0) {                              // plan rapproché et plongeant sur la chute
    const f = horses[r.faller], k = Math.min(1, (4.5 - r.fallCam) / .5);
    camera.position.set(f.x - 150, 110 + 90 * k, f.z + 520 - 120 * k); camera.lookAt(f.x + 60, 25, f.z);
  }

  return r.camX;
}
function stepThrown(h, dt, r) {
  const j = h.thrown; j.t += dt;
  if (j.state === 'fly') {
    j.v.y -= 520 * dt; j.pos.addScaledVector(j.v, dt);
    j.q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(j.spin.x * dt, 0, j.spin.z * dt)));
    if (j.pos.y <= 7 && j.v.y < 0) { j.state = 'roll'; j.pos.y = 7; j.t = 0; burst(j.pos.clone(), 12, .6); }
  } else if (j.state === 'roll') {
    j.v.y = 0; j.v.x *= Math.exp(-3.2 * dt); j.v.z *= Math.exp(-3.2 * dt); j.pos.addScaledVector(j.v, dt);
    j.q.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, -.2)), Math.min(1, dt * 4));
    if (j.t > 1.6) { j.state = 'lie'; j.t = 0; }
  } else if (j.state === 'lie') { if (j.t > .8) { j.state = 'sit'; j.t = 0; } }
  else { j.q.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -.5, 1.05)), Math.min(1, dt * 3)); j.pos.y += (10 - j.pos.y) * Math.min(1, dt * 3); }
}
// Vue du dessus : une ligne par cheval, de 0 à 1,200 m, numéro à sa position réelle
const mapC = $('#map'), mg = mapC.getContext('2d');
function drawMap(live) {
  const dpr = Math.min(devicePixelRatio, 2), w = mapC.clientWidth, h = mapC.clientHeight;
  if (mapC.width !== w * dpr) { mapC.width = w * dpr; mapC.height = h * dpr; }
  mg.setTransform(dpr, 0, 0, dpr, 0, 0); mg.clearRect(0, 0, w, h);
  const L = 18, R = w - 20, row = (h - 22) / 6, X = (x) => L + Math.max(0, Math.min(1.03, x / D)) * (R - L);
  mg.fillStyle = '#1d5a33'; mg.beginPath(); mg.roundRect(L - 12, 0, R - L + 28, h - 18, 8); mg.fill();
  for (let k = 0; k < 6; k++) { mg.fillStyle = k % 2 ? '#ffffff08' : '#00000010'; mg.fillRect(L - 12, k * row, R - L + 28, row); }
  mg.font = '600 10px JetBrains Mono, monospace'; mg.textAlign = 'center'; mg.fillStyle = '#8d9aab';
  for (let m = 0; m <= 1200; m += 200) { const x = L + m / 1200 * (R - L); mg.fillStyle = '#ffffff22'; mg.fillRect(x, 0, 1, h - 18); mg.fillStyle = '#8d9aab'; mg.fillText(m === 1200 ? 'finish' : `${m}`, x, h - 5); }
  for (let k = 0; k < 6; k++) { mg.fillStyle = k % 2 ? '#fff' : '#111'; mg.fillRect(R - 2, k * row, 6, row / 2); mg.fillStyle = k % 2 ? '#111' : '#fff'; mg.fillRect(R - 2, k * row + row / 2, 6, row / 2); }
  horses.forEach((hh, i) => {
    const y = i * row + row / 2, x = X(hh.x), r = Math.min(11, row / 2 - 1), rank = live.indexOf(i) + 1;
    if (!hh.inRace) { mg.fillStyle = '#8d9aab'; mg.font = '600 11px Figtree, sans-serif'; mg.textAlign = 'left'; mg.textBaseline = 'middle'; mg.fillText(`#${hh.num} scratched (injured)`, L, y); mg.textAlign = 'center'; mg.textBaseline = 'alphabetic'; return; }
    if (hh.fallen) { mg.fillStyle = '#5b6573'; mg.beginPath(); mg.arc(x, y, r, 0, 7); mg.fill(); mg.strokeStyle = '#ff5d6c'; mg.lineWidth = 3; mg.beginPath(); mg.moveTo(x - 6, y - 6); mg.lineTo(x + 6, y + 6); mg.moveTo(x + 6, y - 6); mg.lineTo(x - 6, y + 6); mg.stroke(); return; }
    mg.strokeStyle = hh.color + '66'; mg.lineWidth = 3; mg.beginPath(); mg.moveTo(L, y); mg.lineTo(x, y); mg.stroke();
    mg.fillStyle = hh.color; mg.beginPath(); mg.arc(x, y, r, 0, 7); mg.fill();
    if (rank === 1) { mg.strokeStyle = '#e8b931'; mg.lineWidth = 2.5; mg.beginPath(); mg.arc(x, y, r + 3, 0, 7); mg.stroke(); }
    mg.fillStyle = '#0a0e13'; mg.font = `800 ${Math.round(r * 1.2)}px JetBrains Mono, monospace`; mg.textBaseline = 'middle'; mg.fillText(hh.num, x, y + 1); mg.textBaseline = 'alphabetic';
  });
  const lead = horses[live[0]]; $('#mapLead').textContent = `Leader: ${lead.name}`;
}

// ───────── Données de la chaîne ─────────
const S = { rpc: null, contract: '', demo: false, wallet: null, savedWallet: null, balance: null, cfg: null, info: null, fetchedAt: 0,
  cur: null, hist: new Map(), runners: [], view: 'paddock', type: 'W', picks: [], busy: false, myBets: [], played: new Set(), replay: null };
const chainNow = () => (S.info ? Number(S.info.now) + (Date.now() - S.fetchedAt) : Date.now());
const winFrac = () => 1 - Number(S.cfg?.commissionBps ?? 1500) / 10000;
const parisTime = (ms) => new Date(Number(ms)).toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const parisDay = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600); return (h ? h + 'h ' : '') + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
async function view(method, args = []) { const v = await S.rpc.view(S.contract, method, args); return typeof v === 'string' ? JSON.parse(v) : v; }

// Courses passées (mémorisées : une course terminée ne change plus)
async function history(curId) {
  const out = [];
  for (let k = curId - 1; k >= 1 && k >= curId - 40; k--) {
    let r = S.hist.get(k);
    if (!r || (r.status !== 'done' && r.status !== 'cancelled')) { try { r = await view('race', [String(k)]); } catch { break; } if (r.status === 'done' || r.status === 'cancelled') S.hist.set(k, r); }
    out.push(r);
  }
  return out;
}
const histBefore = (id) => [...S.hist.values()].filter((r) => r.id < id).sort((a, b) => b.id - a.id);

// Fiche d'un partant à partir de la course (couloirs, poids) et de l'historique
function runnersOf(r) {
  if (!r || !Array.isArray(r.horses) || r.horses.length !== 6) return [];
  const W = r.w.reduce((a, b) => a + b, 0), past = histBefore(Number(r.id));
  return r.horses.map((id, k) => {
    const s = statsOf(id, past), chance = r.w[k] / W;
    return { id, num: k + 1, lane: k, name: HORSES[id][0], stable: HORSES[id][1], color: HORSES[id][2], silk: HORSES[id][3], jockey: JOCKEYS[id], coat: COATS[id % 6],
      last: s.last, form: s.form, energy: s.energy, pref: s.pref, terrain: r.terrain, chance, cote: Math.max(1.05, winFrac() / chance), note: Math.min(9.8, 3 + scoreOf(s, r.terrain) * 0.75), quote: QUOTES[id % QUOTES.length] };
  });
}

async function refresh() {
  try {
    S.info = await view('info'); S.fetchedAt = Date.now(); S.cfg = S.info.cfg;
    const curId = Number(S.info.current);
    await history(curId);
    S.cur = S.info.race;
    if (S.wallet) { S.balance = await S.rpc.balance(S.wallet.address).catch(() => S.balance); await loadMyBets(curId); }
    const show = S.cur.horses ? S.cur : lastDone();
    S.runners = runnersOf(show);
    if (S.runners.length && ready && S.view === 'paddock' && !S.replay) { await setRunners(S.runners); fillPaddock(); select(Math.min(curSel, 5)); }
    renderHeader(); renderBet(); renderMine(); renderResults();
    maybeAutoReplay();
  } catch (e) { $('#status').textContent = 'Network busy, retrying…'; console.warn(e); }
}
const lastDone = () => [...S.hist.values()].filter((r) => r.status === 'done').sort((a, b) => b.id - a.id)[0] || null;

// ───────── En-tête : course, horaire, terrain, pot, compte à rebours ─────────
function renderHeader() {
  const r = S.cur; if (!r) return;
  const opening = r.status === 'pending';
  $('#raceNo').textContent = `Race #${r.id}`;
  $('#raceTime').textContent = r.closeAt !== '0' ? `${parisDay(r.closeAt)} · ${parisTime(r.closeAt)} (Paris)` : 'Time to be set';
  $('#terrainChip').textContent = r.horses ? `Going: ${TERRAINS[r.terrain]} ${TERRAIN_ICONS[r.terrain]}` : 'Going: –';
  $('#potChip').textContent = `Pot ${ase(BigInt(r.staked || 0) + BigInt(r.carry || 0))} ASE`;
  $('#betsChip').textContent = `${r.nbets || 0} bet${r.nbets === '1' ? '' : 's'}`;
  $('#pausedBanner').hidden = !S.cfg.paused;
  $('#paddockNote').textContent = opening ? 'The next race is being prepared: here are the runners of the last race.' : '';
  tickStatus();
}
function tickStatus() {
  const r = S.cur, el = $('#status'); if (!r || !S.cfg) return;
  const now = chainNow();
  if (S.cfg.paused) { el.textContent = 'Paused'; el.className = 'chip red'; return; }
  if (r.status === 'open' && now < Number(r.closeAt)) { el.textContent = `Bets close in ${mmss(Number(r.closeAt) - now)}`; el.className = 'chip gold'; }
  else if (r.status === 'open') { el.textContent = 'They\'re off! Draw in progress…'; el.className = 'chip red'; }
  else { el.textContent = 'Next race being prepared'; el.className = 'chip'; }
}

// ───────── Paddock ─────────
let curSel = 0;
const sel = $('#sel');
const icons = (n, ch) => Array.from({ length: 5 }, (_, i) => `<span class="${n - i >= .5 ? '' : 'off'}">${ch}</span>`).join('');
function fillPaddock() {
  sel.innerHTML = S.runners.map((h, i) => `<option value="${i}">${h.num} · ${esc(h.name)} (${esc(h.stable)}) — ×${h.cote.toFixed(1)}</option>`).join('');
  $('#runners').innerHTML = S.runners.map((h, i) => `<button class="runner" data-i="${i}"><span class="n" style="background:${h.color}">${h.num}</span><span>${esc(h.name)} <small class="muted">· ${esc(h.stable)} stable</small></span><span class="c">×${h.cote.toFixed(1)}</span></button>`).join('');
  $$('.runner').forEach((b) => b.onclick = () => { select(+b.dataset.i); host.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
$('#prev').onclick = () => select((curSel + 5) % 6);
$('#next').onclick = () => select((curSel + 1) % 6);
sel.onchange = () => select(+sel.value);
function select(i) {
  const h = S.runners[i]; if (!h) return;
  curSel = i; sel.value = i;
  $$('.runner').forEach((b) => b.setAttribute('aria-current', +b.dataset.i === i));
  $('#pNum').textContent = h.num; $('#pNum').style.background = h.color; $('#pName').textContent = h.name;
  $('#pSub').textContent = `${h.stable} stable · jockey ${h.jockey} · ${h.coat[0].toLowerCase()} coat`;
  $('#ring').style.setProperty('--p', Math.round(h.chance * 100 * 2.2)); $('#note').textContent = h.note.toFixed(1);
  $('#chance').textContent = `${(h.chance * 100).toFixed(1)} %`; $('#cote').textContent = `×${h.cote.toFixed(2)}`;
  $('#rows').innerHTML = `<dt>Stable</dt><dd class="plain"><b>🏠 ${esc(h.stable)}</b></dd><span class="v small">${HORSES.filter((x) => x[1] === h.stable).map((x) => esc(x[0])).join(' · ')}</span>
    <dt>Form</dt><dd>${icons(h.form, '❤️')}</dd><span class="v">${h.form.toFixed(1)} / 5</span>
    <dt>Energy</dt><dd>${icons(h.energy, '⚡')}</dd><span class="v">${h.energy} / 5</span>
    <dt>Favourite going</dt><dd class="plain">${TERRAIN_ICONS[h.pref]} ${TERRAINS[h.pref]}</dd><span class="v ${h.pref === h.terrain ? 'good' : ''}">${h.pref === h.terrain ? 'that\'s today!' : 'not today'}</span>`;
  $('#last').innerHTML = h.last.length ? h.last.map((p) => `<span class="${p === 1 ? 'p1' : ''}">${p}</span>`).join('') : '<em class="muted small">First race</em>';
  $('#quote').textContent = `« ${h.quote} » — ${h.jockey}`;
  if (ready && mode === 'paddock' && horses[i]) { horses.forEach((hh, k) => setVisible(hh, k === i)); posePaddock(horses[i]); }
}
function showPaddock() {
  mode = 'paddock'; S.view = 'paddock'; S.replay = null; marks.visible = false; controls.enabled = true;
  $('#paddock').hidden = false; $('#race').hidden = true; $('#ovPaddock').hidden = false; $('#ovRace').hidden = true; $('#count').hidden = true;
  $('#tabPaddock').setAttribute('aria-selected', 'true'); $('#tabRace').setAttribute('aria-selected', 'false');
  for (const d of dust.splice(0)) scene.remove(d);
  (async () => { if (S.runners.length) { await setRunners(S.runners); fillPaddock(); } horses.forEach((h, k) => setVisible(h, k === curSel)); if (horses[curSel]) select(curSel); })();
  controls.target.set(5, 60, 10); camera.position.set(95, 92, 330); resize();
}
function posePaddock(h) {
  const m = h.mouth;
  h.root.quaternion.copy(BASE_Q); h.fallQ = null; h.fy = 0; h.thrown = null;
  h.stander.position.set(m.x - 20, 0, m.z + 30); h.stander.rotation.y = Math.PI / 4; h.stander.updateMatrixWorld(true);
  const Sh = h.stander.localToWorld(h.stander.userData.shoulder.clone()), H = m.clone().add(new THREE.Vector3(-5, -7, 6));
  poseArm(h.sArm, Sh, H, m.clone().add(new THREE.Vector3(-2, -2, 0)), new THREE.Vector3(-3, -6, 4), 2.5);
}
$('#tabPaddock').onclick = () => { if (mode !== 'paddock') showPaddock(); };
$('#back').onclick = () => { showPaddock(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

// ───────── Parier ─────────
function renderBet() {
  const r = S.cur, box = $('#betBox');
  const open = r && r.status === 'open' && chainNow() < Number(r.closeAt) && !S.cfg.paused;
  box.classList.toggle('closed', !open);
  const R = r?.rules || { types: S.cfg.types, stakes: S.cfg.stakes };
  $('#betTypes').innerHTML = TYPE_ORDER.filter((t) => R.types[t]).map((t) => `<button type="button" class="tchip" data-t="${t}" aria-pressed="${S.type === t}">${BET_TYPES[t][0]}</button>`).join('');
  $$('#betTypes .tchip').forEach((b) => b.onclick = () => { S.type = b.dataset.t; S.picks = S.picks.slice(0, BET_TYPES[S.type][1]); renderBet(); });
  const need = BET_TYPES[S.type][1], ordered = S.type === 'W' || S.type === 'CO' || S.type === 'TO';
  $('#betHelp').textContent = BET_TYPES[S.type][2] + (need > 1 ? (ordered ? ' Tap the horses in finishing order.' : ` Tap ${need} horses.`) : '');
  const list = r && r.horses ? runnersOf(r) : [];
  $('#betPicks').innerHTML = list.map((h) => { const k = S.picks.indexOf(h.lane);
    return `<button type="button" class="pick" data-l="${h.lane}" aria-pressed="${k >= 0}"><span class="n" style="background:${h.color}">${h.num}</span><span class="pn">${esc(h.name)}</span>${k >= 0 && ordered && need > 1 ? `<span class="ord">${['1st', '2nd', '3rd'][k]}</span>` : ''}</button>`; }).join('');
  $$('#betPicks .pick').forEach((b) => b.onclick = () => {
    const l = +b.dataset.l, k = S.picks.indexOf(l);
    if (k >= 0) S.picks.splice(k, 1); else { if (S.picks.length >= need) S.picks.shift(); S.picks.push(l); }
    renderBet();
  });
  const lim = R.stakes[S.type].map((x) => Number(BigInt(x) / 10n ** 15n) / 1000);
  const inp = $('#stake'); inp.min = lim[0]; inp.max = lim[1]; inp.step = 'any';
  if (!inp.value || +inp.value < lim[0] || +inp.value > lim[1]) inp.value = lim[0];
  $('#stakeHint').textContent = `${lim[0]} to ${lim[1]} ASE`;
  const ready2 = S.picks.length === need;
  let est = '';
  if (ready2 && list.length) { const p = probOfSel(r.w, S.type, S.picks); est = `If it wins: about ×${Math.max(1, winFrac() / p).toFixed(1)} your stake (pool betting: the final amount depends on all bets).`; }
  $('#betEst').textContent = est;
  const btn = $('#placeBet');
  btn.disabled = !open || !ready2 || S.busy;
  btn.textContent = !open ? (r && r.status === 'open' ? 'Bets are closed' : 'Bets open soon') : !S.wallet ? 'Connect wallet to bet' : ready2 ? `Bet ${inp.value} ASE` : `Pick ${need} horse${need > 1 ? 's' : ''}`;
  if (open && !S.wallet) btn.disabled = false;
}
$('#stake').addEventListener('input', renderBet);
function pOrdered(w, seq) { let W = w.reduce((a, b) => a + b, 0), p = 1; for (const l of seq) { p *= w[l] / W; W -= w[l]; } return p; }
function perms(s) { return s.length <= 1 ? [s] : s.flatMap((x, i) => perms([...s.slice(0, i), ...s.slice(i + 1)]).map((q) => [x, ...q])); }
const probOfSel = (w, t, s) => (t === 'CD' || t === 'TD') ? perms(s).reduce((a, q) => a + pOrdered(w, q), 0) : pOrdered(w, s);

$('#placeBet').onclick = async () => {
  if (S.demo) return toast('Demo mode: nothing is sent. Open the test site with a contract to bet for real.');
  if (!S.wallet) return $('#walletBtn')?.click();
  const r = S.cur, stake = L.parseAse(String($('#stake').value));
  if (await sendTx('bet', [String(r.id), S.type, S.picks.slice()], stake)) { toast(`Bet placed on race #${r.id} ✓`, 'ok'); S.picks = []; await refresh(); }
};
async function sendTx(method, args, value = 0n) {
  if (S.busy) return false;
  S.busy = true; renderBet();
  const t1 = toast(S.wallet.kind === 'telegram' ? 'Approve the transaction in Telegram…' : 'Approve the transaction in your wallet…', '', 0);
  try {
    const hash = await S.wallet.call(S.contract, method, args, value);
    t1.textContent = 'Transaction sent, waiting for confirmation…';
    const rc = await S.rpc.waitReceipt(hash);
    if (!rc.success) throw new Error(rc.error || 'rejected by the contract');
    return rc;
  } catch (e) { toast(errText(cleanError(e)), 'err', 9000); return null; }
  finally { t1.remove(); S.busy = false; renderBet(); }
}
const ERR = { 'paris fermés': 'Bets are closed for this race.', 'course complète': 'This race is full (maximum number of bets reached).', 'banni': 'This wallet is banned from ASE Vegas.',
  'réservé VEGAS': 'This game is reserved for VEGAS holders.', 'pause': 'The game is paused.', 'hors limites': 'Stake outside the allowed range.', 'pas la course en cours': 'This race has already started.' };
const errText = (m) => { for (const k in ERR) if (m.includes(k)) return ERR[k]; return m; };

// ───────── Mes paris ─────────
async function loadMyBets(curId) {
  const me = S.wallet.address, out = [];
  for (let id = curId; id >= 1 && id >= curId - 10; id--) {
    const r = id === curId ? S.info.race : S.hist.get(id) || await view('race', [String(id)]).catch(() => null);
    if (!r || !Number(r.nbets)) continue;
    let bs = []; try { bs = await view('bets', [String(id), '0', '150']); } catch { continue; }
    bs.forEach((b, i) => { if (b.who === me) out.push({ ...b, race: r, i }); });
  }
  S.myBets = out;
}
function renderMine() {
  const box = $('#mineBody');
  if (!S.wallet) { box.innerHTML = '<p class="muted">Connect your wallet to see your bets.</p>'; return; }
  if (!S.myBets.length) { box.innerHTML = '<p class="muted">No bet yet. Pick a race type and your horses above.</p>'; return; }
  const refundable = new Set();
  box.innerHTML = '<div class="mybets">' + S.myBets.map((b) => {
    const r = b.race, names = b.s.map((l) => r.horses ? `${l + 1} ${HORSES[r.horses[l]][0]}` : `#${l + 1}`).join(b.t === 'W' || b.t === 'CO' || b.t === 'TO' ? ' → ' : ' + ');
    let st = '<span class="muted">Waiting for the race</span>';
    if (r.status === 'done') st = BigInt(b.paid) > 0n ? `<span class="good">Won ${ase(b.paid)} ASE ✓ (paid)</span>` : '<span class="muted">Lost</span>';
    else if (r.status === 'cancelled') { if (b.refunded) st = '<span class="muted">Refunded</span>'; else { st = `<button class="btn btn-small" data-refund="${r.id}">Get my ${ase(b.stake)} ASE back</button>`; refundable.add(r.id); } }
    else if (r.status === 'open' && chainNow() > Number(r.closeAt) + Number(S.cfg.timeoutMs)) { st = `<button class="btn btn-small" data-refund="${r.id}">Race not drawn: get refunded</button>`; }
    return `<div class="mb"><span class="mb-r">#${r.id}</span><span><b>${BET_TYPES[b.t][0]}</b> · ${esc(names)}<br><small class="muted">${ase(b.stake)} ASE</small></span><span class="mb-s">${st}</span></div>`;
  }).join('') + '</div>';
  $$('[data-refund]').forEach((b) => b.onclick = async () => { if (await sendTx('claimRefund', [b.dataset.refund])) { toast('Refund sent to your wallet ✓', 'ok'); await refresh(); } });
}

// ───────── Résultats et rediffusion ─────────
function renderResults() {
  const done = [...S.hist.values()].filter((r) => r.status === 'done' || r.status === 'cancelled').sort((a, b) => b.id - a.id).slice(0, 8);
  $('#resultsBody').innerHTML = done.length ? done.map((r) => {
    if (r.status === 'cancelled') return `<div class="res"><span class="mb-r">#${r.id}</span><span class="muted">Cancelled · all bets refundable</span></div>`;
    const podium = r.order.slice(0, 3).map((l, k) => `<span class="n" style="background:${HORSES[r.horses[l]][2]}" title="${esc(HORSES[r.horses[l]][0])}">${l + 1}</span>${k === 0 ? `<b>${esc(HORSES[r.horses[l]][0])}</b>` : ''}`).join('');
    const fell = r.fell >= 0 ? ` · <span class="bad">🤕 ${esc(HORSES[r.horses[r.fell]][0])} fell</span>` : '';
    return `<div class="res"><span class="mb-r">#${r.id}</span><span class="podium">${podium}${fell}<br><small class="muted">${parisDay(r.closeAt)} ${parisTime(r.closeAt)} · pot ${ase(BigInt(r.staked) + BigInt(r.carry))} ASE · ${r.winners || 0} winning bet(s)</small></span><button class="btn btn-small" data-replay="${r.id}">▶ Replay</button></div>`;
  }).join('') : '<p class="muted">No race yet: the first one starts at the time shown above.</p>';
  $$('[data-replay]').forEach((b) => b.onclick = () => { startReplay(S.hist.get(+b.dataset.replay)); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  const last = lastDone();
  $('#tabRace').disabled = !last;
}
function maybeAutoReplay() {
  const r = lastDone(); if (!r || S.played.has(r.id)) return;
  const t = (chainNow() - Number(r.startAt)) / 1000;
  if (t > -60 && t < 25) { S.played.add(r.id); startReplay(r, Math.max(-3.2, t)); toast(`Race #${r.id} is starting!`, 'ok'); }
}
// Rejoue une course terminée : mêmes chevaux, même arrivée, même chute que dans le contrat
async function startReplay(r, t0 = -3.2) {
  if (!r || !ready) return;
  const list = runnersOf(r);
  S.view = 'race'; S.replay = r;
  await setRunners(list);
  mode = 'race'; resize(); controls.enabled = false; marks.visible = true;
  $('#paddock').hidden = true; $('#race').hidden = false; $('#ovPaddock').hidden = true; $('#ovRace').hidden = false; $('#resultCard').hidden = true;
  $('#tabPaddock').setAttribute('aria-selected', 'false'); $('#tabRace').setAttribute('aria-selected', 'true');
  $('#replayTitle').textContent = `Race #${r.id} · ${parisDay(r.closeAt)} ${parisTime(r.closeAt)} · ${TERRAINS[r.terrain]} going`;
  const plan = racePlan(r.rand, r.order, r.fell);
  for (const d of dust.splice(0)) scene.remove(d);
  horses.forEach((h, i) => {
    setVisible(h, true); h.inRace = true; h.root.scale.setScalar(.62); h.action.time = (i * .37) % 1; h.x = 0; h.z = LANES[i];
    h.T = plan.T[i]; h.a = plan.shape[i].a; h.b = plan.shape[i].b; h.ph = plan.shape[i].ph;
    h.falls = i === r.fell; h.fallAt = plan.fallAt; h.fall = null; h.fallQ = null; h.fy = 0; h.thrown = null; h.fallen = false; h.done = false; h.action.timeScale = 0;
  });
  race = { t: -3.2, order: r.order.filter((l) => l !== r.fell), faller: r.fell, P: [0, 1, 2, 3, 4, 5], leader: -1, lastSay: 0, said: {}, finished: 0, camX: 0, slow: 0, src: r };
  say('The horses are in the stalls…');
  while (race.t < t0) { raceStep(.05); for (const h of horses) { h.mixer.update(race.dt); placeHorse(h); } }   // rattrape une course déjà commencée
}
$('#tabRace').onclick = () => { if (mode !== 'race') startReplay(lastDone()); };
$('#again').onclick = () => startReplay(S.replay || lastDone());
function showResult() {
  const r = race, src = r.src, w = horses[r.order[0]];
  const row = (h, pl, sub, right) => `<div class="row ${pl === '✖' ? 'out' : ''}"><span class="pl">${pl}</span><span class="n" style="background:${h.color}">${h.num}</span><span>${esc(h.name)}<br><span class="gap">${sub}</span></span><span class="c">${right}</span></div>`;
  $('#result').innerHTML = r.order.map((i, k) => row(horses[i], k + 1, `${esc(horses[i].stable)} · ${k ? '+' + (horses[i].T - w.T).toFixed(2) + ' s' : w.T.toFixed(2) + ' s'}`, '×' + horses[i].cote.toFixed(1))).join('')
    + (r.faller >= 0 ? row(horses[r.faller], '✖', 'fell · resting 3 days', '—') : '');
  const t3 = r.order.slice(0, 3).map((i) => horses[i].num).join('-');
  $('#payNote').textContent = `Winner: #${w.num} ${w.name}. Trifecta: ${t3}. Pot ${ase(BigInt(src.staked) + BigInt(src.carry))} ASE, ${src.winners || 0} winning bet(s), ${ase(src.paidOut || 0)} ASE paid automatically to the winners.`
    + (r.faller >= 0 ? ` ${horses[r.faller].name} fell: bets on this horse are lost and it rests for 3 days.` : '')
    + (BigInt(src.carriedOut || 0) > 0n ? ` No winning bet: ${ase(src.carriedOut)} ASE go to the next race's pot.` : '');
  $('#resultCard').hidden = false;
  if (S.wallet) refresh();
}
function say(t) { $('#comment').textContent = t; }

// ───────── Wallet (le même sur tout ASE Vegas, géré par vegas.js) ─────────
async function syncWallet() {
  let raw = ''; try { raw = localStorage.getItem('loto.wallet') || ''; } catch {}
  if (raw === S.savedWallet) return;
  S.savedWallet = raw; S.wallet = null; S.myBets = [];
  const s = raw ? JSON.parse(raw) : null;
  try {
    if (s?.kind === 'extension') { for (let i = 0; i < 10 && !ExtensionWallet.available(); i++) await sleep(200); if (ExtensionWallet.available()) { const w = new ExtensionWallet(); if (await w.restore()) S.wallet = w; } }
    else if (s?.kind === 'telegram') { const w = new TelegramWallet(CONFIG.TELEGRAM_API, CONFIG.DAPP_NAME); if (await w.restore(s.session)) S.wallet = w; }
  } catch {}
  if (S.info) { if (S.wallet) await loadMyBets(Number(S.info.current)); renderBet(); renderMine(); }
}

// ───────── Onglets du bas ─────────
$$('.tabs [data-tab]').forEach((b) => b.onclick = () => {
  $$('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
  $$('.hpanel').forEach((p) => (p.hidden = p.id !== 'tab-' + b.dataset.tab));
});

// ───────── Mode démo (pas de contrat) : une fausse chaîne dans le navigateur ─────────
async function demoRpc() {
  const { makeSetup } = await import('./stable.mjs');
  const now0 = Date.now(), races = [];
  for (let id = 1; id <= 6; id++) {
    const st = makeSetup(races.slice().reverse(), Math.random, 500), W = st.w.reduce((a, b) => a + b, 0), left = [0, 1, 2, 3, 4, 5], order = [];
    while (left.length) { let x = Math.random() * left.reduce((a, l) => a + st.w[l], 0), k = 0; while (k < left.length - 1 && (x -= st.w[left[k]]) >= 0) k++; order.push(left.splice(k, 1)[0]); }
    const fell = id === 4 ? order[3] : -1; if (fell >= 0) { order.splice(order.indexOf(fell), 1); order.push(fell); }
    const t = now0 - (7 - id) * 3600000;
    races.push({ id, status: 'done', ...st, order, fell, closeAt: String(t), startAt: String(t + 360000), rand: Math.random().toString(16).slice(2) + 'a1b2c3', staked: String(BigInt(40 + id * 7) * 10n ** 18n), carry: '0', nbets: String(12 + id), winners: String(3 + (id % 3)), paidOut: String(BigInt(34 + id * 6) * 10n ** 18n) });
    void W;
  }
  const cfg = { paused: false, commissionBps: '1500', timeoutMs: '3600000', types: { W: true, CO: true, CD: true, TO: true, TD: true },
    stakes: { W: ['2000000000000000000', '10000000000000000000'], CO: ['1000000000000000000', '5000000000000000000'], CD: ['1000000000000000000', '5000000000000000000'], TO: ['1000000000000000000', '5000000000000000000'], TD: ['1000000000000000000', '5000000000000000000'] } };
  const cur = { id: 7, status: 'open', ...makeSetup(races.slice().reverse(), Math.random, 500), closeAt: String(now0 + 23 * 60000), staked: String(26n * 10n ** 18n), carry: '0', nbets: '9', rules: { types: cfg.types, stakes: cfg.stakes } };
  return { view: async (_c, m, a) => m === 'info' ? JSON.stringify({ cfg, current: '7', race: cur, now: String(Date.now()) }) : m === 'race' ? JSON.stringify(races[Number(a[0]) - 1]) : '[]',
    balance: async () => 0n, waitReceipt: async () => ({ success: true }) };
}

// ───────── Démarrage ─────────
function resize() {
  const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = mode === 'race' ? 30 : (camera.aspect < 1.2 ? 40 : 32); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
const clock = new THREE.Clock();
let fast = 1;
window.HIPPO = { set fast(v) { fast = v; }, get race() { return race; }, startReplay, lastDone, step(n, d) { fast = 0; for (let k = 0; k < n; k++) { raceStep(d); for (const h of horses) if (h.inRace) { h.mixer.update(race.dt); placeHorse(h); } stepDust(race.dt); } renderer.render(scene, camera); } };
function loop() {
  const dt = Math.min(clock.getDelta(), .05) * fast;
  if (ready && horses.length) {
    let focus = 0;
    if (mode === 'paddock') {
      const h = horses[curSel], t = clock.elapsedTime;
      if (h) { h.stand.scale.set(1, 1 + Math.sin(t * 1.6) * .006, 1 + Math.sin(t * 1.6) * .008); h.stander.children[0].rotation.z = Math.sin(t * 1.1) * .015; }
      controls.update();
    } else if (race) {
      focus = raceStep(dt);
      for (const h of horses) if (h.inRace) { h.mixer.update(race.dt ?? dt); placeHorse(h); }
      stepDust(race.dt ?? dt);
    }
    sun.position.set(focus - 200, 320, 260); sun.target.position.set(focus, 0, 0);
    rim.position.set(focus + 250, 180, -300); rim.target.position.set(focus, 0, 0);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
let race = null;
(async function start() {
  S.demo = !CONFIG.CONTRACT || new URLSearchParams(location.search).has('demo');
  $('#demoBar').hidden = !S.demo;
  S.contract = CONFIG.CONTRACT;
  S.rpc = S.demo ? await demoRpc() : new Rpc(CONFIG.RPC);
  if (!S.demo) { startVegas({ walletButton: true }); setInterval(syncWallet, 2000); await syncWallet(); }
  if (S.contract) { const a1 = S.contract.startsWith('ase1') ? S.contract : L.toAse1(S.contract); $('#contractLink').href = `${CONFIG.EXPLORER}/address/${a1}`; $('#contractLink').textContent = a1; }
  resize(); loop();
  try { await prepareModel(); } catch (e) { $('#loading').textContent = 'The 3D could not load: ' + e.message; return; }
  ready = true;
  await refresh();
  $('#loading').remove();
  if (S.runners.length) { await setRunners(S.runners); fillPaddock(); }
  showPaddock(); select(0);
  setInterval(refresh, S.demo ? 60000 : 15000);
  setInterval(() => { tickStatus(); renderBetTimer(); maybeAutoReplay(); }, 1000);
})();
let lastOpen = null;
function renderBetTimer() { const r = S.cur; const open = !!(r && r.status === 'open' && chainNow() < Number(r.closeAt)); if (open !== lastOpen) { lastOpen = open; renderBet(); } }
