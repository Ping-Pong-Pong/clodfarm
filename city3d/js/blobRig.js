/**
 * blobRig.js — procedural 3D FRUIT BLOB mascot rig for the TypePop 3D city.
 *
 * One BlobRig = one MBTI fruit blob resident (per-fruit LatheGeometry
 * silhouette, round black DOT eyes with catchlights seated on the profile
 * surface, per-fruit 3D features, nub arms — except grape — rounded feet).
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
 *   scene.add(rig.group);            // group origin at FEET (y=0 = floor).
 *                                    // Blob ~1.0-1.95 units tall depending on fruit.
 *   rig.group.position.set(x, 0, z); // move by setting group position
 *   rig.setState('idle' | 'walk' | 'happy' | 'sleep' | 'boop');
 *   rig.setFacing(radians);          // yaw; call each frame while walking with Math.atan2(vx, vz)
 *   rig.update(dt, t);               // dt seconds, t = elapsed seconds. Call every frame.
 *   rig.topY;                        // number ≈ per-fruit label-anchor height (pineapple 1.95)
 *   rig.fruit;                       // resolved fruit id, or null for a legacy plain blob
 *   rig.hitProxy;                    // invisible cylinder mesh (visible=false) sized to the body;
 *                                    // integrator adds it to raycast targets and sets userData on it.
 *                                    // (THREE.Raycaster intersects visible=false meshes, so this works.)
 *
 * ---------------------------------------------------------------------------
 * FRUIT SILHOUETTES
 * ---------------------------------------------------------------------------
 * Each fruit's body is a LatheGeometry revolved from a per-fruit 2D profile
 * (PROFILES below: [radius, y] control points, y from -0.75 at the feet to
 * +0.75 at the top, body-local units). The silhouette reads as the fruit:
 * strawberry = inverted teardrop, lemon = pointed oval, avocado = pear,
 * grape = merged-sphere cluster, etc. FRUIT_SPECS.scale adds per-fruit size
 * variety (watermelon largest, blueberry/lime smallest). Eyes, arms, feet,
 * shadow and hit-proxy are all re-seated from the profile + scale, so every
 * fruit stands on the floor with its face on the surface.
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
 * geometries are cached per fruit id (16 max). Body materials are cached per
 * fruit id (one MeshPhysicalMaterial per fruit, shared by all rigs of that
 * fruit; feet use a cached 0.92-darkened variant). Feature geometries are
 * cached per fruit id (16 max). Nothing is allocated inside update() — poses
 * reuse preallocated objects. LatheGeometry segments are 28 (modest).
 *
 * Three.js r170 API. `outputColorSpace` default is fine.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Fruit specs
// ---------------------------------------------------------------------------

function _fs(id, body, rough, scale, topY = 1.55) {
  return { id, body, rough, scale, topY };
}

/**
 * 16 fruit specs. `scale` = body base [x,y,z] (watermelon largest at ~1.3x,
 * blueberry/lime smallest at ~0.7x); `topY` = label-anchor height.
 * Body COLORS are the established palette — do not change them.
 */
