/* TypePop City 3D — city shell (Worker 1).
 *
 * Owns the 3D town, residents, camera, HUD and the step-inside flow.
 * Contract with the interiors (js/room3d.js): Room3D.enter(typeKey, api, onExit)
 * reuses our renderer + composer (swaps the RenderPass scene/camera).
 * Our flow: fly-to-door (cutaway path) -> veil on -> Room3D.enter(key, api, onExit)
 * -> we pause our rAF loop; onExit resumes it.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TYPES, typeByKey } from './types.js?v=2';
import { BlobRig, updatePuffs } from './blobRig.js';
import { Room3D } from './room3d.js?v=2';

/* ================= boot / diagnostics ================= */
const errEl = document.getElementById('errtoast');
function toast(msg) {
  errEl.style.display = 'block';
  errEl.textContent = msg;
}
window.addEventListener('error', (e) => {
  if (errEl && !errEl.dataset.watchdog) toast('Error: ' + (e.message || 'unknown'));
});

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapDelta = (d) => Math.atan2(Math.sin(d), Math.cos(d));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rand = (a, b) => a + Math.random() * (b - a);

/* ================= renderer / composer ================= */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  toast('WebGL unavailable: ' + e.message);
  throw e;
}
// Cap pixel ratio for phone perf (1.75 proven good on hd2d-demo).
const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.75);
renderer.setPixelRatio(PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY_DAY = new THREE.Color(0x9fd4ef);
const SKY_NIGHT = new THREE.Color(0x0b1026);
scene.background = new THREE.Color().copy(SKY_DAY);
scene.fog = new THREE.Fog(scene.background.clone(), 70, 160);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);

// NOTE: samples must stay 0 — a multisampled half-float render target
// renders pure black on iOS Safari (hard-won lesson from hd2d-demo).
const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  samples: 0, type: THREE.HalfFloatType,
});
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(PIXEL_RATIO);
composer.setSize(window.innerWidth, window.innerHeight);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
// High threshold so only lamps / lit windows / pins bloom.
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ================= lights ================= */
const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
sun.position.set(28, 42, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -38; sun.shadow.camera.right = 38;
sun.shadow.camera.top = 38; sun.shadow.camera.bottom = -38;
sun.shadow.camera.near = 5; sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0004;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x6a8f5f, 0.75);
scene.add(hemi);
// A few real point lights for the plaza lamps (no shadows — cheap).
const lampLights = [];
for (let i = 0; i < 3; i++) {
  const pl = new THREE.PointLight(0xffb45e, 0, 22, 2);
  const a = (i / 3) * Math.PI * 2 + 0.5;
  pl.position.set(Math.cos(a) * 12, 3.4, Math.sin(a) * 12);
  scene.add(pl);
  lampLights.push(pl);
}

/* ================= ground / plaza / paths ================= */
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#7fae66';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(110,160,90,.5)' : 'rgba(150,190,120,.45)';
    const s = rand(3, 14);
    g.fillRect(rand(0, 256), rand(0, 256), s, s * 0.7);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(75, 48),
  new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const stoneMat = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.95 });
const plaza = new THREE.Mesh(new THREE.CircleGeometry(8.2, 40), stoneMat);
plaza.rotation.x = -Math.PI / 2;
plaza.position.y = 0.02;
plaza.receiveShadow = true;
scene.add(plaza);

const pathMat = new THREE.MeshStandardMaterial({ color: 0xd9b98a, roughness: 1 });
const ringPath = new THREE.Mesh(new THREE.RingGeometry(8.2, 11, 48), pathMat);
ringPath.rotation.x = -Math.PI / 2;
ringPath.position.y = 0.03;
ringPath.receiveShadow = true;
scene.add(ringPath);

/* ================= fountain / pond ================= */
const fountain = new THREE.Group();
{
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 1.0, 24), stoneMat);
  basin.position.y = 0.5; basin.castShadow = true;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.18, 10, 32), stoneMat);
  rim.rotation.x = Math.PI / 2; rim.position.y = 1.02; rim.castShadow = true;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 12), stoneMat);
  column.position.y = 1.4; column.castShadow = true;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), stoneMat);
  knob.position.y = 2.3;
  fountain.add(basin, rim, column, knob);
}
const waterMat = new THREE.MeshStandardMaterial({
  color: 0x4fa8d8, transparent: true, opacity: 0.88, roughness: 0.15, metalness: 0.1,
});
const water = new THREE.Mesh(new THREE.CircleGeometry(2.15, 28), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.y = 0.92;
fountain.add(water);
scene.add(fountain);

const POND = new THREE.Vector3(14, 0, 9);
const pond = new THREE.Mesh(
  new THREE.CircleGeometry(4.6, 32),
  new THREE.MeshStandardMaterial({ color: 0x3f96c9, roughness: 0.2, metalness: 0.05 })
);
pond.rotation.x = -Math.PI / 2;
pond.position.set(POND.x, 0.025, POND.z);
pond.receiveShadow = true;
scene.add(pond);

/* ================= trees ================= */
const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.2, 7);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
const canopyGeo = new THREE.IcosahedronGeometry(1.15, 0);
const canopyMats = [0x5d9c52, 0x6fae5e, 0x4f8f47].map((c) =>
  new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
function addTree(x, z, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = 0.6 * s; trunk.castShadow = true;
  const canopy = new THREE.Mesh(canopyGeo, canopyMats[(Math.random() * 3) | 0]);
  canopy.position.y = (1.2 + 1.0) * s; canopy.castShadow = true;
  canopy.rotation.y = rand(0, Math.PI);
  g.add(trunk, canopy);
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  scene.add(g);
}
for (let i = 0; i < 22; i++) {
  const a = rand(0, Math.PI * 2), r = rand(33, 46);
  addTree(Math.cos(a) * r, Math.sin(a) * r, rand(0.8, 1.5));
}
for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2 + 0.3;
  addTree(POND.x + Math.cos(a) * 6.4, POND.z + Math.sin(a) * 6.4, rand(0.9, 1.3));
}

