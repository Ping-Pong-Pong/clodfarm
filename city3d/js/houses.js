/* TypePop City 3D — personality-distinct house exteriors (Worker: houses).
 *
 * buildHouseExterior(typeKey) -> { group, doorLocal, roofTopY, winMats,
 *   nightGlow, winTint, smokeTip }
 *   group:     THREE.Group, local +z is the FRONT (faces the plaza; main.js
 *              rotates the group so +z points at the plaza).
 *   doorLocal: Vector3 — door in local coords, always ~(0, 0, 2.7) so the
 *              existing doorPos = pos + dirC*2.7 math keeps working.
 *   roofTopY: top of the structure; pins/DOM labels anchor above it.
 *   winMats:   ALL window materials (front/back/both sides) for the night pass.
 *   nightGlow: extra emissive mats that pulse at night (lamps, string lights,
 *              moon/slit windows...).
 *   winTint:   per-personality night window emissive color (hex).
 *   smokeTip:  optional local Vector3 — chimney tip for daytime smoke puffs.
 *
 * Perf: module-level shared geometries; materials are per-house (colors
 * differ) but created once at build. No per-frame allocation here.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { typeByKey } from './types.js?v=3';

/* ---------------- shared geometry (module-level, cached) ---------------- */
const BOX   = new THREE.BoxGeometry(1, 1, 1);
const CYL   = new THREE.CylinderGeometry(1, 1, 1, 10);
const SPH   = new THREE.SphereGeometry(1, 10, 8);
const PLANE = new THREE.PlaneGeometry(1, 1);
const CIRC  = new THREE.CircleGeometry(0.5, 22);
const CONE  = new THREE.ConeGeometry(1, 1, 12);
const CONE4 = new THREE.ConeGeometry(1, 1, 4);
const TORUS = new THREE.TorusGeometry(1, 0.14, 8, 22);
const ROCK  = new THREE.DodecahedronGeometry(1, 0);
const POST  = new THREE.CylinderGeometry(0.09, 0.11, 1, 8);

/* ---------------- shared neutral materials ---------------- */
const woodMat  = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.85 });
const darkWood = new THREE.MeshStandardMaterial({ color: 0x4e3a24, roughness: 0.9 });
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf5f2ea, roughness: 0.85 });
const stoneMat = new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.95 });
const soilMat  = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
const leafMat  = new THREE.MeshStandardMaterial({ color: 0x4e8f4a, roughness: 0.9, flatShading: true });
const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.8 });

const std = (color, o = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...o });

/** Mesh helper: shared geo, scaled; shadows on for masses, off for tiny decor. */
function put(parent, geo, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, o = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  if (o.ry) m.rotation.y = o.ry;
  if (o.rx) m.rotation.x = o.rx;
  if (o.rz) m.rotation.z = o.rz;
  m.castShadow = o.cast !== false;
  m.receiveShadow = o.recv !== false;
  parent.add(m);
  return m;
}

/* ---------------- rounded-box helpers (less blocky) ---------------- */
/* Cached RoundedBoxGeometry per size: a fixed world-space corner radius
 * (clamped so thin pieces never break) — no scale distortion, unlike
 * scaling a unit rounded box. Segments kept at 2 for phone perf. */
const _rboxCache = new Map();
function rboxGeo(w, h, d, r) {
  const rad = Math.min(r, Math.min(w, h, d) * 0.45);
  const key = w.toFixed(2) + '|' + h.toFixed(2) + '|' + d.toFixed(2) + '|' + rad.toFixed(3);
  if (!_rboxCache.has(key))
    _rboxCache.set(key, new RoundedBoxGeometry(w, h, d, 2, rad));
  return _rboxCache.get(key);
}
/** Rounded-box twin of put(): same positioning, soft corners. o.r = radius (default 0.14). */
function rput(parent, mat, x = 0, y = 0, z = 0, w = 1, h = 1, d = 1, o = {}) {
  const m = new THREE.Mesh(rboxGeo(w, h, d, o.r !== undefined ? o.r : 0.14), mat);
  m.position.set(x, y, z);
  if (o.ry) m.rotation.y = o.ry;
  if (o.rx) m.rotation.x = o.rx;
  if (o.rz) m.rotation.z = o.rz;
  m.castShadow = o.cast !== false;
  m.receiveShadow = o.recv !== false;
  parent.add(m);
  return m;
}
/** Four vertical corner boards for a w x h x d body centered at local origin. */
function cornerBoards(parent, w, h, d, mat = whiteMat) {
  const hw = w / 2, hd = d / 2;
  [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(([x, z]) =>
    put(parent, BOX, mat, x, h / 2, z, 0.18, h, 0.18, { cast: false }));
}

/* ---------------- per-house build context ---------------- */
function makeCtx(tintHex) {
  const g = new THREE.Group();
  const winMats = [];
  const nightGlow = [];
  const tint = new THREE.Color(tintHex);
  // Window with frame. ry: 0 faces +z (front), PI faces -z (back), ±PI/2 sides.
  function win(x, y, z, w, h, ry = 0, kind = 'rect', glow = false) {
    const n = { x: Math.sin(ry), z: Math.cos(ry) }; // facing normal
    // frame box, half-embedded in the wall
    put(g, BOX, frameMat, x + n.x * 0.0, y, z + n.z * 0.0,
      w + 0.3, h + 0.3, 0.14, { ry });
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2c2620, emissive: tint.clone(),
      emissiveIntensity: 0.25, roughness: 0.35,
    });
    const geo = kind === 'round' ? CIRC : PLANE;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x + n.x * 0.085, y, z + n.z * 0.085);
    m.rotation.y = ry;
    m.scale.set(w, h, 1);
    g.add(m);
    winMats.push(mat);
    if (glow) nightGlow.push(mat);
    return mat;
  }
  // Door, tinted toward the type accent. Door front sits at z ≈ 2.65.
  function door(x, z, accentHex, w = 1.3, h = 2.4) {
    const c = new THREE.Color(accentHex).multiplyScalar(0.55);
    const mat = std(c, { roughness: 0.8 });
    // door frame + step: every doorway reads finished, not a slab in a wall
    put(g, BOX, frameMat, x, h / 2 + 0.05, z - 0.02, w + 0.34, h + 0.24, 0.1, { cast: false });
    put(g, BOX, stoneMat, x, 0.07, z + 0.35, w + 0.7, 0.14, 0.7, { cast: false, recv: true });
    put(g, BOX, mat, x, h / 2, z, w, h, 0.16);
    put(g, SPH, std(0xd8b25a, { roughness: 0.4, metalness: 0.5 }),
      x + w * 0.32, 1.1, z + 0.14, 0.07, 0.07, 0.07, { cast: false });
    return mat;
  }
  return { g, winMats, nightGlow, tint, win, door };
}

