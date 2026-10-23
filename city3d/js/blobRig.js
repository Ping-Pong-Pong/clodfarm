/**
 * blobRig.js — procedural 3D blob mascot rig for the TypePop 3D city.
 *
 * One BlobRig = one MBTI blob resident (bean body, dark oval eyes, two-leaf
 * sprout, nub arms, rounded feet). This REPLACES billboard sprites everywhere
 * (16 city wanderers + room interiors): one consistent 3D art direction.
 *
 * ---------------------------------------------------------------------------
 * API CONTRACT (the integrator depends on this exact API)
 * ---------------------------------------------------------------------------
 *   import { BlobRig, spawnPuff, updatePuffs } from './blobRig.js';
 *
 *   const rig = new BlobRig({ bodyColor: '#FF8C69' }); // CSS hex string or hex number
 *   scene.add(rig.group);            // group origin at FEET (y=0 = floor). Blob ~1.5 units tall.
 *   rig.group.position.set(x, 0, z); // move by setting group position
 *   rig.setState('idle' | 'walk' | 'happy' | 'sleep' | 'boop');
 *   rig.setFacing(radians);          // yaw; call each frame while walking with Math.atan2(vx, vz)
 *   rig.update(dt, t);               // dt seconds, t = elapsed seconds. Call every frame.
 *   rig.topY;                        // number ≈ 1.55, for label anchors
 *   rig.hitProxy;                    // invisible cylinder mesh (visible=false) sized to the body;
 *                                    // integrator adds it to raycast targets and sets userData on it.
 *                                    // (THREE.Raycaster intersects visible=false meshes, so this works.)
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
 * All geometries are module-level singletons shared by every rig. Materials are
 * cached per body color (one MeshPhysicalMaterial per color, shared by all rigs
 * of that color; feet use a cached 0.92-darkened variant). Nothing is allocated
 * inside update() — poses reuse preallocated objects.
 *
 * Three.js r170 API. CapsuleGeometry exists. `outputColorSpace` default is fine.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared module-level resources (allocated once)
// ---------------------------------------------------------------------------

function hexKey(c) {
  return '#' + new THREE.Color(c).getHexString();
}

const GEO = {
  body: new THREE.SphereGeometry(0.75, 24, 18),
  unit: new THREE.SphereGeometry(1, 12, 10),          // eyes, highlights, feet, leaves
  stem: new THREE.CylinderGeometry(0.03, 0.04, 0.28, 8),
  arm: new THREE.CapsuleGeometry(0.09, 0.18, 4, 12),
  shadow: new THREE.PlaneGeometry(2.0, 2.0),
  hit: new THREE.CylinderGeometry(0.95, 0.95, 1.7, 8),
};

const _bodyMats = new Map(); // hexKey -> MeshPhysicalMaterial (clearcoat clay)
const _darkMats = new Map(); // hexKey -> darkened MeshStandardMaterial (feet)

function bodyMaterial(colorKey) {
  let m = _bodyMats.get(colorKey);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color: colorKey,
      roughness: 0.55,
      clearcoat: 0.35,
      clearcoatRoughness: 0.6,
    });
    _bodyMats.set(colorKey, m);
  }
  return m;
}

function darkMaterial(colorKey) {
  let m = _darkMats.get(colorKey);
  if (!m) {
    const c = new THREE.Color(colorKey).multiplyScalar(0.92);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 });
    _darkMats.set(colorKey, m);
  }
  return m;
}

let _eyeMat = null;
let _highlightMat = null;
let _stemMat = null;
let _leafMat = null;

function eyeMaterial() {
  if (!_eyeMat) _eyeMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.4 });
  return _eyeMat;
}
function highlightMaterial() {
  if (!_highlightMat) _highlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  return _highlightMat;
}
function stemMaterial() {
  if (!_stemMat) _stemMat = new THREE.MeshStandardMaterial({ color: 0x5da85f, roughness: 0.6 });
  return _stemMat;
}
function leafMaterial() {
  if (!_leafMat) _leafMat = new THREE.MeshStandardMaterial({ color: 0x6fbf73, roughness: 0.6 });
  return _leafMat;
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
  sproutSwayAmp: 0.08, sproutSwayFreq: 1.7,
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
  return { sX: 1, sY: 1, sZ: 1, bobY: 0, roll: 0, eyeY: 1, sproutZ: 0, armL: 0, armR: 0, bodyY: 0.72 };
}

export class BlobRig {
  /**
   * @param {object} opts
   * @param {string|number} opts.bodyColor - CSS hex string ('#FF8C69') or hex number.
   */
  constructor({ bodyColor = '#FF8C69' } = {}) {
    const key = hexKey(bodyColor);
    const bMat = bodyMaterial(key);
    const dMat = darkMaterial(key);

    // group: origin at FEET (y=0 = floor). Integrator positions this.
    this.group = new THREE.Group();
    // bobber: carries everything that hops/waddles; shadow stays flat on the floor.
    this.bobber = new THREE.Group();
    this.group.add(this.bobber);

    // --- body (bean) ---
    this.body = new THREE.Mesh(GEO.body, bMat);
    this.body.scale.set(1.15, 0.95, 1.0);
    this.body.position.y = 0.72;
    this.body.castShadow = true;
    this.body.receiveShadow = false;
    this.bobber.add(this.body);

    // --- eyes (dark ovals, front = +z) + white highlight dots ---
    const eMat = eyeMaterial();
    const hMat = highlightMaterial();
    this.eyeL = new THREE.Mesh(GEO.unit, eMat);
    this.eyeL.scale.set(0.09, 0.13, 0.05);
    this.eyeL.position.set(-0.22, 0.85, 0.62);
    this.eyeR = new THREE.Mesh(GEO.unit, eMat);
    this.eyeR.scale.set(0.09, 0.13, 0.05);
    this.eyeR.position.set(0.22, 0.85, 0.62);
    this.hlL = new THREE.Mesh(GEO.unit, hMat);
    this.hlL.scale.setScalar(0.025);
    this.hlL.position.set(-0.25, 0.90, 0.665);
    this.hlR = new THREE.Mesh(GEO.unit, hMat);
    this.hlR.scale.setScalar(0.025);
    this.hlR.position.set(0.19, 0.90, 0.665);
    this.bobber.add(this.eyeL, this.eyeR, this.hlL, this.hlR);

    // --- sprout (stem + two leaves), sways ---
    this.sprout = new THREE.Group();
    this.sprout.position.set(0, 1.40, 0);
    const stem = new THREE.Mesh(GEO.stem, stemMaterial());
    stem.position.y = 0.14;
    stem.castShadow = true;
    const leafL = new THREE.Mesh(GEO.unit, leafMaterial());
    leafL.scale.set(0.154, 0.055, 0.077);
    leafL.position.set(-0.13, 0.30, 0);
    leafL.rotation.set(0, 0.4, -0.5);
    leafL.castShadow = true;
    const leafR = new THREE.Mesh(GEO.unit, leafMaterial());
    leafR.scale.set(0.154, 0.055, 0.077);
    leafR.position.set(0.13, 0.30, 0);
    leafR.rotation.set(0, -0.4, 0.5);
    leafR.castShadow = true;
    this.sprout.add(stem, leafL, leafR);
    this.bobber.add(this.sprout);

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
    this.topY = 1.55; // ≈ head-top height, for label anchors

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
    a.eyeY = b.eyeY; a.sproutZ = b.sproutZ; a.armL = b.armL; a.armR = b.armR; a.bodyY = b.bodyY;
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

    // --- base pose: idle breathing + sprout sway ---
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
    P.sproutZ = TUNE.sproutSwayAmp * Math.sin(t * TUNE.sproutSwayFreq);

    // --- blink (idle only): eyes shut to y=0.08 for 0.12s ---
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
        P.sproutZ += 0.12 * Math.sin(w + 1);
        break;
      }
      case 'happy': {
        const ht = this._stateT;
        P.eyeY = 1.2;
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
          P.eyeY = 1.2 - 0.2 * u;
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
        P.eyeY = 0.06 / 0.13;   // eyes shut
        P.bodyY = TUNE.sleepBodyY;
        P.sproutZ *= 0.4;       // calmer sway
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
      P.eyeY = 0.08 / 0.13; // blink overrides
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
      pose.sproutZ = a.sproutZ + (P.sproutZ - a.sproutZ) * k;
      pose.armL = a.armL + (P.armL - a.armL) * k;
      pose.armR = a.armR + (P.armR - a.armR) * k;
      pose.bodyY = a.bodyY + (P.bodyY - a.bodyY) * k;
    } else {
      pose.sX = P.sX; pose.sY = P.sY; pose.sZ = P.sZ; pose.bobY = P.bobY;
      pose.roll = P.roll; pose.eyeY = P.eyeY; pose.sproutZ = P.sproutZ;
      pose.armL = P.armL; pose.armR = P.armR; pose.bodyY = P.bodyY;
    }

    // --- apply ---
    this.body.scale.set(1.15 * pose.sX, 0.95 * pose.sY, 1.0 * pose.sZ);
    this.body.position.y = pose.bodyY;
    this.bobber.position.y = pose.bobY;
    this.bobber.rotation.z = pose.roll;
    const ey = 0.13 * pose.eyeY;
    this.eyeL.scale.y = ey;
    this.eyeR.scale.y = ey;
    this.sprout.rotation.z = pose.sproutZ;
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