export const FRUIT_SPECS = {
  strawberry: _fs('strawberry', '#E8404F', 0.55, [1.12, 0.98, 1.05], 1.45),
  orange:     _fs('orange',     '#FF9F2E', 0.55, [1.12, 0.98, 1.08], 1.45),
  apple:      _fs('apple',      '#D63A2F', 0.55, [1.12, 1.00, 1.08], 1.50),
  lemon:      _fs('lemon',      '#F7D038', 0.55, [0.92, 1.18, 0.95], 1.75),
  pineapple:  _fs('pineapple',  '#F2B93B', 0.55, [1.00, 1.22, 1.00], 1.95),
  cherry:     _fs('cherry',     '#C81E3A', 0.55, [0.95, 0.95, 0.95], 1.40),
  mango:      _fs('mango',      '#FF9E2C', 0.55, [1.18, 1.02, 1.05], 1.55),
  watermelon: _fs('watermelon', '#3FA34D', 0.55, [1.45, 1.24, 1.35], 1.85),
  blueberry:  _fs('blueberry',  '#4A5FA5', 0.55, [0.78, 0.66, 0.78], 1.00),
  peach:      _fs('peach',      '#FFB37E', 0.90, [1.12, 0.98, 1.08], 1.45),
  plum:       _fs('plum',       '#5B2A6E', 0.55, [1.00, 1.12, 1.00], 1.70),
  lime:       _fs('lime',       '#A8D93A', 0.55, [0.80, 0.70, 0.80], 1.05),
  grape:      _fs('grape',      '#7B4FA6', 0.75, [1.00, 1.00, 1.00], 1.50),
  kiwi:       _fs('kiwi',       '#8A6D3B', 0.95, [1.05, 0.95, 1.00], 1.40),
  coconut:    _fs('coconut',    '#8A6D4A', 0.55, [1.08, 1.00, 1.08], 1.50),
  avocado:    _fs('avocado',    '#5C8A3A', 0.55, [1.10, 1.08, 1.05], 1.60),
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
  body: new THREE.SphereGeometry(0.75, 24, 18), // legacy plain-blob fallback only
  unit: new THREE.SphereGeometry(1, 12, 10),   // eyes, highlights, feet
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
  disc: new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12), // blueberry crown
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
// Fruit silhouette profiles (body-local space: y from -0.75 at feet to +0.75
// at the top, radius in the same units; the rig's FRUIT_SPECS.scale sizes it)
// ---------------------------------------------------------------------------

/**
 * Build a smooth lathe profile from [radius, y] control points (y increasing).
 * Returns { pts, radiusAt(y) }.
 */
function _prof(ctrl, samples = 28) {
  const v = ctrl.map(p => new THREE.Vector2(Math.max(0, p[0]), p[1]));
  const pts = new THREE.SplineCurve(v).getPoints(samples);
  for (const p of pts) p.x = Math.max(0.0001, p.x);
  pts[0].x = 0.0001;
  pts[pts.length - 1].x = 0.0001;
  return {
    pts,
    radiusAt(y) {
      if (y <= pts[0].y) return pts[0].x;
      for (let i = 1; i < pts.length; i++) {
        if (y <= pts[i].y) {
          const a = pts[i - 1], b = pts[i];
          const t = (y - a.y) / Math.max(1e-6, b.y - a.y);
          return a.x + (b.x - a.x) * t;
        }
      }
      return pts[pts.length - 1].x;
    },
  };
}

