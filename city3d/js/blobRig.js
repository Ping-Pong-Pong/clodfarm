/**
 * blobRig.js — procedural 3D FRUIT BLOB mascot rig for the TypePop 3D city.
 *
 * One BlobRig = one MBTI fruit blob resident (round bean body, round black
 * DOT eyes with catchlights, per-fruit 3D features, nub arms, rounded feet).
 * This REPLACES billboard sprites everywhere (16 city wanderers + room
 * interiors): one consistent 3D art direction.
 *
 * ---------------------------------------------------------------------------
 * API CONTRACT (the integrator depends on this exact API)
 * ---------------------------------------------------------------------------
 *   import { BlobRig, FRUIT_SPECS, spawnPuff, updatePuffs } from './blobRig.js';
 *
 *   const rig = new BlobRig({ fruit: 'strawberry' }); // one of 16 FRUIT_SPECS ids
 *   // legacy form still accepted (fruit spec wins when both are given):
 *   const rig2 = new BlobRig({ bodyColor: '#FF8C69' }); // plain blob, no features,
 *                                                      // unless the hex matches a fruit body color
 *   scene.add(rig.group);            // group origin at FEET (y=0 = floor). Blob ~1.5 units tall.
 *   rig.group.position.set(x, 0, z); // move by setting group position
 *   rig.setState('idle' | 'walk' | 'happy' | 'sleep' | 'boop');
 *   rig.setFacing(radians);          // yaw; call each frame while walking with Math.atan2(vx, vz)
 *   rig.update(dt, t);               // dt seconds, t = elapsed seconds. Call every frame.
 *   rig.topY;                        // number ≈ 1.55 (pineapple 1.95), for label anchors
 *   rig.fruit;                       // resolved fruit id, or null for a legacy plain blob
 *   rig.hitProxy;                    // invisible cylinder mesh (visible=false) sized to the body;
 *                                    // integrator adds it to raycast targets and sets userData on it.
 *                                    // (THREE.Raycaster intersects visible=false meshes, so this works.)
 *
 * ---------------------------------------------------------------------------
 * FRUIT FEATURES
 * ---------------------------------------------------------------------------
 * Each fruit's static features (seeds, stems, leaves, crowns, stripes, cleft,
 * dots, shell) are built once per fruit id as transformed primitives with
 * baked vertex colors, merged into ONE geometry (cached in a module Map) and
 * rendered with ONE shared MeshStandardMaterial({vertexColors:true}).
 * One draw call per rig. The feature mesh is a child of the body mesh, so it
 * rides the squash-and-stretch poses organically.
 *
 * ---------------------------------------------------------------------------
 * PUFF-POOL CHOICE
 * ---------------------------------------------------------------------------
 * Dust puffs live in WORLD space in one module-level shared pool (max 24
 * sprites, one shared radial-gradient canvas texture, each puff owns a cheap
 * SpriteMaterial for its own opacity fade). `BlobRig` fires puffs itself on the
 * happy-state landing: it converts the rig's world position into
 * `rig.group.parent` space and calls the exported `spawnPuff(parent, x, y, z)`.
 * The integrator MUST call `updatePuffs(dt)` once per frame (any scene) to
 * animate live puffs. `spawnPuff`/`updatePuffs` are also exported so the
 * integrator can trigger puffs manually (e.g. footstep puffs).
 *
 * ---------------------------------------------------------------------------
 * PERFORMANCE
 * ---------------------------------------------------------------------------
 * All geometries are module-level singletons shared by every rig. Body
 * materials are cached per fruit id (one MeshPhysicalMaterial per fruit,
 * shared by all rigs of that fruit; feet use a cached 0.92-darkened variant).
 * Feature geometries are cached per fruit id (16 max). Nothing is allocated
 * inside update() — poses reuse preallocated objects.
 *
 * Three.js r170 API. CapsuleGeometry exists. `outputColorSpace` default is fine.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Fruit specs
// ---------------------------------------------------------------------------

function _fs(id, body, rough, scale, topY = 1.55) {
  return { id, body, rough, scale, topY };
}

/** 16 fruit specs. `scale` = body base [x,y,z]; `topY` = label-anchor height. */
export const FRUIT_SPECS = {
  strawberry: _fs('strawberry', '#E8404F', 0.55, [1.15, 0.95, 1.0]),
  orange:     _fs('orange',     '#FF9F2E', 0.55, [1.15, 0.95, 1.0]),
  apple:      _fs('apple',      '#D63A2F', 0.55, [1.15, 0.95, 1.0]),
  lemon:      _fs('lemon',      '#F7D038', 0.55, [1.10, 0.92, 1.12]),
  pineapple:  _fs('pineapple',  '#F2B93B', 0.55, [1.15, 0.95, 1.0], 1.95),
  cherry:     _fs('cherry',     '#C81E3A', 0.55, [1.05, 1.00, 1.00]),
  mango:      _fs('mango',      '#FF9E2C', 0.55, [1.12, 0.98, 1.00]),
  watermelon: _fs('watermelon', '#3FA34D', 0.55, [1.15, 0.95, 1.0]),
  blueberry:  _fs('blueberry',  '#4A5FA5', 0.55, [1.15, 0.95, 1.0]),
  peach:      _fs('peach',      '#FFB37E', 0.90, [1.15, 0.95, 1.0]),
  plum:       _fs('plum',       '#5B2A6E', 0.55, [1.15, 0.95, 1.0]),
  lime:       _fs('lime',       '#A8D93A', 0.55, [1.10, 0.93, 1.08]),
  grape:      _fs('grape',      '#7B4FA6', 0.75, [1.00, 1.00, 1.00]),
  kiwi:       _fs('kiwi',       '#8A6D3B', 0.95, [1.15, 0.95, 1.0]),
  coconut:    _fs('coconut',    '#8A6D4A', 0.55, [1.02, 0.98, 1.02]),
  avocado:    _fs('avocado',    '#5C8A3A', 0.55, [1.15, 0.95, 1.0]),
};