/* ================= lamps ================= */
const lampHeadGeo = new THREE.SphereGeometry(0.28, 12, 10);
const lampHeadMat = new THREE.MeshStandardMaterial({
  color: 0x443a2c, emissive: 0xffca7a, emissiveIntensity: 0.4, roughness: 0.5,
});
const lampPoleGeo = new THREE.CylinderGeometry(0.08, 0.11, 3.0, 8);
const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.8 });
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + 0.2;
  const x = Math.cos(a) * 12.4, z = Math.sin(a) * 12.4;
  const pole = new THREE.Mesh(lampPoleGeo, lampPoleMat);
  pole.position.set(x, 1.5, z); pole.castShadow = true;
  const head = new THREE.Mesh(lampHeadGeo, lampHeadMat);
  head.position.set(x, 3.15, z);
  scene.add(pole, head);
}

/* ================= houses ================= */
const RING_R = 26;
const bodyGeo = new THREE.BoxGeometry(6, 4, 5);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf3e7d3, roughness: 0.9 });
const doorGeo = new THREE.BoxGeometry(1.3, 2.4, 0.18);
const doorMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 });
const winGeo = new THREE.PlaneGeometry(1.1, 1.1);
const hitGeo = new THREE.BoxGeometry(10, 10, 10);
const hitMat = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
});
const triShape = new THREE.Shape();
triShape.moveTo(-3.5, 0); triShape.lineTo(3.5, 0); triShape.lineTo(0, 2.5); triShape.closePath();
const roofGeo = new THREE.ExtrudeGeometry(triShape, { depth: 5.7, bevelEnabled: false });
roofGeo.translate(0, 0, -2.85);

const houses = [];       // {key, idx, type, group, pos, angle, doorPos, doorTheta, roofTopY, winMats}
const tapTargets = [];   // hit boxes + pin groups for raycast
const tagsRoot = document.getElementById('tags');

TYPES.forEach((t, i) => {
  const a = (i / TYPES.length) * Math.PI * 2;
  const pos = new THREE.Vector3(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R);
  const g = new THREE.Group();
  g.position.copy(pos);
  g.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a)); // front (+z) faces plaza

  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 2; body.castShadow = true; body.receiveShadow = true;
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
    color: new THREE.Color(t.color), roughness: 0.7, flatShading: true,
  }));
  roof.position.y = 4; roof.castShadow = true;
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.position.set(0, 1.2, 2.56);
  g.add(body, roof, door);

  const winMats = [];
  [-1.75, 1.75].forEach((wx) => {
    const wm = new THREE.MeshStandardMaterial({
      color: 0x3a2c1c, emissive: 0xffd27a, emissiveIntensity: 0.25, roughness: 0.4,
    });
    const w = new THREE.Mesh(winGeo, wm);
    w.position.set(wx, 2.3, 2.52);
    g.add(w);
    winMats.push(wm);
  });
  scene.add(g);

  // radial path from ring path to the door
  const dirC = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
  const spoke = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 14.5), pathMat);
  spoke.rotation.x = -Math.PI / 2;
  spoke.rotation.z = -a + Math.PI / 2;
  spoke.position.set(Math.cos(a) * 18.2, 0.03, Math.sin(a) * 18.2);
  spoke.receiveShadow = true;
  scene.add(spoke);

  const doorPos = pos.clone().addScaledVector(dirC, 2.7);
  const hit = new THREE.Mesh(hitGeo, hitMat);
  hit.position.set(pos.x, 4.5, pos.z);
  hit.userData.houseKey = t.key;
  scene.add(hit);
  tapTargets.push(hit);

  const tag = document.createElement('div');
  tag.className = 'tag house';
  tag.style.setProperty('--tc', t.color);
  tag.textContent = t.name;
  tagsRoot.appendChild(tag);

  houses.push({
    key: t.key, idx: i, type: t, group: g, pos,
    angle: a,
    doorPos,
    doorTheta: Math.atan2(dirC.x, dirC.z),
    roofTopY: 6.6,
    winMats,
    tagEl: tag,
  });
});
const houseByKey = (k) => houses.find((h) => h.key === k);