const PROFILES = {
  // strawberry: inverted teardrop — broad rounded shoulders, soft point at the bottom
  strawberry: _prof([[0, -0.75], [0.28, -0.68], [0.50, -0.50], [0.64, -0.22], [0.72, 0.08], [0.73, 0.32], [0.64, 0.55], [0.45, 0.70], [0.30, 0.74], [0, 0.75]]),
  // orange: round
  orange: _prof([[0, -0.75], [0.40, -0.64], [0.60, -0.42], [0.71, -0.12], [0.74, 0.15], [0.66, 0.42], [0.50, 0.62], [0.28, 0.72], [0, 0.75]]),
  // apple: round with a dimple at the top (last two points dip at the pole)
  apple: _prof([[0, -0.75], [0.40, -0.64], [0.60, -0.42], [0.71, -0.12], [0.74, 0.15], [0.66, 0.42], [0.50, 0.60], [0.30, 0.68], [0.13, 0.685], [0, 0.66]]),
  // lemon: oval with pointed nubs at both ends (y-scale stretches it tall)
  lemon: _prof([[0, -0.75], [0.16, -0.70], [0.38, -0.55], [0.55, -0.28], [0.62, 0.02], [0.58, 0.30], [0.44, 0.54], [0.24, 0.68], [0.09, 0.73], [0, 0.75]]),
  // pineapple: tall barrel oval
  pineapple: _prof([[0, -0.75], [0.38, -0.66], [0.58, -0.42], [0.68, -0.08], [0.69, 0.22], [0.62, 0.50], [0.44, 0.68], [0, 0.75]]),
  // cherry: round (smaller via scale)
  cherry: _prof([[0, -0.75], [0.40, -0.64], [0.60, -0.42], [0.71, -0.12], [0.74, 0.15], [0.66, 0.42], [0.50, 0.62], [0.28, 0.72], [0, 0.75]]),
  // mango: plump bottom-heavy oval (+ sideways lean baked into the geometry below)
  mango: _prof([[0, -0.75], [0.42, -0.64], [0.62, -0.40], [0.71, -0.05], [0.70, 0.28], [0.58, 0.55], [0.38, 0.70], [0, 0.75]]),
  // watermelon: true sphere (stripes hug it); biggest via scale
  watermelon: _prof([[0, -0.75], [0.38, -0.646], [0.53, -0.53], [0.65, -0.375], [0.72, -0.217], [0.75, 0], [0.72, 0.217], [0.65, 0.375], [0.53, 0.53], [0.38, 0.646], [0, 0.75]]),
  // blueberry: round (small via scale)
  blueberry: _prof([[0, -0.75], [0.40, -0.64], [0.60, -0.42], [0.71, -0.12], [0.74, 0.15], [0.66, 0.42], [0.50, 0.62], [0.28, 0.72], [0, 0.75]]),
  // peach: round, slightly squat
  peach: _prof([[0, -0.75], [0.41, -0.63], [0.61, -0.40], [0.72, -0.08], [0.73, 0.20], [0.64, 0.47], [0.47, 0.65], [0, 0.75]]),
  // plum: smooth tall oval
  plum: _prof([[0, -0.75], [0.36, -0.65], [0.56, -0.42], [0.66, -0.08], [0.67, 0.25], [0.58, 0.53], [0.40, 0.69], [0, 0.75]]),
  // lime: round (small via scale)
  lime: _prof([[0, -0.75], [0.40, -0.64], [0.60, -0.42], [0.71, -0.12], [0.74, 0.15], [0.66, 0.42], [0.50, 0.62], [0.28, 0.72], [0, 0.75]]),
  // kiwi: oval
  kiwi: _prof([[0, -0.75], [0.38, -0.64], [0.58, -0.42], [0.68, -0.10], [0.70, 0.20], [0.62, 0.48], [0.44, 0.66], [0, 0.75]]),
  // coconut: round
  coconut: _prof([[0, -0.75], [0.42, -0.62], [0.62, -0.38], [0.72, -0.05], [0.73, 0.25], [0.64, 0.52], [0.44, 0.68], [0, 0.75]]),
  // avocado: pear — narrow neck on top, wide bottom
  avocado: _prof([[0, -0.75], [0.40, -0.66], [0.62, -0.45], [0.72, -0.15], [0.68, 0.15], [0.55, 0.42], [0.36, 0.62], [0.16, 0.72], [0, 0.75]]),
};

// grape: a cluster of small spheres [x, y, z, r] (body-local units), no lathe.
const GRAPE_BALLS = [
  [0, -0.50, 0, 0.22],
  [-0.23, -0.22, 0.05, 0.26],
  [0.23, -0.22, 0.05, 0.26],
  [0, -0.22, -0.21, 0.26],
  [-0.24, 0.06, -0.06, 0.26],
  [0.24, 0.06, -0.06, 0.26],
  [0, 0.06, 0.21, 0.26],
  [-0.19, 0.32, 0.04, 0.24],
  [0.19, 0.32, 0.04, 0.24],
  [0, 0.55, 0, 0.22],
];

/** Front-most surface z of the grape bunch at body-local (x, y). */
function _grapeFrontZ(x, y) {
  let z = -Infinity;
  for (const b of GRAPE_BALLS) {
    const dx = x - b[0], dy = y - b[1];
    const rr = b[3] * b[3] - dx * dx - dy * dy;
    if (rr > 0) z = Math.max(z, b[2] + Math.sqrt(rr));
  }
  return z === -Infinity ? 0.3 : z;
}