// legacy bodyColor -> fruit lookup (hex match against the fruit palette)
const _hexToFruit = new Map(
  Object.values(FRUIT_SPECS).map(s => [s.body.toLowerCase(), s.id])
);

// ---------------------------------------------------------------------------
// Shared module-level resources (allocated once)
// ---------------------------------------------------------------------------

function hexKey(c) {
  return '#' + new THREE.Color(c).getHexString();
}

const GEO = {
  body: new THREE.SphereGeometry(0.75, 24, 18),
  unit: new THREE.SphereGeometry(1, 12, 10),          // eyes, highlights, feet
  arm: new THREE.CapsuleGeometry(0.09, 0.18, 4, 12),
  shadow: new THREE.PlaneGeometry(2.0, 2.0),
  hit: new THREE.CylinderGeometry(0.95, 0.95, 1.7, 8),
};

// Low-poly template geometries for fruit features (cloned, never rendered).
const FGEO = {
  seed: new THREE.SphereGeometry(0.032, 6, 5),
  dot3: new THREE.SphereGeometry(0.03, 6, 5),
  dot5: new THREE.SphereGeometry(0.05, 8, 6),
  cone: new THREE.ConeGeometry(0.09, 0.22, 8),
  crown: new THREE.ConeGeometry(0.07, 0.5, 8),
  stemS: new THREE.CylinderGeometry(0.035, 0.045, 0.3, 8),
  stemNub: new THREE.CylinderGeometry(0.04, 0.05, 0.12, 8),
  stemCherry: new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6),
  leaf: new THREE.SphereGeometry(1, 10, 8), // flattened via scale
  stripe: new THREE.TorusGeometry(0.76, 0.035, 8, 40, 2.4),
  cleft: new THREE.TorusGeometry(0.74, 0.028, 8, 32, 1.6),
  seam: new THREE.TorusGeometry(0.74, 0.022, 8, 40, 2.0),
  disc: new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12),
  shell: new THREE.SphereGeometry(0.78, 20, 14),
};

const _bodyMats = new Map(); // fruit-id-or-hex -> MeshPhysicalMaterial (clearcoat clay)
const _darkMats = new Map(); // fruit-id-or-hex -> darkened MeshStandardMaterial (feet)

function bodyMaterial(key, color, rough) {
  let m = _bodyMats.get(key);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      roughness: rough,
      clearcoat: 0.35,
      clearcoatRoughness: 0.6,
    });
    _bodyMats.set(key, m);
  }
  return m;
}

function darkMaterial(key, color) {
  let m = _darkMats.get(key);
  if (!m) {
    const c = new THREE.Color(color).multiplyScalar(0.92);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 });
    _darkMats.set(key, m);
  }
  return m;
}

let _eyeMat = null;
let _highlightMat = null;

function eyeMaterial() {
  if (!_eyeMat) _eyeMat = new THREE.MeshStandardMaterial({ color: 0x16120e, roughness: 0.35 });
  return _eyeMat;
}
function highlightMaterial() {
  if (!_highlightMat) _highlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  return _highlightMat;
}

// ---------------------------------------------------------------------------
// Fruit feature builders (body-local space; body = sphere r=0.75 at origin)
// ---------------------------------------------------------------------------

const STEM_BROWN = '#6B4A2B';
const LEAF_GREEN = '#4F9B4F';
const CROWN_GREEN = '#3E8E41';