/* ================= residents (procedural 3D blob rigs + wander AI) ================= */
const residents = []; // {key,type,rig,node,pos,state,t,target,targetHouse,visitHouse,chatWith,friends,tagEl,bubbleEl,...}
function makeResidentDom(t) {
  const tag = document.createElement('div');
  tag.className = 'tag pal';
  tag.style.setProperty('--tc', t.color);
  tag.textContent = t.palName;
  tagsRoot.appendChild(tag);
  const bub = document.createElement('div');
  bub.className = 'bubble hidden';
  bub.style.setProperty('--tc', t.color);
  bub.innerHTML = '<span class="dot"></span><span class="txt"></span>';
  tagsRoot.appendChild(bub);
  return { tag, bub, txt: bub.querySelector('.txt') };
}
function residentHomePos(key) {
  const h = houseByKey(key);
  return h.doorPos.clone().add(new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)));
}
function pickTarget(r) {
  r.targetHouse = null; r.visitHouse = null;
  if (Math.random() < 0.38) {
    const h = houses[(Math.random() * houses.length) | 0];
    r.targetHouse = h.key;
    r.target.copy(h.doorPos).add(new THREE.Vector3(rand(-2.5, 2.5), 0, rand(-1, 2.5)));
  } else {
    const a = rand(0, Math.PI * 2), rad = rand(9, 27);
    r.target.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
  }
  r.state = 'walk';
  r.speed = rand(2.0, 2.8);
}
function onArrive(r) {
  if (r.targetHouse && r.targetHouse !== r.key && Math.random() < 0.4) {
    r.state = 'visit';
    r.visitHouse = r.targetHouse;
    r.t = rand(8, 14);
    spawnPin(r.visitHouse, 'visitor');
  } else {
    r.state = 'idle';
    r.t = rand(2, 6);
  }
  r.targetHouse = null;
}
function endVisit(r) {
  if (r.visitHouse) removePin(r.visitHouse, 'visitor');
  r.visitHouse = null;
  r.state = 'idle';
  r.t = rand(1.5, 4);
}
function moodFor(r) {
  switch (r.state) {
    case 'walk':
      return r.targetHouse
        ? `Strolling to ${typeByKey(r.targetHouse).palName}’s place`
        : 'Wandering the lanes';
    case 'visit': return `Visiting ${typeByKey(r.visitHouse).palName}`;
    case 'chat': return `Chatting with ${typeByKey(r.chatWith).palName}`;
    default: return 'Lounging at home';
  }
}
function updateResident(r, dt, now) {
  const p = r.node.position;
  // AI state machine; the rig's own animation states are driven below.
  switch (r.state) {
    case 'idle':
      r.t -= dt;
      if (r.t <= 0) pickTarget(r);
      break;
    case 'walk': {
      const dx = r.target.x - p.x, dz = r.target.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) { onArrive(r); break; }
      const vx = (dx / d) * r.speed, vz = (dz / d) * r.speed;
      p.x += vx * dt; p.z += vz * dt;
      r.rig.setFacing(Math.atan2(vx, vz));
      break;
    }
    case 'visit':
      r.t -= dt;
      if (r.t <= 0) endVisit(r);
      break;
    case 'chat':
      r.t -= dt;
      if (r.t <= 0) { r.state = 'idle'; r.t = rand(2, 5); r.chatWith = null; }
      break;
  }
  // Map AI state -> rig animation state (only on change; the rig owns the motion).
  // At night, idle residents near home settle into sleep.
  // Chat re-triggers 'happy' every frame: the rig's hop timeline ends in idle,
  // so this loops the celebration for the whole conversation.
  if (r.state === 'chat') {
    r.rig.setState('happy');
    r._rigState = 'happy';
  } else {
    const want = r.state === 'walk' ? 'walk'
      : (nightF > 0.6 && r.state === 'idle' ? 'sleep' : 'idle');
    if (r._rigState !== want) { r.rig.setState(want); r._rigState = want; }
  }
  r.rig.update(dt, now / 1000);
}
function tryMeetings(dt) {
  for (let i = 0; i < residents.length; i++) {
    for (let j = i + 1; j < residents.length; j++) {
      const a = residents[i], b = residents[j];
      if (a.state === 'chat' || b.state === 'chat') continue;
      if (a.state === 'visit' || b.state === 'visit') continue;
      const dx = a.node.position.x - b.node.position.x;
      const dz = a.node.position.z - b.node.position.z;
      if (dx * dx + dz * dz > 2.4 * 2.4) continue;
      const pair = a.key < b.key ? a.key + b.key : b.key + a.key;
      if (Math.random() > dt * 0.25) continue; // ~25%/s chance while close
      a.lastMeet = a.lastMeet || {};
      b.lastMeet = b.lastMeet || {};
      const nowMs = performance.now();
      if (nowMs - (a.lastMeet[pair] || 0) < 45000) continue;
      a.lastMeet[pair] = nowMs;
      b.lastMeet[pair] = nowMs;
      a.state = b.state = 'chat';
      a.t = b.t = rand(4, 6);
      a.chatWith = b.key; b.chatWith = a.key;
      a.friends.add(b.key); b.friends.add(a.key);
      // friendship pin over the nearest house
      let best = houses[0], bd = Infinity;
      const mx = (a.node.position.x + b.node.position.x) / 2;
      const mz = (a.node.position.z + b.node.position.z) / 2;
      for (const h of houses) {
        const d = (h.pos.x - mx) ** 2 + (h.pos.z - mz) ** 2;
        if (d < bd) { bd = d; best = h; }
      }
      spawnPin(best.key, 'friends', 25);
    }
  }
}

/* ================= floating event pins ================= */
const pinPool = [];
const activePins = []; // {g, houseKey, kind, ttl, phase}
{
  const coneGeo = new THREE.ConeGeometry(0.42, 1.1, 10);
  const ballGeo = new THREE.SphereGeometry(0.22, 10, 8);
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x33270f, emissive: 0xffcf5e, emissiveIntensity: 1.6, roughness: 0.5,
    });
    const cone = new THREE.Mesh(coneGeo, mat);
    cone.rotation.x = Math.PI; // tip down
    cone.position.y = -0.55;
    const ball = new THREE.Mesh(ballGeo, mat);
    ball.position.y = 0.18;
    g.add(cone, ball);
    g.visible = false;
    g.userData.mat = mat;
    scene.add(g);
    pinPool.push(g);
  }
}
function spawnPin(houseKey, kind, ttl = Infinity, delayMs = 0) {
  if (activePins.some((p) => p.houseKey === houseKey && p.kind === kind)) return;
  const g = pinPool.find((x) => !x.visible);
  if (!g) return;
  g.visible = true;
  g.userData.houseKey = houseKey;
  g.userData.mat.emissive.set(kind === 'visitor' ? 0x7dd3fc : 0xffcf5e);
  // staged arrival: pins scale in with a stagger rather than popping
  const bornAt = performance.now() + delayMs;
  g.scale.setScalar(0.001);
  const pin = { g, houseKey, kind, ttl, phase: rand(0, Math.PI * 2), bornAt };
  activePins.push(pin);
  tapTargets.push(g);
}
function removePin(houseKey, kind) {
  const i = activePins.findIndex((p) => p.houseKey === houseKey && p.kind === kind);
  if (i < 0) return;
  const [pin] = activePins.splice(i, 1);
  pin.g.visible = false;
  const ti = tapTargets.indexOf(pin.g);
  if (ti >= 0) tapTargets.splice(ti, 1);
}
function updatePins(dt, now) {
  for (let i = activePins.length - 1; i >= 0; i--) {
    const pin = activePins[i];
    if (pin.ttl !== Infinity) {
      pin.ttl -= dt;
      if (pin.ttl <= 0) { removePin(pin.houseKey, pin.kind); continue; }
    }
    // scale-in over ~280ms after the stagger delay (staged arrival)
    const age = now - pin.bornAt;
    if (age < 0) { pin.g.scale.setScalar(0.001); continue; }
    const s = Math.min(1, age / 280);
    const e = 1 + 2.2 * Math.pow(s - 1, 3) + 1.2 * Math.pow(s - 1, 2); // easeOutBack-ish
    pin.g.scale.setScalar(Math.max(0.001, e));
    const h = houseByKey(pin.houseKey);
    pin.g.position.set(
      h.pos.x,
      h.roofTopY + 2.3 + Math.sin(now * 0.0022 + pin.phase) * 0.35,
      h.pos.z
    );
    pin.g.rotation.y = now * 0.001 + pin.phase;
  }
}