/* ---------------- roofs ---------------- */
function gableRoof(g, mat, w, d, h, y) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y; m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  // fascia boards: a finished eave edge front + back
  put(g, BOX, frameMat, 0, y + 0.08, d / 2 + 0.03, w + 0.4, 0.18, 0.12, { cast: false });
  put(g, BOX, frameMat, 0, y + 0.08, -d / 2 - 0.03, w + 0.4, 0.18, 0.12, { cast: false });
  return m;
}
function flatRoof(g, mat, w, d, y, over = 0.5, thick = 0.32) {
  return rput(g, mat, 0, y + thick / 2, 0, w + over * 2, thick, d + over * 2, { r: 0.06 });
}
function coneRoof(g, mat, x, y, z, r, h, seg4 = false) {
  return put(g, seg4 ? CONE4 : CONE, mat, x, y + h / 2, z, r, h, r,
    seg4 ? { ry: Math.PI / 4 } : {});
}
// Barrel roof: full cylinder sunk into the walls (lower half hidden inside).
// Squashed 0.55 vertically so the dome is a gentle arc, not a quonset hut.
function barrelRoof(g, mat, w, d, y) {
  return put(g, CYL, mat, 0, y, 0, w / 2, d, (w / 2) * 0.55, { rx: Math.PI / 2 });
}

/* ---------------- chimney (returns tip y) ---------------- */
function chimney(g, x, z, y0, h, mat = null) {
  const m = mat || std(0x8a6f5c, { roughness: 0.95, flatShading: true });
  put(g, BOX, m, x, y0 + h / 2, z, 0.9, h, 0.9);
  put(g, BOX, stoneMat, x, y0 + h + 0.08, z, 1.1, 0.16, 1.1);
  return y0 + h + 0.16;
}

/* ---------------- type-code sign (physical, by the door) ---------------- */
const _signTex = {};
function signTexture(code, nick) {
  if (_signTex[code]) return _signTex[code];
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const x = c.getContext('2d');
  x.fillStyle = '#6e4f2e'; x.fillRect(0, 0, 256, 160);
  x.strokeStyle = '#4a3419'; x.lineWidth = 10; x.strokeRect(5, 5, 246, 150);
  x.fillStyle = '#fff4dc'; x.textAlign = 'center';
  x.font = 'bold 62px system-ui, sans-serif';
  x.fillText(code, 128, 78);
  x.font = '26px system-ui, sans-serif'; x.fillStyle = '#ffe3ae';
  x.fillText(nick, 128, 122);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _signTex[code] = t;
  return t;
}
function addSign(g, code, nick, x = 2.55, z = 3.7, ry = 0.35) {
  put(g, POST, darkWood, x, 0.6, z, 1, 1.2, 1);
  const board = put(g, BOX, woodMat, x, 1.45, z, 1.75, 0.95, 0.09, { ry });
  const face = new THREE.Mesh(PLANE, new THREE.MeshStandardMaterial({
    map: signTexture(code, nick), roughness: 0.85,
  }));
  face.scale.set(1.62, 1.0, 1);
  face.position.set(x + Math.sin(ry) * 0.055, 1.45, z + Math.cos(ry) * 0.055);
  face.rotation.y = ry;
  g.add(face);
  return board;
}

/* ---------------- mailbox ---------------- */
function addMailbox(g, x, z, { roundTop = true, flag = false } = {}) {
  put(g, POST, darkWood, x, 0.5, z, 1, 1.0, 1);
  const boxMat = std(0x3f4a5a, { roughness: 0.7 });
  put(g, BOX, boxMat, x, 1.15, z, 0.5, 0.34, 0.72);
  if (roundTop) put(g, CYL, boxMat, x, 1.32, z, 0.25, 0.72, 0.25, { rx: Math.PI / 2 });
  else put(g, BOX, boxMat, x, 1.36, z, 0.54, 0.06, 0.76);
  put(g, BOX, darkWood, x, 1.0, z + 0.42, 0.12, 0.06, 0.2); // door flap hint
  if (flag) {
    put(g, BOX, std(0xd23c2e), x + 0.28, 1.5, z, 0.05, 0.5, 0.05, { cast: false });
    put(g, BOX, std(0xd23c2e), x + 0.28, 1.7, z + 0.12, 0.05, 0.16, 0.3, { cast: false });
  }
}

/* ---------------- walkways (local +z from the door toward the plaza) ---------------- */
const stoneWalkMat = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 1 });
const brickWalkMat = new THREE.MeshStandardMaterial({ color: 0xa86a4e, roughness: 1 });
function addWalkway(g, kind) {
  if (kind === 'stones') {
    [3.6, 5.0, 6.4, 7.8].forEach((z, i) =>
      put(g, CYL, stoneWalkMat, (i % 2 ? 0.28 : -0.28), 0.05, z, 0.5, 0.1, 0.42,
        { cast: false, recv: true }));
  } else if (kind === 'bricks') {
    [3.5, 4.7, 5.9, 7.1, 8.3].forEach((z) =>
      put(g, BOX, brickWalkMat, 0, 0.04, z, 1.7, 0.08, 1.0, { cast: false, recv: true }));
  }
}

/* ---------------- small yard helpers ---------------- */
const flowerCols = [0xff5a7a, 0xffd93d, 0xff8c69, 0xc77dff, 0xffffff, 0x4ecdc4];
function wildflowers(g, cx, cz, n, spread) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.4 + Math.random() * spread;
    put(g, SPH, std(flowerCols[i % flowerCols.length], { roughness: 0.7 }),
      cx + Math.cos(a) * r, 0.14, cz + Math.sin(a) * r,
      0.13, 0.13, 0.13, { cast: false, recv: false });
    put(g, CYL, leafMat, cx + Math.cos(a) * r, 0.07, cz + Math.sin(a) * r,
      0.03, 0.14, 0.03, { cast: false, recv: false });
  }
}
function bushRow(g, xs, z, r, mat = leafMat) {
  xs.forEach((x) => put(g, SPH, mat, x, r * 0.8, z, r, r * 0.85, r));
}
function flowerDots(g, xs, z, mat) {
  xs.forEach((x, i) => put(g, SPH, mat || std(flowerCols[i % 6]),
    x, 0.32, z, 0.11, 0.11, 0.11, { cast: false, recv: false }));
}

const DOOR_Z = 2.7;
function base(tintHex, accentHex) {
  const ctx = makeCtx(tintHex);
  ctx.accent = accentHex;
  return ctx;
}
function finish(ctx, key, roofTopY, smokeTip = null, extra = {}) {
  const t = typeByKey(key);
  addSign(ctx.g, t.name, t.nickname);
  return {
    group: ctx.g,
    doorLocal: new THREE.Vector3(0, 0, DOOR_Z),
    roofTopY,
    winMats: ctx.winMats,
    nightGlow: ctx.nightGlow,
    winTint: new THREE.Color(ctx.tint).getHex(),
    smokeTip,
    ...extra,
  };
}

/* ================= 16 personality builders ================= */