// One body geometry per fruit id (cached). LatheGeometry(pts, 28).
const _bodyGeoCache = new Map();
function bodyGeometry(fruitId) {
  let g = _bodyGeoCache.get(fruitId);
  if (!g) {
    g = _buildBodyGeometry(fruitId);
    _bodyGeoCache.set(fruitId, g);
  }
  return g;
}

const _mm = new THREE.Matrix4();

function _buildBodyGeometry(fruitId) {
  if (fruitId === 'grape') {
    const parts = [];
    for (const b of GRAPE_BALLS) {
      const g = new THREE.SphereGeometry(b[3], 10, 8);
      _mm.makeTranslation(b[0], b[1], b[2]);
      g.applyMatrix4(_mm);
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return merged;
  }
  const g = new THREE.LatheGeometry(PROFILES[fruitId].pts, 28);
  if (fruitId === 'mango') {
    // kidney lean: sideways bulge peaking at mid-body (eyes/stem compensate)
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = Math.sin(Math.PI * THREE.MathUtils.clamp((y + 0.75) / 1.5, 0, 1));
      pos.setX(i, pos.getX(i) + 0.09 * k);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// ---------------------------------------------------------------------------
// Fruit feature builders (body-local space; y from -0.75 at feet to +0.75 top)
// ---------------------------------------------------------------------------

const STEM_BROWN = '#6B4A2B';
const LEAF_GREEN = '#4F9B4F';
const CROWN_GREEN = '#3E8E41';

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

// dot seated on the profile surface at body-local (x, y), ~35% embedded
function _dotOnProfile(list, prof, geo, hex, x, y, r) {
  const R = prof.radiusAt(y);
  const z = Math.sqrt(Math.max(0.0004, R * R - x * x)) - r * 0.35;
  const s = r / 0.05;
  _part(list, geo, hex, x, y, z, 0, 0, 0, s, s, s);
}

// seed dots hugging the profile between y0 and y1 (fibonacci distribution)
function _seedsOnProfile(list, prof, count, y0, y1, hex) {
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const y = y0 + (y1 - y0) * t;
    const ph = i * ga;
    const r = prof.radiusAt(y) * 0.97;
    _part(list, FGEO.seed, hex,
      r * Math.cos(ph), y, r * Math.sin(ph),
      0, 0, 0, 1, 1, 1);
  }
}

// tube arc following the profile surface along one meridian (front = +z at 90°)
function _meridianTube(list, prof, y0, y1, lonDeg, tubeR, hex) {
  const pts = [];
  const lon = lonDeg * Math.PI / 180;
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const y = y0 + (y1 - y0) * i / N;
    const r = prof.radiusAt(y) + tubeR * 0.25 - 0.004;
    pts.push(new THREE.Vector3(r * Math.cos(lon), y, r * Math.sin(lon)));
  }
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, tubeR, 6, false);
  list.push(_paint(g, hex));
}

// brown stem + one flattened leaf near the top (xOff shifts both sideways)
function _stemFruitParts(list, tilt, smallLeaf, baseY, xOff = 0) {
  _partDir(list, FGEO.stemS, STEM_BROWN, xOff, baseY + 0.12, 0, tilt, 1, 0, 1, 1, 1);
  const ls = smallLeaf ? 0.7 : 1;
  _part(list, FGEO.leaf, LEAF_GREEN, xOff + 0.16, baseY + 0.34, 0.02,
    0.25, 0.45, -0.45, 0.13 * ls, 0.045 * ls, 0.07 * ls);
}

function _buildStrawberry() {
  const list = [];
  const prof = PROFILES.strawberry;
  // 26 seed dots over the upper ~2/3, hugging the teardrop
  _seedsOnProfile(list, prof, 26, -0.30, 0.58, '#8A2432');
  // calyx: 6 leaves radiating on the top dome
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.26;
    _partDir(list, FGEO.cone, '#3E8E41',
      0.28 * Math.cos(a), 0.72, 0.28 * Math.sin(a),
      1.0 * Math.cos(a), 0.45, 1.0 * Math.sin(a),
      1, 0.7, 0.9);
  }
  // tiny stem
  _part(list, FGEO.stemNub, '#5C8A3C', 0, 0.73, 0, 0, 0, 0.15, 0.7, 1.0, 0.7);
  return list;
}