/* ================= camera ================= */
const ESTABLISH = { theta: 0.7, phi: 0.92, radius: 44, look: new THREE.Vector3(0, 1.5, 0) };
const cam = {
  theta: ESTABLISH.theta, phi: ESTABLISH.phi, radius: ESTABLISH.radius,
  look: ESTABLISH.look.clone(),
};
const goal = {
  theta: ESTABLISH.theta, phi: ESTABLISH.phi, radius: ESTABLISH.radius,
  look: ESTABLISH.look.clone(),
};
function applyCam() {
  camera.position.set(
    cam.look.x + cam.radius * Math.sin(cam.phi) * Math.sin(cam.theta),
    cam.look.y + cam.radius * Math.cos(cam.phi),
    cam.look.z + cam.radius * Math.sin(cam.phi) * Math.cos(cam.theta)
  );
  camera.lookAt(cam.look);
}
let flight = null; // {keys, i, t, from{...}}
function flyTo(keys) {
  return new Promise((resolve) => { flight = { keys, i: 0, t: 0, from: null, resolve }; });
}
function stepFlight(dt) {
  if (!flight) return;
  const k = flight.keys[flight.i];
  if (!flight.from) {
    flight.from = {
      theta: goal.theta, phi: goal.phi, radius: goal.radius,
      look: goal.look.clone(),
    };
    flight.t = 0;
  }
  flight.t += dt;
  const p = clamp(flight.t / k.dur, 0, 1);
  const e = easeInOut(p);
  const f = flight.from;
  goal.theta = f.theta + wrapDelta(k.theta - f.theta) * e;
  goal.phi = lerp(f.phi, k.phi, e);
  goal.radius = lerp(f.radius, k.radius, e);
  goal.look.lerpVectors(f.look, k.look, e);
  if (p >= 1) {
    flight.i++;
    flight.from = null;
    if (flight.i >= flight.keys.length) {
      const r = flight.resolve;
      flight = null;
      if (r) r();
    }
  }
}
const OV = { theta: 0.7, phi: 0.92, radius: 44 };
function flyOverview() {
  return flyTo([{ ...OV, look: new THREE.Vector3(0, 1.5, 0), dur: 1.2 }]);
}
// Cutaway transition: the flight first swings UP high so the house reads as a
// dollhouse cutaway model, then descends to the door — stepping into the HD-2D
// interior feels continuous.
function flyToDoor(h) {
  const lookDoor = new THREE.Vector3(h.doorPos.x, 1.8, h.doorPos.z);
  return flyTo([
    { theta: h.doorTheta, phi: 0.34, radius: 46, look: new THREE.Vector3(h.pos.x, 2, h.pos.z), dur: 0.5 },
    { theta: h.doorTheta, phi: 0.62, radius: 24, look: lookDoor.clone(), dur: 0.45 },
    { theta: h.doorTheta, phi: 1.2, radius: 9.5, look: lookDoor.clone(), dur: 0.55 },
  ]);
}
function flyToHouse(h) {
  const theta = Math.PI / 2 - h.angle; // camera outside the ring, looking in
  return flyTo([{
    theta, phi: 0.86, radius: 21,
    look: new THREE.Vector3(h.pos.x, 2.2, h.pos.z), dur: 1.15,
  }]);
}

/* pointer controls: drag to turn, scroll/pinch to zoom, tap to select */
const pointers = new Map();
let pinchDist = 0;
let lastInteract = performance.now();
let downInfo = null;
const el = renderer.domElement;
el.style.touchAction = 'none';
el.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) downInfo = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
  if (flight) { const r = flight.resolve; flight = null; if (r) r(); } // don't strand awaiters
  focusKey = null;           // stop following the resident
  syncOverview();
  lastInteract = performance.now();
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastInteract = performance.now();
  if (pointers.size === 1) {
    goal.theta -= dx * 0.0052;
    goal.phi = clamp(goal.phi + dy * 0.004, 0.35, 1.25);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0 && d > 0) goal.radius = clamp(goal.radius * (pinchDist / d), 18, 60);
    pinchDist = d;
  }
});
el.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (downInfo && pointers.size === 0) {
    const moved = Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y);
    const dtms = performance.now() - downInfo.t;
    if (moved < 9 && dtms < 450) handleTap(e.clientX, e.clientY);
  }
  downInfo = null;
});
el.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); downInfo = null; });
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  goal.radius = clamp(goal.radius * (1 + e.deltaY * 0.0011), 18, 60);
  lastInteract = performance.now();
}, { passive: false });

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function handleTap(cx, cy) {
  if (roomActive) return; // the 3D room owns taps while active
  ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(tapTargets, true);
  if (!hits.length) return;
  let o = hits[0].object;
  // resident boop? (hitProxy carries userData.residentKey)
  let n = o;
  while (n && !n.userData.residentKey && !n.userData.houseKey) n = n.parent;
  if (n && n.userData.residentKey) {
    const r = residents.find((x) => x.key === n.userData.residentKey);
    if (r) { r.rig.setState('boop'); r._rigState = 'boop'; }
    return;
  }
  while (o && !o.userData.houseKey) o = o.parent;
  if (o) selectHouse(o.userData.houseKey, { fly: true, sheet: true });
}