/* ---- ENFP (strawberry) — boho cottage: crooked walls, shutters, flower boxes, pinwheel ---- */
function bEnfp(key) {
  const c = base('#ffe9a8', '#FF8C69');
  const tilt = new THREE.Group();
  tilt.rotation.z = 0.035; tilt.rotation.y = -0.03; // slightly crooked
  c.g.add(tilt);
  const walls = std('#f6e3c8');
  rput(tilt, walls, 0, 2, 0, 6, 4, 5);
  cornerBoards(tilt, 6, 4, 5);
  gableRoof(tilt, std('#FF8C69', { flatShading: true }), 6.6, 5.6, 2.2, 4);
  // colorful shutters + flower boxes on the front windows
  const shutCols = [0x4ecdc4, 0xffd93d, 0xc77dff, 0x6d9dc5];
  [-1.75, 1.75].forEach((wx, i) => {
    put(tilt, BOX, std(shutCols[i]), wx - 0.85, 2.3, 2.52, 0.34, 1.3, 0.08, { cast: false });
    put(tilt, BOX, std(shutCols[i + 2]), wx + 0.85, 2.3, 2.52, 0.34, 1.3, 0.08, { cast: false });
    put(tilt, BOX, darkWood, wx, 1.55, 2.62, 1.5, 0.28, 0.3, { cast: false });
    flowerDots(tilt, [wx - 0.45, wx - 0.15, wx + 0.15, wx + 0.45], 2.62);
  });
  // pinwheel on a stick, front-right
  put(c.g, CYL, darkWood, 3.6, 1.1, 3.4, 0.05, 2.2, 0.05);
  const pw = new THREE.Group(); pw.position.set(3.6, 2.3, 3.4); c.g.add(pw);
  for (let i = 0; i < 4; i++) {
    const blade = put(pw, PLANE,
      new THREE.MeshStandardMaterial({ color: shutCols[i], side: THREE.DoubleSide, roughness: 0.7 }),
      0, 0, 0.02, 0.55, 0.55, 1, { cast: false, recv: false });
    blade.rotation.z = i * Math.PI / 2 + 0.4;
    blade.position.set(Math.cos(i * Math.PI / 2) * 0.28, Math.sin(i * Math.PI / 2) * 0.28, 0.02);
  }
  put(pw, SPH, std('#fff'), 0, 0, 0.05, 0.09, 0.09, 0.09, { cast: false });
  c.door(0, 2.56, c.accent);
  // windows ride the crooked tilt group so they lean with the walls
  const mkWin = (x, y, w, h) => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2c2620, emissive: c.tint.clone(), emissiveIntensity: 0.25, roughness: 0.35,
    });
    put(tilt, BOX, frameMat, x, y, 2.5, w + 0.3, h + 0.3, 0.14);
    const m = new THREE.Mesh(PLANE, mat);
    m.position.set(x, y, 2.585); m.scale.set(w, h, 1); tilt.add(m);
    c.winMats.push(mat);
  };
  mkWin(-1.75, 2.3, 1.1, 1.1);
  mkWin(1.75, 2.3, 1.1, 1.1);
  addWalkway(c.g, 'stones');
  wildflowers(c.g, -3.4, 4.6, 14, 2.2);
  wildflowers(c.g, 3.9, 5.2, 8, 1.4);
  addMailbox(c.g, -2.7, 4.4, { roundTop: true });
  return finish(c, key, 6.4);
}

/* ---- ENFJ (orange) — craftsman bungalow: wide porch, posts + railing, cream trim ---- */
function bEnfj(key) {
  const c = base('#ffd27a', '#FF6B6B');
  const walls = std('#f3e9d2');
  rput(c.g, walls, 0, 2, 0, 6, 4, 5);
  gableRoof(c.g, std('#8a5a44', { flatShading: true }), 7.0, 6.0, 1.8, 4);
  // cream corner trim
  [[-3.02, 0], [3.02, 0], [-3.02, -2.52], [3.02, -2.52]].forEach(([x, z]) =>
    put(c.g, BOX, whiteMat, x, 2, z + 1.26, 0.16, 4, 0.16, { cast: false }));
  // wide front porch: deck, 4 posts, railing, roof
  put(c.g, BOX, darkWood, 0, 0.25, 4.1, 6.6, 0.5, 3.2);
  [[-2.9], [2.9]].forEach(([x]) => {
    put(c.g, POST, whiteMat, x, 1.9, 5.35, 1.4, 2.8, 1.4);
    put(c.g, BOX, whiteMat, x, 3.35, 5.35, 0.24, 0.24, 0.24, { cast: false });
  });
  for (let i = -2; i <= 2; i++)
    put(c.g, BOX, whiteMat, i * 1.25, 1.05, 5.5, 0.1, 0.9, 0.1, { cast: false });
  put(c.g, BOX, whiteMat, 0, 1.55, 5.5, 6.4, 0.12, 0.14, { cast: false });
  put(c.g, BOX, std('#8a5a44'), 0, 3.6, 4.35, 7.0, 0.22, 3.0); // porch roof
  // porch lamp by the door -> nightGlow
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x443a2c, emissive: 0xffca7a, emissiveIntensity: 0.4, roughness: 0.5,
  });
  put(c.g, SPH, lampMat, 1.15, 2.6, 2.62, 0.14, 0.18, 0.14, { cast: false });
  c.nightGlow.push(lampMat);
  c.win(-1.75, 2.3, 2.57, 1.1, 1.1);
  c.win(1.75, 2.3, 2.57, 1.1, 1.1);
  c.win(-3.07, 2.3, 0, 1.1, 1.1, -Math.PI / 2);
  c.win(3.07, 2.3, 0, 1.1, 1.1, Math.PI / 2);
  c.win(0, 2.3, -2.57, 1.1, 1.1, Math.PI);
  c.door(0, 2.56, c.accent);
  addWalkway(c.g, 'bricks');
  bushRow(c.g, [-4.4, 4.4], 4.6, 0.7);
  addMailbox(c.g, 2.7, 4.4, { roundTop: false });
  return finish(c, key, 6.0);
}

/* ---- ENTJ (apple) — modernist glass box: sharp, big glass front, flat roof, slat fence ---- */
function bEntj(key) {
  const c = base('#cfe4ff', '#8B5CF6');
  const walls = std('#dfe3ea', { roughness: 0.6 });
  rput(c.g, walls, 0, 3, -0.6, 6, 6, 3.8); // tall body, set back
  flatRoof(c.g, std('#3a3f4a'), 6, 3.8, 6, 0.7);
  // big glass front: transparent plane + dark mullion grid
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xbfe0ff, transparent: true, opacity: 0.32,
    roughness: 0.15, metalness: 0.1,
  });
  const glass = new THREE.Mesh(PLANE, glassMat);
  glass.scale.set(5.4, 5.2, 1); glass.position.set(0, 3, 1.32); c.g.add(glass);
  const mull = std('#2c313c', { roughness: 0.5 });
  for (let i = -1; i <= 1; i++)
    put(c.g, BOX, mull, i * 1.8, 3, 1.34, 0.1, 5.2, 0.06, { cast: false });
  put(c.g, BOX, mull, 0, 3, 1.34, 5.4, 0.1, 0.06, { cast: false });
  // warm interior glow plane behind the glass -> nightGlow
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0x8a7a5a, emissive: 0xffd9a0, emissiveIntensity: 0.25, roughness: 0.9,
  });
  const inner = new THREE.Mesh(PLANE, innerMat);
  inner.scale.set(5.0, 4.8, 1); inner.position.set(0, 3, 0.4); c.g.add(inner);
  c.nightGlow.push(innerMat);
  // modern horizontal slat fence, one side
  put(c.g, POST, mull, -4.4, 0.7, 2.5, 1, 1.4, 1);
  put(c.g, POST, mull, -4.4, 0.7, 5.5, 1, 1.4, 1);
  for (let i = 0; i < 5; i++)
    put(c.g, BOX, darkWood, -4.4, 0.35 + i * 0.26, 4.0, 0.08, 0.16, 3.1, { cast: false });
  c.win(-2.2, 4.4, -2.57, 1.0, 1.0, Math.PI); // back window (body back face at z=-2.5)
  c.door(0, 1.36, '#8B5CF6', 1.5, 2.6); // minimal dark panel on the glass
  addWalkway(c.g, 'bricks');
  addMailbox(c.g, 2.7, 3.4, { roundTop: false });
  return finish(c, key, 6.6);
}