const _mm = new THREE.Matrix4();
const _mv = new THREE.Vector3(), _sv = new THREE.Vector3();
const _qv = new THREE.Quaternion(), _ev = new THREE.Euler();
const _cc = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _dv = new THREE.Vector3();

function _paint(g, hex) {
  _cc.set(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = _cc.r; a[i * 3 + 1] = _cc.g; a[i * 3 + 2] = _cc.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// transformed + vertex-colored part (euler rotation)
function _part(list, geo, hex, px, py, pz, rx, ry, rz, sx, sy, sz) {
  const g = geo.clone();
  _ev.set(rx, ry, rz); _qv.setFromEuler(_ev);
  _mv.set(px, py, pz); _sv.set(sx, sy, sz);
  _mm.compose(_mv, _qv, _sv);
  g.applyMatrix4(_mm);
  list.push(_paint(g, hex));
}

// transformed + vertex-colored part, +Y axis oriented along (dx,dy,dz)
function _partDir(list, geo, hex, px, py, pz, dx, dy, dz, sx, sy, sz) {
  const g = geo.clone();
  _dv.set(dx, dy, dz).normalize();
  _qv.setFromUnitVectors(_up, _dv);
  _mv.set(px, py, pz); _sv.set(sx, sy, sz);
  _mm.compose(_mv, _qv, _sv);
  g.applyMatrix4(_mm);
  list.push(_paint(g, hex));
}

// brown stem + one flattened leaf near the top (local y ~0.7-0.95)
function _stemFruitParts(list, tilt, smallLeaf) {
  _partDir(list, FGEO.stemS, STEM_BROWN, 0, 0.80, 0, tilt, 1, 0, 1, 1, 1);
  const ls = smallLeaf ? 0.7 : 1;
  _part(list, FGEO.leaf, LEAF_GREEN, 0.17, 0.90, 0.02,
    0.25, 0.45, -0.45, 0.13 * ls, 0.045 * ls, 0.07 * ls);
}

function _buildStrawberry() {
  const list = [];
  // 26 seed dots, fibonacci distribution over the upper ~2/3, slightly embedded
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const cosTh = 1 - t * 1.25; // 1 → -0.25
    const sinTh = Math.sqrt(Math.max(0, 1 - cosTh * cosTh));
    const ph = i * ga;
    const r = 0.715;
    _part(list, FGEO.seed, '#8A2432',
      r * sinTh * Math.cos(ph), r * cosTh, r * sinTh * Math.sin(ph),
      0, 0, 0, 1, 1, 1);
  }
  // calyx: 6 flattened green cones in a star at the top
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.26;
    _partDir(list, FGEO.cone, '#3E8E41',
      0.40 * Math.cos(a), 0.60, 0.40 * Math.sin(a),
      0.9 * Math.cos(a), 0.35, 0.9 * Math.sin(a),
      1, 0.55, 0.8);
  }
  // tiny stem
  _part(list, FGEO.stemNub, '#5C8A3C', 0, 0.76, 0, 0, 0, 0.15, 0.7, 0.9, 0.7);
  return list;
}

function _buildPineapple() {
  const list = [];
  // crown of 7 long green cones fanning up/outward
  _partDir(list, FGEO.crown, CROWN_GREEN, 0, 0.70, 0, 0, 1, 0, 1, 1, 1);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    _partDir(list, FGEO.crown, '#357A37',
      0.16 * Math.cos(a), 0.64, 0.16 * Math.sin(a),
      0.45 * Math.cos(a), 1, 0.45 * Math.sin(a),
      1, 1, 1);
  }
  return list;
}

function _buildCherry() {
  const list = [];
  // two thin stems angled apart from the top + one leaf
  _partDir(list, FGEO.stemCherry, '#5C4A2E', -0.06, 0.85, 0, -0.45, 1, 0.1, 1, 1, 1);
  _partDir(list, FGEO.stemCherry, '#5C4A2E', 0.06, 0.85, 0, 0.45, 1, -0.1, 1, 1, 1);
  _part(list, FGEO.leaf, LEAF_GREEN, 0.15, 1.02, 0.05,
    0.2, 0.4, -0.5, 0.12, 0.04, 0.06);
  return list;
}

function _buildWatermelon() {
  const list = [];
  // 3 dark-green stripes on vertical longitudes 0°/60°/120°, hugging the body
  for (let k = 0; k < 3; k++) {
    const g = FGEO.stripe.clone();
    g.rotateZ(Math.PI / 2 - 2.4 / 2); // center the 2.4-rad arc at +Y
    g.rotateY((k / 3) * Math.PI);     // 0°/60°/120°
    list.push(_paint(g, '#2B6B2F'));
  }
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.74, 0, 0, 0, 0.1, 0.8, 0.9, 0.8);
  return list;
}

