/* TypePop City 3D — the plaza fountain, rebuilt with personality.
 *
 * Replaces the old grey single-basin fountain with a tiered centerpiece:
 *  - 3 stacked lathe-profile basins in warm sandstone (not grey)
 *  - a mosaic tile band around the lower basin in all 16 type colors
 *  - animated water: scrolling procedural texture + opacity pulse
 *  - a falling-water Points spray (gravity arc, top tier -> lower basin)
 *  - expanding ripple rings on the lower basin
 *  - a stone statue of Pip the strawberry (frozen mid-hop BlobRig) on top,
 *    with a gold trim ring on its pedestal
 *  - flower ring + stone edging around the base
 *  - night: water glows softly, mosaic tiles catch the light
 *
 * API: buildFountain() -> { group, update(dt, elapsed, lampF) }
 *   group: THREE.Group at the plaza center (0,0,0), ~5.5 units tall.
 *   update: call every frame from the city loop; lampF = 0..1 night factor
 *   (drives the night glow; day shows none).
 */
import * as THREE from 'three';
import { TYPES } from './types.js?v=3';
import { BlobRig } from './blobRig.js?v=2';

/* ---------------- shared bits ---------------- */
const stoneMat = new THREE.MeshStandardMaterial({ color: 0xc9b294, roughness: 0.9 });
const stoneDark = new THREE.MeshStandardMaterial({ color: 0xa98f68, roughness: 0.95 });
const goldMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.75, roughness: 0.35 });

function radialSpriteTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Lathe-profile basin bowl: outer wall rises to a lip, inner wall drops
 *  back to a shallow inner floor. r = outer radius, h = rim height. */
function basinGeo(r, h) {
  const pts = [
    new THREE.Vector2(0.0, 0),
    new THREE.Vector2(r * 0.55, 0),
    new THREE.Vector2(r * 0.85, 0.12 * h),
    new THREE.Vector2(r * 0.98, 0.55 * h),
    new THREE.Vector2(r, 0.85 * h),
    new THREE.Vector2(r * 0.94, h),
    new THREE.Vector2(r * 0.86, h),
    new THREE.Vector2(r * 0.8, 0.6 * h),
    new THREE.Vector2(0.0, 0.28 * h),
  ];
  return new THREE.LatheGeometry(pts, 30);
}

function waterTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#4fa8d8';
  x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 26; i++) {
    x.strokeStyle = i % 2 ? 'rgba(190,230,255,0.55)' : 'rgba(255,255,255,0.5)';
    x.lineWidth = 1 + Math.random() * 2;
    x.beginPath();
    const y = Math.random() * 128;
    x.moveTo(0, y);
    x.bezierCurveTo(40, y + (Math.random() - 0.5) * 14, 88, y + (Math.random() - 0.5) * 14, 128, y);
    x.stroke();
  }
  for (let i = 0; i < 40; i++) {
    x.fillStyle = 'rgba(255,255,255,0.6)';
    x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Pip the strawberry as a stone statue, frozen mid-hop (the happy apex).
 *  The rig is stepped manually to the airborne frame, then its materials
 *  are swapped to stone — it never animates again. */
function buildStatue() {
  const rig = new BlobRig({ fruit: 'strawberry' });
  rig.setState('happy');
  let t = 0;
  for (let i = 0; i < 40; i++) { t += 0.016; rig.update(0.016, t); } // ~apex of the hop
  const stone = new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.85 });
  const stoneDk = new THREE.MeshStandardMaterial({ color: 0xb09a72, roughness: 0.9 });
  const slate = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.6 });
  const marble = new THREE.MeshStandardMaterial({ color: 0xfff8e8, roughness: 0.4 });
  rig.body.material = stone;
  if (rig.features) rig.features.material = stoneDk;
  rig.eyeL.material = slate;
  rig.eyeR.material = slate;
  rig.hlL.material = marble;
  rig.hlR.material = marble;
  if (rig.armL) rig.armL.material = stone;
  if (rig.armR) rig.armR.material = stone;
  rig.footL.material = stoneDk;
  rig.footR.material = stoneDk;
  rig.shadow.visible = false;
  rig.hitProxy.visible = false;
  rig.group.scale.setScalar(1.35);
  return rig.group;
}

