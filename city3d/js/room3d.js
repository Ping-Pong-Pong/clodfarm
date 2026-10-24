/* ============================================================================
 * room3d.js — TypePop 3D City: full-3D dollhouse room interior (ROOM 3D v3)
 * ============================================================================
 * Replaces the old 2D-background interior path (js/interior.js, js/interior-fx.js).
 * Same art direction as the 3D city: low-poly primitives, warm lighting,
 * bloom-friendly emissives. Cutaway dollhouse: BACK + LEFT walls only.
 *
 * v3: DATA-DRIVEN PERSONALITY INTERIORS. A compact furniture library
 * (FURNITURE, ~20 builder functions sharing GEO/stdMat) plus one ROOM_SPECS
 * entry per type key (wall color, floor style, light temperature, per-type
 * intensities, furniture layout, rug, prop anchor, wander waypoints).
 * buildRoom() consumes the spec; _update() biases the key/hemi/lamp light
 * toward the spec's lightTemp while preserving the day/night lerp.
 *
 * API CONTRACT (the integrator depends on this EXACT API):
 *
 *   import { Room3D } from './room3d.js';
 *   // api = { renderer, composer, renderPass, getNightF: () => 0..1 }
 *   Room3D.enter(typeKey, api, onExit);
 *     - saves renderPass.scene / renderPass.camera
 *     - builds (caches per typeKey) a room Scene + room camera, sets them on renderPass
 *     - starts its own rAF loop: rig.update, wander, dust drift, day/night lerp
 *     - shows its own DOM "Back to city" button (classes prefixed `rm3d-`)
 *     - tap the blob -> rig.setState('boop'); tap elsewhere does nothing
 *       (gentle camera nudge only, via the limited orbit)
 *     - exit(): cancels loop, removes button + listeners, restores
 *       renderPass scene/camera, calls onExit()
 *   Room3D.exit();          // same as the back-button path; safe no-op when inactive
 *   Room3D.getResident();   // -> active BlobRig | null
 *
 * The resident is the PAYOFF of stepping inside: built synchronously in enter()
 * (procedural BlobRig, no async), framed center-rug as the hero of the default
 * camera framing, wanders between waypoints, and does one 'happy' greeting hop
 * ~0.8s after the transition completes.
 *
 * Imports: 'three' (r170 via import map), './blobRig.js', './types.js'.
 * No postprocessing of its own: reuses the shared composer (bloom threshold 0.85).
 * iOS-safe: no extra render targets, pixel ratio left to the host.
 * ========================================================================== */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BlobRig } from './blobRig.js';
import { typeByKey } from './types.js?v=3';

/* ------------------------------------------------------------------ */
/* tuning knobs (integrator-facing)                                    */
/* ------------------------------------------------------------------ */
const KNOBS = {
  roomW: 10, roomD: 8, wallH: 5,          // dollhouse footprint
  camPos: [7.5, 5.2, 10.5], camTarget: [0, 1.2, 0], camFov: 42,
  yawRange: 0.55,                         // ± rad drag-orbit around base yaw
  pitchMin: 0.18, pitchMax: 0.95,         // elevation clamp (rad)
  orbitDamp: 8,                           // camera damping factor
  tapMaxMove: 10,                         // px
  tapMaxMs: 450,
  boopCooldownMs: 1200,
  arrivalBeatMs: 800,                     // greeting hop after enter()
  wanderDelayMs: 3000,                    // wander starts after arrival beat
  wanderSpeed: 1.25,                      // units / s
  wanderIdleMin: 4, wanderIdleMax: 8,     // s between walks
  dustN: 120,
  dayKeyI: 1.55, nightKeyI: 0.15,
  dayHemiI: 0.5, nightHemiI: 0.22,
  lampNightI: 18,                         // point light intensity at full night
  shaftDayO: 0.32, shaftNightO: 0.05,
  lampEmissivePeak: 2.2, windowEmissivePeak: 1.6,
};

/* ------------------------------------------------------------------ */
/* small utils                                                         */
/* ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
/* module temp colors: keep the per-frame lighting math allocation-free */
const _cA = new THREE.Color();
const _cB = new THREE.Color();

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* floor styles: 'wood' | 'stone' | 'darkwood' */
function floorTexture(style = 'wood') {
  if (style === 'stone') {
    return canvasTexture(512, (g, s) => {
      const n = 4, ts = s / n;
      const rnd = mulberry32(77);
      g.fillStyle = '#7e7a72';
      g.fillRect(0, 0, s, s); // grout
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const v = 146 + rnd() * 24;
        g.fillStyle = `rgb(${v | 0},${(v * 0.97) | 0},${(v * 0.91) | 0})`;
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, ts - 6);
        g.fillStyle = 'rgba(255,255,255,0.07)'; // top-edge highlight
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, 5);
        g.fillStyle = 'rgba(0,0,0,0.08)'; // speckle
        for (let k = 0; k < 6; k++)
          g.fillRect(i * ts + 6 + rnd() * (ts - 12), j * ts + 6 + rnd() * (ts - 12), 2, 2);
      }
    });
  }
  const dark = style === 'darkwood';
  return canvasTexture(512, (g, s) => {
    const rows = 8, rh = s / rows;
    const rnd = mulberry32(dark ? 4321 : 1234);
    for (let r = 0; r < rows; r++) {
      const base = (dark ? 98 : 168) + rnd() * (dark ? 16 : 26);
      g.fillStyle = `rgb(${base | 0},${(base * 0.78) | 0},${(base * 0.55) | 0})`;
      g.fillRect(0, r * rh, s, rh);
      // grain streaks
      g.strokeStyle = dark ? 'rgba(40,25,12,0.22)' : 'rgba(90,60,35,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const y = r * rh + rnd() * rh;
        g.beginPath();
        g.moveTo(0, y);
        g.bezierCurveTo(s * 0.3, y + (rnd() - 0.5) * 6, s * 0.7, y + (rnd() - 0.5) * 6, s, y);
        g.stroke();
      }
      // plank seams + staggered joints
      g.fillStyle = dark ? 'rgba(30,18,8,0.6)' : 'rgba(70,45,25,0.55)';
      g.fillRect(0, r * rh, s, 2);
      const jx = ((r * 197) % s);
      g.fillRect(jx, r * rh, 2, rh);
    }
  });
}

function shaftTexture() {
  return canvasTexture(128, (g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, 'rgba(255,240,214,0.85)');
    grad.addColorStop(0.7, 'rgba(255,240,214,0.25)');
    grad.addColorStop(1, 'rgba(255,240,214,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

function _checkerTex() {
  return canvasTexture(128, (g, s) => {
    const n = 8, ts = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? '#2c2318' : '#f3e9d7';
      g.fillRect(i * ts, j * ts, ts, ts);
    }
  });
}

/* ------------------------------------------------------------------ */
/* geometry / material caches (shared across all 16 cached rooms)      */
/* ------------------------------------------------------------------ */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 14),
  sph: new THREE.SphereGeometry(0.5, 14, 12),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  cone: new THREE.ConeGeometry(0.5, 1, 14),
  plane: new THREE.PlaneGeometry(1, 1),
  circle: new THREE.CircleGeometry(0.5, 28),
  torus: new THREE.TorusGeometry(0.5, 0.16, 10, 20),
};
const _mats = new Map();
function stdMat(key, params) {
  if (!_mats.has(key)) _mats.set(key, new THREE.MeshStandardMaterial(params));
  return _mats.get(key);
}