/* ---- ENTP (lemon) — wacky tilted house: whole body leans 8°, rooftop antenna ---- */
function bEntp(key) {
  const c = base('#ffdca8', '#F59E0B');
  const lean = new THREE.Group();
  lean.rotation.z = 0.14; // ~8° tilt
  lean.position.y = 0.35;
  c.g.add(lean);
  rput(lean, std('#f7e9b0'), 0, 1.75, 0, 5.6, 3.5, 4.6);
  gableRoof(lean, std('#F59E0B', { flatShading: true }), 6.2, 5.2, 2.0, 3.5);
  // crooked windows (slightly rotated rects), riding the leaning group
  const mkWin = (x, y, z, w, h, rz) => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2c2620, emissive: c.tint.clone(), emissiveIntensity: 0.25, roughness: 0.35,
    });
    put(lean, BOX, frameMat, x, y, z, w + 0.3, h + 0.3, 0.14);
    const m = new THREE.Mesh(PLANE, mat);
    m.position.set(x, y, z + 0.085); m.scale.set(w, h, 1); m.rotation.z = rz;
    lean.add(m); c.winMats.push(mat);
  };
  mkWin(-1.55, 2.0, 2.32, 1.0, 1.0, 0.1);
  mkWin(1.55, 2.2, 2.32, 1.0, 1.0, -0.12);
  mkWin(0, 2.1, -2.32, 1.2, 1.0, 0.08);
  // door on the leaning body
  put(lean, BOX, std(new THREE.Color(c.accent).multiplyScalar(0.55)),
    0, 1.05, 2.32, 1.3, 2.1, 0.16);
  // rooftop antenna: thin cylinder + dish
  put(lean, CYL, darkWood, 1.8, 6.4, -0.8, 0.05, 2.4, 0.05);
  put(lean, CONE, std('#c8ccd4', { roughness: 0.5, metalness: 0.4 }),
    1.8, 7.5, -0.8, 0.55, 0.4, 0.55, { rx: Math.PI / 3 });
  put(lean, SPH, std('#ff5a5a'), 1.8, 7.75, -0.8, 0.08, 0.08, 0.08, { cast: false });
  addWalkway(c.g, 'stones');
  addMailbox(c.g, -2.7, 4.4, { roundTop: true });
  return finish(c, key, 8.0);
}

/* ---- ESTJ (pineapple) — colonial brick: symmetrical, white columns, flag, weathervane ---- */
function bEstj(key) {
  const c = base('#ffdca8', '#4A5F8A');
  const brick = std('#9e5b4a', { roughness: 0.95 });
  rput(c.g, brick, 0, 2, 0, 6, 4, 5);
  gableRoof(c.g, std('#5a4638', { flatShading: true }), 6.6, 5.6, 2.2, 4);
  // white portico: 4 columns + pediment
  [[-2.2], [-0.75], [0.75], [2.2]].forEach(([x]) =>
    put(c.g, CYL, whiteMat, x, 1.75, 3.6, 0.22, 3.5, 0.22));
  put(c.g, BOX, whiteMat, 0, 3.6, 3.6, 5.6, 0.3, 1.6);
  const tri = new THREE.Shape();
  tri.moveTo(-2.8, 0); tri.lineTo(2.8, 0); tri.lineTo(0, 1.1); tri.closePath();
  const triGeo = new THREE.ExtrudeGeometry(tri, { depth: 1.5, bevelEnabled: false });
  triGeo.translate(0, 0, -0.75);
  const ped = new THREE.Mesh(triGeo, whiteMat);
  ped.position.set(0, 3.75, 3.6); ped.castShadow = true; c.g.add(ped);
  // symmetrical shuttered windows
  [-1.75, 1.75].forEach((wx) => {
    c.win(wx, 2.3, 2.57, 1.1, 1.2);
    put(c.g, BOX, whiteMat, wx - 0.85, 2.3, 2.54, 0.3, 1.4, 0.06, { cast: false });
    put(c.g, BOX, whiteMat, wx + 0.85, 2.3, 2.54, 0.3, 1.4, 0.06, { cast: false });
  });
  c.win(-3.07, 2.3, 0, 1.1, 1.2, -Math.PI / 2);
  c.win(3.07, 2.3, 0, 1.1, 1.2, Math.PI / 2);
  c.win(0, 2.3, -2.57, 1.1, 1.2, Math.PI);
  c.door(0, 2.56, '#4A5F8A');
  // flag pole + waving-ish flag
  put(c.g, CYL, std('#c8ccd4', { metalness: 0.5, roughness: 0.4 }), -3.8, 2.6, 4.6, 0.06, 5.2, 0.06);
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0xd23c2e, side: THREE.DoubleSide, roughness: 0.8,
  });
  put(c.g, PLANE, flagMat, -3.35, 4.7, 4.6, 0.9, 0.55, 1, { cast: false, ry: 0.25 });
  put(c.g, SPH, std('#d8b25a', { metalness: 0.6, roughness: 0.4 }),
    -3.8, 5.25, 4.6, 0.09, 0.09, 0.09, { cast: false });
  // weathervane on the roof
  put(c.g, CYL, darkWood, 0, 6.9, 0, 0.04, 1.0, 0.04);
  put(c.g, PLANE, std('#3a3a3a', { side: THREE.DoubleSide }),
    0, 7.25, 0, 0.9, 0.18, 1, { cast: false, ry: 0.6 });
  put(c.g, CONE, std('#3a3a3a'), 0.5, 7.25, 0.29, 0.09, 0.22, 0.09,
    { cast: false, rz: -Math.PI / 2, ry: 0.6 });
  addWalkway(c.g, 'bricks');
  bushRow(c.g, [-4.6, -3.6, 3.6, 4.6], 4.4, 0.55);
  // trimmed cone topiaries flanking the door
  put(c.g, CONE, leafMat, -1.9, 0.75, 3.1, 0.5, 1.5, 0.5);
  put(c.g, CONE, leafMat, 1.9, 0.75, 3.1, 0.5, 1.5, 0.5);
  addMailbox(c.g, 2.7, 4.4, { roundTop: false, flag: true });
  return finish(c, key, 7.4);
}