function _buildBlueberry() {
  const list = [];
  // crown: small dark disc on top + 5 tiny spheres in a star around it
  _part(list, FGEO.disc, '#2C3A5E', 0, 0.74, 0, 0, 0, 0, 1, 1, 1);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    _part(list, FGEO.dot3, '#2C3A5E',
      0.13 * Math.cos(a), 0.735, 0.13 * Math.sin(a), 0, 0, 0, 1, 1, 1);
  }
  return list;
}

function _buildPeach() {
  const list = [];
  // cleft: thin torus arc, shallow-embedded on the front-left meridian
  const g = FGEO.cleft.clone();
  g.rotateZ(Math.PI / 2 - 1.6 / 2); // center the 1.6-rad arc at +Y
  g.rotateY(-Math.PI * 0.75);       // swing to the front-left longitude
  list.push(_paint(g, '#D98A4E'));
  return list;
}

function _buildPlum() {
  const list = [];
  // seam: thin torus arc down the front
  const g = FGEO.seam.clone();
  g.rotateZ(Math.PI / 2 - 2.0 / 2); // center the 2.0-rad arc at +Y
  g.rotateY(-Math.PI / 2);          // bring the meridian to the front (+z)
  list.push(_paint(g, '#3D1C4E'));
  // tiny stem nub
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.74, 0, 0, 0, 0, 0.8, 0.9, 0.8);
  return list;
}

function _buildKiwi() {
  const list = [];
  // tiny stem nub only
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.73, 0, 0, 0, 0, 0.9, 1, 0.9);
  return list;
}

function _buildCoconut() {
  const list = [];
  // three dark dots on the front-upper face: two above the eyes, one below-center
  _part(list, FGEO.dot5, '#4A3520', -0.19, 0.35, 0.61, 0, 0, 0, 1, 1, 1);
  _part(list, FGEO.dot5, '#4A3520', 0.19, 0.35, 0.61, 0, 0, 0, 1, 1, 1);
  _part(list, FGEO.dot5, '#4A3520', 0, 0.08, 0.72, 0, 0, 0, 1, 1, 1);
  return list;
}

function _buildAvocado() {
  const list = [];
  // darker-green bottom shell intersecting the lower body (kept just off the floor)
  _part(list, FGEO.shell, '#3E6B25', 0, -0.20, 0, 0, 0, 0, 1.16, 0.6, 1.0);
  return list;
}

const _FRUIT_BUILDERS = {
  strawberry: _buildStrawberry,
  orange: () => { const l = []; _stemFruitParts(l, 0.30, false); return l; },
  apple: () => { const l = []; _stemFruitParts(l, 0.50, false); return l; },
  lemon: () => { const l = []; _stemFruitParts(l, 0.35, false); return l; },
  pineapple: _buildPineapple,
  cherry: _buildCherry,
  mango: () => { const l = []; _stemFruitParts(l, 0.30, false); return l; },
  watermelon: _buildWatermelon,
  blueberry: _buildBlueberry,
  peach: _buildPeach,
  plum: _buildPlum,
  lime: () => { const l = []; _stemFruitParts(l, 0.35, true); return l; },
  grape: () => { const l = []; _stemFruitParts(l, 0.30, true); return l; },
  kiwi: _buildKiwi,
  coconut: _buildCoconut,
  avocado: _buildAvocado,
};

// One merged geometry per fruit id (cached). Rendered with the single shared
// vertex-colored material below: one draw call per rig.
const _fruitGeoCache = new Map();
function fruitFeatureGeometry(fruitId) {
  let g = _fruitGeoCache.get(fruitId);
  if (!g) {
    const parts = _FRUIT_BUILDERS[fruitId]();
    g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    _fruitGeoCache.set(fruitId, g);
  }
  return g;
}

let _featMat = null;
function featureMaterial() {
  if (!_featMat) _featMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  return _featMat;
}

// Soft radial-gradient blob shadow texture (shared)
let _shadowTex = null;
function shadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

// "Z" texture for sleep (shared)
let _zTex = null;
function zTexture() {
  if (_zTex) return _zTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 92px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(120,140,180,0.9)';
  g.strokeText('Z', 64, 68);
  g.fillStyle = 'rgba(235,242,255,0.95)';
  g.fillText('Z', 64, 68);
  _zTex = new THREE.CanvasTexture(c);
  return _zTex;
}

// ---------------------------------------------------------------------------
// Dust puff pool (world space, shared across all rigs)
// ---------------------------------------------------------------------------

let _puffTex = null;
function puffTexture() {
  if (_puffTex) return _puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _puffTex = new THREE.CanvasTexture(c);
  return _puffTex;
}

const PUFF_MAX = 24;
const PUFF_LIFE = 0.5;
const _puffPool = []; // { sprite, life }
const _wp = new THREE.Vector3(); // scratch