function _buildPineapple() {
  const list = [];
  // crown of 7 long green cones fanning upward from the top
  _partDir(list, FGEO.crown, CROWN_GREEN, 0, 0.68, 0, 0, 1, 0, 1, 0.55, 1);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    _partDir(list, FGEO.crown, '#357A37',
      0.16 * Math.cos(a), 0.66, 0.16 * Math.sin(a),
      0.45 * Math.cos(a), 1, 0.45 * Math.sin(a),
      1, 0.55, 1);
  }
  return list;
}

function _buildCherry() {
  const list = [];
  // two thin stems angled apart from the top + one leaf
  _partDir(list, FGEO.stemCherry, '#5C4A2E', -0.05, 0.78, 0, -0.45, 1, 0.1, 1, 1, 1);
  _partDir(list, FGEO.stemCherry, '#5C4A2E', 0.05, 0.78, 0, 0.45, 1, -0.1, 1, 1, 1);
  _part(list, FGEO.leaf, LEAF_GREEN, 0.18, 1.00, 0.05,
    0.2, 0.4, -0.5, 0.12, 0.04, 0.06);
  return list;
}

function _buildWatermelon() {
  const list = [];
  // 3 dark-green stripes on vertical longitudes 0°/60°/120°, hugging the sphere
  for (let k = 0; k < 3; k++) {
    const g = FGEO.stripe.clone();
    g.rotateZ(Math.PI / 2 - 2.4 / 2); // center the 2.4-rad arc at +Y
    g.rotateY((k / 3) * Math.PI);     // 0°/60°/120°
    list.push(_paint(g, '#2B6B2F'));
  }
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.72, 0, 0, 0, 0.1, 0.8, 1.0, 0.8);
  return list;
}

function _buildBlueberry() {
  const list = [];
  const prof = PROFILES.blueberry;
  // crown: small dark disc on top + 5 tiny spheres in a star around it
  _part(list, FGEO.disc, '#2C3A5E', 0, 0.735, 0, 0, 0, 0, 2, 1, 2);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    _dotOnProfile(list, prof, FGEO.dot3, '#2C3A5E',
      0.15 * Math.cos(a), 0.72, 0.03);
  }
  return list;
}

function _buildPeach() {
  const list = [];
  // cleft: thin arc hugging the front-left meridian
  _meridianTube(list, PROFILES.peach, -0.15, 0.55, 135, 0.028, '#D98A4E');
  return list;
}

function _buildPlum() {
  const list = [];
  // seam: thin arc down the front meridian + tiny stem nub
  _meridianTube(list, PROFILES.plum, -0.55, 0.62, 90, 0.022, '#3D1C4E');
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.72, 0, 0, 0, 0, 0.8, 1.0, 0.8);
  return list;
}

function _buildKiwi() {
  const list = [];
  // tiny stem nub only
  _part(list, FGEO.stemNub, STEM_BROWN, 0, 0.72, 0, 0, 0, 0, 0.9, 1.0, 0.9);
  return list;
}

function _buildCoconut() {
  const list = [];
  const prof = PROFILES.coconut;
  // three dark dots on the face: two above the eyes, one centered below
  _dotOnProfile(list, prof, FGEO.dot5, '#4A3520', -0.19, 0.35, 0.05);
  _dotOnProfile(list, prof, FGEO.dot5, '#4A3520', 0.19, 0.35, 0.05);
  _dotOnProfile(list, prof, FGEO.dot5, '#4A3520', 0, -0.08, 0.05);
  return list;
}

function _buildAvocado() {
  const list = [];
  // darker-green bottom shell: the pear profile's lower part, grown slightly
  const prof = PROFILES.avocado;
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const y = -0.75 + 0.73 * (i / 12);
    pts.push(new THREE.Vector2(prof.radiusAt(y) * 1.02 + 0.004, y));
  }
  list.push(_paint(new THREE.LatheGeometry(pts, 24), '#3E6B25'));
  return list;
}

