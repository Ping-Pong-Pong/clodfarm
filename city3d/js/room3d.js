/* ============================================================================
 * room3d.js — TypePop 3D City: full-3D dollhouse room interior (ROOM 3D v2)
 * ============================================================================
 * Replaces the old 2D-background interior path (js/interior.js, js/interior-fx.js).
 * Same art direction as the 3D city: low-poly primitives, warm lighting,
 * bloom-friendly emissives. Cutaway dollhouse: BACK + LEFT walls only.
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
import { BlobRig } from './blobRig.js';
import { typeByKey } from './types.js';

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

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function floorTexture() {
  return canvasTexture(512, (g, s) => {
    const rows = 8, rh = s / rows;
    const rnd = mulberry32(1234);
    for (let r = 0; r < rows; r++) {
      const base = 168 + rnd() * 26;
      g.fillStyle = `rgb(${base | 0},${(base * 0.78) | 0},${(base * 0.55) | 0})`;
      g.fillRect(0, r * rh, s, rh);
      // grain streaks
      g.strokeStyle = 'rgba(90,60,35,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const y = r * rh + rnd() * rh;
        g.beginPath();
        g.moveTo(0, y);
        g.bezierCurveTo(s * 0.3, y + (rnd() - 0.5) * 6, s * 0.7, y + (rnd() - 0.5) * 6, s, y);
        g.stroke();
      }
      // plank seams + staggered joints
      g.fillStyle = 'rgba(70,45,25,0.55)';
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
/* room builder (lazy, cached per typeKey)                             */
/* ------------------------------------------------------------------ */
const roomCache = new Map();