/* ================= selection: sheet / rail / directory ================= */
const sheetEl = document.getElementById('sheet');
const backdropEl = document.getElementById('sheetBackdrop');
let sheetKey = null;
let focusKey = null; // resident the camera is glued to ("Meet the resident")
const FOCUS_BUBBLE_MS = 12000;

function traitsFor(t) {
  return [
    `Keeps a ${t.prop} by the front door`,
    `Certified ${t.nickname.replace(/^The /, '').toLowerCase()}`,
    `Often overheard: \u201c${t.oneLiners[0]}\u201d`,
  ];
}
const overviewBtn = document.getElementById('btnOverview');
// The Overview pill only appears while a house is focused (sheet open or
// resident followed) — otherwise the city IS the overview.
function syncOverview() {
  overviewBtn.classList.toggle('show', !!(sheetKey || focusKey));
}
function openSheet(key) {
  const h = houseByKey(key);
  const t = h.type;
  sheetKey = key;
  document.getElementById('shEyebrow').textContent =
    `HOUSE ${String(h.idx + 1).padStart(2, '0')} \u00b7 ${t.name}`;
  document.getElementById('shAvatar').src = `../city/assets/blob_${t.key}_open.png`;
  document.getElementById('shTitle').textContent = t.nickname;
  document.getElementById('shDesc').textContent =
    `${t.palName}, the ${t.nickname.toLowerCase()} of the block \u2014 rarely seen without a ${t.prop}.`;
  const traits = document.getElementById('shTraits');
  traits.innerHTML = '';
  traitsFor(t).forEach((tr, i) => {
    const li = document.createElement('li');
    li.dataset.n = i + 1;
    li.textContent = tr;
    traits.appendChild(li);
  });
  refreshSheetLive();
  sheetEl.classList.add('open');
  sheetEl.setAttribute('aria-hidden', 'false');
  backdropEl.classList.add('open');
  markRailActive(key);
  syncOverview();
}
function refreshSheetLive() {
  if (!sheetKey) return;
  const r = residents.find((x) => x.key === sheetKey);
  if (!r) return;
  document.getElementById('shMood').textContent = moodFor(r);
  document.getElementById('shFriends').textContent =
    r.friends.size ? `${r.friends.size} \u2014 ${[...r.friends].map((k) => typeByKey(k).palName).join(', ')}` : 'None yet';
  // live status line: the resident's current activity, rotating every ~6s
  // through their type-flavored present-tense activities (highest-ROI liveliness trick)
  const acts = r.type.activities || [];
  if (acts.length) {
    const act = acts[Math.floor(Date.now() / 6000) % acts.length];
    const doingEl = document.getElementById('shDoing');
    const html = `<span class="dot"></span>${r.type.palName.toUpperCase()} &middot; ${act}`;
    if (doingEl.dataset.act !== act) {
      doingEl.dataset.act = act;
      doingEl.innerHTML = html;
    }
  }
}
function closeSheet() {
  sheetKey = null;
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  backdropEl.classList.remove('open');
  syncOverview();
}
backdropEl.addEventListener('click', closeSheet);
// drag-down to dismiss
{
  const grab = document.getElementById('sheetGrab');
  const eyebrow = document.getElementById('shEyebrow');
  let sy = null, dy = 0;
  const start = (y) => { sy = y; dy = 0; sheetEl.classList.add('dragging'); };
  const move = (y) => {
    if (sy === null) return;
    dy = Math.max(0, y - sy);
    sheetEl.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (sy === null) return;
    sheetEl.classList.remove('dragging');
    sheetEl.style.transform = '';
    if (dy > 90) closeSheet();
    sy = null;
  };
  [grab, eyebrow].forEach((zone) => {
    zone.addEventListener('pointerdown', (e) => start(e.clientY));
    zone.addEventListener('pointermove', (e) => move(e.clientY));
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  });
}
async function selectHouse(key, { fly = true, sheet = true } = {}) {
  const h = houseByKey(key);
  if (!h) return;
  // Staged arrival (towers.app sequencing): the camera flight lands FIRST,
  // the card content cross-swaps only ON ARRIVAL — nothing pops early.
  focusKey = null;
  markRailActive(key);
  if (fly) { await flyToHouse(h); lastInteract = performance.now(); }
  if (sheet) openSheet(key);
}