export function buildFountain() {
  const g = new THREE.Group();
  const mosaicMats = [];

  /* ---- plinth ---- */
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.45, 0.35, 36), stoneDark);
  plinth.position.y = 0.175;
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  g.add(plinth);
  const plinthTrim = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.07, 8, 40), goldMat);
  plinthTrim.rotation.x = Math.PI / 2;
  plinthTrim.position.y = 0.36;
  g.add(plinthTrim);

  /* ---- three lathe basins + columns ---- */
  const lower = new THREE.Mesh(basinGeo(2.7, 0.85), stoneMat);
  lower.position.y = 0.35;
  lower.castShadow = true;
  lower.receiveShadow = true;
  g.add(lower);
  const col1 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.05, 14), stoneMat);
  col1.position.y = 1.55;
  col1.castShadow = true;
  g.add(col1);
  const mid = new THREE.Mesh(basinGeo(1.9, 0.7), stoneMat);
  mid.position.y = 2.0;
  mid.castShadow = true;
  mid.receiveShadow = true;
  g.add(mid);
  const col2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.85, 12), stoneMat);
  col2.position.y = 2.85;
  col2.castShadow = true;
  g.add(col2);
  const top = new THREE.Mesh(basinGeo(1.15, 0.55), stoneMat);
  top.position.y = 3.2;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  /* ---- mosaic tile band: all 16 type colors around the lower basin ---- */
  for (let i = 0; i < TYPES.length; i++) {
    const a = (i / TYPES.length) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({
      color: TYPES[i].color, emissive: TYPES[i].color, emissiveIntensity: 0,
      roughness: 0.55,
    });
    const tile = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.42, 0.07), mat);
    const r = 2.62;
    tile.position.set(Math.cos(a) * r, 0.78, Math.sin(a) * r);
    tile.rotation.y = -a + Math.PI / 2;
    tile.castShadow = false;
    g.add(tile);
    mosaicMats.push(mat);
  }

  /* ---- water discs (shared scrolling texture) ---- */
  const wTex = waterTexture();
  const waterMat = new THREE.MeshStandardMaterial({
    map: wTex, color: 0x9fd4ee, transparent: true, opacity: 0.85,
    roughness: 0.15, metalness: 0.1, emissive: 0x2a6a8a, emissiveIntensity: 0,
  });
  const disc = (r, y) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 30), waterMat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    g.add(m);
    return m;
  };
  disc(2.35, 1.06); // lower basin water
  disc(1.6, 2.52);  // mid basin water
  disc(0.92, 3.58); // top basin water

  /* ---- falling-water spray: Points with a gravity arc ---- */
  const SPRAY_N = 90;
  const sPos = new Float32Array(SPRAY_N * 3);
  const sVel = new Float32Array(SPRAY_N * 3);
  function resetDrop(i, randomY = false) {
    const a = Math.random() * Math.PI * 2;
    const sp = 0.9 + Math.random() * 0.4;
    sPos[i * 3] = 0;
    sPos[i * 3 + 1] = randomY ? 1.1 + Math.random() * 2.5 : 3.62;
    sPos[i * 3 + 2] = 0;
    sVel[i * 3] = Math.cos(a) * sp;
    sVel[i * 3 + 1] = 1.6 + Math.random() * 0.4;
    sVel[i * 3 + 2] = Math.sin(a) * sp;
  }
  for (let i = 0; i < SPRAY_N; i++) resetDrop(i, true);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  const sprayMat = new THREE.PointsMaterial({
    size: 0.14, map: radialSpriteTex(), transparent: true, opacity: 0.85,
    color: 0xbfe6ff, blending: THREE.AdditiveBlending, depthWrite: false,
    sizeAttenuation: true,
  });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.frustumCulled = false;
  g.add(spray);

  /* ---- ripple rings on the lower basin ---- */
  const ripples = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd8f2ff, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.0, 36), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1.07;
    g.add(ring);
    ripples.push({ ring, mat, phase: i / 3 });
  }

  /* ---- statue: Pip on a pedestal with a gold trim ring ---- */
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.3, 18), stoneMat);
  ped.position.y = 3.85;
  ped.castShadow = true;
  g.add(ped);
  const pedTrim = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.05, 8, 24), goldMat);
  pedTrim.rotation.x = Math.PI / 2;
  pedTrim.position.y = 3.72;
  g.add(pedTrim);
  const statue = buildStatue();
  statue.position.y = 4.0;
  g.add(statue);
  // The statue is frozen mid-hop, so its feet hover above the pedestal.
  // A translucent water jet rising from the pedestal to the blob's underside
  // explains the float — Pip is held up by the fountain itself.
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.15, 10), waterMat);
  jet.position.y = 4.58;
  g.add(jet);

  /* ---- flower ring + stone edging around the base ---- */
  const flowerCols = [0xff5a7a, 0xffd93d, 0xff8c69, 0xc77dff, 0xffffff, 0x4ecdc4];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({ color: flowerCols[i % flowerCols.length], roughness: 0.7 });
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), mat);
    f.position.set(Math.cos(a) * 3.75, 0.16, Math.sin(a) * 3.75);
    g.add(f);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 5),
      new THREE.MeshStandardMaterial({ color: 0x4e8f4a, roughness: 0.9 }));
    stem.position.set(Math.cos(a) * 3.75, 0.08, Math.sin(a) * 3.75);
    g.add(stem);
  }
  const edgeGeo = new THREE.DodecahedronGeometry(0.16, 0);
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 1, flatShading: true });
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const st = new THREE.Mesh(edgeGeo, edgeMat);
    st.position.set(Math.cos(a) * 4.15, 0.1, Math.sin(a) * 4.15);
    st.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    st.castShadow = true;
    g.add(st);
  }

  /* ---- night glow sprite above the statue ---- */
  const glowMat = new THREE.SpriteMaterial({
    map: radialSpriteTex(), color: 0xffd9a0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.position.set(0, 4.6, 0);
  glow.scale.set(4.5, 4.5, 1);
  g.add(glow);

  /* ---- per-frame animation ---- */
  function update(dt, elapsed, lampF) {
    wTex.offset.x += dt * 0.015;
    wTex.offset.y += dt * 0.008;
    waterMat.opacity = 0.82 + Math.sin(elapsed * 1.7) * 0.06;
    // spray physics: gravity arc, recycle at the lower basin water level
    const p = sprayGeo.attributes.position.array;
    for (let i = 0; i < SPRAY_N; i++) {
      sVel[i * 3 + 1] -= 3.5 * dt;
      p[i * 3] += sVel[i * 3] * dt;
      p[i * 3 + 1] += sVel[i * 3 + 1] * dt;
      p[i * 3 + 2] += sVel[i * 3 + 2] * dt;
      if (p[i * 3 + 1] < 1.06) resetDrop(i);
    }
    sprayGeo.attributes.position.needsUpdate = true;
    // ripple rings: expand + fade, staggered
    for (const r of ripples) {
      const u = (elapsed * 0.45 + r.phase) % 1;
      const s = 0.4 + u * 2.0;
      r.ring.scale.set(s, s, 1);
      r.mat.opacity = (1 - u) * 0.45;
    }
    // night: water glows, mosaic catches light, statue halo appears
    waterMat.emissiveIntensity = lampF * 0.55;
    glowMat.opacity = lampF * 0.35;
    for (const m of mosaicMats) m.emissiveIntensity = lampF * 0.3;
  }

  return { group: g, update };
}