function _buildGrape() {
  const list = [];
  // small stem + leaf on top of the bunch
  _partDir(list, FGEO.stemS, STEM_BROWN, 0, 0.82, 0, 0.30, 1, 0, 1, 1, 1);
  _part(list, FGEO.leaf, LEAF_GREEN, 0.16, 0.98, 0.02,
    0.25, 0.45, -0.45, 0.10, 0.035, 0.055);
  return list;
}

const _FRUIT_BUILDERS = {
  strawberry: _buildStrawberry,
  orange: () => { const l = []; _stemFruitParts(l, 0.30, false, 0.60); return l; },
  apple: () => { const l = []; _stemFruitParts(l, 0.50, false, 0.56); return l; },
  lemon: () => { const l = []; _stemFruitParts(l, 0.35, false, 0.58); return l; },
  pineapple: _buildPineapple,
  cherry: _buildCherry,
  mango: () => { const l = []; _stemFruitParts(l, 0.30, false, 0.55, 0.07); return l; },
  watermelon: _buildWatermelon,
  blueberry: _buildBlueberry,
  peach: _buildPeach,
  plum: _buildPlum,
  lime: () => { const l = []; _stemFruitParts(l, 0.35, true, 0.58); return l; },
  grape: _buildGrape,
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

    // Per-fruit size factors, normalized against the original default scale
    // [1.15, 0.95, 1.0] so legacy fruits behave exactly as before.
    const sx = spec.scale[0], sy = spec.scale[1], sz = spec.scale[2];
    const xK = sx / 1.15, yK = sy / 0.95, zK = sz / 1.0;

    // group: origin at FEET (y=0 = floor). Integrator positions this.
    this.group = new THREE.Group();
    // bobber: carries everything that hops/waddles; shadow stays flat on the floor.
    this.bobber = new THREE.Group();
    this.group.add(this.bobber);

    // --- body (per-fruit LatheGeometry silhouette; legacy plain blob = sphere) ---
    this.body = new THREE.Mesh(spec.id ? bodyGeometry(spec.id) : GEO.body, bMat);
    this.body.scale.set(sx, sy, sz);
    this.body.position.y = 0.72 * yK;
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

    // --- eyes: round black DOT eyes (true spheres) + white catchlights,
    //     seated on the profile surface at ~60-70% body height ---
    const eMat = eyeMaterial();
    const hMat = highlightMaterial();
    const prof = spec.id ? PROFILES[spec.id] : null;
    let ely = 0.18; // eye height in body-local units (~62% of body height)
    let exB = 0.22 * xK; // bobber-space half spread
    let es = 0.095 * THREE.MathUtils.clamp((sx + sy) / 2 / 1.05, 0.7, 1.3);
    let elz; // front surface z at the eye, body-local
    let leanB = 0; // mango's sideways bulge at eye height, bobber-space
    if (spec.id === 'grape') {
      ely = 0.10; exB = 0.19 * xK; es *= 0.9;
      elz = _grapeFrontZ(exB / sx, ely) * sz;
    } else {
      if (spec.id === 'strawberry' || spec.id === 'pineapple') ely = 0.28;
      if (spec.id === 'mango') leanB = 0.09 * Math.sin(Math.PI * (ely + 0.75) / 1.5) * sx;
      const R = prof ? prof.radiusAt(ely)
        : 0.75 * Math.sqrt(Math.max(0.05, 1 - (ely / 0.75) * (ely / 0.75))); // legacy sphere
      const exL = exB / sx;
      elz = Math.sqrt(Math.max(0.0004, R * R - exL * exL)) * sz;
    }
    const esz = es * 0.53;
    const eyeWY = this.body.position.y + ely * sy;
    const eyeWZ = elz - es * 0.15; // slightly inset into the surface
    this._eyeBase = es;
    this._hlBase = 0.295 * es;
    this.eyeL = new THREE.Mesh(GEO.unit, eMat);
    this.eyeL.scale.set(es, es, esz);
    this.eyeL.position.set(-exB + leanB, eyeWY, eyeWZ);
    this.eyeR = new THREE.Mesh(GEO.unit, eMat);
    this.eyeR.scale.set(es, es, esz);
    this.eyeR.position.set(exB + leanB, eyeWY, eyeWZ);
    this.hlL = new THREE.Mesh(GEO.unit, hMat);
    this.hlL.scale.set(this._hlBase, this._hlBase, this._hlBase);
    this.hlL.position.set(-exB + leanB - 0.45 * es, eyeWY + 0.45 * es, eyeWZ + esz * 0.9);
    this.hlR = new THREE.Mesh(GEO.unit, hMat);
    this.hlR.scale.set(this._hlBase, this._hlBase, this._hlBase);
    this.hlR.position.set(exB + leanB - 0.45 * es, eyeWY + 0.45 * es, eyeWZ + esz * 0.9);
    this.bobber.add(this.eyeL, this.eyeR, this.hlL, this.hlR);

    // --- nub arms (grape has none — feet only, per the fruit spec) ---
    this.armL = null;
    this.armR = null;
    if (spec.id !== 'grape') {
      const aMat = bMat;
      const armK = THREE.MathUtils.clamp((sx + sy) / 2 / 1.05, 0.75, 1.3);
      this.armL = new THREE.Mesh(GEO.arm, aMat);
      this.armL.scale.setScalar(armK);
      this.armL.position.set(-0.78 * xK, 0.65 * yK, 0);
      this.armL.rotation.z = 0.25; // outward tilt (base)
      this.armL.castShadow = true;
      this.armR = new THREE.Mesh(GEO.arm, aMat);
      this.armR.scale.setScalar(armK);
      this.armR.position.set(0.78 * xK, 0.65 * yK, 0);
      this.armR.rotation.z = -0.25;
      this.armR.castShadow = true;
      this.bobber.add(this.armL, this.armR);
    }

    // --- feet (darker) ---
    this.footL = new THREE.Mesh(GEO.unit, dMat);
    this.footL.scale.set(0.22 * xK, 0.121 * yK, 0.264 * zK);
    this.footL.position.set(-0.32 * xK, 0.121 * yK, 0.12 * zK);
    this.footL.castShadow = true;
    this.footR = new THREE.Mesh(GEO.unit, dMat);
    this.footR.scale.set(0.22 * xK, 0.121 * yK, 0.264 * zK);
    this.footR.position.set(0.32 * xK, 0.121 * yK, 0.12 * zK);
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
    this.shadow.scale.set(xK, zK, 1);
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
    this.hitProxy.scale.set(xK, yK, zK);
    this.hitProxy.position.y = 0.85 * yK;
    this.hitProxy.visible = false;
    this.group.add(this.hitProxy);

    // --- public contract fields ---
    this.fruit = spec.id;      // fruit id, or null for a legacy plain blob
    this.topY = spec.topY;     // label-anchor height (per fruit)
    this._bs = spec.scale;     // body base scale [x,y,z]

    // --- per-fruit pose anchors (internal; the state machine is unchanged) ---
    this._yBase = 0.72 * yK;   // body rest center height
    this._sleepY = TUNE.sleepBodyY * yK;
    this._yK = yK;

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
    P.bodyY = this._yBase;
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
        P.bodyY = this._sleepY;
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
    const ey = this._eyeBase * pose.eyeY;
    this.eyeL.scale.y = ey;
    this.eyeR.scale.y = ey;
    // catchlights shrink with the eyes, hidden when nearly shut
    const clOn = pose.eyeY >= 0.3;
    this.hlL.visible = clOn;
    this.hlR.visible = clOn;
    if (clOn) {
      this.hlL.scale.y = this._hlBase * pose.eyeY;
      this.hlR.scale.y = this._hlBase * pose.eyeY;
    }
    if (this.armL) {
      this.armL.rotation.x = pose.armL;
      this.armR.rotation.x = pose.armR;
    }

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
        const headY = pose.bodyY + 0.75 * this._yK;
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