function buildRoom(typeKey) {
  const type = typeByKey(typeKey);
  const accent = new THREE.Color(type.color);
  const seed = [...typeKey].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = mulberry32(seed);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1620);
  scene.fog = new THREE.Fog(0x1a1620, 18, 34);

  const W = KNOBS.roomW, D = KNOBS.roomD, H = KNOBS.wallH;

  /* ---- floor: 10x8 wooden planks ---- */
  const floor = new THREE.Mesh(
    GEO.plane,
    stdMat('floor', { map: floorTexture(), roughness: 0.7 })
  );
  floor.material.map.repeat.set(2.5, 2);
  floor.material.map.wrapS = floor.material.map.wrapT = THREE.RepeatWrapping;
  floor.rotation.x = -Math.PI / 2;
  floor.scale.set(W, D, 1);
  floor.receiveShadow = true;
  scene.add(floor);

  /* ---- walls: back + left only (cutaway). Cream tinted 12% toward accent ---- */
  const cream = new THREE.Color(0xf3e9d7);
  const wallTint = cream.clone().lerp(accent, 0.12);
  const wallMat = stdMat('wall' + typeKey, { color: wallTint, roughness: 0.9 });
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

  /* ---- furniture (all castShadow via box()/helpers) ---- */
  const cushM = stdMat('cush' + typeKey, { color: accent, roughness: 0.85 });
  const woodM = stdMat('wood', { color: 0x8a6242, roughness: 0.65 });
  const darkM = stdMat('darkWood', { color: 0x5d4630, roughness: 0.7 });

  /* couch at (-2.5, 0, -2.6), facing +z */
  const couch = new THREE.Group();
  couch.position.set(-2.5, 0, -2.6);
  box(couch, 2.6, 0.55, 1.1, woodM, 0, 0.28, 0);
  box(couch, 2.6, 0.9, 0.3, woodM, 0, 0.85, -0.42);
  box(couch, 0.3, 0.75, 1.1, woodM, -1.15, 0.62, 0);
  box(couch, 0.3, 0.75, 1.1, woodM, 1.15, 0.62, 0);
  box(couch, 1.05, 0.22, 0.85, cushM, -0.55, 0.66, 0.05);
  box(couch, 1.05, 0.22, 0.85, cushM, 0.55, 0.66, 0.05);
  scene.add(couch);

  /* coffee table at (-2.5, 0, -0.8): cylinder top + 3 legs */
  const table = new THREE.Group();
  table.position.set(-2.5, 0, -0.8);
  const top = new THREE.Mesh(GEO.cyl, woodM);
  top.scale.set(1.7, 0.09, 1.7); top.position.y = 0.5;
  top.castShadow = true; top.receiveShadow = true; table.add(top);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(GEO.cyl, darkM);
    leg.scale.set(0.12, 0.48, 0.12);
    leg.position.set(Math.cos(a) * 0.55, 0.24, Math.sin(a) * 0.55);
    leg.castShadow = true; table.add(leg);
  }
  scene.add(table);
  const tableTopY = 0.55;

  /* bookshelf at (3.2, 0, -3.3): frame + 3 shelves + ~12 seeded books */
  const shelf = new THREE.Group();
  shelf.position.set(3.2, 0, -3.3);
  box(shelf, 1.6, 2.6, 0.5, darkM, 0, 1.3, 0);
  box(shelf, 1.4, 2.3, 0.34, stdMat('shelfInner', { color: 0x2c2318, roughness: 0.9 }), 0, 1.25, 0.05);
  const bookCols = [0xff6b6b, 0xffd93d, 0x4ecdc4, 0x8b5cf6, 0x6d9dc5, 0xa8e6cf, 0xf59e0b, 0xe8b84b];
  for (let s = 0; s < 3; s++) {
    const sy = 0.45 + s * 0.7;
    box(shelf, 1.4, 0.06, 0.36, woodM, 0, sy, 0.06);
    let bx = -0.6;
    for (let b = 0; b < 4 && bx < 0.55; b++) {
      const bw = 0.12 + rnd() * 0.1, bh = 0.4 + rnd() * 0.15;
      const bm = stdMat('book' + ((seed + s * 4 + b) % bookCols.length), {
        color: bookCols[(seed + s * 4 + b) % bookCols.length], roughness: 0.8 });
      box(shelf, bw, bh, 0.28, bm, bx + bw / 2, sy + 0.03 + bh / 2, 0.06);
      bx += bw + 0.03;
    }
  }
  scene.add(shelf);

  /* floor lamp at (4.2, 0, -2.6): pole + shade + night PointLight */
  const lamp = new THREE.Group();
  lamp.position.set(4.2, 0, -2.6);
  const pole = new THREE.Mesh(GEO.cyl, darkM);
  pole.scale.set(0.1, 2.0, 0.1); pole.position.y = 1.0; pole.castShadow = true; lamp.add(pole);
  const lampBase = new THREE.Mesh(GEO.cyl, darkM);
  lampBase.scale.set(0.5, 0.08, 0.5); lampBase.position.y = 0.04; lampBase.castShadow = true; lamp.add(lampBase);
  const shadeMat = new THREE.MeshStandardMaterial({
    color: accent, emissive: accent, emissiveIntensity: 0.3,
    roughness: 0.7, side: THREE.DoubleSide,
  });
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.6, 14, 1, true), shadeMat);
  shade.position.y = 2.1; shade.castShadow = true; lamp.add(shade);
  const lampLight = new THREE.PointLight(0xffc98a, 0, 9, 1.6);
  lampLight.position.y = 1.95;
  lamp.add(lampLight);
  scene.add(lamp);

  /* potted plant at (-4.2, 0, -1.2) */
  const plant = new THREE.Group();
  plant.position.set(-4.2, 0, -1.2);
  const pot = new THREE.Mesh(GEO.cyl, stdMat('plantPot', { color: 0xb0714f, roughness: 0.8 }));
  pot.scale.set(0.55, 0.5, 0.55); pot.position.y = 0.25; pot.castShadow = true; plant.add(pot);
  const leafM = stdMat('leaf', { color: 0x5da85f, roughness: 0.8 });
  [[0, 0.85, 0, 0.5], [0.25, 0.65, 0.1, 0.38], [-0.22, 0.68, -0.08, 0.42]].forEach(([x, y, z, s]) => {
    const leaf = new THREE.Mesh(GEO.ico, leafM);
    leaf.scale.setScalar(s); leaf.position.set(x, y, z); leaf.castShadow = true; plant.add(leaf);
  });
  scene.add(plant);

  /* round rug, center (0.5, 0, 0.8) — the resident's stage */
  const rug = new THREE.Mesh(GEO.circle, stdMat('rug' + typeKey, { color: accent, roughness: 0.95 }));
  rug.rotation.x = -Math.PI / 2;
  rug.scale.setScalar(4.4);
  rug.position.set(0.5, 0.012, 0.8);
  rug.receiveShadow = true;
  scene.add(rug);
  const rugRing = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.56, 28),
    stdMat('rugRing', { color: 0xf7f2e8, roughness: 0.95 })
  );
  rugRing.rotation.x = -Math.PI / 2;
  rugRing.scale.setScalar(3.7);
  rugRing.position.set(0.5, 0.014, 0.8);
  rugRing.receiveShadow = true;
  scene.add(rugRing);

  /* ---- signature prop: on the coffee table, or floor-standing for tall ones ---- */
  const floorProps = new Set(['entj']); // scepter stands on the floor
  const prop = buildProp(typeKey, accent);
  if (floorProps.has(typeKey)) {
    prop.position.set(-1.2, 0, -0.6); // beside the coffee table
  } else {
    prop.position.set(-2.5, tableTopY, -0.8);
  }
  scene.add(prop);

  /* ---- resident: BlobRig, built synchronously — room is NEVER empty ---- */
  const rig = new BlobRig({ bodyColor: type.color });
  rig.group.position.set(0.5, 0, 0.8); // center rug
  // face the room camera's start position
  rig.setFacing(Math.atan2(KNOBS.camPos[0] - 0.5, KNOBS.camPos[2] - 0.8));
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
    // wander state
    waypoints: [
      new THREE.Vector3(0.5, 0, 0.8),    // rug center (hero spot)
      new THREE.Vector3(1.0, 0, -1.9),   // window front
      new THREE.Vector3(-0.9, 0, -1.3),  // couch side
    ],
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

  /* ---- resident reset: always present, hero framing ---- */
  room.rig.group.position.set(0.5, 0, 0.8);
  room.rig.setFacing(Math.atan2(KNOBS.camPos[0] - 0.5, KNOBS.camPos[2] - 0.8));
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

  /* ---- arrival beat: one greeting hop ~0.8s after the transition ---- */
  st.timers.push(setTimeout(() => {
    if (active === st) room.rig.setState('happy');
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

  /* ---- resident wander: rug -> window -> couch side ---- */
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

  /* ---- day/night lerp via api.getNightF() ---- */
  let nf = 0;
  try { nf = clamp(st.api.getNightF ? st.api.getNightF() : 0, 0, 1); } catch (e) { nf = 0; }
  room.nightF = lerp(room.nightF, nf, 1 - Math.exp(-2 * dt));
  const f = room.nightF;

  room.key.intensity = lerp(KNOBS.dayKeyI, KNOBS.nightKeyI, f);
  room.key.color.set(0xffe7c4).lerp(new THREE.Color(0x8fa8ff), f);
  room.hemi.intensity = lerp(KNOBS.dayHemiI, KNOBS.nightHemiI, f);
  room.lampLight.intensity = lerp(0, KNOBS.lampNightI, f);
  room.shadeMat.emissiveIntensity = lerp(0.3, KNOBS.lampEmissivePeak, f);
  // window pane: warm white by day -> moon blue by night (kept at bloom peak)
  room.paneMat.emissive.set(0xfff2d8).lerp(new THREE.Color(0x9fc4ff), f);
  room.paneMat.emissiveIntensity = KNOBS.windowEmissivePeak;
  room.shaftMat.opacity = lerp(KNOBS.shaftDayO, KNOBS.shaftNightO, f)
    * (1 + 0.08 * Math.sin(t * 0.9)); // subtle breathing
}

function _exit(silent) {
  const st = active;
  if (!st) return;
  active = null;
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
  /** tuning knobs exposed for the integrator */
  knobs: KNOBS,
};