/* rail */
const railTicks = document.getElementById('railTicks');
const tickBtns = {};
TYPES.forEach((t) => {
  const b = document.createElement('button');
  b.className = 'tick';
  b.style.background = t.color;
  b.title = `${t.name} \u2014 ${t.nickname}`;
  b.setAttribute('aria-label', `Fly to ${t.name} house`);
  b.addEventListener('click', () => selectHouse(t.key, { fly: true, sheet: true }));
  railTicks.appendChild(b);
  tickBtns[t.key] = b;
});
function markRailActive(key) {
  Object.entries(tickBtns).forEach(([k, b]) => b.classList.toggle('active', k === key));
}
let railOrderIdx = 0;
document.getElementById('railUp').addEventListener('click', () => {
  railOrderIdx = (railOrderIdx - 1 + TYPES.length) % TYPES.length;
  selectHouse(TYPES[railOrderIdx].key, { fly: true, sheet: true });
});
document.getElementById('railDown').addEventListener('click', () => {
  railOrderIdx = (railOrderIdx + 1) % TYPES.length;
  selectHouse(TYPES[railOrderIdx].key, { fly: true, sheet: true });
});
setInterval(() => {
  // highlight the tick nearest the current camera target
  let best = null, bd = Infinity;
  for (const h of houses) {
    const d = (h.pos.x - goal.look.x) ** 2 + (h.pos.z - goal.look.z) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  if (best && !sheetKey) markRailActive(best.key);
}, 600);

/* directory: rows [number | type | playful title] + live search */
const dirEl = document.getElementById('directory');
const dirList = document.getElementById('dirList');
const dirSearch = document.getElementById('dirSearch');
function buildDirRows(filter = '') {
  dirList.innerHTML = '';
  const q = filter.trim().toLowerCase();
  TYPES.forEach((t, i) => {
    const hay = `${t.name} ${t.nickname} ${t.palName}`.toLowerCase();
    if (q && !hay.includes(q)) return;
    const row = document.createElement('button');
    row.className = 'dir-row';
    row.innerHTML =
      `<span class="num">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="sw" style="background:${t.color}"></span>` +
      `<span class="code">${t.name}</span><span class="nick">${t.nickname}</span>`;
    row.setAttribute('aria-label', `Fly to the ${t.name} house`);
    row.addEventListener('click', () => {
      closeDir();
      selectHouse(t.key, { fly: true, sheet: true });
    });
    dirList.appendChild(row);
  });
  if (!dirList.children.length) {
    const empty = document.createElement('div');
    empty.className = 'dir-row';
    empty.style.cursor = 'default';
    empty.innerHTML = `<span class="nick">No resident matches \u201c${filter}\u201d</span>`;
    dirList.appendChild(empty);
  }
}
function openDir() {
  dirSearch.value = '';
  buildDirRows();
  dirEl.classList.add('open');
  dirEl.classList.remove('closed');
  dirEl.setAttribute('aria-hidden', 'false');
}
function closeDir() {
  dirEl.classList.remove('open');
  dirEl.classList.add('closed');
  dirEl.setAttribute('aria-hidden', 'true');
}
dirSearch.addEventListener('input', () => buildDirRows(dirSearch.value));
buildDirRows();
document.getElementById('btnDirectory').addEventListener('click', () => {
  if (dirEl.classList.contains('open')) closeDir();
  else openDir();
});
document.getElementById('dirClose').addEventListener('click', closeDir);
document.getElementById('btnOverview').addEventListener('click', () => {
  focusKey = null;
  closeSheet();
  dirEl.classList.remove('open'); dirEl.classList.add('closed');
  flyOverview();
  lastInteract = performance.now();
});

/* CTAs */
document.getElementById('ctaStep').addEventListener('click', async () => {
  const key = sheetKey;
  if (!key) return;
  closeSheet();
  await flyToDoor(houseByKey(key));
  enterInterior(key);
});
document.getElementById('ctaMeet').addEventListener('click', () => {
  const key = sheetKey;
  if (!key) return;
  closeSheet();
  const r = residents.find((x) => x.key === key);
  if (!r) return;
  focusKey = key;
  syncOverview();
  // speech bubble with a one-liner, white pill + colored dot + dark text
  r.bubbleText = `\u201c${r.type.oneLiners[(Math.random() * r.type.oneLiners.length) | 0]}\u201d`;
  r.bubbleUntil = performance.now() + FOCUS_BUBBLE_MS;
  const p = r.node.position;
  flyTo([{
    theta: goal.theta, phi: 0.82, radius: 11,
    look: new THREE.Vector3(p.x, 1.4, p.z), dur: 1.0,
  }]);
  lastInteract = performance.now();
});
document.getElementById('secToggle').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.classList.toggle('open');
  document.getElementById('shTraits').classList.toggle('open');
});

/* share: deep link per house (?house=<type>) — beats towers.app, which has none */
const copyToastEl = document.getElementById('copytoast');
let copyToastTimer = 0;
function showCopyToast(msg) {
  copyToastEl.textContent = msg;
  copyToastEl.classList.add('show');
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => copyToastEl.classList.remove('show'), 2200);
}
function houseUrl(key) {
  const u = new URL(window.location.href);
  u.searchParams.set('house', key);
  return u.toString();
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // iOS fallback: hidden textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
    ta.remove();
    return ok;
  }
}
document.getElementById('ctaShare').addEventListener('click', async () => {
  if (!sheetKey) return;
  const ok = await copyText(houseUrl(sheetKey));
  showCopyToast(ok ? 'Link copied' : 'Could not copy \u2014 long-press the URL instead');
});

/* ================= step inside: veil + Room3D.enter ================= */
/* one-time coaching hint after the first step-inside, anchored to the
 * resident in 3D (via Room3D.residentScreenPos) */
const coachEl = document.getElementById('coachHint');
let coachTimer = 0, coachPosTimer = 0;
function hideCoach() {
  clearInterval(coachPosTimer); clearTimeout(coachTimer);
  coachEl.classList.add('hidden');
}
function maybeCoachBoop() {
  let seen = false;
  try {
    seen = !!localStorage.getItem('typepop3d_boophint');
    if (!seen) localStorage.setItem('typepop3d_boophint', '1');
  } catch (e) { /* private mode: show it this once anyway */ }
  if (seen) return;
  coachEl.classList.remove('hidden');
  clearInterval(coachPosTimer);
  coachPosTimer = setInterval(() => {
    if (!roomActive || typeof Room3D.residentScreenPos !== 'function') { hideCoach(); return; }
    const p = Room3D.residentScreenPos();
    if (!p) return;
    coachEl.style.transform =
      `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-135%)`;
  }, 120);
  clearTimeout(coachTimer);
  coachTimer = setTimeout(hideCoach, 8000);
}