/* ---- ESFJ (cherry) — cozy cottage: big glowing kitchen window, garden bed, hedge fence ---- */
function bEsfj(key) {
  const c = base('#ffd27a', '#FFB59E');
  rput(c.g, std('#f7e8d8'), 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  gableRoof(c.g, std('#c96f5a', { flatShading: true }), 6.6, 5.6, 2.2, 4);
  // BIG glowing kitchen window (wide, warm) -> nightGlow
  const km = c.win(-1.5, 2.2, 2.57, 2.4, 1.5, 0, 'rect', true);
  c.win(1.9, 2.4, 2.57, 0.9, 0.9);
  c.win(-3.07, 2.3, 0, 1.0, 1.0, -Math.PI / 2);
  c.win(3.07, 2.3, 0, 1.0, 1.0, Math.PI / 2);
  c.win(0, 2.3, -2.57, 1.2, 1.0, Math.PI);
  // window cross mullions on the big window
  put(c.g, BOX, frameMat, -1.5, 2.2, 2.6, 0.08, 1.5, 0.05, { cast: false });
  put(c.g, BOX, frameMat, -1.5, 2.2, 2.6, 2.4, 0.08, 0.05, { cast: false });
  // porch lamp
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x443a2c, emissive: 0xffca7a, emissiveIntensity: 0.4, roughness: 0.5,
  });
  put(c.g, SPH, lampMat, 1.15, 2.6, 2.62, 0.14, 0.18, 0.14, { cast: false });
  c.nightGlow.push(lampMat);
  c.door(0.6, 2.56, c.accent);
  // neat garden bed: soil box + green dots
  put(c.g, BOX, soilMat, -3.6, 0.18, 4.4, 2.6, 0.36, 1.2);
  flowerDots(c.g, [-4.4, -4.0, -3.6, -3.2, -2.8], 4.4, leafMat);
  flowerDots(c.g, [-4.2, -3.8, -3.4, -3.0], 4.75, std('#ff8c69'));
  // hedge fence along the front
  for (let i = 0; i < 5; i++)
    put(c.g, BOX, leafMat, -4.4 + i * 1.35, 0.5, 6.4, 1.25, 1.0, 0.6);
  const tipY = chimney(c.g, 1.9, -1.2, 4.6, 1.8);
  addWalkway(c.g, 'stones');
  addMailbox(c.g, 2.7, 4.4, { roundTop: true });
  return finish(c, key, 6.6,
    new THREE.Vector3(1.9, tipY + 0.1, -1.2));
}

/* ---- ESTP (mango) — surf shack: open front, posts + roof, surfboard, sand ---- */
function bEstp(key) {
  const c = base('#ffdca8', '#FF5A3C');
  const plank = std('#b99f7a', { roughness: 1 });
  // back + side walls only — the front is OPEN
  put(c.g, BOX, plank, 0, 2, -2.5, 6, 4, 0.3);
  put(c.g, BOX, plank, -3, 2, 0, 0.3, 4, 5);
  put(c.g, BOX, plank, 3, 2, 0, 0.3, 4, 5);
  // plank siding lines on the back wall
  for (let i = 0; i < 5; i++)
    put(c.g, BOX, darkWood, 0, 0.8 + i * 0.7, -2.32, 5.9, 0.06, 0.04, { cast: false });
  // 4 front posts + slanted roof
  [[-2.8], [-0.95], [0.95], [2.8]].forEach(([x]) =>
    put(c.g, CYL, darkWood, x, 1.75, 2.4, 0.14, 3.5, 0.14));
  const roof = put(c.g, BOX, std('#7a6a55', { flatShading: true }),
    0, 4.05, 0.2, 7.0, 0.25, 6.2, { rx: 0.1 });
  // hanging sign plank
  put(c.g, BOX, woodMat, 0, 3.0, 2.45, 2.2, 0.5, 0.08, { cast: false });
  // surfboard leaning by the door — bright
  const boardMat = std('#FF5A3C', { roughness: 0.5 });
  put(c.g, BOX, boardMat, 2.1, 1.15, 2.9, 0.55, 2.3, 0.12, { rz: -0.28, cast: true });
  put(c.g, BOX, whiteMat, 2.1, 1.15, 2.97, 0.18, 2.1, 0.02, { rz: -0.28, cast: false });
  // life ring on a post
  put(c.g, TORUS, std('#f5f2ea'), -2.5, 2.0, 2.45, 0.42, 0.42, 0.42, { cast: false });
  // tiki torch -> nightGlow
  put(c.g, CYL, darkWood, -3.4, 0.8, 3.2, 0.06, 1.6, 0.06);
  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xff9a3c, emissive: 0xff8c2e, emissiveIntensity: 0.8, roughness: 0.6,
  });
  put(c.g, SPH, flameMat, -3.4, 1.75, 3.2, 0.14, 0.2, 0.14, { cast: false, recv: false });
  c.nightGlow.push(flameMat);
  // door frame between posts (open shack still has a door)
  c.door(0, 2.45, c.accent);
  c.win(0, 2.4, -2.62, 1.6, 1.1, Math.PI);
  // sand patch yard
  put(c.g, CYL, std('#e8d9a8', { roughness: 1 }), 0, 0.03, 5.6, 3.4, 0.06, 2.6,
    { cast: false, recv: true });
  addMailbox(c.g, -2.7, 4.4, { roundTop: true });
  return finish(c, key, 4.4);
}

/* ---- ESFP (watermelon) — party house: bright paint, striped awning, string lights ---- */
function bEsfp(key) {
  const c = base('#ffe9a8', '#FFD93D');
  rput(c.g, std('#FFD93D', { roughness: 0.85 }), 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  flatRoof(c.g, std('#ff5a3c', { flatShading: true }), 6, 5, 4, 0.6);
  // bold striped awning over the door (canvas stripe texture, shared)
  const awnTex = (() => {
    if (bEsfp._t) return bEsfp._t;
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32;
    const x = cv.getContext('2d');
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#f5f2ea' : '#ff5a3c'; x.fillRect(i * 16, 0, 16, 32); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    bEsfp._t = t; return t;
  })();
  const awn = put(c.g, BOX,
    new THREE.MeshStandardMaterial({ map: awnTex, roughness: 0.85 }),
    0, 3.15, 3.1, 2.6, 0.12, 1.4, { rx: 0.28 });
  void awn;
  // string lights: catenary of small emissive spheres from awning to posts
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff2c8, emissive: 0xffd76a, emissiveIntensity: 0.5, roughness: 0.4,
  });
  c.nightGlow.push(bulbMat);
  const strand = (x0, x1) => {
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      const x = x0 + (x1 - x0) * u;
      const y = 3.1 - Math.sin(u * Math.PI) * 0.55;
      put(c.g, SPH, bulbMat, x, y, 3.9, 0.09, 0.09, 0.09, { cast: false, recv: false });
    }
  };
  strand(-3.2, 3.2);
  put(c.g, POST, darkWood, -3.3, 1.5, 3.9, 1, 3.0, 1);
  put(c.g, POST, darkWood, 3.3, 1.5, 3.9, 1, 3.0, 1);
  // round-ish playful windows with pink frames
  c.win(-1.9, 2.4, 2.57, 1.1, 1.1, 0, 'round');
  c.win(1.9, 2.4, 2.57, 1.1, 1.1, 0, 'round');
  c.win(-3.07, 2.3, 0, 1.0, 1.0, -Math.PI / 2);
  c.win(3.07, 2.3, 0, 1.0, 1.0, Math.PI / 2);
  c.win(0, 2.3, -2.57, 1.2, 1.0, Math.PI);
  c.door(0, 2.56, '#d63c6e');
  addWalkway(c.g, 'stones');
  wildflowers(c.g, -4.2, 4.8, 10, 1.6); // confetti-flower bed
  addMailbox(c.g, 2.7, 4.4, { roundTop: false });
  return finish(c, key, 4.6);
}