/**
 * Spawn one dust puff at a world-space-ish position under `parent`
 * (pass coordinates in `parent`'s local space). Integrator typically never
 * calls this directly — BlobRig fires it on happy-landings.
 */
export function spawnPuff(parent, x, y, z) {
  if (!parent) return;
  let p = null;
  for (let i = 0; i < _puffPool.length; i++) {
    if (_puffPool[i].life <= 0) { p = _puffPool[i]; break; }
  }
  if (!p && _puffPool.length < PUFF_MAX) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: puffTexture(),
      color: 0xe8e4dc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }));
    sprite.visible = false;
    p = { sprite, life: 0 };
    _puffPool.push(p);
  }
  if (!p) p = _puffPool[0]; // pool full: steal the oldest slot
  p.life = PUFF_LIFE;
  parent.add(p.sprite); // add() re-parents automatically if needed
  p.sprite.position.set(x, y, z);
  p.sprite.scale.set(0.3, 0.3, 1);
  p.sprite.material.opacity = 0.5;
  p.sprite.visible = true;
}

/** Animate all live puffs. Integrator MUST call this once per frame. */
export function updatePuffs(dt) {
  for (let i = 0; i < _puffPool.length; i++) {
    const p = _puffPool[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.sprite.visible = false; continue; }
    const u = 1 - p.life / PUFF_LIFE; // 0 → 1
    p.sprite.position.y += dt * 0.85; // rises ~0.4 over its life
    const s = 0.3 + 0.6 * u;          // expands 0.3 → 0.9
    p.sprite.scale.set(s, s, 1);
    p.sprite.material.opacity = 0.5 * (1 - u);
  }
}

// ---------------------------------------------------------------------------
// BlobRig
// ---------------------------------------------------------------------------

const STATES = new Set(['idle', 'walk', 'happy', 'sleep', 'boop']);

// Animation tuning constants — the integrator can tweak these freely.
const TUNE = {
  idleBreathAmp: 0.03,      // body scale-y breathing amplitude
  idleBreathFreq: 2.2,      // rad/s
  blinkMin: 2.4, blinkMax: 5.5, // seconds between blinks
  blinkDur: 0.12,           // seconds eyes stay shut
  walkFreq: 9,              // rad/s step cycle
  walkBobAmp: 0.16,         // vertical hop height
  walkRollAmp: 0.09,        // waddle roll
  walkArmSwing: 0.5,        // arm swing amplitude (rad)
  stepSquash: 0.08,         // scale-y dip on each footstep
  happyDur: 0.9,            // total happy hop timeline (s)
  happyPeak: 1.1,           // hop apex height
  boopDur: 0.6,             // total boop timeline (s)
  sleepScaleY: 0.45,        // squashed body height while asleep
  sleepBodyY: 0.35,         // body center height while asleep
  transitionTime: 0.15,      // lerp time between states
};

function newPose() {
  return { sX: 1, sY: 1, sZ: 1, bobY: 0, roll: 0, eyeY: 1, armL: 0, armR: 0, bodyY: 0.72 };
}