const veilEl = document.getElementById('interior-veil');
const uiEl = document.getElementById('ui');
let running = true;
let roomActive = false; // the 3D room owns the canvas (and taps) while true
function enterInterior(typeKey) {
  veilEl.classList.add('on');   // CSS fade .6s (fade to black)
  running = false;              // pause our rAF loop
  setTimeout(() => {
    try {
      // Room3D reuses our renderer + composer (swaps the RenderPass scene/camera).
      Room3D.enter(typeKey, {
        renderer, composer, renderPass,
        getNightF: () => nightF,
      }, () => {
        roomActive = false;
        hideCoach();
        uiEl.classList.add('on'); // restore city chrome
        veilEl.classList.remove('on');
        if (!running) { running = true; requestAnimationFrame(loop); }
      });
      roomActive = true;
      uiEl.classList.remove('on'); // hide city chrome while inside (frozen tags otherwise)
      // Crossfade: veil fades back out, revealing the 3D room underneath.
      requestAnimationFrame(() => requestAnimationFrame(() => veilEl.classList.remove('on')));
      // Hard check per the user's beat: the resident is the payoff of the click.
      if (!Room3D.getResident()) {
        toast('Interior opened without its resident — please report this.');
      }
      maybeCoachBoop();
    } catch (e) {
      roomActive = false;
      uiEl.classList.add('on');
      toast('Interior failed to open: ' + (e.message || e));
      veilEl.classList.remove('on');
      running = true;
      requestAnimationFrame(loop);
    }
  }, 620);
}

