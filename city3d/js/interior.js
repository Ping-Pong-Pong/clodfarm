/* interior.js — HD-2D diorama interior module for TypePop City 3D.
 *
 * Contract (binding, Worker 1 ↔ Worker 2):
 *   import { Interior } from './interior.js';
 *   Interior.enter(typeKey, onExit)
 *
 *   - Worker 1's index.html provides <div id="interior-veil"> (fullscreen
 *     overlay). enter() creates its OWN THREE.WebGLRenderer appended inside
 *     the veil, sized to the veil, builds the room for the given type,
 *     adds class `on` to the veil (fade-in), and runs its own rAF loop.
 *   - A visible "← Back to city" pill removes the `on` class, cancels the
 *     rAF, disposes renderer/geometries/materials, then calls onExit() so
 *     the city resumes.
 *   - The room is the proven hd2d-demo diorama architecture (tilt-shift
 *     DOF + bloom + grade, god-ray shaft, dust, fireflies, day/night
 *     crossfade, tap-to-boop), re-skinned per type from TYPES.
 *   - iOS rules kept: EffectComposer render target samples:0, pixel ratio
 *     cap 1.75, 1024 shadow map. Any exception in enter() is rethrown after
 *     cleanup so window error listeners (Worker 1's toast) see it.
 *
 * Follow-ups (not in v1): per-type HD-2D resident sprites (v1 tints
 * pip_idle/blink/happy toward the type color for non-ENFP types), per-type
 * props (prop names live in TYPES[].prop).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  TiltShiftShader, GradeShader, makeShaftMaterial, makeFireflyMaterial,
  makeRadialTexture, makeShadowTexture,
  makeWoodTexture, makeWallpaperTexture, makePaintingTexture,
} from './interior-fx.js';
import { typeByKey } from './types.js';

const ASSETS = new URL('../assets/', import.meta.url).href;
const lerp = (a, b, k) => a + (b - a) * k;
const C = (h) => new THREE.Color(h);
const WARM_CREAM = C(0xf3e2c0);

// [time, scaleY, scaleX]
const HOP_KEYS = [
  [0.00, 1.00, 1.00], [0.10, 0.66, 1.26], [0.30, 1.10, 0.94],
  [0.55, 1.16, 0.90], [0.85, 1.12, 0.92], [1.00, 0.72, 1.22], [1.28, 1.00, 1.00],
];

/* One injected <style> for the veil + our pills + bubble, so the module
 * looks right even before Worker 1's stylesheet lands. Unique ids only —
 * no collisions with city styles. */