export class BlobRig {
  /**
   * @param {object} opts
   * @param {string} [opts.fruit] - one of the 16 FRUIT_SPECS ids; wins over bodyColor.
   * @param {string|number} [opts.bodyColor] - legacy: CSS hex string or hex number.
   *   Matched against the fruit palette (a fruit blob with features results);
   *   unmatched colors fall back to a plain featureless blob.
   */
  constructor({ fruit = null, bodyColor = '#FF8C69' } = {}) {
    // --- resolve the fruit spec ---
    let spec;
    let key;
    if (fruit && FRUIT_SPECS[fruit]) {
      spec = FRUIT_SPECS[fruit];
      key = fruit;
    } else {
      const hex = hexKey(bodyColor);
      const fid = _hexToFruit.get(hex);
      if (fid) { spec = FRUIT_SPECS[fid]; key = fid; }
      else {
        spec = { id: null, body: hex, rough: 0.55, scale: [1.15, 0.95, 1.0], topY: 1.55 };
        key = hex;
      }
    }
    const bMat = bodyMaterial(key, spec.body, spec.rough);
    const dMat = darkMaterial(key, spec.body);

    // group: origin at FEET (y=0 = floor). Integrator positions this.
    this.group = new THREE.Group();
    // bobber: carries everything that hops/waddles; shadow stays flat on the floor.
    this.bobber = new THREE.Group();
    this.group.add(this.bobber);

    // --- body (round fruit bean) ---
    this.body = new THREE.Mesh(GEO.body, bMat);
    this.body.scale.set(spec.scale[0], spec.scale[1], spec.scale[2]);
    this.body.position.y = 0.72;
    this.body.castShadow = true;
    this.body.receiveShadow = false;
    this.bobber.add(this.body);

    // --- fruit features (one merged geometry, one shared vertex-colored
    //     material = one draw call). Child of the body, so it rides squash.
    this.features = null;
    if (spec.id) {
      this.features = new THREE.Mesh(fruitFeatureGeometry(spec.id), featureMaterial());
      this.features.castShadow = true;
      this.body.add(this.features);
    }

    // --- eyes: round black DOT eyes (true spheres) + white catchlights ---
    const eMat = eyeMaterial();
    const hMat = highlightMaterial();
    this.eyeL = new THREE.Mesh(GEO.unit, eMat);
    this.eyeL.scale.set(0.095, 0.095, 0.05);
    this.eyeL.position.set(-0.22, 0.85, 0.62);
    this.eyeR = new THREE.Mesh(GEO.unit, eMat);
    this.eyeR.scale.set(0.095, 0.095, 0.05);
    this.eyeR.position.set(0.22, 0.85, 0.62);
    this.hlL = new THREE.Mesh(GEO.unit, hMat);
    this.hlL.scale.set(0.028, 0.028, 0.028);
    this.hlL.position.set(-0.268, 0.895, 0.652);
    this.hlR = new THREE.Mesh(GEO.unit, hMat);
    this.hlR.scale.set(0.028, 0.028, 0.028);
    this.hlR.position.set(0.172, 0.895, 0.652);
    this.bobber.add(this.eyeL, this.eyeR, this.hlL, this.hlR);

    // --- nub arms ---
    const aMat = bMat;
    this.armL = new THREE.Mesh(GEO.arm, aMat);
    this.armL.position.set(-0.78, 0.65, 0);
    this.armL.rotation.z = 0.25; // outward tilt (base)
    this.armL.castShadow = true;
    this.armR = new THREE.Mesh(GEO.arm, aMat);
    this.armR.position.set(0.78, 0.65, 0);
    this.armR.rotation.z = -0.25;
    this.armR.castShadow = true;
    this.bobber.add(this.armL, this.armR);

    // --- feet (darker) ---
    this.footL = new THREE.Mesh(GEO.unit, dMat);
    this.footL.scale.set(0.22, 0.121, 0.264);
    this.footL.position.set(-0.32, 0.12, 0.12);
    this.footL.castShadow = true;
    this.footR = new THREE.Mesh(GEO.unit, dMat);
    this.footR.scale.set(0.22, 0.121, 0.264);
    this.footR.position.set(0.32, 0.12, 0.12);
    this.footR.castShadow = true;
    this.bobber.add(this.footL, this.footR);

    // --- soft blob shadow (stays on the floor, fades as the blob rises) ---
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(GEO.shadow, this.shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.receiveShadow = false;
    this.group.add(this.shadow);

    // --- sleep "Z" sprites (shared texture, per-rig materials for opacity) ---
    this.zSprites = [];
    const zt = zTexture();
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: zt, transparent: true, opacity: 0, depthWrite: false,
      }));
      sp.visible = false;
      this.group.add(sp);
      this.zSprites.push(sp);
    }

    // --- invisible raycast hit proxy ---
    this.hitProxy = new THREE.Mesh(GEO.hit, new THREE.MeshBasicMaterial());
    this.hitProxy.position.y = 0.85;
    this.hitProxy.visible = false;
    this.group.add(this.hitProxy);

    // --- public contract fields ---
    this.fruit = spec.id;      // fruit id, or null for a legacy plain blob
    this.topY = spec.topY;     // label-anchor height (1.95 for pineapple)
    this._bs = spec.scale;     // body base scale [x,y,z]

    // --- state machine ---
    this._state = 'idle';
    this._stateT = 0;
    this._pending = null;      // state requested mid-hop (happy/boop finish first)
    this._boopReturn = 'idle'; // state to restore after boop
    this._landed = false;      // happy landing puff already fired
    this._blinkT = 2.5 + Math.random() * 2; // countdown to next blink
    this._blink = 0;           // remaining blink-shut time
    this._pulse = 0;           // walk footstep squash pulse (decays)
    this._prevSwn = 0;         // previous walk sin for zero-crossing detection

    // Pose plumbing: _tgt = freshly computed target, _prev = pose at last
    // state change, _pose = blended/applied pose. No allocation in update().
    this._tgt = newPose();
    this._prev = newPose();
    this._pose = newPose();
    this._blend = 1; // 1 = fully on target (no transition in progress)
  }

  /** Request a state. happy/boop finish their timeline first, then go to the
   *  newly requested state if different. All other transitions blend ~0.15s. */
  setState(s) {
    if (!STATES.has(s)) throw new Error(`BlobRig.setState: unknown state "${s}"`);
    if (s === this._state) return;
    if (this._state === 'happy' || this._state === 'boop') {
      this._pending = s; // finish the timeline, then switch
      return;
    }
    if (s === 'boop') this._boopReturn = this._state;
    this._begin(s);
  }

  /** Yaw in radians. Call each frame while walking with Math.atan2(vx, vz). */
  setFacing(radians) {
    this.group.rotation.y = radians;
  }

  _begin(s) {
    // snapshot current pose so the transition lerps from it
    const a = this._prev, b = this._pose;
    a.sX = b.sX; a.sY = b.sY; a.sZ = b.sZ; a.bobY = b.bobY; a.roll = b.roll;
    a.eyeY = b.eyeY; a.armL = b.armL; a.armR = b.armR; a.bodyY = b.bodyY;
    this._state = s;
    this._stateT = 0;
    this._blend = 0;
    this._landed = false;
  }

  _burstPuffs() {
    const parent = this.group.parent;
    if (!parent) return;
    this.group.getWorldPosition(_wp);
    parent.worldToLocal(_wp);
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.35 + Math.random() * 0.35;
      spawnPuff(parent, _wp.x + Math.cos(a) * r, 0.08, _wp.z + Math.sin(a) * r);
    }
  }

  /** dt seconds, t = elapsed seconds. Call every frame. */
  update(dt, t) {
    this._stateT += dt;
    const P = this._tgt;

    // --- base pose: idle breathing ---
    const br = Math.sin(t * TUNE.idleBreathFreq);
    P.sX = 1 - 0.015 * br;
    P.sY = 1 + TUNE.idleBreathAmp * br;
    P.sZ = 1 - 0.015 * br;
    P.bobY = 0;
    P.roll = 0;
    P.eyeY = 1;
    P.bodyY = 0.72;
    P.armL = 0;
    P.armR = 0;

    // --- blink (idle only): eyes shut to 0.1 for 0.12s ---
    if (this._state === 'idle') {
      this._blinkT -= dt;
      if (this._blinkT <= 0) {
        this._blink = TUNE.blinkDur;
        this._blinkT = TUNE.blinkMin + Math.random() * (TUNE.blinkMax - TUNE.blinkMin);
      }
    }
    if (this._blink > 0) this._blink -= dt;

    let endTimeline = null;

    switch (this._state) {
      case 'walk': {
        const w = t * TUNE.walkFreq;
        const swn = Math.sin(w);
        P.bobY = Math.abs(swn) * TUNE.walkBobAmp;
        P.roll = TUNE.walkRollAmp * swn;
        P.armL = TUNE.walkArmSwing * swn;
        P.armR = -TUNE.walkArmSwing * swn;
        // footstep squash pulse on each sin zero-crossing
        if ((this._prevSwn <= 0) !== (swn <= 0)) this._pulse = 1;
        this._prevSwn = swn;
        this._pulse = Math.max(0, this._pulse - dt * 6);
        P.sY *= 1 - TUNE.stepSquash * this._pulse;
        P.sX *= 1 + 0.04 * this._pulse;
        P.sZ *= 1 + 0.04 * this._pulse;
        break;
      }
      case 'happy': {
        const ht = this._stateT;
        P.eyeY = 1.25;
        if (ht < 0.15) {                    // anticipation squash
          const u = ht / 0.15;
          P.sY = 1 - 0.3 * u; P.sX = 1 + 0.25 * u; P.sZ = 1 + 0.15 * u;
        } else if (ht < 0.3) {              // launch stretch
          const u = (ht - 0.15) / 0.15;
          P.sY = 0.7 + 0.48 * u; P.sX = 1.25 - 0.35 * u; P.sZ = 1.15 - 0.15 * u;
        } else if (ht < 0.75) {             // airborne parabola, apex ~1.1
          const u = (ht - 0.3) / 0.45;
          P.bobY = TUNE.happyPeak * 4 * u * (1 - u);
          P.sY = 1.1; P.sX = 0.92; P.sZ = 0.95;
        } else {                            // landing squash + recovery
          const u = Math.min(1, (ht - 0.75) / 0.15);
          if (!this._landed) { this._landed = true; this._burstPuffs(); }
          P.sY = 0.72 + 0.28 * u;
          P.sX = 1.25 - 0.25 * u;
          P.sZ = 1.15 - 0.15 * u;
          P.eyeY = 1.25 - 0.25 * u;
        }
        if (ht >= TUNE.happyDur) {
          endTimeline = this._pending || 'idle';
          this._pending = null;
        }
        break;
      }
      case 'sleep': {
        P.sY = TUNE.sleepScaleY + 0.02 * Math.sin(t * 1.5); // slow sleep breathing
        P.sX = 1.12; P.sZ = 1.08;
        P.eyeY = 0.1;   // eyes shut
        P.bodyY = TUNE.sleepBodyY;
        break;
      }
      case 'boop': {
        const bt = this._stateT;
        if (bt < 0.15) {                     // fast squash
          const u = bt / 0.15;
          P.sY = 1 - 0.32 * u; P.sX = 1 + 0.2 * u; P.sZ = 1 + 0.12 * u;
        } else if (bt < 0.35) {              // stretch pop + tiny hop + eye pop
          const u = (bt - 0.15) / 0.2;
          P.sY = 0.68 + 0.54 * u;
          P.sX = 1.2 - 0.28 * u;
          P.sZ = 1.12 - 0.18 * u;
          P.eyeY = 1 + 0.35 * Math.sin(Math.PI * u);
          P.bobY = 0.35 * 4 * u * (1 - u);
        } else {                             // recover
          const u = Math.min(1, (bt - 0.35) / 0.25);
          P.sY = 1.22 - 0.22 * u;
          P.sX = 0.92 + 0.08 * u;
          P.sZ = 0.94 + 0.06 * u;
        }
        if (bt >= TUNE.boopDur) {
          endTimeline = this._pending || this._boopReturn || 'idle';
          this._pending = null;
        }
        break;
      }
      // 'idle' needs nothing beyond the base pose
    }

    if (this._blink > 0 && (this._state === 'idle' || this._state === 'walk')) {
      P.eyeY = 0.1; // blink overrides
    }

    // --- blend from previous pose on state change (~0.15s) ---
    const pose = this._pose;
    if (this._blend < 1) {
      this._blend = Math.min(1, this._blend + dt / TUNE.transitionTime);
      const k = this._blend * this._blend * (3 - 2 * this._blend); // smoothstep
      const a = this._prev;
      pose.sX = a.sX + (P.sX - a.sX) * k;
      pose.sY = a.sY + (P.sY - a.sY) * k;
      pose.sZ = a.sZ + (P.sZ - a.sZ) * k;
      pose.bobY = a.bobY + (P.bobY - a.bobY) * k;
      pose.roll = a.roll + (P.roll - a.roll) * k;
      pose.eyeY = a.eyeY + (P.eyeY - a.eyeY) * k;
      pose.armL = a.armL + (P.armL - a.armL) * k;
      pose.armR = a.armR + (P.armR - a.armR) * k;
      pose.bodyY = a.bodyY + (P.bodyY - a.bodyY) * k;
    } else {
      pose.sX = P.sX; pose.sY = P.sY; pose.sZ = P.sZ; pose.bobY = P.bobY;
      pose.roll = P.roll; pose.eyeY = P.eyeY;
      pose.armL = P.armL; pose.armR = P.armR; pose.bodyY = P.bodyY;
    }

    // --- apply ---
    this.body.scale.set(this._bs[0] * pose.sX, this._bs[1] * pose.sY, this._bs[2] * pose.sZ);
    this.body.position.y = pose.bodyY;
    this.bobber.position.y = pose.bobY;
    this.bobber.rotation.z = pose.roll;
    // dot eyes: eyeY is a direct multiplier (1 = open)
    const ey = 0.095 * pose.eyeY;
    this.eyeL.scale.y = ey;
    this.eyeR.scale.y = ey;
    // catchlights shrink with the eyes, hidden when nearly shut
    const clOn = pose.eyeY >= 0.3;
    this.hlL.visible = clOn;
    this.hlR.visible = clOn;
    if (clOn) {
      this.hlL.scale.y = 0.028 * pose.eyeY;
      this.hlR.scale.y = 0.028 * pose.eyeY;
    }
    this.armL.rotation.x = pose.armL;
    this.armR.rotation.x = pose.armR;

    // shadow fades as the blob rises
    const hop = Math.max(0, pose.bobY);
    this.shadowMat.opacity = 0.32 * THREE.MathUtils.clamp(1 - hop / 1.4, 0.2, 1);

    // sleep Z's float upward on a loop
    const sleeping = this._state === 'sleep';
    for (let i = 0; i < this.zSprites.length; i++) {
      const sp = this.zSprites[i];
      sp.visible = sleeping;
      if (sleeping) {
        const ph = (t * 0.45 + i / 3) % 1;
        const headY = pose.bodyY + 0.75;
        sp.position.set(
          0.25 + 0.1 * Math.sin(t * 2 + i * 2.1),
          headY + 0.15 + ph * 0.85,
          0.1
        );
        const sc = 0.28 + 0.12 * ph;
        sp.scale.set(sc, sc, 1);
        sp.material.opacity = (1 - ph) * 0.85;
      }
    }

    // timeline finished → transition (blends from current pose)
    if (endTimeline) this._begin(endTimeline === this._state ? 'idle' : endTimeline);
  }
}

export { TUNE };
