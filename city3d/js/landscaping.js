/* TypePop City 3D — ground dressing: richer ground, plaza cobbles, and
 * scattered life (flower tufts, grass clumps, bushes, benches, lanterns,
 * pond edging). Perf-first: tufts/bushes/edging are InstancedMeshes
 * (a handful of draw calls for hundreds of plants), all textures procedural.
 *
 * API:
 *   grassTexture()  -> THREE.CanvasTexture (tileable lawn)
 *   cobbleTexture() -> THREE.CanvasTexture (tileable plaza cobbles)
 *   buildLandscaping(scene, houses, pondPos) -> { update(lampF) }
 *     houses: [{ pos: Vector3 }] — tufts/bushes keep clear of house plots,
 *     paths, the plaza, and the pond. update() drives lantern night glow.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------------- procedural ground textures ---------------- */
export function grassTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const rnd = mulberry32(20240);
  x.fillStyle = '#79a95e';
  x.fillRect(0, 0, S, S);
  // mottled patches: darker + lighter lawn noise
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = rnd() < 0.5 ? 'rgba(90,140,70,0.35)' : 'rgba(150,190,110,0.32)';
    const s = 3 + rnd() * 12;
    x.fillRect(rnd() * S, rnd() * S, s, s * 0.7);
  }
  // blade strokes
  for (let i = 0; i < 900; i++) {
    x.strokeStyle = rnd() < 0.5 ? 'rgba(70,120,55,0.5)' : 'rgba(140,180,100,0.45)';
    x.lineWidth = 1 + rnd() * 1.2;
    const bx = rnd() * S, by = rnd() * S;
    x.beginPath();
    x.moveTo(bx, by);
    x.lineTo(bx + (rnd() - 0.5) * 5, by - 3 - rnd() * 6);
    x.stroke();
  }
  // tiny clover dots
  for (let i = 0; i < 60; i++) {
    x.fillStyle = 'rgba(230,240,200,0.35)';
    x.beginPath();
    x.arc(rnd() * S, rnd() * S, 1 + rnd() * 2, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function cobbleTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const rnd = mulberry32(777);
  x.fillStyle = '#8f8a80'; // mortar
  x.fillRect(0, 0, S, S);
  const rowH = 64, stoneW = 86;
  for (let row = 0; row < S / rowH; row++) {
    const off = row % 2 ? stoneW / 2 : 0;
    for (let col = -1; col < S / stoneW + 1; col++) {
      const sx = col * stoneW + off + 4, sy = row * rowH + 4;
      const tone = 178 + Math.floor(rnd() * 42);
      const warm = rnd() < 0.5;
      x.fillStyle = warm
        ? `rgb(${tone},${tone - 12},${tone - 34})`
        : `rgb(${tone - 14},${tone - 8},${tone - 8})`;
      x.beginPath();
      x.roundRect(sx, sy, stoneW - 8, rowH - 8, 14);
      x.fill();
      // subtle top highlight + bottom shade: stones read rounded, not flat
      x.fillStyle = 'rgba(255,255,255,0.13)';
      x.fillRect(sx + 6, sy + 4, stoneW - 20, 5);
      x.fillStyle = 'rgba(0,0,0,0.12)';
      x.fillRect(sx + 6, sy + rowH - 14, stoneW - 20, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------- tuft texture (crossed planes) ---------------- */
function tuftTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const rnd = mulberry32(4242);
  // grass blades fanning from the base
  for (let i = 0; i < 14; i++) {
    const bx = 24 + rnd() * 80;
    x.strokeStyle = rnd() < 0.5 ? '#5d9c52' : '#79b96a';
    x.lineWidth = 2.5 + rnd() * 2;
    x.beginPath();
    x.moveTo(bx, S);
    x.quadraticCurveTo(bx + (rnd() - 0.5) * 30, S * 0.55, bx + (rnd() - 0.5) * 44, S * (0.15 + rnd() * 0.3));
    x.stroke();
  }
  // tiny wildflower dots
  const cols = ['#ff5a7a', '#ffd93d', '#ffffff', '#c77dff'];
  for (let i = 0; i < 6; i++) {
    x.fillStyle = cols[i % cols.length];
    x.beginPath();
    x.arc(20 + rnd() * 88, 20 + rnd() * 70, 3 + rnd() * 3, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------- scatter placement (keeps walkways + plots clear) ---------------- */
function scatterPoint(rnd, houses, pondPos) {
  for (let tries = 0; tries < 40; tries++) {
    const a = rnd() * Math.PI * 2;
    const r = 12.5 + rnd() * 20; // outside the plaza + ring path
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // clear of house plots (ring r=26, house footprint ~5)
    let bad = false;
    for (const h of houses) {
      const dx = x - h.pos.x, dz = z - h.pos.z;
      if (dx * dx + dz * dz < 7.5 * 7.5) { bad = true; break; }
    }
    if (bad) continue;
    // clear of the pond
    const pdx = x - pondPos.x, pdz = z - pondPos.z;
    if (pdx * pdx + pdz * pdz < 7 * 7) continue;
    // clear of the radial spoke paths (house angle, r 11..26, half-width 1.6)
    for (const h of houses) {
      const hx = Math.cos(h.angle), hz = Math.sin(h.angle);
      const along = x * hx + z * hz;
      if (along < 10 || along > 27) continue;
      const perp = Math.abs(-x * hz + z * hx);
      if (perp < 1.6) { bad = true; break; }
    }
    if (bad) continue;
    return [x, z];
  }
  return null;
}

export function buildLandscaping(scene, houses, pondPos) {
  const rnd = mulberry32(1337);
  const nightMats = []; // { mat, base, peak } lantern glows driven by lampF

  /* ---- flower tufts + grass clumps: one InstancedMesh, crossed planes ---- */
  const p1 = new THREE.PlaneGeometry(1.0, 0.75);
  p1.translate(0, 0.375, 0);
  const p2 = new THREE.PlaneGeometry(1.0, 0.75);
  p2.rotateY(Math.PI / 2);
  p2.translate(0, 0.375, 0);
  const tuftGeo = mergeGeometries([p1, p2]);
  const tuftMat = new THREE.MeshStandardMaterial({
    map: tuftTexture(), transparent: true, alphaTest: 0.4,
    side: THREE.DoubleSide, roughness: 1,
  });
  const TUFTS = 70;
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFTS);
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < TUFTS * 3 && placed < TUFTS; i++) {
    const pt = scatterPoint(rnd, houses, pondPos);
    if (!pt) continue;
    const sc = 0.7 + rnd() * 0.9;
    dummy.position.set(pt[0], 0, pt[1]);
    dummy.rotation.y = rnd() * Math.PI;
    dummy.scale.set(sc, sc * (0.85 + rnd() * 0.4), sc);
    dummy.updateMatrix();
    tufts.setMatrixAt(placed++, dummy.matrix);
  }
  tufts.count = placed;
  tufts.receiveShadow = true;
  scene.add(tufts);

  /* ---- rounded bushes: squashed icosahedra, instanced, 3 green tones ---- */
  const bushGeo = new THREE.IcosahedronGeometry(0.75, 1);
  bushGeo.scale(1, 0.72, 1);
  const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  const BUSHES = 26;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BUSHES);
  const greens = [new THREE.Color(0x5d9c52), new THREE.Color(0x6fae5e), new THREE.Color(0x4f8f47)];
  placed = 0;
  for (let i = 0; i < BUSHES * 3 && placed < BUSHES; i++) {
    const pt = scatterPoint(rnd, houses, pondPos);
    if (!pt) continue;
    const sc = 0.7 + rnd() * 0.8;
    dummy.position.set(pt[0], 0.45 * sc, pt[1]);
    dummy.rotation.y = rnd() * Math.PI;
    dummy.scale.set(sc, sc, sc);
    dummy.updateMatrix();
    bushes.setMatrixAt(placed, dummy.matrix);
    bushes.setColorAt(placed, greens[placed % 3]);
    placed++;
  }
  bushes.count = placed;
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  scene.add(bushes);

  /* ---- benches facing the fountain (3, at the plaza edge) ---- */
  const benchWood = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.85 });
  const benchDark = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.8 });
  const rboxCache = new Map();
  function benchRbox(w, h, d) {
    const key = w + '|' + h + '|' + d;
    if (!rboxCache.has(key))
      rboxCache.set(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(0.05, Math.min(w, h, d) * 0.45)));
    return rboxCache.get(key);
  }
  [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6].forEach((a) => {
    const bx = Math.cos(a) * 9.8, bz = Math.sin(a) * 9.8;
    const bench = new THREE.Group();
    // seat slats (rounded) + back slats + side frames
    for (const dz of [-0.18, 0.18]) {
      const slat = new THREE.Mesh(benchRbox(1.9, 0.07, 0.34), benchWood);
      slat.position.set(0, 0.46, dz);
      slat.castShadow = true;
      bench.add(slat);
    }
    for (const y of [0.82, 1.04]) {
      const back = new THREE.Mesh(benchRbox(1.9, 0.13, 0.07), benchWood);
      back.position.set(0, y, -0.34);
      back.rotation.x = -0.12;
      back.castShadow = true;
      bench.add(back);
    }
    for (const sx of [-0.8, 0.8]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.46, 0.55), benchDark);
      frame.position.set(sx, 0.23, 0);
      frame.castShadow = true;
      bench.add(frame);
    }
    bench.position.set(bx, 0, bz);
    bench.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a)); // face the fountain
    scene.add(bench);
  });

  /* ---- lantern posts near the plaza (2, glow at night) ---- */
  const lampGlowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,205,120,0.9)');
    grad.addColorStop(0.4, 'rgba(255,180,90,0.35)');
    grad.addColorStop(1, 'rgba(255,170,80,0)');
    x.fillStyle = grad;
    x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  [Math.PI / 6, (3 * Math.PI) / 2].forEach((a) => {
    const x = Math.cos(a) * 10.6, z = Math.sin(a) * 10.6;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.1, 2.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.8 }));
    post.position.set(x, 1.15, z);
    post.castShadow = true;
    scene.add(post);
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 0.4, 4),
      new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.8 }));
    cap.position.set(x, 2.5, z);
    cap.rotation.y = Math.PI / 4;
    scene.add(cap);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x443a2c, emissive: 0xffca7a, emissiveIntensity: 0.4, roughness: 0.5,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), lampMat);
    bulb.position.set(x, 2.28, z);
    scene.add(bulb);
    const glowMat = new THREE.SpriteMaterial({
      map: lampGlowTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(x, 2.28, z);
    glow.scale.set(2.6, 2.6, 1);
    scene.add(glow);
    nightMats.push({ mat: lampMat, base: 0.4, peak: 3.2 });
    nightMats.push({ mat: glowMat, base: 0, peak: 0.55, isOpacity: true });
  });

  /* ---- stone edging ring around the pond ---- */
  const edgeGeo = new THREE.DodecahedronGeometry(0.22, 0);
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 1, flatShading: true });
  const EDGES = 26;
  const edging = new THREE.InstancedMesh(edgeGeo, edgeMat, EDGES);
  for (let i = 0; i < EDGES; i++) {
    const a = (i / EDGES) * Math.PI * 2;
    dummy.position.set(pondPos.x + Math.cos(a) * 5.4, 0.12, pondPos.z + Math.sin(a) * 5.4);
    dummy.rotation.set(rnd() * 3, rnd() * 3, 0);
    const sc = 0.8 + rnd() * 0.5;
    dummy.scale.set(sc, sc, sc);
    dummy.updateMatrix();
    edging.setMatrixAt(i, dummy.matrix);
  }
  edging.castShadow = true;
  edging.receiveShadow = true;
  scene.add(edging);

  function update(lampF) {
    for (const n of nightMats) {
      if (n.isOpacity) n.mat.opacity = n.base + (n.peak - n.base) * lampF;
      else n.mat.emissiveIntensity = n.base + (n.peak - n.base) * lampF;
    }
  }
  return { update };
}