/* ================= day / night ================= */
const DAY_LEN = 150, NIGHT_LEN = 60, CYCLE = DAY_LEN + NIGHT_LEN;
let nightF = 0;                 // 0 = full day, 1 = full night
let dnMode = 'auto';            // auto | day | night
const dnPill = document.getElementById('dnPill');
const dnLabel = document.getElementById('dnLabel');
dnPill.addEventListener('click', () => {
  dnMode = dnMode === 'auto' ? 'day' : dnMode === 'day' ? 'night' : 'auto';
});
const sunDay = new THREE.Color(0xfff2dd), sunNight = new THREE.Color(0x7d94c9);
const FIREFLY_N = 120;
const fireflyBase = new Float32Array(FIREFLY_N * 3);
const fireflyPhase = new Float32Array(FIREFLY_N);
let fireflyGeo, fireflyMat, fireflyPts;
function initFireflies() {
  const pos = new Float32Array(FIREFLY_N * 3);
  for (let i = 0; i < FIREFLY_N; i++) {
    const cx = Math.random() < 0.6 ? POND.x : rand(-20, 20);
    const cz = Math.random() < 0.6 ? POND.z : rand(-20, 20);
    const a = rand(0, Math.PI * 2), r = rand(2, 9);
    fireflyBase[i * 3] = cx + Math.cos(a) * r * 0.4;
    fireflyBase[i * 3 + 1] = rand(0.6, 3.2);
    fireflyBase[i * 3 + 2] = cz + Math.sin(a) * r * 0.4;
    fireflyPhase[i] = rand(0, Math.PI * 2);
    pos.set([fireflyBase[i * 3], fireflyBase[i * 3 + 1], fireflyBase[i * 3 + 2]], i * 3);
  }
  fireflyGeo = new THREE.BufferGeometry();
  fireflyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  fireflyMat = new THREE.PointsMaterial({
    color: 0xffe28a, size: 0.32, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(fireflyGeo, fireflyMat);
  pts.frustumCulled = false;
  pts.visible = false;
  fireflyPts = pts;
  scene.add(pts);
}
function updateDayNight(dt, elapsed) {
  let target;
  if (dnMode === 'day') target = 0;
  else if (dnMode === 'night') target = 1;
  else target = (elapsed % CYCLE) > DAY_LEN ? 1 : 0;
  nightF += (target - nightF) * Math.min(1, dt / 5);
  if (Math.abs(target - nightF) < 0.002) nightF = target;

  sun.intensity = lerp(1.35, 0.12, nightF);
  sun.color.copy(sunDay).lerp(sunNight, nightF);
  hemi.intensity = lerp(0.75, 0.18, nightF);
  scene.background.copy(SKY_DAY).lerp(SKY_NIGHT, nightF);
  scene.fog.color.copy(scene.background);
  for (const h of houses)
    for (const wm of h.winMats) wm.emissiveIntensity = lerp(0.25, 2.4, nightF);
  lampHeadMat.emissiveIntensity = lerp(0.4, 3.4, nightF);
  for (const pl of lampLights) pl.intensity = lerp(0, 26, nightF);
  fireflyMat.opacity = nightF * 0.9;
  if (fireflyPts) fireflyPts.visible = nightF > 0.03;

  const isNight = nightF > 0.5;
  dnPill.classList.toggle('night', isNight);
  const label = dnMode === 'auto' ? (isNight ? 'Night' : 'Day') : (dnMode === 'day' ? 'Day (held)' : 'Night (held)');
  if (dnLabel.textContent !== label) dnLabel.textContent = label;
}

/* ================= labels & bubbles (DOM, per-frame projection) ================= */
const projV = new THREE.Vector3();
function placeEl(elm, x, y, z, visible) {
  if (!visible) { elm.classList.add('hidden'); return; }
  projV.set(x, y, z).project(camera);
  if (projV.z > 1) { elm.classList.add('hidden'); return; }
  elm.classList.remove('hidden');
  const sx = (projV.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-projV.y * 0.5 + 0.5) * window.innerHeight;
  elm.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%)`;
}
function updateLabels() {
  const showHouses = cam.radius < 47;
  const showPals = cam.radius < 43;
  for (const h of houses) placeEl(h.tagEl, h.pos.x, h.roofTopY + 1.5, h.pos.z, showHouses);
  const now = performance.now();
  for (const r of residents) {
    const p = r.node.position;
    placeEl(r.tagEl, p.x, 2.2, p.z, showPals);
    // speech bubble: white pill, colored dot, dark text
    let text = null;
    if (r.state === 'visit') text = `Visiting ${typeByKey(r.visitHouse).palName}\u2026`;
    else if (r.state === 'chat') text = `Chatting with ${typeByKey(r.chatWith).palName}`;
    else if (focusKey === r.key && now < r.bubbleUntil) text = r.bubbleText;
    if (text && text !== r.bubbleShown) { r.txt.textContent = text; r.bubbleShown = text; }
    placeEl(r.bub, p.x, 3.15, p.z, !!text && showPals);
    if (!text) r.bubbleShown = null;
  }
}

/* ================= main loop ================= */
/* deep link: ?house=<type> skips the intro and flies straight there */
const deepHouseParam = new URLSearchParams(window.location.search).get('house');
const deepHouseKey = deepHouseParam && houseByKey(deepHouseParam.toLowerCase())
  ? deepHouseParam.toLowerCase() : null;

const clock = new THREE.Clock();
let booted = false;
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  const elapsed = clock.elapsedTime;

  stepFlight(dt);
  if (!flight) {
    // damped follow toward goal
    const k = 1 - Math.exp(-dt * 7);
    cam.theta += wrapDelta(goal.theta - cam.theta) * k;
    cam.phi += (goal.phi - cam.phi) * k;
    cam.radius += (goal.radius - cam.radius) * k;
    cam.look.lerp(goal.look, k);
    // subtle idle drift after 5s untouched
    if (now - lastInteract > 5000 && !focusKey) goal.theta += dt * 0.022;
  } else {
    // during flights snap the damped state along (avoids a jump at hand-off)
    cam.theta = goal.theta; cam.phi = goal.phi; cam.radius = goal.radius;
    cam.look.copy(goal.look);
  }
  // "meet the resident" follow: keep the camera glued to the wandering blob
  if (focusKey && !flight) {
    const r = residents.find((x) => x.key === focusKey);
    if (r) {
      const p = r.node.position;
      goal.look.x += (p.x - goal.look.x) * Math.min(1, dt * 3);
      goal.look.z += (p.z - goal.look.z) * Math.min(1, dt * 3);
      goal.look.y += (1.4 - goal.look.y) * Math.min(1, dt * 3);
    }
  }
  applyCam();

  for (const r of residents) updateResident(r, dt, now);
  updatePuffs(dt); // shared dust-puff pool for the blob rigs
  tryMeetings(dt);
  updatePins(dt, now);

  water.rotation.z = elapsed * 0.25;
  const wp = 1 + Math.sin(elapsed * 1.7) * 0.02;
  water.scale.set(wp, wp, 1);

  if (fireflyGeo) {
    const pos = fireflyGeo.attributes.position.array;
    const drift = nightF > 0.03 ? 1 : 0;
    if (drift) {
      for (let i = 0; i < FIREFLY_N; i++) {
        const ph = fireflyPhase[i];
        pos[i * 3] = fireflyBase[i * 3] + Math.sin(elapsed * 0.7 + ph) * 0.7;
        pos[i * 3 + 1] = fireflyBase[i * 3 + 1] + Math.sin(elapsed * 1.1 + ph * 2) * 0.35;
        pos[i * 3 + 2] = fireflyBase[i * 3 + 2] + Math.cos(elapsed * 0.5 + ph) * 0.7;
      }
      fireflyGeo.attributes.position.needsUpdate = true;
    }
  }
  updateDayNight(dt, elapsed);
  updateLabels();

  composer.render();

  if (!booted) {
    booted = true;
    window.__city3d_booted = true;
    document.getElementById('loader').classList.add('done');
    document.getElementById('ui').classList.add('on');
    if (deepHouseKey) {
      // deep link: skip the intro, fly straight to the house
      setTimeout(() => selectHouse(deepHouseKey, { fly: true, sheet: true }), 700);
    } else {
      // directory auto-opens shortly after first load
      setTimeout(() => { if (!sheetKey && !deepHouseKey) openDir(); }, 1500);
    }
  }
}

/* ================= resize ================= */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

/* ================= init ================= */
function init() {
  initFireflies();
  // residents are procedural 3D rigs now — built synchronously, no texture waits
  for (const t of TYPES) {
    const rig = new BlobRig({ bodyColor: t.color });
    const start = residentHomePos(t.key);
    rig.group.position.set(start.x, 0, start.z);
    scene.add(rig.group);
    rig.hitProxy.userData.residentKey = t.key;
    tapTargets.push(rig.hitProxy);
    const dom = makeResidentDom(t);
    residents.push({
      key: t.key, type: t, rig, node: rig.group,
      state: 'idle', t: rand(0.5, 5),
      target: new THREE.Vector3(), targetHouse: null,
      visitHouse: null, chatWith: null,
      friends: new Set(), speed: 2.4, phase: rand(0, 6),
      tagEl: dom.tag, bub: dom.bub, txt: dom.txt,
      bubbleText: null, bubbleShown: null, bubbleUntil: 0,
      _rigState: null,
    });
  }
  // sheet live-status refresh (MOOD NOW / FRIENDS)
  setInterval(refreshSheetLive, 1000);
  applyCam();
  requestAnimationFrame(loop);
}
try {
  init();
} catch (e) {
  toast('Failed to start the city: ' + (e.message || e));
  console.error(e);
}