/* ---- INFJ (blueberry) — mystic narrow tower: tall thin box, moon window, cone spire ---- */
function bInfj(key) {
  const c = base('#ffdca8', '#6D9DC5');
  const walls = std('#4a5a7a', { roughness: 0.9 });
  rput(c.g, walls, 0, 5, 0, 4, 10, 4);
  cornerBoards(c.g, 4, 10, 4, frameMat);
  coneRoof(c.g, std('#2e3a52', { flatShading: true }), 0, 10, 0, 3.1, 2.6, true);
  // round moon window near the top -> nightGlow
  const moonMat = c.win(0, 8.2, 2.02, 1.3, 1.3, 0, 'round', true);
  // tiny round windows climbing the shaft
  c.win(0, 5.6, 2.02, 0.7, 0.7, 0, 'round');
  c.win(-2.02, 3.4, 0.8, 0.7, 0.7, -Math.PI / 2, 'round');
  c.win(2.02, 6.4, -0.8, 0.7, 0.7, Math.PI / 2, 'round');
  c.win(0, 4.2, -2.02, 0.9, 0.9, Math.PI, 'round');
  c.door(0, 2.06, '#6D9DC5', 1.1, 2.2);
  // crescent accent on the moon window
  put(c.g, CIRC, std('#fff3c4', { emissive: 0xffedb8, emissiveIntensity: 0.4 }),
    0.25, 8.35, 2.12, 0.5, 0.5, 1, { cast: false, recv: false });
  // dark stone circle yard
  put(c.g, CYL, std('#3a3f52', { roughness: 1 }), 0, 0.03, 5.4, 2.6, 0.06, 2.0,
    { cast: false, recv: true });
  addWalkway(c.g, 'stones');
  addMailbox(c.g, 2.7, 4.4, { roundTop: true });
  return finish(c, key, 12.8);
}

/* ---- INFP (peach) — dreamy cottage: barrel roof, round windows, climbing vines, smoke ---- */
function bInfp(key) {
  const c = base('#ffd27a', '#A8E6CF');
  const walls = std('#f6dcc8');
  rput(c.g, walls, 0, 1.9, 0, 6, 3.8, 5);
  cornerBoards(c.g, 6, 3.8, 5);
  barrelRoof(c.g, std('#b78a6e', { flatShading: true }), 6.6, 5.6, 3.8);
  // round windows everywhere
  c.win(-1.75, 2.2, 2.57, 1.15, 1.15, 0, 'round');
  c.win(1.75, 2.2, 2.57, 1.15, 1.15, 0, 'round');
  c.win(-3.07, 2.1, 0, 0.9, 0.9, -Math.PI / 2, 'round');
  c.win(3.07, 2.1, 0, 0.9, 0.9, Math.PI / 2, 'round');
  c.win(0, 2.1, -2.57, 1.0, 1.0, Math.PI, 'round');
  c.door(0, 2.56, '#A8E6CF', 1.25, 2.3);
  // climbing vines: green torus arcs + leaf spheres up the front wall
  const vineMat = std('#5a9a5a', { roughness: 0.9 });
  [[-2.6, 1.2], [2.7, 1.6], [-2.2, 2.6]].forEach(([x, y]) => {
    put(c.g, TORUS, vineMat, x, y, 2.56, 0.55, 0.55, 0.55, { cast: false });
    put(c.g, SPH, leafMat, x + 0.4, y + 0.5, 2.58, 0.14, 0.14, 0.14, { cast: false });
    put(c.g, SPH, leafMat, x - 0.45, y - 0.3, 2.58, 0.12, 0.12, 0.12, { cast: false });
  });
  // winding stone path
  [3.6, 5.0, 6.4, 7.8].forEach((z, i) =>
    put(c.g, CYL, stoneWalkMat, Math.sin(i * 1.4) * 0.5, 0.05, z, 0.5, 0.1, 0.42,
      { cast: false, recv: true }));
  wildflowers(c.g, 3.8, 4.8, 9, 1.5);
  const tipY = chimney(c.g, -1.9, -1.2, 4.4, 1.6);
  addMailbox(c.g, -2.7, 4.4, { roundTop: false });
  return finish(c, key, 5.6,
    new THREE.Vector3(-1.9, tipY + 0.1, -1.2));
}

/* ---- INTJ (plum) — minimalist dark monolith: ONE slit window, zen rock garden ---- */
function bIntj(key) {
  const c = base('#cfe4ff', '#3B4A6B');
  const walls = std('#232838', { roughness: 0.7 });
  rput(c.g, walls, 0, 4, 0, 5, 8, 5, { r: 0.06 });
  flatRoof(c.g, std('#161a24'), 5, 5, 8, 0.35);
  // ONE vertical slit window -> nightGlow (cool blue-white)
  const slitMat = new THREE.MeshStandardMaterial({
    color: 0x1a2030, emissive: c.tint.clone(), emissiveIntensity: 0.4, roughness: 0.3,
  });
  put(c.g, BOX, slitMat, 0.8, 4.5, 2.52, 0.28, 4.2, 0.1, { cast: false });
  c.winMats.push(slitMat); c.nightGlow.push(slitMat);
  c.door(-1.2, 2.56, '#3B4A6B', 1.2, 2.3);
  // zen rock garden: raked gravel disc + 3 rocks, off to the side
  put(c.g, CYL, std('#c9c4b8', { roughness: 1 }), 4.6, 0.04, 4.2, 2.6, 0.08, 2.2,
    { cast: false, recv: true });
  const rockMat = std('#8a8a86', { flatShading: true, roughness: 1 });
  put(c.g, ROCK, rockMat, 3.9, 0.35, 3.7, 0.55, 0.45, 0.5);
  put(c.g, ROCK, rockMat, 5.2, 0.28, 4.4, 0.4, 0.32, 0.38);
  put(c.g, ROCK, rockMat, 4.6, 0.5, 5.0, 0.7, 0.6, 0.62);
  addMailbox(c.g, -2.7, 4.4, { roundTop: false });
  return finish(c, key, 8.5);
}