const STYLE_ID = 'interior-module-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
    #interior-veil { position: fixed; inset: 0; z-index: 60; overflow: hidden;
      opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity .45s ease, visibility 0s linear .45s; background: #0b0f18; }
    #interior-veil.on { opacity: 1; visibility: visible; pointer-events: auto;
      transition: opacity .45s ease; }
    #interior-veil canvas { display: block; }
    .int-pill { position: absolute; font: 600 14px/1 -apple-system, 'Segoe UI', system-ui, sans-serif;
      color: #fff; background: rgba(20,26,40,.72); border: 1px solid rgba(255,255,255,.22);
      border-radius: 999px; padding: 11px 18px; cursor: pointer; backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px); box-shadow: 0 4px 18px rgba(0,0,0,.35);
      pointer-events: auto; user-select: none; -webkit-user-select: none; z-index: 5; }
    .int-pill:active { transform: scale(.96); }
    #int-back { top: max(14px, env(safe-area-inset-top)); left: 14px; }
    #int-header { top: max(14px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
      cursor: default; white-space: nowrap; max-width: 62vw; overflow: hidden; text-overflow: ellipsis; }
    #int-dn { top: max(14px, env(safe-area-inset-top)); right: 14px; display: flex; gap: 2px; padding: 5px; }
    #int-dn .opt { border: 0; background: transparent; color: #cfd6ea; font: inherit;
      border-radius: 999px; padding: 7px 12px; cursor: pointer; }
    #int-dn .opt.active { background: rgba(255,255,255,.22); color: #fff; }
    #int-bubble { position: absolute; z-index: 4; max-width: 230px; transform: translate(-50%,-100%);
      background: #fff; color: #223; border-radius: 14px; padding: 9px 12px;
      font: 500 13px/1.35 -apple-system, 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: none; opacity: 0;
      transition: opacity .3s ease; }
    #int-bubble.show { opacity: 1; }
    #int-bubble:after { content: ''; position: absolute; left: 50%; bottom: -7px;
      transform: translateX(-50%); border: 7px solid transparent; border-top-color: #fff; border-bottom: 0; }
    #int-loader { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center;
      justify-content: center; color: #cfd6ea; font: 500 14px -apple-system, system-ui, sans-serif;
      letter-spacing: .04em; pointer-events: none; transition: opacity .4s ease; }
    #int-loader.done { opacity: 0; }
  `;
  document.head.appendChild(st);
}

let active = false;

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

function keyTrack(t, keys) {
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      let k = (t - a[0]) / (b[0] - a[0]);
      k = k * k * (3 - 2 * k);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  const l = keys[keys.length - 1];
  return [l[1], l[2]];
}

function build(type, S) {
  const veil = S.veil;
  const typeColor = C(type.color);
  const typeTintDay = C(0xffffff).lerp(typeColor, 0.45); // v1: tint pip toward type color

  /* ---------------- renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(PIXEL_RATIO);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  veil.appendChild(renderer.domElement);
  S.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = C(0x2b1e15);
  S.scene = scene;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  const CAM_BASE = new THREE.Vector3(0.8, 9.0, 15.0);
  const LOOK_BASE = new THREE.Vector3(0.2, 1.5, -1.6);
  camera.position.copy(CAM_BASE);
  camera.lookAt(LOOK_BASE);
  S.camera = camera;

  /* ---------------- textures ---------------- */
  const manager = new THREE.LoadingManager();
  const texLoader = new THREE.TextureLoader(manager);
  const loadSprite = (name) => {
    const t = texLoader.load(ASSETS + name);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = 4;
    return t;
  };
  const texIdle = loadSprite('pip_idle.png');
  const texBlink = loadSprite('pip_blink.png');
  const texHappy = loadSprite('pip_happy.png');
  const texChair = loadSprite('armchair.png');
  const texPlant = loadSprite('plant.png');
  const texLamp = loadSprite('floor_lamp.png');
  const texRug = loadSprite('rug.png');

  const woodTex = makeWoodTexture(); woodTex.repeat.set(2.2, 1.8);
  const wallTex = makeWallpaperTexture(); wallTex.repeat.set(3, 1.6);
  const paintTex = makePaintingTexture();
  const radialTex = makeRadialTexture();
  const shadowTex = makeShadowTexture();

  /* ---------------- room shell ---------------- */
  const ROOM = { w: 12, d: 10, h: 6.5 };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.5, metalness: 0.08 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // re-skin: wall tint = type color mixed 75% toward warm cream
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 });
  wallMat.color.copy(typeColor).lerp(WARM_CREAM, 0.75);
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.h), wallMat);
  backWall.position.set(0, ROOM.h / 2, -ROOM.d / 2);
  backWall.receiveShadow = true;
  scene.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.d, ROOM.h), wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-ROOM.w / 2, ROOM.h / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);

  const bbMat = new THREE.MeshStandardMaterial({ color: 0x6e4a2e, roughness: 0.7 });
  const bb1 = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.35, 0.12), bbMat);
  bb1.position.set(0, 0.175, -ROOM.d / 2 + 0.06);
  const bb2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, ROOM.d), bbMat);
  bb2.position.set(-ROOM.w / 2 + 0.06, 0.175, 0);
  scene.add(bb1, bb2);

  /* ---------------- window ---------------- */
  const WIN = { x: 2.3, y: 3.7, w: 3.1, h: 3.7, bar: 0.28 };
  const winG = new THREE.Group();
  winG.position.set(WIN.x, WIN.y, -ROOM.d / 2 + 0.03);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x5d3f27, roughness: 0.6 });
  const frameBox = (w, h, d, x, y, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
    m.position.set(x, y, z);
    m.castShadow = true;
    winG.add(m);
  };
  frameBox(WIN.w, WIN.bar, 0.22, 0,  WIN.h / 2 - WIN.bar / 2);
  frameBox(WIN.w, WIN.bar, 0.22, 0, -WIN.h / 2 + WIN.bar / 2);
  frameBox(WIN.bar, WIN.h - 2 * WIN.bar, 0.22, -WIN.w / 2 + WIN.bar / 2, 0);
  frameBox(WIN.bar, WIN.h - 2 * WIN.bar, 0.22,  WIN.w / 2 - WIN.bar / 2, 0);
  frameBox(0.12, WIN.h - 2 * WIN.bar, 0.1, 0, 0);
  frameBox(WIN.w - 2 * WIN.bar, 0.12, 0.1, 0, 0.15);
  frameBox(WIN.w + 0.5, 0.16, 0.55, 0, -WIN.h / 2 - 0.08, 0.16);
  const DAY_PANE = C(0xffe9bd), NIGHT_PANE = C(0xa9c4f5);
  const paneMat = new THREE.MeshBasicMaterial({ color: DAY_PANE.clone() });
  const panes = new THREE.Mesh(new THREE.PlaneGeometry(WIN.w - 2 * WIN.bar, WIN.h - 2 * WIN.bar), paneMat);
  panes.position.z = -0.06;
  winG.add(panes);
  scene.add(winG);

  const windowGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTex, color: DAY_PANE.clone(), transparent: true,
    opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  windowGlow.position.set(WIN.x, WIN.y, -ROOM.d / 2 + 0.4);
  windowGlow.scale.set(7.5, 7.5, 1);
  windowGlow.renderOrder = 4;
  scene.add(windowGlow);

  /* ---------------- light shaft ---------------- */
  const shaftMat = makeShaftMaterial();
  const shaftOrigin = new THREE.Vector3(WIN.x, WIN.y - 0.3, -ROOM.d / 2 + 0.1);
  const shaftTarget = new THREE.Vector3(0.5, 0, 0.6);
  const shaftDir = shaftOrigin.clone().sub(shaftTarget);
  const shaftLen = shaftDir.length() + 1.2;
  const shaftMid = shaftOrigin.clone().add(shaftTarget).multiplyScalar(0.5);
  const shaftQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), shaftDir.clone().normalize());
  for (const roll of [0, Math.PI / 2]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.0, shaftLen), shaftMat);
    m.position.copy(shaftMid);
    m.quaternion.copy(shaftQuat);
    m.rotateY(roll);
    m.renderOrder = 5;
    scene.add(m);
  }

  const patchMat = new THREE.MeshBasicMaterial({
    map: radialTex, color: C(0xffc98a), transparent: true,
    opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const patchGeo = new THREE.PlaneGeometry(3.8, 5.4);
  patchGeo.rotateX(-Math.PI / 2);
  const patch = new THREE.Mesh(patchGeo, patchMat);
  patch.position.set(0.7, 0.025, 0.1);
  patch.rotation.y = -0.31;
  patch.renderOrder = 3;
  scene.add(patch);

  /* ---------------- furniture ---------------- */
  const billboards = [];
  const addBillboard = (tex, height, x, z, tint = 0xffffff) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, color: tint,
    }));
    s.position.set(x, height / 2, z);
    s.renderOrder = 2;
    scene.add(s);
    billboards.push({ sprite: s, height });
    return s;
  };
  const contactShadow = (x, z, w, opacity = 0.5) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, w * 0.55),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.015, z);
    m.renderOrder = 1;
    scene.add(m);
  };

  // re-skin: accents tinted with the type color (chair subtle, rug strong)
  const chairTint = C(0xffffff).lerp(typeColor, 0.28);
  addBillboard(texChair, 2.15, -3.2, -2.3, chairTint);
  contactShadow(-3.2, -2.3, 3.0);
  addBillboard(texPlant, 2.6, 4.25, -3.1);
  contactShadow(4.25, -3.1, 1.9);
  const lampSprite = addBillboard(texLamp, 3.1, -4.55, -0.9);
  contactShadow(-4.55, -0.9, 1.5);

  const lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTex, color: C(0xffc06a), transparent: true,
    opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  lampGlow.position.set(-4.55, 2.72, -0.9);
  lampGlow.scale.set(2.6, 2.6, 1);
  lampGlow.renderOrder = 4;
  scene.add(lampGlow);

  const rugMat = new THREE.MeshStandardMaterial({ map: texRug, transparent: true, roughness: 0.95 });
  rugMat.color.copy(C(0xffffff).lerp(typeColor, 0.55)); // re-skin: rug in type color
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.9, 48), rugMat);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(-0.5, 0.012, 1.2);
  rug.receiveShadow = true;
  scene.add(rug);

  const paintFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 1.3, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.6 })
  );
  paintFrame.position.set(-2.7, 3.9, -ROOM.d / 2 + 0.06);
  scene.add(paintFrame);
  const painting = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.1),
    new THREE.MeshBasicMaterial({ map: paintTex })
  );
  painting.position.set(-2.7, 3.9, -ROOM.d / 2 + 0.12);
  scene.add(painting);

  /* ---------------- resident blob ---------------- */
  const PIP = { x: 0.75, z: 1.35, baseY: 0.78, h: 1.5 };
  const pip = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texIdle, transparent: true, depthWrite: false, color: typeTintDay.clone(),
  }));
  pip.position.set(PIP.x, PIP.baseY, PIP.z);
  pip.renderOrder = 3;
  scene.add(pip);
  const pipRefl = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texIdle, transparent: true, depthWrite: false, opacity: 0.15,
    color: typeTintDay.clone().multiplyScalar(0.6),
  }));
  pipRefl.renderOrder = 1;
  scene.add(pipRefl);
  const pipShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.8),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.42, depthWrite: false })
  );
  pipShadow.rotation.x = -Math.PI / 2;
  pipShadow.position.set(PIP.x, 0.03, PIP.z);
  pipShadow.renderOrder = 1;
  scene.add(pipShadow);

  /* ---------------- lights ---------------- */
  const hemi = new THREE.HemisphereLight(0xfff0d8, 0x8a6f52, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd9a4, 2.6);
  sun.position.set(5.5, 8.5, 3.5);
  sun.target.position.set(-0.5, 0, -1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 25;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  const lampLight = new THREE.PointLight(0xffb45e, 0, 13, 2);
  lampLight.position.set(-4.55, 2.7, -0.9);
  scene.add(lampLight);

  /* ---------------- particles ---------------- */
  const DUST_N = 240;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST_N * 3);
  const dustSpd = new Float32Array(DUST_N);
  const dustPh = new Float32Array(DUST_N);
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i*3]   = -0.2 + Math.random() * 2.8;
    dustPos[i*3+1] = 0.15 + Math.random() * 4.4;
    dustPos[i*3+2] = -4.6 + Math.random() * 5.4;
    dustSpd[i] = 0.05 + Math.random() * 0.14;
    dustPh[i] = Math.random() * Math.PI * 2;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.055, map: radialTex, transparent: true, opacity: 0.55,
    color: 0xffe6b8, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.renderOrder = 6;
  scene.add(dust);

  const { geo: flyGeo, mat: flyMat } = makeFireflyMaterial();
  const flies = new THREE.Points(flyGeo, flyMat);
  flies.renderOrder = 6;
  scene.add(flies);

  const SPARK_N = 90;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(SPARK_N * 3);
  const sparkCol = new Float32Array(SPARK_N * 3);
  const sparkVel = new Float32Array(SPARK_N * 3);
  const sparkLife = new Float32Array(SPARK_N);
  const sparkMax = new Float32Array(SPARK_N);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({
    size: 0.13, map: radialTex, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.renderOrder = 7;
  sparks.frustumCulled = false;
  scene.add(sparks);
  const SPARK_BASE = new THREE.Color(0xffe9a8);
  const burst = (x, y, z, n, spread = 1.7, up = 2.4) => {
    for (let k = 0; k < n; k++) {
      const i = S.sparkCursor; S.sparkCursor = (S.sparkCursor + 1) % SPARK_N;
      sparkPos[i*3]   = x + (Math.random() - 0.5) * 0.6;
      sparkPos[i*3+1] = y + Math.random() * 0.3;
      sparkPos[i*3+2] = z + (Math.random() - 0.5) * 0.6;
      const a = Math.random() * Math.PI * 2, r = (0.4 + Math.random() * 0.9) * spread;
      sparkVel[i*3]   = Math.cos(a) * r;
      sparkVel[i*3+1] = up * (0.5 + Math.random() * 0.9);
      sparkVel[i*3+2] = Math.sin(a) * r;
      sparkLife[i] = sparkMax[i] = 0.6 + Math.random() * 0.5;
    }
  };

  /* ---------------- post chain (samples:0 — iOS rule) ---------------- */
  const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 0, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(PIXEL_RATIO);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.55, 0.78);
  composer.addPass(bloom);
  composer.addPass(new ShaderPass(TiltShiftShader));
  composer.addPass(new OutputPass());
  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);
  S.composer = composer;

  /* ---------------- day / night ---------------- */
  const ENV = {
    dayBg: C(0x2b1e15), nightBg: C(0x04060d),
    daySky: C(0xfff0d8), nightSky: C(0x33477a),
    dayGnd: C(0x8a6f52), nightGnd: C(0x0d0f16),
    daySun: C(0xffd9a4), nightSun: C(0x8fb4ff),
    dayShaft: C(0xffdca8), nightShaft: C(0x9db9ff),
    dayPatch: C(0xffc98a), nightPatch: C(0x7d94c9),
    dayTint: typeTintDay, nightTint: C(0x9db1dd),
  };
  const _c = new THREE.Color();
  const applyEnv = (m) => {
    hemi.intensity = lerp(0.34, 0.6, m);
    hemi.color.lerpColors(ENV.nightSky, ENV.daySky, m);
    hemi.groundColor.lerpColors(ENV.nightGnd, ENV.dayGnd, m);
    sun.intensity = lerp(0.55, 2.6, m);
    sun.color.lerpColors(ENV.nightSun, ENV.daySun, m);
    lampLight.intensity = lerp(26, 0, m);
    paneMat.color.lerpColors(NIGHT_PANE, DAY_PANE, m);
    windowGlow.material.color.lerpColors(ENV.nightShaft, ENV.dayShaft, m);
    windowGlow.material.opacity = lerp(0.5, 0.32, m);
    shaftMat.uniforms.intensity.value = lerp(0.10, 0.22, m);
    shaftMat.uniforms.color.value.lerpColors(ENV.nightShaft, ENV.dayShaft, m);
    patchMat.color.lerpColors(ENV.nightPatch, ENV.dayPatch, m);
    patchMat.opacity = lerp(0.30, 0.5, m);
    bloom.strength = lerp(0.85, 0.45, m);
    scene.background.lerpColors(ENV.nightBg, ENV.dayBg, m);
    _c.lerpColors(ENV.nightTint, ENV.dayTint, m);
    pip.material.color.copy(_c);
    lampSprite.material.color.copy(_c);
    pipRefl.material.color.copy(_c).multiplyScalar(0.6);
    dustMat.opacity = lerp(0.30, 0.55, m);
    flyMat.uniforms.night.value = 1 - m;
    lampGlow.material.opacity = (1 - m) * 0.6;
    renderer.toneMappingExposure = lerp(1.04, 1.14, m);
  };

  Object.assign(S, {
    PIP, pip, pipRefl, pipShadow, lampSprite,
    texIdle, texBlink, texHappy, billboards,
    dustGeo, dustSpd, dustPh, dustMat, DUST_N,
    sparkGeo, sparkPos, sparkCol, sparkVel, sparkLife, sparkMax, SPARK_N, SPARK_BASE,
    flyMat, shaftMat, gradePass, bloom,
    CAM_BASE, LOOK_BASE,
    applyEnv, burst,
    dayTarget: 1, dayMix: 1,
    pipAspect: 1,
    pipSt: { hopT: -1, lastHt: 0, happyUntil: -1, nextBlink: 2.5, blinkUntil: -1 },
    parallax: new THREE.Vector3(), parallaxGoal: new THREE.Vector3(),
    lookCur: LOOK_BASE.clone(),
    clock: new THREE.Clock(),
    sparkCursor: 0,
  });

  /* ---------------- behaviour fns ---------------- */
  S.triggerHop = (now) => {
    const st = S.pipSt;
    if (st.hopT >= 0) return;
    st.hopT = 0; st.lastHt = 0;
    st.happyUntil = now + 2.2;
    S.burst(S.PIP.x, S.PIP.baseY + 0.4, S.PIP.z, 22, 1.4, 2.0);
  };

  S.updatePip = (dt, t) => {
    const st = S.pipSt;
    let y = PIP.baseY + Math.sin(t * 2.1) * 0.035;
    let sy = 1 - Math.sin(t * 2.1) * 0.014;
    let sx = 1 + Math.sin(t * 2.1) * 0.014;
    if (st.hopT >= 0) {
      st.hopT += dt / 0.9;
      const ht = st.hopT;
      if (ht >= 1.28) { st.hopT = -1; }
      else {
        if (st.lastHt < 0.10 && ht >= 0.10) S.burst(PIP.x, 0.25, PIP.z, 18, 1.8, 1.6);
        if (st.lastHt < 1.00 && ht >= 1.00) S.burst(PIP.x, 0.25, PIP.z, 26, 2.0, 2.2);
        st.lastHt = ht;
        if (ht <= 1) y = PIP.baseY + 1.55 * 4 * ht * (1 - ht);
        [sy, sx] = keyTrack(Math.min(ht, 1.28), HOP_KEYS);
      }
    }
    let tex = S.texIdle;
    if (t < st.happyUntil) tex = S.texHappy;
    else if (st.hopT < 0) {
      if (t > st.nextBlink) { st.blinkUntil = t + 0.13; st.nextBlink = t + 2.4 + Math.random() * 3.4; }
      if (t < st.blinkUntil) tex = S.texBlink;
    }
    if (pip.material.map !== tex) { pip.material.map = tex; pipRefl.material.map = tex; }
    pip.position.set(PIP.x, y, PIP.z);
    pip.scale.set(PIP.h * S.pipAspect * sx, PIP.h * sy, 1);
    pipRefl.position.set(PIP.x, -y - 0.02, PIP.z);
    pipRefl.scale.set(PIP.h * S.pipAspect * sx, -PIP.h * sy, 1);
    const airK = Math.min(1, Math.max(0, (y - PIP.baseY) / 1.55));
    pipShadow.material.opacity = 0.42 * (1 - airK * 0.55);
    const ss = 1 - airK * 0.35;
    pipShadow.scale.set(ss, ss, 1);
  };

  S.updateDust = (dt, t) => {
    const p = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST_N; i++) {
      let y = p[i*3+1] + dustSpd[i] * dt;
      p[i*3] += Math.sin(t * 0.7 + dustPh[i]) * 0.10 * dt;
      if (y > 4.6) {
        y = 0.15;
        p[i*3] = -0.2 + Math.random() * 2.8;
        p[i*3+2] = -4.6 + Math.random() * 5.4;
      }
      p[i*3+1] = y;
    }
    dustGeo.attributes.position.needsUpdate = true;
  };

  S.updateSparks = (dt) => {
    const p = sparkGeo.attributes.position.array;
    const c = sparkGeo.attributes.color.array;
    let any = false;
    for (let i = 0; i < SPARK_N; i++) {
      if (sparkLife[i] <= 0) continue;
      any = true;
      sparkLife[i] -= dt;
      const k = Math.max(0, sparkLife[i] / sparkMax[i]);
      sparkVel[i*3+1] -= 4.5 * dt;
      p[i*3]   += sparkVel[i*3] * dt;
      p[i*3+1] += sparkVel[i*3+1] * dt;
      p[i*3+2] += sparkVel[i*3+2] * dt;
      c[i*3] = SPARK_BASE.r * k; c[i*3+1] = SPARK_BASE.g * k; c[i*3+2] = SPARK_BASE.b * k;
    }
    if (any) {
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
    }
  };

  S.updateCamera = (dt, t) => {
    S.parallax.lerp(S.parallaxGoal, 1 - Math.exp(-dt * 3));
    camera.position.set(
      CAM_BASE.x + Math.sin(t * 0.11) * 0.35 + S.parallax.x,
      CAM_BASE.y + Math.sin(t * 0.147 + 1.3) * 0.22 + S.parallax.y,
      CAM_BASE.z + Math.sin(t * 0.09 + 0.6) * 0.15
    );
    S.lookCur.copy(LOOK_BASE).addScaledVector(S.parallax, 0.35);
    camera.lookAt(S.lookCur);
  };

  /* ---------------- input ---------------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = 0, downX = 0, downY = 0;
  S.onPointerDown = (e) => { downAt = performance.now(); downX = e.clientX; downY = e.clientY; };
  S.onPointerUp = (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > 10 || performance.now() - downAt > 450) return;
    const w = veil.clientWidth || window.innerWidth, h = veil.clientHeight || window.innerHeight;
    ndc.set((e.clientX / w) * 2 - 1, -(e.clientY / h) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.intersectObject(pip).length) S.triggerHop(S.clock.elapsedTime);
  };
  S.onPointerMove = (e) => {
    const px = (e.clientX / window.innerWidth) * 2 - 1;
    const py = (e.clientY / window.innerHeight) * 2 - 1;
    S.parallaxGoal.set(px * 0.9, -py * 0.55, 0);
  };
  veil.addEventListener('pointerdown', S.onPointerDown);
  veil.addEventListener('pointerup', S.onPointerUp);
  window.addEventListener('pointermove', S.onPointerMove);

  /* ---------------- main loop ---------------- */
  S.resize = () => {
    const w = veil.clientWidth || window.innerWidth;
    const h = veil.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.fov = camera.aspect < 0.8 ? 34 : 26;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  };
  window.addEventListener('resize', S.resize);
  S.resize();

  const v3 = new THREE.Vector3();
  S.animate = () => {
    if (!active) return;
    S.raf = requestAnimationFrame(S.animate);
    const dt = Math.min(S.clock.getDelta(), 0.05);
    const t = S.clock.elapsedTime;

    S.dayMix += (S.dayTarget - S.dayMix) * (1 - Math.exp(-dt * 2.0));
    S.applyEnv(S.dayMix);

    S.shaftMat.uniforms.time.value = t;
    S.flyMat.uniforms.time.value = t;
    S.gradePass.uniforms.time.value = t;

    S.updateCamera(dt, t);
    S.updatePip(dt, t);
    S.updateDust(dt, t);
    S.updateSparks(dt);

    // speech bubble tracks the blob
    if (S.bubble) {
      v3.set(S.pip.position.x, S.pip.position.y + 1.05, S.pip.position.z).project(camera);
      const w = veil.clientWidth || window.innerWidth, h = veil.clientHeight || window.innerHeight;
      S.bubble.style.left = ((v3.x * 0.5 + 0.5) * w) + 'px';
      S.bubble.style.top = ((-v3.y * 0.5 + 0.5) * h - 14) + 'px';
    }

    composer.render();
  };

  /* ---------------- go ---------------- */
  const loaderEl = veil.querySelector('#int-loader');
  manager.onLoad = () => {
    if (!active) return;
    for (const b of billboards) {
      const img = b.sprite.material.map.image;
      if (img && img.width) {
        const a = img.width / img.height;
        b.sprite.scale.set(b.height * a, b.height, 1);
      }
    }
    const img = texIdle.image;
    if (img && img.width) S.pipAspect = img.width / img.height;
    S.applyEnv(1);
    composer.render(); // warm up
    if (loaderEl) loaderEl.classList.add('done');
    S.animate();
  };
  S.loadTimeout = setTimeout(() => {
    if (!active || S.raf) return;
    if (loaderEl) loaderEl.classList.add('done');
    S.animate();
  }, 15000);
}

/* Speech-bubble one-liner rotation, ~7s */
function startBubble(S, type) {
  if (!S.bubble) return;
  let i = Math.floor(Math.random() * type.oneLiners.length);
  const show = () => {
    if (!active) return;
    S.bubble.textContent = type.oneLiners[i % type.oneLiners.length];
    i++;
    S.bubble.classList.add('show');
    clearTimeout(S.bubbleHide);
    S.bubbleHide = setTimeout(() => S.bubble.classList.remove('show'), 5200);
  };
  show();
  S.bubbleTimer = setInterval(show, 7000);
}

export const Interior = {
  /** Open the HD-2D interior for a type. Contract: appends its own renderer
   *  to #interior-veil, adds `on` to the veil, runs its own loop.
   *  onExit() is called after teardown when the user taps "← Back to city". */
  enter(typeKey, onExit) {
    if (active) return; // guard against double-enter
    try {
      this._enter(typeKey, onExit);
    } catch (e) {
      this._teardown();
      throw e; // surface to window error listeners (Worker 1's toast)
    }
  },

  _enter(typeKey, onExit) {
    ensureStyle();
    const type = typeByKey(typeKey);
    let veil = document.getElementById('interior-veil');
    if (!veil) { // defensive: contract says Worker 1 provides it
      veil = document.createElement('div');
      veil.id = 'interior-veil';
      document.body.appendChild(veil);
    }
    active = true;

    const S = this._s = {
      veil, onExit, typeKey: type.key,
      raf: 0, bubbleTimer: 0, bubbleHide: 0, loadTimeout: 0,
      renderer: null, composer: null, scene: null, camera: null,
      bubble: null,
    };

    /* DOM: header chip, back pill, day/night toggle, bubble, loader */
    const mk = (tag, id, cls, html) => {
      const el = document.createElement(tag);
      if (id) el.id = id;
      if (cls) el.className = cls;
      if (html != null) el.innerHTML = html;
      veil.appendChild(el);
      return el;
    };
    S.backBtn = mk('button', 'int-back', 'int-pill', '← Back to city');
    S.backBtn.addEventListener('click', () => this.exit());
    mk('div', 'int-header', 'int-pill',
      `${escapeHtml(type.palName)} · ${escapeHtml(type.nickname)} · ${escapeHtml(type.name)}`);
    const dn = mk('div', 'int-dn', 'int-pill', '');
    const optDay = document.createElement('button');
    optDay.className = 'opt day active';
    optDay.textContent = '☀️ Day';
    const optNight = document.createElement('button');
    optNight.className = 'opt night';
    optNight.textContent = '🌙 Night';
    dn.append(optDay, optNight);
    const setDay = (day) => {
      S.dayTarget = day ? 1 : 0;
      optDay.classList.toggle('active', day);
      optNight.classList.toggle('active', !day);
    };
    optDay.addEventListener('click', () => setDay(true));
    optNight.addEventListener('click', () => setDay(false));
    S.bubble = mk('div', 'int-bubble', '', '');
    mk('div', 'int-loader', '', 'loading the cozy corner…');

    veil.classList.add('on');

    build(type, S);
    startBubble(S, type);
  },

  /** Teardown: remove `on`, cancel rAF, dispose everything, then onExit(). */
  exit() {
    if (!active) return;
    const S = this._s;
    const onExit = S && S.onExit;
    this._teardown();
    if (typeof onExit === 'function') {
      try { onExit(); } catch (e) { setTimeout(() => { throw e; }, 0); }
    }
  },

  _teardown() {
    const S = this._s;
    this._s = null;
    active = false;
    if (!S) return;
    try {
      clearTimeout(S.loadTimeout);
      clearInterval(S.bubbleTimer);
      clearTimeout(S.bubbleHide);
      if (S.raf) cancelAnimationFrame(S.raf);
      if (S.composer) {
        for (const p of (S.composer.passes || [])) { try { p.dispose && p.dispose(); } catch (_) {} }
        try { S.composer.dispose && S.composer.dispose(); } catch (_) {}
      }
      if (S.scene) disposeScene(S.scene);
      if (S.renderer) {
        S.renderer.dispose();
        if (S.renderer.domElement && S.renderer.domElement.parentNode) {
          S.renderer.domElement.parentNode.removeChild(S.renderer.domElement);
        }
      }
      window.removeEventListener('resize', S.resize);
      window.removeEventListener('pointermove', S.onPointerMove);
      if (S.veil) {
        S.veil.removeEventListener('pointerdown', S.onPointerDown);
        S.veil.removeEventListener('pointerup', S.onPointerUp);
        S.veil.classList.remove('on');
        // remove only the DOM this module added
        for (const id of ['int-back', 'int-header', 'int-dn', 'int-bubble', 'int-loader']) {
          const el = S.veil.querySelector('#' + id);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      }
    } catch (_) { /* teardown must not throw */ }
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// Expose for the city shell (loaded as a bare module script): main.js calls window.Interior.enter().
globalThis.Interior = Interior;