/* one box helper: parent.add(box(w,h,d,mat,x,y,z,{rx,ry,rz,shadow})) */
function box(parent, w, h, d, mat, x, y, z, rot) {
  const m = new THREE.Mesh(GEO.box, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

/* rounded twin of box(): cached RoundedBoxGeometry per size, fixed
 * world-space corner radius clamped so thin pieces never break. Used for
 * the big furniture masses (couch, armchair, bookshelf, cabinets) so the
 * rooms read soft like the exteriors, not sharp boxes. */
const _rboxCache = new Map();
function rboxGeo(w, h, d, r) {
  const rad = Math.min(r, Math.min(w, h, d) * 0.45);
  const key = w.toFixed(2) + '|' + h.toFixed(2) + '|' + d.toFixed(2) + '|' + rad.toFixed(3);
  if (!_rboxCache.has(key))
    _rboxCache.set(key, new RoundedBoxGeometry(w, h, d, 2, rad));
  return _rboxCache.get(key);
}
function rbox(parent, w, h, d, mat, x, y, z, rot, r = 0.09) {
  const m = new THREE.Mesh(rboxGeo(w, h, d, r), mat);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

/* ------------------------------------------------------------------ */
/* per-type signature props (5–10 lines each).                         */
/* propGroup is positioned at its anchor; build around local origin.   */
/* ------------------------------------------------------------------ */
function buildProp(key, accent) {
  const g = new THREE.Group();
  const acc = stdMat('propAcc' + key, { color: accent, roughness: 0.6 });
  switch (key) {
    case 'enfp': { // party popper: cone + tiny emissive dots
      const cone = new THREE.Mesh(GEO.cone, acc);
      cone.scale.set(0.5, 0.7, 0.5); cone.position.y = 0.35;
      cone.rotation.z = Math.PI; cone.castShadow = true; g.add(cone);
      const dotM = stdMat('propPopDots', { color: 0xffffff, emissive: 0xffd93d, emissiveIntensity: 1.4 });
      const rnd = mulberry32(7);
      for (let i = 0; i < 8; i++) {
        const d = new THREE.Mesh(GEO.sph, dotM);
        d.scale.setScalar(0.09);
        d.position.set((rnd() - 0.5) * 0.9, 0.75 + rnd() * 0.5, (rnd() - 0.5) * 0.9);
        g.add(d);
      }
      break;
    }
    case 'intj': { // chess piece: cylinder + cone + sphere
      const base = new THREE.Mesh(GEO.cyl, acc);
      base.scale.set(0.5, 0.12, 0.5); base.position.y = 0.06; g.add(base);
      const body = new THREE.Mesh(GEO.cone, acc);
      body.scale.set(0.34, 0.55, 0.34); body.position.y = 0.4; body.castShadow = true; g.add(body);
      const head = new THREE.Mesh(GEO.sph, acc);
      head.scale.setScalar(0.3); head.position.y = 0.8; head.castShadow = true; g.add(head);
      break;
    }
    case 'enfj': { // megaphone: cone + box handle
      const horn = new THREE.Mesh(GEO.cone, acc);
      horn.scale.set(0.7, 0.8, 0.7);
      horn.rotation.z = Math.PI / 2; horn.position.set(0, 0.55, 0);
      horn.castShadow = true; g.add(horn);
      box(g, 0.16, 0.4, 0.16, stdMat('propDark', { color: 0x3a3a44, roughness: 0.7 }), -0.1, 0.2, 0);
      break;
    }
    case 'entj': { // scepter: cylinder + emissive sphere (floor-standing)
      const rod = new THREE.Mesh(GEO.cyl, stdMat('propGold', { color: 0xd9a441, metalness: 0.6, roughness: 0.35 }));
      rod.scale.set(0.16, 1.6, 0.16); rod.position.y = 0.8; rod.castShadow = true; g.add(rod);
      const orb = new THREE.Mesh(GEO.sph, stdMat('propScepterOrb', {
        color: accent, emissive: accent, emissiveIntensity: 1.8 }));
      orb.scale.setScalar(0.42); orb.position.y = 1.75; g.add(orb);
      break;
    }
    case 'entp': { // lightbulb: emissive sphere + small cylinder base
      const bulb = new THREE.Mesh(GEO.sph, stdMat('propBulb', {
        color: 0xfff3c4, emissive: 0xffd93d, emissiveIntensity: 1.5 }));
      bulb.scale.setScalar(0.55); bulb.position.y = 0.62; g.add(bulb);
      const b = new THREE.Mesh(GEO.cyl, stdMat('propDark', { color: 0x555560, metalness: 0.5, roughness: 0.5 }));
      b.scale.set(0.24, 0.25, 0.24); b.position.y = 0.13; b.castShadow = true; g.add(b);
      break;
    }
    case 'infj': { // lantern: 4 thin boxes + emissive core
      const frame = stdMat('propDark', { color: 0x3a3a44, roughness: 0.7 });
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
        box(g, 0.07, 0.7, 0.07, frame, sx * 0.22, 0.4, sz * 0.22);
      box(g, 0.55, 0.07, 0.55, frame, 0, 0.78, 0);
      box(g, 0.55, 0.07, 0.55, frame, 0, 0.04, 0);
      const core = new THREE.Mesh(GEO.sph, stdMat('propLanternCore', {
        color: 0xffe9b8, emissive: 0xffc46b, emissiveIntensity: 2.0 }));
      core.scale.setScalar(0.36); core.position.y = 0.42; g.add(core);
      break;
    }
    case 'infp': { // flower: stem + 5 petal spheres
      const stem = new THREE.Mesh(GEO.cyl, stdMat('propStem', { color: 0x5da85f, roughness: 0.7 }));
      stem.scale.set(0.08, 0.7, 0.08); stem.position.y = 0.35; stem.castShadow = true; g.add(stem);
      const pot = new THREE.Mesh(GEO.cyl, stdMat('propPot', { color: 0xb0714f, roughness: 0.8 }));
      pot.scale.set(0.34, 0.28, 0.34); pot.position.y = 0.14; pot.castShadow = true; g.add(pot);
      const petalM = stdMat('propPetal' + key, { color: accent, roughness: 0.6 });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const p = new THREE.Mesh(GEO.sph, petalM);
        p.scale.setScalar(0.2);
        p.position.set(Math.cos(a) * 0.18, 0.78, Math.sin(a) * 0.18);
        p.castShadow = true; g.add(p);
      }
      const c = new THREE.Mesh(GEO.sph, stdMat('propPetalC', { color: 0xffd93d, roughness: 0.6 }));
      c.scale.setScalar(0.16); c.position.y = 0.78; g.add(c);
      break;
    }
    case 'intp': { // beaker: transparent cylinder + inner liquid cylinder
      const glass = new THREE.Mesh(GEO.cyl, stdMat('propGlass', {
        color: 0xcfe4ef, transparent: true, opacity: 0.35, roughness: 0.15 }));
      glass.scale.set(0.5, 0.7, 0.5); glass.position.y = 0.35; g.add(glass);
      const liq = new THREE.Mesh(GEO.cyl, stdMat('propLiq' + key, {
        color: accent, emissive: accent, emissiveIntensity: 0.5, roughness: 0.4 }));
      liq.scale.set(0.4, 0.32, 0.4); liq.position.y = 0.2; g.add(liq);
      break;
    }
    case 'esfp': { // maraca: sphere + handle
      const ball = new THREE.Mesh(GEO.sph, acc);
      ball.scale.setScalar(0.5); ball.position.y = 0.62; ball.castShadow = true; g.add(ball);
      const h = new THREE.Mesh(GEO.cyl, stdMat('propDark', { color: 0x8a5a3b, roughness: 0.7 }));
      h.scale.set(0.12, 0.4, 0.12); h.position.y = 0.2; h.castShadow = true; g.add(h);
      break;
    }
    case 'esfj': { // gift box: box + 2 ribbon boxes
      const bx = stdMat('propGiftBox', { color: 0xf7f2e8, roughness: 0.6 });
      box(g, 0.6, 0.45, 0.6, bx, 0, 0.225, 0);
      box(g, 0.66, 0.1, 0.16, acc, 0, 0.5, 0);
      box(g, 0.16, 0.1, 0.66, acc, 0, 0.5, 0);
      const bow = new THREE.Mesh(GEO.sph, acc);
      bow.scale.set(0.18, 0.12, 0.18); bow.position.y = 0.58; g.add(bow);
      break;
    }
    case 'estp': { // lightning bolt: two flattened emissive cones, zigzag, floating
      const boltM = stdMat('propBolt', { color: 0xffd93d, emissive: 0xffb020, emissiveIntensity: 1.7 });
      const c1 = new THREE.Mesh(GEO.cone, boltM);
      c1.scale.set(0.35, 0.6, 0.14); c1.position.set(-0.1, 0.55, 0); c1.rotation.z = 0.5; g.add(c1);
      const c2 = new THREE.Mesh(GEO.cone, boltM);
      c2.scale.set(0.35, 0.6, 0.14); c2.position.set(0.12, 0.22, 0); c2.rotation.z = Math.PI - 0.5; g.add(c2);
      g.position.y += 0.25; // floats above the table
      g.userData.spin = true;
      break;
    }
    case 'estj': { // clipboard: thin box + small clip box
      const board = stdMat('propBoard', { color: 0x9a7b52, roughness: 0.7 });
      const cb = box(g, 0.5, 0.7, 0.05, board, 0, 0.35, 0, [0, 0, 0.08]);
      cb.castShadow = true;
      box(g, 0.2, 0.1, 0.08, stdMat('propClip', { color: 0x666672, metalness: 0.6, roughness: 0.4 }), 0, 0.66, 0.01, [0, 0, 0.08]);
      box(g, 0.4, 0.08, 0.06, stdMat('propPaper', { color: 0xffffff, roughness: 0.9 }), 0, 0.42, 0.03, [0, 0, 0.08]);
      break;
    }
    case 'isfp': { // paint palette: flattened cylinder + 4 paint dots
      const pal = new THREE.Mesh(GEO.cyl, stdMat('propPal', { color: 0xd9c4a5, roughness: 0.7 }));
      pal.scale.set(0.7, 0.08, 0.7); pal.position.y = 0.05; pal.castShadow = true; g.add(pal);
      const dots = [0xff6b6b, 0xffd93d, 0x4ecdc4, 0x8b5cf6];
      dots.forEach((dc, i) => {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const d = new THREE.Mesh(GEO.sph, stdMat('propDot' + i, { color: dc, roughness: 0.4 }));
        d.scale.set(0.12, 0.07, 0.12);
        d.position.set(Math.cos(a) * 0.2, 0.1, Math.sin(a) * 0.2);
        g.add(d);
      });
      break;
    }
    case 'istp': { // wrench: box handle + torus-segment jaw
      const steel = stdMat('propSteel', { color: 0x9aa2ad, metalness: 0.7, roughness: 0.35 });
      box(g, 0.14, 0.7, 0.1, steel, 0, 0.35, 0, [0, 0, 0.5]);
      const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.07, 8, 14, Math.PI * 1.25), steel);
      jaw.position.set(0.28, 0.62, 0); jaw.rotation.z = Math.PI * 0.9;
      jaw.castShadow = true; g.add(jaw);
      break;
    }
    case 'isfj': { // shield: flattened sphere, accent
      const sh = new THREE.Mesh(GEO.sph, acc);
      sh.scale.set(0.55, 0.7, 0.2); sh.position.y = 0.42;
      sh.castShadow = true; g.add(sh);
      const boss = new THREE.Mesh(GEO.sph, stdMat('propGold', { color: 0xd9a441, metalness: 0.6, roughness: 0.35 }));
      boss.scale.setScalar(0.16); boss.position.set(0, 0.45, 0.18); g.add(boss);
      break;
    }
    case 'istj': // wristwatch: torus + circle face
    default: {
      const band = new THREE.Mesh(GEO.torus, stdMat('propBand', { color: 0x4a4a55, roughness: 0.6 }));
      band.scale.setScalar(0.62); band.position.y = 0.32; band.castShadow = true; g.add(band);
      const face = new THREE.Mesh(GEO.circle, stdMat('propFace', { color: 0xf4f1e6, roughness: 0.4 }));
      face.scale.setScalar(0.5); face.position.set(0, 0.32, 0.1); g.add(face);
      const hand = stdMat('propHand', { color: 0x33333c, roughness: 0.5 });
      box(g, 0.03, 0.16, 0.01, hand, 0, 0.36, 0.11);
      box(g, 0.11, 0.03, 0.01, hand, 0.03, 0.32, 0.11);
      break;
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}
/* ------------------------------------------------------------------ */
/* FURNITURE LIBRARY — small builders sharing GEO/stdMat/box.          */
/* Each builder: (accent, tk, opts, rnd) -> THREE.Group, feet at y=0,  */
/* castShadow on. userData contracts:                                  */
/*   surface = { y, dx, dz }  — local top surface a prop can sit on    */
/*   isLamp = true, lightY, shadeMat — the room's ONE point light goes */
/*   on the first isLamp piece placed.                                 */
/* ------------------------------------------------------------------ */

/* shared furniture materials: woods/metal/cream cached, cushions per type */
function _fmat(tk, accent) {
  return {
    wood: stdMat('wood', { color: 0x8a6242, roughness: 0.65 }),
    dark: stdMat('darkWood', { color: 0x5d4630, roughness: 0.7 }),
    metal: stdMat('fMetal', { color: 0x9aa2ad, metalness: 0.6, roughness: 0.4 }),
    cream: stdMat('fCream', { color: 0xf3e9d7, roughness: 0.9 }),
    cush: stdMat('cush' + tk, { color: accent, roughness: 0.85 }),
    cushDk: stdMat('cushDk' + tk, { color: accent.clone().multiplyScalar(0.8), roughness: 0.85 }),
  };
}

/* one shelf of seeded books along width w at (y, z).
   Book materials are shared across ALL rooms (8 cached colors), exactly like
   the pre-v3 shelf — only positions/sizes vary per room seed. */
function _bookRow(g, w, y, z, rnd, tag) {
  const cols = [0xff6b6b, 0xffd93d, 0x4ecdc4, 0x8b5cf6, 0x6d9dc5, 0xa8e6cf, 0xf59e0b, 0xe8b84b];
  let bx = -w / 2 + 0.06, i = 0;
  const start = tag.length % cols.length;
  while (bx < w / 2 - 0.14) {
    const bw = 0.1 + rnd() * 0.09, bh = 0.38 + rnd() * 0.16;
    const ci = (start + i * 3) % cols.length;
    const bm = stdMat('book' + ci, { color: cols[ci], roughness: 0.8 });
    box(g, bw, bh, 0.26, bm, bx + bw / 2, y + bh / 2, z, (rnd() < 0.08) ? [0, 0, 0.12] : null);
    bx += bw + 0.035; i++;
  }
}

const FURNITURE = {
  /* 2-seat couch, faces +z */
  couch(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 2.6, 0.55, 1.1, M.wood, 0, 0.28, 0);
    rbox(g, 2.6, 0.95, 0.3, M.wood, 0, 0.85, -0.42);
    rbox(g, 0.3, 0.8, 1.1, M.wood, -1.15, 0.62, 0);
    rbox(g, 0.3, 0.8, 1.1, M.wood, 1.15, 0.62, 0);
    rbox(g, 1.02, 0.22, 0.85, M.cush, -0.55, 0.66, 0.05);
    rbox(g, 1.02, 0.22, 0.85, M.cushDk, 0.55, 0.66, 0.05);
    rbox(g, 0.5, 0.42, 0.16, M.cream, -0.7, 1.0, -0.3, [-0.2, 0, 0.08]); // throw pillows
    rbox(g, 0.5, 0.42, 0.16, M.cush, 0.7, 1.0, -0.3, [-0.2, 0, -0.08]);
    return g;
  },

  /* single armchair, faces +z */
  armchair(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 1.05, 0.5, 0.95, M.wood, 0, 0.25, 0);
    rbox(g, 1.05, 0.9, 0.26, M.wood, 0, 0.8, -0.36);
    rbox(g, 0.24, 0.68, 0.95, M.wood, -0.42, 0.55, 0);
    rbox(g, 0.24, 0.68, 0.95, M.wood, 0.42, 0.55, 0);
    rbox(g, 0.56, 0.2, 0.66, M.cush, 0, 0.58, 0.06);
    rbox(g, 0.56, 0.5, 0.14, M.cushDk, 0, 0.85, -0.22);
    return g;
  },

  /* desk + tucked chair. Chair sits at local +z; rotY=0 faces the window (-z),
     rotY=PI faces the room (+z). */
  desk(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    box(g, 1.8, 0.08, 0.9, M.wood, 0, 0.74, 0);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      box(g, 0.08, 0.74, 0.08, M.dark, sx * 0.82, 0.37, sz * 0.37);
    box(g, 1.5, 0.5, 0.06, M.dark, 0, 0.45, -0.3); // modesty panel
    box(g, 0.55, 0.09, 0.55, M.dark, 0.1, 0.45, 0.95); // chair seat
    box(g, 0.55, 0.7, 0.09, M.dark, 0.1, 0.85, 1.2); // chair back
    box(g, 0.48, 0.12, 0.48, M.cush, 0.1, 0.53, 0.95); // seat cushion
    const ped = new THREE.Mesh(GEO.cyl, M.dark);
    ped.scale.set(0.09, 0.45, 0.09); ped.position.set(0.1, 0.22, 0.95);
    ped.castShadow = true; g.add(ped);
    g.userData.surface = { y: 0.79, dx: -0.38, dz: -0.1 };
    return g;
  },

  /* bookshelf, 1.6w x 2.6h */
  bookshelf(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 1.6, 2.6, 0.5, M.dark, 0, 1.3, 0);
    rbox(g, 1.4, 2.3, 0.3, stdMat('shelfIn', { color: 0x2c2318, roughness: 0.9 }), 0, 1.25, 0.06);
    for (let s = 0; s < 3; s++) {
      const y = 0.42 + s * 0.68;
      rbox(g, 1.4, 0.06, 0.34, M.wood, 0, y, 0.06);
      _bookRow(g, 1.28, y + 0.03, 0.06, rnd, tk + 's' + s);
    }
    return g;
  },

  /* full-wall bookshelf, 3.4w x 2.9h */
  bookshelfTall(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 3.4, 2.9, 0.55, M.dark, 0, 1.45, 0);
    rbox(g, 3.2, 2.6, 0.34, stdMat('shelfIn', { color: 0x2c2318, roughness: 0.9 }), 0, 1.4, 0.06);
    for (let s = 0; s < 4; s++) {
      const y = 0.3 + s * 0.62;
      rbox(g, 3.2, 0.06, 0.38, M.wood, 0, y, 0.06);
      _bookRow(g, 3.08, y + 0.03, 0.06, rnd, tk + 't' + s);
    }
    rbox(g, 3.5, 0.12, 0.62, M.wood, 0, 2.96, 0); // cornice
    return g;
  },

  /* round coffee table */
  roundTable(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const top = new THREE.Mesh(GEO.cyl, M.wood);
    top.scale.set(1.7, 0.09, 1.7); top.position.y = 0.5;
    top.castShadow = top.receiveShadow = true; g.add(top);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(GEO.cyl, M.dark);
      leg.scale.set(0.12, 0.48, 0.12);
      leg.position.set(Math.cos(a) * 0.55, 0.24, Math.sin(a) * 0.55);
      leg.castShadow = true; g.add(leg);
    }
    g.userData.surface = { y: 0.55, dx: 0, dz: 0 };
    return g;
  },

  /* small chess table with checkerboard top */
  chessTable(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const top = new THREE.Mesh(GEO.cyl, M.dark);
    top.scale.set(1.25, 0.08, 1.25); top.position.y = 0.62;
    top.castShadow = top.receiveShadow = true; g.add(top);
    const ped = new THREE.Mesh(GEO.cyl, M.wood);
    ped.scale.set(0.22, 0.6, 0.22); ped.position.y = 0.3; ped.castShadow = true; g.add(ped);
    const board = new THREE.Mesh(GEO.plane, stdMat('chess', { map: _checkerTex(), roughness: 0.6 }));
    board.rotation.x = -Math.PI / 2; board.scale.setScalar(1.0);
    board.position.y = 0.67; board.receiveShadow = true; g.add(board);
    g.userData.surface = { y: 0.68, dx: 0, dz: 0 };
    return g;
  },

  /* tall floor lamp — carries the room's point light */
  floorLamp(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const base = new THREE.Mesh(GEO.cyl, M.dark);
    base.scale.set(0.5, 0.08, 0.5); base.position.y = 0.04; base.castShadow = true; g.add(base);
    const pole = new THREE.Mesh(GEO.cyl, M.dark);
    pole.scale.set(0.09, 2.0, 0.09); pole.position.y = 1.0; pole.castShadow = true; g.add(pole);
    const sm = new THREE.MeshStandardMaterial({
      color: accent, emissive: accent, emissiveIntensity: 0.3,
      roughness: 0.7, side: THREE.DoubleSide,
    });
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.6, 14, 1, true), sm);
    shade.position.y = 2.15; shade.castShadow = true; g.add(shade);
    g.userData.isLamp = true; g.userData.lightY = 2.0; g.userData.shadeMat = sm;
    return g;
  },

  /* side table + small lamp — alternate carrier of the room's point light */
  tableLamp(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const top = new THREE.Mesh(GEO.cyl, M.wood);
    top.scale.set(0.85, 0.07, 0.85); top.position.y = 0.55;
    top.castShadow = top.receiveShadow = true; g.add(top);
    const leg = new THREE.Mesh(GEO.cyl, M.dark);
    leg.scale.set(0.1, 0.53, 0.1); leg.position.y = 0.27; leg.castShadow = true; g.add(leg);
    const stem = new THREE.Mesh(GEO.cyl, M.metal);
    stem.scale.set(0.06, 0.4, 0.06); stem.position.y = 0.78; g.add(stem);
    const sm = new THREE.MeshStandardMaterial({
      color: accent, emissive: accent, emissiveIntensity: 0.3,
      roughness: 0.7, side: THREE.DoubleSide,
    });
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.32, 12, 1, true), sm);
    shade.position.y = 1.08; shade.castShadow = true; g.add(shade);
    const bulb = new THREE.Mesh(GEO.sph, stdMat('lampBulb', {
      color: 0xfff3c4, emissive: 0xffd93d, emissiveIntensity: 1.2 }));
    bulb.scale.setScalar(0.14); bulb.position.y = 1.0; g.add(bulb);
    g.userData.isLamp = true; g.userData.lightY = 1.05; g.userData.shadeMat = sm;
    return g;
  },

  /* small potted plant */
  plant(accent, tk, o, rnd) {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(GEO.cyl, stdMat('plantPot', { color: 0xb0714f, roughness: 0.8 }));
    pot.scale.set(0.55, 0.5, 0.55); pot.position.y = 0.25; pot.castShadow = true; g.add(pot);
    const leafM = stdMat('leaf', { color: 0x5da85f, roughness: 0.8 });
    [[0, 0.85, 0, 0.5], [0.25, 0.65, 0.1, 0.38], [-0.22, 0.68, -0.08, 0.42]].forEach(([x, y, z, s]) => {
      const leaf = new THREE.Mesh(GEO.ico, leafM);
      leaf.scale.setScalar(s); leaf.position.set(x, y, z);
      leaf.rotation.set(rnd() * 3, rnd() * 3, 0); leaf.castShadow = true; g.add(leaf);
    });
    return g;
  },

  /* big statement plant */
  bigPlant(accent, tk, o, rnd) {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(GEO.cyl, stdMat('plantPot', { color: 0xb0714f, roughness: 0.8 }));
    pot.scale.set(0.7, 0.6, 0.7); pot.position.y = 0.3; pot.castShadow = true; g.add(pot);
    const trunk = new THREE.Mesh(GEO.cyl, stdMat('darkWood', { color: 0x5d4630, roughness: 0.7 }));
    trunk.scale.set(0.12, 0.9, 0.12); trunk.position.y = 0.9; trunk.castShadow = true; g.add(trunk);
    const leafM = stdMat('leaf', { color: 0x5da85f, roughness: 0.8 });
    [[0, 1.6, 0, 0.62], [0.35, 1.35, 0.15, 0.5], [-0.32, 1.4, -0.12, 0.52],
     [0.12, 1.85, -0.2, 0.44], [-0.15, 1.9, 0.22, 0.46]].forEach(([x, y, z, s]) => {
      const leaf = new THREE.Mesh(GEO.ico, leafM);
      leaf.scale.setScalar(s); leaf.position.set(x, y, z);
      leaf.rotation.set(rnd() * 3, rnd() * 3, 0); leaf.castShadow = true; g.add(leaf);
    });
    return g;
  },

  /* squashed-sphere beanbag */
  beanbag(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const b = new THREE.Mesh(GEO.sph, M.cush);
    b.scale.set(1.05, 0.62, 1.05); b.position.y = 0.33;
    b.castShadow = b.receiveShadow = true; g.add(b);
    const btn = new THREE.Mesh(GEO.sph, M.cushDk);
    btn.scale.setScalar(0.12); btn.position.y = 0.66; g.add(btn);
    return g;
  },

  /* painter's easel with a canvas that has paint on it */
  easel(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    [[-0.22, 0.18, 0.1], [0.22, -0.18, 0.1], [0, 0, -0.35]].forEach(([x, tilt, z], i) => {
      const leg = new THREE.Mesh(GEO.box, M.wood);
      leg.scale.set(0.09, 2.1, 0.09);
      leg.position.set(x, 1.0, z);
      leg.rotation.z = tilt; leg.rotation.x = i === 2 ? 0.35 : -0.12;
      leg.castShadow = true; g.add(leg);
    });
    const cv = new THREE.Mesh(GEO.plane, stdMat('canvas', { color: 0xfbf7ec, roughness: 0.9 }));
    cv.scale.set(1.15, 1.45, 1); cv.position.set(0, 1.55, 0.18); cv.rotation.x = -0.1;
    cv.castShadow = true; g.add(cv);
    [0xff6b6b, 0xffd93d, 0x4ecdc4].forEach((dc, i) => {
      const d = new THREE.Mesh(GEO.sph, stdMat('easelDot' + i, { color: dc, roughness: 0.5 }));
      d.scale.set(0.16, 0.1, 0.05);
      d.position.set(-0.3 + i * 0.3, 1.35 + (i % 2) * 0.35, 0.24);
      g.add(d);
    });
    return g;
  },

  /* telescope on a tripod, aimed up over the room */
  telescope(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(GEO.cyl, M.dark);
      leg.scale.set(0.07, 1.25, 0.07);
      leg.position.set(Math.cos(a) * 0.32, 0.58, Math.sin(a) * 0.32);
      leg.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
      leg.castShadow = true; g.add(leg);
    }
    box(g, 0.3, 0.22, 0.3, M.metal, 0, 1.18, 0); // mount
    const tube = new THREE.Mesh(GEO.cyl, M.cush);
    tube.scale.set(0.32, 1.25, 0.32);
    tube.position.set(0, 1.62, 0.18); tube.rotation.x = Math.PI / 2 - 0.5;
    tube.castShadow = true; g.add(tube);
    const eye = new THREE.Mesh(GEO.cyl, M.metal);
    eye.scale.set(0.1, 0.22, 0.1);
    eye.position.set(0, 1.32, -0.32); eye.rotation.x = Math.PI / 2 - 0.5; g.add(eye);
    return g;
  },

  /* 3-drawer filing cabinet */
  filingCabinet(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 0.75, 1.35, 0.65, M.metal, 0, 0.675, 0);
    for (let d = 0; d < 3; d++) {
      const y = 0.32 + d * 0.42;
      rbox(g, 0.65, 0.34, 0.03, stdMat('drawer', { color: 0x8a929e, metalness: 0.5, roughness: 0.5 }), 0, y, 0.33);
      rbox(g, 0.3, 0.05, 0.05, M.dark, 0, y + 0.08, 0.35);
    }
    g.userData.surface = { y: 1.36, dx: 0, dz: 0 };
    return g;
  },

  /* drum kit: bass + snare + cymbal + sticks */
  drumKit(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const bass = new THREE.Mesh(GEO.cyl, M.cush);
    bass.scale.set(0.9, 0.45, 0.9); bass.rotation.x = Math.PI / 2;
    bass.position.set(-0.35, 0.45, 0); bass.castShadow = true; g.add(bass);
    const snare = new THREE.Mesh(GEO.cyl, M.cushDk);
    snare.scale.set(0.6, 0.28, 0.6); snare.position.set(0.45, 0.62, 0.25);
    snare.castShadow = true; g.add(snare);
    const stand = new THREE.Mesh(GEO.cyl, M.metal);
    stand.scale.set(0.06, 1.0, 0.06); stand.position.set(0.5, 0.5, -0.45);
    stand.castShadow = true; g.add(stand);
    const cym = new THREE.Mesh(GEO.cyl, stdMat('cymbal', { color: 0xd9a441, metalness: 0.75, roughness: 0.3 }));
    cym.scale.set(0.7, 0.05, 0.7); cym.position.set(0.5, 1.02, -0.45);
    cym.castShadow = true; g.add(cym);
    [[-0.1, 0.3], [0.15, -0.2]].forEach(([x, tilt]) => {
      const stick = new THREE.Mesh(GEO.cyl, M.wood);
      stick.scale.set(0.05, 0.7, 0.05);
      stick.position.set(x, 0.85, 0.35); stick.rotation.z = tilt; stick.rotation.x = 0.5;
      stick.castShadow = true; g.add(stick);
    });
    return g;
  },

  /* garage workbench with static clutter on top */
  workbench(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    box(g, 2.0, 0.1, 0.9, M.wood, 0, 0.85, 0);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      box(g, 0.1, 0.85, 0.1, M.dark, sx * 0.9, 0.42, sz * 0.35);
    box(g, 1.7, 0.06, 0.7, M.dark, 0, 0.25, 0); // lower shelf
    box(g, 0.34, 0.34, 0.34, M.cushDk, -0.6, 1.07, -0.15); // parts box
    const can = new THREE.Mesh(GEO.cyl, M.metal);
    can.scale.set(0.22, 0.4, 0.22); can.position.set(-0.15, 1.1, 0.2);
    can.castShadow = true; g.add(can);
    box(g, 0.5, 0.12, 0.3, M.cream, 0.62, 0.96, -0.22); // small tray
    g.userData.surface = { y: 0.91, dx: 0.3, dz: 0.18 };
    return g;
  },

  /* bench under the window, with cushions + throw pillows */
  windowSeat(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 2.6, 0.42, 1.0, M.wood, 0, 0.21, 0);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      rbox(g, 0.09, 0.21, 0.09, M.dark, sx * 1.2, 0.1, sz * 0.42);
    rbox(g, 1.18, 0.16, 0.88, M.cush, -0.62, 0.5, 0);
    rbox(g, 1.18, 0.16, 0.88, M.cushDk, 0.62, 0.5, 0);
    rbox(g, 0.5, 0.5, 0.18, M.cream, -0.95, 0.82, -0.32, [-0.25, 0, 0.1]);
    rbox(g, 0.5, 0.5, 0.18, M.cush, 0.95, 0.82, -0.32, [-0.25, 0, -0.1]);
    g.userData.surface = { y: 0.59, dx: 0, dz: 0.1 };
    return g;
  },

  /* cluster of floor cushions; opts.n (default 2) */
  floorCushions(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    const n = o.n || 2;
    for (let i = 0; i < n; i++) {
      const c = new THREE.Mesh(GEO.sph, i % 2 ? M.cream : M.cush);
      c.scale.set(1.1, 0.42, 1.1);
      c.position.set((i - (n - 1) / 2) * 1.25, 0.22, (rnd() - 0.5) * 0.3);
      c.rotation.y = rnd() * 3;
      c.castShadow = c.receiveShadow = true; g.add(c);
    }
    return g;
  },

  /* stacked crates — the istp "tool wall" */
  crateStack(accent, tk, o, rnd) {
    const g = new THREE.Group(), M = _fmat(tk, accent);
    rbox(g, 0.95, 0.95, 0.95, M.dark, 0, 0.475, 0, [0, 0.1, 0]);
    rbox(g, 0.7, 0.7, 0.7, M.wood, 0.12, 1.3, 0.05, [0, -0.25, 0]);
    rbox(g, 0.5, 0.5, 0.5, M.cushDk, -0.08, 1.9, -0.02, [0, 0.4, 0]);
    return g;
  },

  /* round rug with stitched edge; opts.r radius, opts.splat paint dots */
  rug(accent, tk, o, rnd) {
    const g = new THREE.Group();
    const r = o.r || 2.2;
    const tex = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = '#' + accent.getHexString();
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 14;
      ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 22, 0, Math.PI * 2); ctx.stroke();
      if (o.splat) {
        const cols = ['#ff6b6b', '#ffd93d', '#4ecdc4', '#ffffff', '#8b5cf6'];
        for (let i = 0; i < 26; i++) {
          const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * s * 0.42;
          ctx.fillStyle = cols[i % cols.length];
          ctx.beginPath();
          ctx.arc(s / 2 + Math.cos(a) * rr, s / 2 + Math.sin(a) * rr, 3 + rnd() * 7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    const m = new THREE.Mesh(GEO.circle, stdMat('rugTx' + tk, { map: tex, roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2; m.scale.setScalar(r * 2); m.position.y = 0.012;
    m.receiveShadow = true; g.add(m);
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.8, r * 0.94, 28),
      stdMat('rugRing', { color: 0xf7f2e8, roughness: 0.95 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.014; ring.receiveShadow = true; g.add(ring);
    return g;
  },
};
/* ------------------------------------------------------------------ */
/* ROOM_SPECS — one personality-distinct room per type key.            */
/*                                                                     */
/* wallColor   wall paint (tinted 8% toward the type accent at build)  */
/* floorStyle  'wood' | 'stone' | 'darkwood'                           */
/* lightTemp   hex the day key light is biased toward                  */
/* lightBias   0..1 — how far the key leans toward lightTemp            */
/* keyI        [day, night] key-light intensities                      */
/* hemiI       [day, night] hemisphere intensities (optional)          */
/* lampColor   the room's single point light (+ shade emissive)        */
/* lampNightI  point-light intensity at full night (optional)          */
/* furniture   [{ p: piece, x, z, r: rotY, o: builder opts }]          */
/* rug         { x, z, r, splat } — resident starts at rug center      */
/* propOn      'table' -> prop sits on propPiece's surface;            */
/*             'floor' -> prop stands at propFloor [x, z]               */
/* waypoints   [[x, z] x3] — wander targets, kept clear of furniture   */
/* ------------------------------------------------------------------ */
const ROOM_SPECS = {
  /* INTJ "The Chess Player" — command center: desk facing the window,
     FULL bookshelf wall, cold blue-white light, dark floor, zero cozy. */
  intj: {
    wallColor: 0xe8ecf2, floorStyle: 'darkwood',
    lightTemp: 0xbcd2ff, lightBias: 0.75, keyI: [1.7, 0.12], lampColor: 0xcfe0ff,
    furniture: [
      { p: 'desk', x: 1.0, z: -2.9, r: 0 },
      { p: 'bookshelfTall', x: -2.4, z: -3.55, r: 0 },
      { p: 'floorLamp', x: 4.3, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.8, r: 2.2 }, propOn: 'table', propPiece: 'desk',
    waypoints: [[0.5, 0.8], [1.0, -1.1], [-2.4, -2.4]],
  },

  /* ENFP "The Hype Machine" — 3 beanbags, drum kit, warm BRIGHT light,
     confetti-splatter rug, party popper standing on the floor. */
  enfp: {
    wallColor: 0xfff1e0, floorStyle: 'wood',
    lightTemp: 0xffd9a0, lightBias: 0.6, keyI: [1.85, 0.18], lampColor: 0xffd0a0,
    furniture: [
      { p: 'beanbag', x: -1.7, z: 0.5, r: 0.5 },
      { p: 'beanbag', x: 2.7, z: 0.5, r: -0.4 },
      { p: 'beanbag', x: 0.5, z: 2.5, r: 2.8 },
      { p: 'drumKit', x: -3.3, z: -2.7, r: 0.6 },
      { p: 'floorLamp', x: 4.3, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.7, r: 2.4, splat: true }, propOn: 'floor', propFloor: [0.5, -1.1],
    waypoints: [[0.5, 0.7], [-2.1, -1.7], [2.2, 1.9]],
  },

  /* ISTJ "The Archivist" — 2 filing cabinets + neat desk facing the room,
     neutral even light, stone floor. Everything squared away. */
  istj: {
    wallColor: 0xe9e7e2, floorStyle: 'stone',
    lightTemp: 0xf2f0ea, lightBias: 0.25, keyI: [1.5, 0.15], lampColor: 0xffe9c4,
    furniture: [
      { p: 'desk', x: -1.5, z: -2.5, r: Math.PI },
      { p: 'filingCabinet', x: 2.7, z: -3.55, r: 0 },
      { p: 'filingCabinet', x: 3.55, z: -3.55, r: 0 },
      { p: 'floorLamp', x: -4.0, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.8, r: 2.2 }, propOn: 'table', propPiece: 'desk',
    waypoints: [[0.5, 0.8], [-1.5, -1.4], [3.1, -2.5]],
  },

  /* INFP "The Dreamer" — window seat under the window, 3 big plants,
     soft rose light, flower resting on the seat. */
  infp: {
    wallColor: 0xf7ecec, floorStyle: 'wood',
    lightTemp: 0xffc9d4, lightBias: 0.55, keyI: [1.35, 0.14], lampColor: 0xffc9a8,
    furniture: [
      { p: 'windowSeat', x: 1.0, z: -3.4, r: 0 },
      { p: 'bigPlant', x: -3.6, z: -2.6, r: 0 },
      { p: 'bigPlant', x: -4.2, z: -0.8, r: 0 },
      { p: 'bigPlant', x: 3.8, z: -2.8, r: 0 },
      { p: 'tableLamp', x: 3.2, z: -0.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.9, r: 2.3 }, propOn: 'table', propPiece: 'windowSeat',
    waypoints: [[0.5, 0.9], [1.0, -2.3], [-3.2, -1.4]],
  },

  /* ENTP "The Debater" — workbench + telescope + chess table + beanbag,
     warm key with a COOL lamp: the quirky warm-cool mix. */
  entp: {
    wallColor: 0xf3ead9, floorStyle: 'wood',
    lightTemp: 0xffe3b3, lightBias: 0.45, keyI: [1.6, 0.16], lampColor: 0xbfe0ff,
    furniture: [
      { p: 'workbench', x: -2.8, z: -3.1, r: 0.15 },
      { p: 'telescope', x: 3.3, z: -2.5, r: -0.5 },
      { p: 'chessTable', x: 0.9, z: 1.7, r: 0.4 },
      { p: 'beanbag', x: -1.5, z: 1.9, r: 1.2 },
      { p: 'tableLamp', x: -4.1, z: -1.6, r: 0 },
    ],
    rug: { x: 0.6, z: 0.6, r: 2.2, splat: true }, propOn: 'table', propPiece: 'workbench',
    waypoints: [[0.6, 0.6], [-2.3, -2.1], [2.6, -1.5]],
  },

  /* ESFP "The Entertainer" — bold splatter rug, 2 floor-cushion clusters,
     colorful magenta-glowing table lamp, party-warm light. */
  esfp: {
    wallColor: 0xfff4d6, floorStyle: 'wood',
    lightTemp: 0xffb3e2, lightBias: 0.6, keyI: [1.7, 0.18], lampColor: 0xff9de2,
    furniture: [
      { p: 'floorCushions', x: -0.9, z: 1.3, r: 0.4, o: { n: 2 } },
      { p: 'floorCushions', x: 2.0, z: 1.1, r: -0.5, o: { n: 2 } },
      { p: 'tableLamp', x: 3.6, z: -2.8, r: 0 },
      { p: 'roundTable', x: -3.2, z: -2.2, r: 0 },
    ],
    rug: { x: 0.5, z: 0.3, r: 2.5, splat: true }, propOn: 'table', propPiece: 'roundTable',
    waypoints: [[0.5, 0.3], [-2.5, -1.0], [2.6, -1.8]],
  },

  /* INFJ "The Counselor" — armchair aimed at the window, dim violet light,
     moonlight bias, small bookshelf, lantern on the floor beside the chair. */
  infj: {
    wallColor: 0xe6e0f2, floorStyle: 'darkwood',
    lightTemp: 0x9a8cff, lightBias: 0.7, keyI: [1.0, 0.10], lampColor: 0x9a8cff,
    furniture: [
      { p: 'armchair', x: 1.0, z: -2.4, r: Math.PI },
      { p: 'bookshelf', x: -3.2, z: -3.6, r: 0 },
      { p: 'tableLamp', x: 2.3, z: -2.5, r: 0 },
    ],
    rug: { x: 0.3, z: 0.8, r: 2.2 }, propOn: 'floor', propFloor: [2.0, -1.6],
    waypoints: [[0.3, 0.8], [1.0, -1.3], [-2.5, -2.5]],
  },

  /* ISFP "The Artist" — easel angled into the room, paint-splatter rug,
     warm artistic light, palette on the floor by the easel. */
  isfp: {
    wallColor: 0xfdf3e8, floorStyle: 'wood',
    lightTemp: 0xffd9a0, lightBias: 0.55, keyI: [1.6, 0.16], lampColor: 0xffc98a,
    furniture: [
      { p: 'easel', x: -1.6, z: -2.5, r: 0.5 },
      { p: 'tableLamp', x: 2.7, z: -2.9, r: 0 },
      { p: 'plant', x: -3.9, z: -1.3, r: 0 },
    ],
    rug: { x: 0.6, z: 0.9, r: 2.4, splat: true }, propOn: 'floor', propFloor: [-0.5, -2.2],
    waypoints: [[0.6, 0.9], [-1.6, -1.4], [2.0, -1.8]],
  },

  /* ESTJ "The Executive" — symmetrical: desk centered under the window,
     filing cabinets flanking, crisp neutral light, stone floor. */
  estj: {
    wallColor: 0xeceff2, floorStyle: 'stone',
    lightTemp: 0xf4f6ff, lightBias: 0.5, keyI: [1.65, 0.15], lampColor: 0xfff0d8,
    furniture: [
      { p: 'desk', x: 1.0, z: -2.9, r: 0 },
      { p: 'filingCabinet', x: -0.7, z: -3.55, r: 0 },
      { p: 'filingCabinet', x: 2.7, z: -3.55, r: 0 },
      { p: 'floorLamp', x: -3.6, z: -2.8, r: 0 },
    ],
    rug: { x: 1.0, z: 0.8, r: 2.2 }, propOn: 'table', propPiece: 'desk',
    waypoints: [[1.0, 0.8], [1.0, -1.0], [-2.2, 0.4]],
  },

  /* ESFJ "The Caregiver" — round table with 2 armchairs pulled up,
     warm kitchen glow, gift box on the table. */
  esfj: {
    wallColor: 0xfdf0e4, floorStyle: 'wood',
    lightTemp: 0xffd2a8, lightBias: 0.55, keyI: [1.6, 0.20], lampColor: 0xffc07a,
    furniture: [
      { p: 'roundTable', x: 0.5, z: 0.2, r: 0 },
      { p: 'armchair', x: -1.5, z: 0.2, r: 1.35 },
      { p: 'armchair', x: 2.5, z: 0.2, r: -1.35 },
      { p: 'floorLamp', x: 3.7, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 1.6, r: 2.0 }, propOn: 'table', propPiece: 'roundTable',
    waypoints: [[0.5, 1.6], [-2.1, -1.0], [2.9, -1.6]],
  },

  /* ESTP "The Daredevil" — workbench + beanbag, bright daylight,
     stone "garage" floor, lightning bolt floating over the bench. */
  estp: {
    wallColor: 0xf6f1e6, floorStyle: 'stone',
    lightTemp: 0xfff6e8, lightBias: 0.3, keyI: [1.9, 0.14], lampColor: 0xfff2d8,
    furniture: [
      { p: 'workbench', x: -2.6, z: -3.1, r: -0.1 },
      { p: 'beanbag', x: 1.9, z: 1.5, r: 0.8 },
      { p: 'floorLamp', x: 3.8, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.7, r: 2.3 }, propOn: 'table', propPiece: 'workbench',
    waypoints: [[0.5, 0.7], [-2.1, -2.1], [2.3, 0.4]],
  },

  /* ENFJ "The Cheerleader" — couch + coffee table corner, plants,
     welcoming warm light, megaphone on the table. */
  enfj: {
    wallColor: 0xfdeee4, floorStyle: 'wood',
    lightTemp: 0xffc9a0, lightBias: 0.55, keyI: [1.6, 0.20], lampColor: 0xffbe8a,
    furniture: [
      { p: 'couch', x: -2.4, z: -2.7, r: 0 },
      { p: 'roundTable', x: -2.4, z: -0.9, r: 0 },
      { p: 'bigPlant', x: 3.6, z: -2.8, r: 0 },
      { p: 'plant', x: -4.2, z: -1.2, r: 0 },
      { p: 'floorLamp', x: 4.2, z: -0.9, r: 0 },
    ],
    rug: { x: 0.9, z: 0.9, r: 2.4 }, propOn: 'table', propPiece: 'roundTable',
    waypoints: [[0.9, 0.9], [0.0, -2.6], [2.8, -1.9]],
  },

  /* ENTJ "The Commander" — desk facing INTO the room (commanding),
     bookshelf, cool-bright light, dark floor, scepter by the desk. */
  entj: {
    wallColor: 0xecebf4, floorStyle: 'darkwood',
    lightTemp: 0xdfe8ff, lightBias: 0.65, keyI: [1.8, 0.14], lampColor: 0xe8e4ff,
    furniture: [
      { p: 'desk', x: 0.6, z: -2.5, r: Math.PI },
      { p: 'bookshelf', x: 3.4, z: -3.55, r: 0 },
      { p: 'floorLamp', x: -3.6, z: -2.8, r: 0 },
    ],
    rug: { x: 0.6, z: 0.8, r: 2.3 }, propOn: 'floor', propFloor: [-0.7, -2.3],
    waypoints: [[0.6, 0.8], [0.6, -1.3], [2.6, -2.4]],
  },

  /* INTP "The Thinker" — desk facing window + telescope + bookshelf,
     cool lab light, stone floor, beaker on the desk. */
  intp: {
    wallColor: 0xe8edf2, floorStyle: 'stone',
    lightTemp: 0xcfe0ff, lightBias: 0.6, keyI: [1.55, 0.13], lampColor: 0xd6e6ff,
    furniture: [
      { p: 'desk', x: -1.2, z: -2.9, r: 0 },
      { p: 'telescope', x: 3.2, z: -2.4, r: -0.6 },
      { p: 'bookshelf', x: -3.4, z: -3.55, r: 0 },
      { p: 'tableLamp', x: 2.0, z: -2.9, r: 0 },
    ],
    rug: { x: 0.5, z: 0.8, r: 2.2 }, propOn: 'table', propPiece: 'desk',
    waypoints: [[0.5, 0.8], [-1.2, -1.0], [2.4, -1.4]],
  },

  /* ISFJ "The Protector" — armchair + round table nook, soft warm safe
     light, shield on the table. */
  isfj: {
    wallColor: 0xfbf3e2, floorStyle: 'wood',
    lightTemp: 0xffd9a8, lightBias: 0.6, keyI: [1.5, 0.20], lampColor: 0xffc98a,
    furniture: [
      { p: 'armchair', x: -1.2, z: -2.1, r: 0.6 },
      { p: 'roundTable', x: -1.0, z: -0.8, r: 0 },
      { p: 'plant', x: -3.9, z: -2.7, r: 0 },
      { p: 'tableLamp', x: 0.6, z: -2.7, r: 0 },
    ],
    rug: { x: 0.2, z: 0.6, r: 2.3 }, propOn: 'table', propPiece: 'roundTable',
    waypoints: [[0.2, 0.6], [-2.4, -0.4], [1.0, -1.8]],
  },

  /* ISTP "The Mechanic" — workbench + crate "tool wall", bright garage
     light, stone floor, wrench on the bench. */
  istp: {
    wallColor: 0xf0efe8, floorStyle: 'stone',
    lightTemp: 0xfff3dc, lightBias: 0.35, keyI: [1.85, 0.14], lampColor: 0xffe9c0,
    furniture: [
      { p: 'workbench', x: 0.2, z: -3.1, r: 0 },
      { p: 'crateStack', x: -2.9, z: -3.2, r: 0.2 },
      { p: 'floorLamp', x: 3.7, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.7, r: 2.3 }, propOn: 'table', propPiece: 'workbench',
    waypoints: [[0.5, 0.7], [0.2, -2.0], [-2.3, -2.2]],
  },

  /* fallback: never used unless a type key is missing its spec */
  _default: {
    wallColor: 0xf3e9d7, floorStyle: 'wood',
    lightTemp: 0xffe7c4, lightBias: 0.4, keyI: [KNOBS.dayKeyI, KNOBS.nightKeyI], lampColor: 0xffc98a,
    furniture: [
      { p: 'couch', x: -2.4, z: -2.7, r: 0 },
      { p: 'roundTable', x: -2.4, z: -0.9, r: 0 },
      { p: 'floorLamp', x: 4.2, z: -2.6, r: 0 },
    ],
    rug: { x: 0.5, z: 0.8, r: 2.2 }, propOn: 'table', propPiece: 'roundTable',
    waypoints: [[0.5, 0.8], [1.0, -1.9], [-0.9, -1.3]],
  },
};
/* ------------------------------------------------------------------ */
/* room builder (lazy, cached per typeKey) — consumes ROOM_SPECS        */
/* ------------------------------------------------------------------ */
const roomCache = new Map();

function buildRoom(typeKey) {
  const spec = ROOM_SPECS[typeKey] || ROOM_SPECS._default;
  const type = typeByKey(typeKey);
  const accent = new THREE.Color(type.color);
  const seed = [...typeKey].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = mulberry32(seed);
  const tk = typeKey;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1620);
  scene.fog = new THREE.Fog(0x1a1620, 18, 34);

  const W = KNOBS.roomW, D = KNOBS.roomD, H = KNOBS.wallH;

  /* ---- floor: style per spec (wood / stone / darkwood) ---- */
  const floor = new THREE.Mesh(
    GEO.plane,
    stdMat('floor-' + spec.floorStyle, { map: floorTexture(spec.floorStyle), roughness: 0.75 })
  );
  floor.material.map.repeat.set(2.5, 2);
  floor.material.map.wrapS = floor.material.map.wrapT = THREE.RepeatWrapping;
  floor.rotation.x = -Math.PI / 2;
  floor.scale.set(W, D, 1);
  floor.receiveShadow = true;
  scene.add(floor);

  /* ---- walls: back + left only (cutaway). spec wallColor, 8% toward accent ---- */
  const wallTint = new THREE.Color(spec.wallColor).lerp(accent, 0.08);
  const wallMat = stdMat('wall' + tk, { color: wallTint, roughness: 0.9 });
  const backWall = new THREE.Mesh(GEO.box, wallMat);
  backWall.scale.set(W + 0.4, H, 0.3);
  backWall.position.set(0, H / 2, -D / 2 - 0.15);
  backWall.receiveShadow = true;
  scene.add(backWall);
  const leftWall = new THREE.Mesh(GEO.box, wallMat);
  leftWall.scale.set(0.3, H, D + 0.4);
  leftWall.position.set(-W / 2 - 0.15, H / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);

  /* baseboards */
  const bbMat = stdMat('baseboard', { color: 0xe4d6bd, roughness: 0.8 });
  box(scene, W, 0.22, 0.08, bbMat, 0, 0.11, -D / 2 + 0.05);
  box(scene, 0.08, 0.22, D, bbMat, -W / 2 + 0.05, 0.11, 0);

  /* ---- window on back wall + light shaft + dust ---- */
  const winX = 1.0, winY = 2.9;
  const frameM = stdMat('winFrame', { color: 0x7a5c3e, roughness: 0.7 });
  box(scene, 2.5, 0.18, 0.34, frameM, winX, winY + 1.0, -D / 2 + 0.05);
  box(scene, 2.5, 0.18, 0.34, frameM, winX, winY - 1.0, -D / 2 + 0.05);
  box(scene, 0.18, 2.1, 0.34, frameM, winX - 1.16, winY, -D / 2 + 0.05);
  box(scene, 0.18, 2.1, 0.34, frameM, winX + 1.16, winY, -D / 2 + 0.05);
  box(scene, 0.14, 1.85, 0.3, frameM, winX, winY, -D / 2 + 0.05); // mullion
  box(scene, 2.2, 0.14, 0.3, frameM, winX, winY, -D / 2 + 0.05);
  box(scene, 2.9, 0.14, 0.5, frameM, winX, winY - 1.15, -D / 2 + 0.12); // sill

  const paneMat = new THREE.MeshStandardMaterial({
    color: 0x222831, emissive: 0xfff2d8,
    emissiveIntensity: KNOBS.windowEmissivePeak, roughness: 0.4,
  });
  const pane = new THREE.Mesh(GEO.plane, paneMat);
  pane.scale.set(2.2, 1.85, 1);
  pane.position.set(winX, winY, -D / 2 - 0.02);
  scene.add(pane);

  /* volumetric-feel shaft: additive gradient plane, window -> floor */
  const shaftMat = new THREE.MeshBasicMaterial({
    map: shaftTexture(), transparent: true,
    opacity: KNOBS.shaftDayO, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const shaft = new THREE.Mesh(GEO.plane, shaftMat);
  shaft.scale.set(2.6, 5.2, 1);
  shaft.position.set(winX, 1.55, -D / 2 + 1.7);
  shaft.rotation.x = -0.62;
  scene.add(shaft);

  /* dust motes inside the shaft region */
  const dn = KNOBS.dustN;
  const dustPos = new Float32Array(dn * 3);
  const dustSeed = new Float32Array(dn * 2);
  for (let i = 0; i < dn; i++) {
    dustPos[i * 3] = winX - 1.3 + rnd() * 2.6;
    dustPos[i * 3 + 1] = 0.2 + rnd() * 3.0;
    dustPos[i * 3 + 2] = -D / 2 + 0.2 + rnd() * 3.0;
    dustSeed[i * 2] = rnd() * Math.PI * 2;
    dustSeed[i * 2 + 1] = 0.3 + rnd() * 0.7;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xffe9c0, size: 0.045, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(dust);

  /* ---- furniture per spec ---- */
  const placed = []; // [{ piece, group }]
  let lampPiece = null, shadeMat = null;
  for (const f of spec.furniture) {
    const builder = FURNITURE[f.p];
    if (!builder) continue; // unknown piece: skip, don't break the room
    const g = builder(accent, tk, f.o || {}, rnd);
    g.position.set(f.x, 0, f.z);
    g.rotation.y = f.r || 0;
    scene.add(g);
    placed.push({ piece: f.p, group: g });
    if (!lampPiece && g.userData.isLamp) {
      lampPiece = g;
      shadeMat = g.userData.shadeMat || null;
    }
  }

  /* ---- the room's ONE point light, riding the first lamp piece ---- */
  const lampLight = new THREE.PointLight(spec.lampColor, 0, 9, 1.6);
  if (lampPiece) {
    lampLight.position.y = lampPiece.userData.lightY || 1.8;
    lampPiece.add(lampLight);
  } else {
    // defensive fallback (every real spec carries a lamp)
    lampLight.position.set(4.2, 1.95, -2.6);
    scene.add(lampLight);
    shadeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: spec.lampColor, emissiveIntensity: 0.3 });
  }

  /* ---- rug: the resident's stage ---- */
  const rugG = FURNITURE.rug(accent, tk, { r: spec.rug.r, splat: spec.rug.splat }, rnd);
  rugG.position.set(spec.rug.x, 0, spec.rug.z);
  scene.add(rugG);

  /* ---- signature prop: on a furniture surface, or floor-standing ---- */
  const prop = buildProp(typeKey, accent);
  if (spec.propOn === 'table') {
    const anchor = placed.find((p) => p.piece === spec.propPiece && p.group.userData.surface)
      || placed.find((p) => p.group.userData.surface);
    if (anchor) {
      const s = anchor.group.userData.surface, ag = anchor.group;
      const ry = ag.rotation.y, c = Math.cos(ry), sn = Math.sin(ry);
      prop.position.set(
        ag.position.x + s.dx * c + s.dz * sn,
        s.y,
        ag.position.z - s.dx * sn + s.dz * c
      );
    } else {
      prop.position.set(spec.rug.x, 0, spec.rug.z);
    }
  } else {
    prop.position.set(spec.propFloor[0], 0, spec.propFloor[1]);
  }
  scene.add(prop);

  /* ---- resident: BlobRig, built synchronously — room is NEVER empty ---- */
  const rig = new BlobRig({ fruit: type.fruit });
  rig.group.position.set(spec.rug.x, 0, spec.rug.z); // rug center
  // face the room camera's start position
  rig.setFacing(Math.atan2(KNOBS.camPos[0] - spec.rug.x, KNOBS.camPos[2] - spec.rug.z));
  rig.setState('idle');
  scene.add(rig.group);

  /* ---- lights ---- */
  const key = new THREE.DirectionalLight(0xffe7c4, KNOBS.dayKeyI);
  key.position.set(winX + 1.5, 6.5, -1.5); // from the window direction
  key.target.position.set(0, 0, 0.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -7; key.shadow.camera.right = 7;
  key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
  key.shadow.camera.near = 1; key.shadow.camera.far = 20;
  key.shadow.bias = -0.002;
  scene.add(key, key.target);

  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x8a6f52, KNOBS.dayHemiI);
  scene.add(hemi);

  /* ---- room camera: resident framed as hero ---- */
  const camera = new THREE.PerspectiveCamera(
    KNOBS.camFov,
    1, // fixed on enter() from renderer size
    0.1, 60
  );
  const target = new THREE.Vector3(...KNOBS.camTarget);
  const basePos = new THREE.Vector3(...KNOBS.camPos);
  const off = basePos.clone().sub(target);
  const baseYaw = Math.atan2(off.x, off.z);
  const baseR = off.length();
  const basePitch = Math.asin(clamp(off.y / baseR, -1, 1));
  camera.position.copy(basePos);
  camera.lookAt(target);

  const room = {
    typeKey, type, accent, scene, camera, target,
    baseYaw, baseR, basePitch,
    yaw: baseYaw, pitch: basePitch,           // orbit goals (damped toward)
    rig, key, hemi, lampLight, shadeMat, paneMat, shaftMat, dust,
    dustSeed, prop,
    spec, rugPos: [spec.rug.x, spec.rug.z],
    // wander state — waypoints straight from the spec
    waypoints: spec.waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    wpIdx: 0, wpTimer: 0, moving: false, wpTarget: null, wanderOn: false,
    nightF: 0,
  };
  roomCache.set(typeKey, room);
  return room;
}

/* ------------------------------------------------------------------ */
/* Room3D singleton controller                                         */
/* ------------------------------------------------------------------ */
let active = null; // { room, api, onExit, raf, saved, btn, timers[], handlers }
const _projV = new THREE.Vector3();

function _stopTimers(st) {
  for (const t of st.timers) { clearTimeout(t); clearInterval(t); }
  st.timers.length = 0;
}

function _detach(st) {
  const el = st.api.renderer.domElement;
  el.removeEventListener('pointerdown', st.onDown);
  el.removeEventListener('pointerup', st.onUp);
  window.removeEventListener('resize', st.onResize);
  if (st.btn && st.btn.parentNode) st.btn.parentNode.removeChild(st.btn);
  st.btn = null;
}

function _enter(typeKey, api, onExit) {
  if (active) _exit(true); // re-enter safety: tear down first, silently
  if (!api || !api.renderer || !api.renderPass) {
    throw new Error('Room3D.enter: api must provide { renderer, renderPass }');
  }

  const room = roomCache.get(typeKey) || buildRoom(typeKey);
  const st = {
    room, api, onExit: typeof onExit === 'function' ? onExit : null,
    raf: 0, timers: [],
    saved: { scene: api.renderPass.scene, camera: api.renderPass.camera },
    btn: null, onDown: null, onUp: null, onResize: null,
    downX: 0, downY: 0, downT: 0, orbiting: false, lastOX: 0, lastOY: 0,
    lastBoop: 0, lastT: performance.now(),
  };

  /* swap the shared render pass onto the room */
  api.renderPass.scene = room.scene;
  api.renderPass.camera = room.camera;

  /* camera aspect from the real canvas */
  const size = new THREE.Vector2();
  api.renderer.getSize(size);
  room.camera.aspect = size.x / Math.max(1, size.y);
  room.camera.updateProjectionMatrix();

  /* ---- resident reset: always present, hero framing (rug center per spec) ---- */
  room.rig.group.position.set(room.rugPos[0], 0, room.rugPos[1]);
  room.rig.setFacing(Math.atan2(KNOBS.camPos[0] - room.rugPos[0], KNOBS.camPos[2] - room.rugPos[1]));
  room.rig.setState('idle');
  room.yaw = room.baseYaw; room.pitch = room.basePitch;
  room.wpIdx = 0; room.moving = false; room.wpTarget = null;
  room.wanderOn = false; room.nightF = 0;

  /* ---- back button (rm3d- prefixed) ---- */
  const btn = document.createElement('button');
  btn.className = 'rm3d-back';
  btn.type = 'button';
  btn.textContent = '\u2190 Back to city';
  btn.setAttribute('aria-label', 'Back to city');
  Object.assign(btn.style, {
    position: 'fixed', top: '14px', left: '14px', zIndex: '30',
    padding: '10px 18px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.25)',
    background: 'rgba(18,18,24,0.55)', color: '#fff',
    fontSize: '15px', fontWeight: '600', fontFamily: 'inherit',
    backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
  });
  btn.addEventListener('click', () => Room3D.exit());
  document.body.appendChild(btn);
  st.btn = btn;

  /* ---- pointer: tap detection + limited orbit drag ---- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  st.onDown = (e) => {
    st.downX = e.clientX; st.downY = e.clientY; st.downT = performance.now();
    st.orbiting = true; st.lastOX = e.clientX; st.lastOY = e.clientY;
  };
  st.onUp = (e) => {
    st.orbiting = false;
    const dx = e.clientX - st.downX, dy = e.clientY - st.downY;
    const dt = performance.now() - st.downT;
    if (Math.hypot(dx, dy) < KNOBS.tapMaxMove && dt < KNOBS.tapMaxMs) {
      const rect = api.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
              -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, room.camera);
      const hits = ray.intersectObject(room.rig.hitProxy, true);
      if (hits.length && performance.now() - st.lastBoop > KNOBS.boopCooldownMs) {
        st.lastBoop = performance.now();
        room.rig.setState('boop');
      }
      // tap elsewhere: nothing (orbit already gives a gentle nudge feel)
    }
  };
  const el = api.renderer.domElement;
  el.addEventListener('pointerdown', st.onDown);
  el.addEventListener('pointerup', st.onUp);
  st.onResize = () => {
    api.renderer.getSize(size);
    room.camera.aspect = size.x / Math.max(1, size.y);
    room.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', st.onResize);

  /* ---- arrival beat: one greeting hop ~0.8s after the transition,
         plus a greeting speech bubble (white pill, colored dot, dark text) ---- */
  st.timers.push(setTimeout(() => {
    if (active !== st) return;
    room.rig.setState('happy');
    _showGreeting(st, room.type);
  }, KNOBS.arrivalBeatMs));
  /* wander unlocks after the greeting so the beat reads cleanly */
  st.timers.push(setTimeout(() => {
    if (active === st) { room.wanderOn = true; room.wpTimer = 1.5 + Math.random() * 2; }
  }, KNOBS.wanderDelayMs));

  /* ---- the room's own rAF loop ---- */
  const tick = () => {
    if (active !== st) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - st.lastT) / 1000);
    st.lastT = now;
    _update(st, dt, now / 1000);
    if (api.composer && typeof api.composer.render === 'function') api.composer.render();
    else api.renderer.render(room.scene, room.camera);
    st.raf = requestAnimationFrame(tick);
  };

  active = st;
  st.raf = requestAnimationFrame(tick);
}

function _update(st, dt, t) {
  const room = st.room, rig = room.rig;

  /* ---- camera: damped limited orbit (drag deltas applied on pointermove) ---- */
  const yaw = lerp(room.yawCur ?? room.baseYaw, room.yaw, 1 - Math.exp(-KNOBS.orbitDamp * dt));
  const pitch = lerp(room.pitchCur ?? room.basePitch, room.pitch, 1 - Math.exp(-KNOBS.orbitDamp * dt));
  room.yawCur = yaw; room.pitchCur = pitch;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  room.camera.position.set(
    room.target.x + room.baseR * cp * Math.sin(yaw),
    room.target.y + room.baseR * sp,
    room.target.z + room.baseR * cp * Math.cos(yaw)
  );
  room.camera.lookAt(room.target);

  /* ---- resident wander: waypoints come from the spec ---- */
  if (room.wanderOn) {
    if (room.moving && room.wpTarget) {
      const p = rig.group.position;
      const dx = room.wpTarget.x - p.x, dz = room.wpTarget.z - p.z;
      const dist = Math.hypot(dx, dz);
      const step = KNOBS.wanderSpeed * dt;
      if (dist <= step + 0.02) {
        p.x = room.wpTarget.x; p.z = room.wpTarget.z;
        room.moving = false;
        rig.setState('idle');
        room.wpTimer = KNOBS.wanderIdleMin + Math.random() * (KNOBS.wanderIdleMax - KNOBS.wanderIdleMin);
      } else {
        p.x += (dx / dist) * step; p.z += (dz / dist) * step;
        rig.setFacing(Math.atan2(dx, dz));
      }
    } else {
      room.wpTimer -= dt;
      if (room.wpTimer <= 0) {
        // pick a waypoint different from the current one
        let next = (Math.random() * room.waypoints.length) | 0;
        if (next === room.wpIdx) next = (next + 1) % room.waypoints.length;
        room.wpIdx = next;
        room.wpTarget = room.waypoints[next];
        room.moving = true;
        rig.setState('walk');
      }
    }
  }

  /* ---- rig animation ---- */
  rig.update(dt, t);

  /* ---- dust drift (rise + sway, wrap) ---- */
  const pos = room.dust.geometry.attributes.position;
  const n = KNOBS.dustN;
  for (let i = 0; i < n; i++) {
    const s1 = room.dustSeed[i * 2], s2 = room.dustSeed[i * 2 + 1];
    let y = pos.getY(i) + dt * 0.12 * s2;
    if (y > 3.4) y = 0.15;
    pos.setY(i, y);
    pos.setX(i, pos.getX(i) + Math.sin(t * 0.7 + s1) * dt * 0.05);
  }
  pos.needsUpdate = true;

  /* ---- prop idle motion (estp bolt spin) ---- */
  if (room.prop.userData.spin) room.prop.rotation.y = t * 1.2;

  /* ---- day/night lerp via api.getNightF(), biased by the room spec ---- */
  let nf = 0;
  try { nf = clamp(st.api.getNightF ? st.api.getNightF() : 0, 0, 1); } catch (e) { nf = 0; }
  room.nightF = lerp(room.nightF, nf, 1 - Math.exp(-2 * dt));
  const f = room.nightF;
  const S = room.spec, bias = S.lightBias || 0.5;

  // key: day color = warm white biased toward the spec's lightTemp; night = moon blue
  _cA.set(0xffe7c4).lerp(_cB.set(S.lightTemp), bias);
  room.key.color.copy(_cA).lerp(_cB.set(0x8fa8ff), f);
  room.key.intensity = lerp(S.keyI[0], S.keyI[1], f);

  // hemi: gentle bias toward lightTemp, per-spec intensities
  _cA.set(0xbcd6ff).lerp(_cB.set(S.lightTemp), bias * 0.4);
  room.hemi.color.copy(_cA);
  room.hemi.intensity = lerp(S.hemiI ? S.hemiI[0] : KNOBS.dayHemiI, S.hemiI ? S.hemiI[1] : KNOBS.nightHemiI, f);

  // lamp: spec color, ramps up at night (single point light per room, as before)
  room.lampLight.intensity = lerp(0, S.lampNightI || KNOBS.lampNightI, f);
  if (room.shadeMat) {
    room.shadeMat.emissive.set(S.lampColor);
    room.shadeMat.emissiveIntensity = lerp(0.3, KNOBS.lampEmissivePeak, f);
  }

  // window pane: warm white by day -> moon blue by night, tinted toward lightTemp
  _cA.set(0xfff2d8).lerp(_cB.set(S.lightTemp), bias * 0.35);
  room.paneMat.emissive.copy(_cA).lerp(_cB.set(0x9fc4ff), f);
  room.paneMat.emissiveIntensity = KNOBS.windowEmissivePeak;
  room.shaftMat.opacity = lerp(KNOBS.shaftDayO, KNOBS.shaftNightO, f)
    * (1 + 0.08 * Math.sin(t * 0.9)); // subtle breathing
}

/** Room-entry greeting bubble: random per-type greeting shown with the
 *  greeting hop, auto-hides after a few seconds. Reuses the white-pill /
 *  colored-dot / dark-text bubble language. */
function _showGreeting(st, type) {
  const el = document.getElementById('greetBubble');
  if (!el || !type.greetings || !type.greetings.length) return;
  const g = type.greetings[(Math.random() * type.greetings.length) | 0];
  el.innerHTML =
    `<span class="dot" style="background:${type.color}"></span>` +
    `<span>\u201c${g}\u201d</span>`;
  el.classList.add('show');
  st.timers.push(setTimeout(() => {
    if (active === st) el.classList.remove('show');
  }, 4500));
}

function _exit(silent) {
  const st = active;
  if (!st) return;
  active = null;
  const gb = document.getElementById('greetBubble');
  if (gb) gb.classList.remove('show');
  cancelAnimationFrame(st.raf);
  _stopTimers(st);
  _detach(st);
  // restore the city's scene/camera on the shared render pass
  try {
    st.api.renderPass.scene = st.saved.scene;
    st.api.renderPass.camera = st.saved.camera;
  } catch (e) { /* host torn down; nothing to restore */ }
  if (!silent && st.onExit) {
    try { st.onExit(); } catch (e) { /* integrator callback must not break exit */ }
  }
}

/* ------------------------------------------------------------------ */
/* wire orbit pointermove lazily (single global listener, active-aware) */
/* ------------------------------------------------------------------ */
let orbitWired = false;
function _wireOrbitOnce() {
  if (orbitWired) return;
  orbitWired = true;
  window.addEventListener('pointermove', (e) => {
    const st = active;
    if (!st || !st.orbiting) return;
    // only when the pointer is over the room canvas
    const dx = e.clientX - st.lastOX, dy = e.clientY - st.lastOY;
    st.lastOX = e.clientX; st.lastOY = e.clientY;
    const room = st.room;
    room.yaw = clamp(room.yaw + dx * 0.004, room.baseYaw - KNOBS.yawRange, room.baseYaw + KNOBS.yawRange);
    room.pitch = clamp(room.pitch + dy * 0.003, KNOBS.pitchMin, KNOBS.pitchMax);
  }, { passive: true });
}
_wireOrbitOnce();

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */
export const Room3D = {
  enter(typeKey, api, onExit) { _enter(typeKey, api, onExit); },
  exit() { _exit(false); },
  getResident() { return active ? active.room.rig : null; },
  /* project the resident's head to client coords (for 3D-anchored DOM hints) */
  residentScreenPos() {
    if (!active) return null;
    const v = _projV.set(0, 0, 0);
    active.room.rig.group.getWorldPosition(v);
    v.y += 1.9; // above the blob's head
    v.project(active.room.camera);
    if (v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  },
  /** tuning knobs exposed for the integrator */
  knobs: KNOBS,
};