/* ---- INTP (lime) — workshop/lab: clutter, pipes, telescope dome on the roof ---- */
function bIntp(key) {
  const c = base('#cfe4ff', '#8B9BB4');
  const walls = std('#cfd6c8', { roughness: 0.9 });
  rput(c.g, walls, 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  flatRoof(c.g, std('#6b7280'), 6, 5, 4, 0.5);
  // telescope dome: half-sphere sunk into the roof + angled telescope
  put(c.g, SPH, std('#b8bec8', { roughness: 0.5, metalness: 0.3 }),
    -1.4, 4.35, -0.8, 1.1, 1.1, 1.1);
  put(c.g, CYL, darkWood, -1.4, 5.5, -0.8, 0.1, 1.6, 0.1, { rx: 0.7 });
  put(c.g, CYL, std('#3a3f4a'), -1.4, 6.15, -1.25, 0.16, 1.1, 0.16, { rx: 0.7 });
  put(c.g, CYL, std('#8B9BB4'), -1.4, 6.6, -1.6, 0.2, 0.35, 0.2, { rx: 0.7 });
  // odd pipes on the wall
  const pipeMat = std('#9a8a6a', { metalness: 0.4, roughness: 0.5 });
  put(c.g, CYL, pipeMat, 2.2, 2.8, 2.55, 0.12, 2.4, 0.12);
  put(c.g, CYL, pipeMat, 2.2, 1.7, 2.2, 0.12, 1.0, 0.12, { rx: Math.PI / 2 });
  put(c.g, SPH, pipeMat, 2.2, 4.0, 2.55, 0.16, 0.16, 0.16, { cast: false });
  // clutter crates outside
  const crate = std('#a8895a', { roughness: 1 });
  put(c.g, BOX, crate, -3.6, 0.4, 3.4, 0.9, 0.8, 0.9);
  put(c.g, BOX, crate, -3.5, 1.15, 3.3, 0.7, 0.6, 0.7, { ry: 0.3 });
  put(c.g, BOX, crate, 3.7, 0.3, 4.1, 0.7, 0.6, 0.7, { ry: -0.2 });
  put(c.g, CYL, pipeMat, 3.7, 0.85, 4.1, 0.3, 0.5, 0.3);
  // one square + one porthole window
  c.win(-1.6, 2.5, 2.57, 1.0, 1.0);
  c.win(1.6, 2.5, 2.57, 0.8, 0.8, 0, 'round');
  c.win(0, 2.3, -2.57, 1.1, 1.0, Math.PI);
  c.door(0, 2.56, '#8B9BB4');
  // dirt patch instead of a walkway
  put(c.g, CYL, std('#a8896a', { roughness: 1 }), 0, 0.02, 5.6, 2.4, 0.05, 2.2,
    { cast: false, recv: true });
  addMailbox(c.g, 2.7, 4.4, { roundTop: true });
  return finish(c, key, 6.9);
}

/* ---- ISFJ (grape) — tidy cottage: white picket fence, flower rows, smoke ---- */
function bIsfj(key) {
  const c = base('#ffd27a', '#E8B84B');
  rput(c.g, std('#f2ead8'), 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  gableRoof(c.g, std('#b08a5a', { flatShading: true }), 6.6, 5.6, 2.2, 4);
  c.win(-1.75, 2.3, 2.57, 1.1, 1.1);
  c.win(1.75, 2.3, 2.57, 1.1, 1.1);
  c.win(-3.07, 2.3, 0, 1.0, 1.0, -Math.PI / 2);
  c.win(3.07, 2.3, 0, 1.0, 1.0, Math.PI / 2);
  c.win(0, 2.3, -2.57, 1.1, 1.0, Math.PI);
  c.door(0, 2.56, c.accent);
  // white picket fence around the front garden (gap at the walkway)
  const fenceZ = 5.6;
  for (let x = -4.2; x <= 4.2; x += 0.62) {
    if (Math.abs(x) < 1.1) continue; // walkway gap
    put(c.g, BOX, whiteMat, x, 0.55, fenceZ, 0.14, 1.0, 0.06, { cast: false });
    put(c.g, CONE4, whiteMat, x, 1.12, fenceZ, 0.1, 0.18, 0.1, { cast: false, ry: Math.PI / 4 });
  }
  put(c.g, BOX, whiteMat, -2.65, 0.8, fenceZ, 3.2, 0.1, 0.06, { cast: false });
  put(c.g, BOX, whiteMat, 2.65, 0.8, fenceZ, 3.2, 0.1, 0.06, { cast: false });
  put(c.g, BOX, whiteMat, -2.65, 0.45, fenceZ, 3.2, 0.1, 0.06, { cast: false });
  put(c.g, BOX, whiteMat, 2.65, 0.45, fenceZ, 3.2, 0.1, 0.06, { cast: false });
  // neat flower rows inside the fence
  flowerDots(c.g, [-3.4, -2.9, -2.4, -1.9, 1.9, 2.4, 2.9, 3.4], 4.6);
  flowerDots(c.g, [-3.15, -2.65, -2.15, 2.15, 2.65, 3.15], 4.15, std('#ffffff'));
  const tipY = chimney(c.g, 1.9, -1.2, 4.6, 1.8);
  addWalkway(c.g, 'bricks');
  addMailbox(c.g, -2.7, 4.6, { roundTop: false });
  return finish(c, key, 6.6,
    new THREE.Vector3(1.9, tipY + 0.1, -1.2));
}

/* ---- ISFP (kiwi) — art studio: paint splatter, easel, sculpture corner ---- */
function bIsfp(key) {
  const c = base('#ffdca8', '#4ECDC4');
  rput(c.g, std('#e8f0f2', { roughness: 0.9 }), 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  flatRoof(c.g, std('#4ECDC4'), 6, 5, 4, 0.6);
  // big north-light studio window on the side
  c.win(-3.07, 2.4, 0.4, 1.8, 2.0, -Math.PI / 2);
  c.win(1.9, 2.4, 2.57, 1.0, 1.0);
  c.win(-1.9, 2.4, 2.57, 1.0, 1.0);
  c.win(0, 2.3, -2.57, 1.2, 1.0, Math.PI);
  c.door(0, 2.56, '#4ECDC4');
  // paint-splatter dots on the front wall
  const splat = [0xff5a7a, 0xffd93d, 0x4ecdc4, 0xc77dff, 0xff8c69];
  for (let i = 0; i < 12; i++)
    put(c.g, SPH, std(splat[i % 5]),
      -2.6 + Math.random() * 5.2, 0.8 + Math.random() * 2.4, 2.56,
      0.06 + Math.random() * 0.07, 0.06 + Math.random() * 0.07, 0.05,
      { cast: false, recv: false });
  // easel outside: 3 legs + canvas with an abstract blob painting
  const ex = 3.9, ez = 3.6;
  put(c.g, CYL, woodMat, ex - 0.35, 0.9, ez, 0.05, 1.9, 0.05, { rz: 0.18 });
  put(c.g, CYL, woodMat, ex + 0.35, 0.9, ez, 0.05, 1.9, 0.05, { rz: -0.18 });
  put(c.g, CYL, woodMat, ex, 0.85, ez - 0.3, 0.05, 1.8, 0.05, { rx: -0.25 });
  const artTex = (() => {
    if (bIsfp._t) return bIsfp._t;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const x = cv.getContext('2d');
    x.fillStyle = '#f5f2ea'; x.fillRect(0, 0, 64, 64);
    const cols = ['#ff8c69', '#4ecdc4', '#8b5cf6', '#ffd93d'];
    for (let i = 0; i < 5; i++) {
      x.fillStyle = cols[i % 4]; x.beginPath();
      x.ellipse(12 + Math.random() * 40, 12 + Math.random() * 40,
        6 + Math.random() * 9, 5 + Math.random() * 8, Math.random(), 0, 7);
      x.fill();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    bIsfp._t = t; return t;
  })();
  put(c.g, PLANE, new THREE.MeshStandardMaterial({ map: artTex, roughness: 0.9 }),
    ex, 1.55, ez + 0.12, 1.1, 1.3, 1, { rx: -0.1, cast: false });
  // sculpture corner: abstract stacked shapes on a plinth
  put(c.g, BOX, stoneMat, -4.2, 0.25, 4.6, 1.1, 0.5, 1.1);
  put(c.g, TORUS, std('#ff5a7a'), -4.2, 1.0, 4.6, 0.34, 0.34, 0.34, { rx: 0.5 });
  put(c.g, BOX, std('#4ecdc4'), -4.2, 1.55, 4.6, 0.4, 0.4, 0.4, { ry: 0.5 });
  put(c.g, SPH, std('#ffd93d'), -4.2, 2.0, 4.6, 0.24, 0.24, 0.24);
  addWalkway(c.g, 'stones');
  addMailbox(c.g, 2.7, 4.4, { roundTop: true });
  return finish(c, key, 4.6);
}

/* ---- ISTJ (coconut) — log cabin: stacked log cylinders, stone chimney, veg rows ---- */
function bIstj(key) {
  const c = base('#ffdca8', '#7B8BA3');
  const logMat = std('#8a6a48', { roughness: 1 });
  const logEnd = std('#6e5236', { roughness: 1 });
  // stacked horizontal logs (front/back faces show the log ends)
  for (let i = 0; i < 7; i++) {
    const y = 0.35 + i * 0.55;
    put(c.g, CYL, logMat, 0, y, 2.32, 0.28, 6.2, 0.28, { rz: Math.PI / 2 });
    put(c.g, CYL, logMat, 0, y, -2.32, 0.28, 6.2, 0.28, { rz: Math.PI / 2 });
    put(c.g, CYL, logMat, -2.95, y, 0, 0.28, 5.0, 0.28, { rx: Math.PI / 2 });
    put(c.g, CYL, logMat, 2.95, y, 0, 0.28, 5.0, 0.28, { rx: Math.PI / 2 });
  }
  // log-end caps on the front
  for (let i = 0; i < 7; i++) {
    const y = 0.35 + i * 0.55;
    put(c.g, CYL, logEnd, -3.12, y, 2.32, 0.29, 0.06, 0.29, { rz: Math.PI / 2, cast: false });
    put(c.g, CYL, logEnd, 3.12, y, 2.32, 0.29, 0.06, 0.29, { rz: Math.PI / 2, cast: false });
  }
  gableRoof(c.g, std('#5a4638', { flatShading: true }), 7.0, 6.0, 2.2, 4.0);
  // small square windows with cross frames
  [[-1.75], [1.75]].forEach(([wx]) => {
    c.win(wx, 2.3, 2.62, 0.9, 0.9);
    put(c.g, BOX, frameMat, wx, 2.3, 2.64, 0.07, 0.9, 0.04, { cast: false });
    put(c.g, BOX, frameMat, wx, 2.3, 2.64, 0.9, 0.07, 0.04, { cast: false });
  });
  c.win(-3.24, 2.3, 0, 0.9, 0.9, -Math.PI / 2);
  c.win(3.24, 2.3, 0, 0.9, 0.9, Math.PI / 2);
  c.win(0, 2.3, -2.62, 0.9, 0.9, Math.PI);
  c.door(0, 2.56, '#5a4632', 1.25, 2.3); // solid wood door
  // solid stone chimney (gray box) -> smoke
  const tipY = chimney(c.g, 1.9, -1.2, 4.6, 2.0, stoneMat);
  // ruler-straight vegetable rows
  for (let r = 0; r < 3; r++) {
    const z = 4.3 + r * 1.1;
    put(c.g, BOX, soilMat, -4.1, 0.16, z, 1.9, 0.32, 0.8);
    for (let i = 0; i < 5; i++)
      put(c.g, SPH, leafMat, -4.85 + i * 0.38, 0.42, z, 0.13, 0.15, 0.13,
        { cast: false, recv: false });
  }
  addMailbox(c.g, 2.7, 4.4, { roundTop: false, flag: true });
  return finish(c, key, 6.4,
    new THREE.Vector3(1.9, tipY + 0.1, -1.2));
}

/* ---- ISTP (avocado) — garage workshop: big paneled garage door, workbench, tools ---- */
function bIstp(key) {
  const c = base('#ffdca8', '#8A9A5B');
  rput(c.g, std('#b8b0a0', { roughness: 0.95 }), 0, 2, 0, 6, 4, 5);
  cornerBoards(c.g, 6, 4, 5);
  flatRoof(c.g, std('#4a4a4a'), 6, 5, 4, 0.7);
  // big paneled garage door (the "front door")
  const gdMat = std('#8A9A5B', { roughness: 0.8 });
  put(c.g, BOX, gdMat, 0, 1.5, 2.52, 3.6, 3.0, 0.14);
  for (let i = 0; i < 4; i++)
    put(c.g, BOX, frameMat, 0, 0.6 + i * 0.75, 2.6, 3.6, 0.05, 0.03, { cast: false });
  put(c.g, BOX, frameMat, 0, 1.5, 2.6, 0.05, 3.0, 0.03, { cast: false });
  // high small square windows
  c.win(-2.0, 3.2, 2.57, 0.8, 0.8);
  c.win(2.0, 3.2, 2.57, 0.8, 0.8);
  c.win(0, 3.2, -2.57, 1.0, 0.8, Math.PI);
  // (the paneled garage door above IS this house's front door)
  // workbench outside + tool shapes
  put(c.g, BOX, woodMat, 4.3, 0.85, 3.4, 1.8, 0.14, 0.8);
  [[3.6], [5.0]].forEach(([x]) => {
    put(c.g, BOX, darkWood, x, 0.4, 3.15, 0.12, 0.8, 0.12);
    put(c.g, BOX, darkWood, x, 0.4, 3.65, 0.12, 0.8, 0.12);
  });
  const toolRed = std('#c23b2e'), toolGray = std('#8a8f96', { metalness: 0.5, roughness: 0.5 });
  put(c.g, BOX, toolRed, 3.9, 1.05, 3.4, 0.5, 0.18, 0.3, { cast: false });   // toolbox
  put(c.g, CYL, toolGray, 4.5, 1.05, 3.3, 0.09, 0.5, 0.09, { rz: Math.PI / 2, cast: false }); // wrench-ish
  put(c.g, BOX, toolGray, 4.2, 1.0, 3.6, 0.16, 0.12, 0.4, { cast: false });
  // leaning tires
  put(c.g, TORUS, std('#2e2e2e', { roughness: 1 }), -4.0, 0.45, 3.2, 0.45, 0.45, 0.45, { rx: 0.2 });
  put(c.g, TORUS, std('#2e2e2e', { roughness: 1 }), -3.4, 0.45, 3.5, 0.45, 0.45, 0.45, { rx: -0.15 });
  // oil stain
  put(c.g, CIRC, std('#2a2a2a', { roughness: 1 }), 1.5, 0.02, 5.8, 1.2, 0.9, 1,
    { rx: -Math.PI / 2, cast: false, recv: true });
  addMailbox(c.g, -2.7, 4.4, { roundTop: true });
  return finish(c, key, 4.6);
}

/* ---------------- dispatcher ---------------- */
const BUILDERS = {
  enfp: bEnfp, enfj: bEnfj, entj: bEntj, entp: bEntp,
  estj: bEstj, esfj: bEsfj, estp: bEstp, esfp: bEsfp,
  infj: bInfj, infp: bInfp, intj: bIntj, intp: bIntp,
  isfj: bIsfj, isfp: bIsfp, istj: bIstj, istp: bIstp,
};

/** Build the personality-distinct exterior for one type key. */
export function buildHouseExterior(typeKey) {
  const b = BUILDERS[typeKey];
  if (!b) throw new Error('houses.js: unknown type key ' + typeKey);
  return b(typeKey);
}
