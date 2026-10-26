/* selftest.js — `?selftest=1` audit mode for TypePop City 3D.
 *
 * Problem: browser screenshot capture fails intermittently on heavy WebGL
 * pages, so visual QA cannot depend on screenshots. This module reports its
 * verdict as DOM TEXT (plus document.title + console JSON), readable by any
 * text-based tool.
 *
 * Usage (wired by main.js, zero cost when the param is absent):
 *   const { runSelfTest } = await import('./selftest.js?v=1');
 *   await runSelfTest(ctx);
 * where ctx supplies the live city objects (renderer, composer, renderPass,
 * scene, camera, houses, residents, fountain, dn, TYPES, Room3D, applySky,
 * pauseCity, resumeCity, restoreCity, getBootErrors).
 *
 * The audit pauses the city loop, runs structural assertions on the live
 * scene graph, scripts the camera through render probes (sampling pixels
 * from the canvas — no screenshots), measures FPS, then restores the city
 * and writes the report. Thresholds are deliberately generous: the goal is
 * catching regressions (black screen, missing statue, grey fountain, dark
 * night), not pixel-perfect matching.
 */
import * as THREE from 'three';
import { createDayNight } from './daynight.js?v=2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- pixel analysis (pure helpers, unit-testable) ---------------- */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

// Fraction of pixels in a region that read as gold (statue hue range).
export function goldFraction(data, w, h, x0, y0, x1, y1) {
  let gold = 0, total = 0;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const i = (y * w + x) * 4;
      const { h: hue, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      total++;
      if (hue >= 28 && hue <= 52 && s > 0.25 && l > 0.22) gold++;
    }
  }
  return total ? gold / total : 0;
}

// Distinct 30-degree hue buckets among sampled points (sat/val gated).
export function hueBuckets(samples) {
  const buckets = new Set();
  for (const [r, g, b] of samples) {
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s > 0.3 && l > 0.22 && l < 0.92) buckets.add(Math.floor(h / 30));
  }
  return buckets.size;
}

// Mean brightness + warm-pixel fraction of a region (0..1 each).
export function regionStats(data, w, h, x0, y0, x1, y1) {
  let sum = 0, warm = 0, total = 0, rSum = 0, bSum = 0;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h: hue, s, l } = rgbToHsl(r, g, b);
      sum += l; rSum += r; bSum += b; total++;
      if (hue >= 18 && hue <= 62 && s > 0.3 && l > 0.25) warm++;
    }
  }
  if (!total) return { mean: 0, warmFrac: 0, rMean: 0, bMean: 0 };
  return { mean: sum / total, warmFrac: warm / total, rMean: rSum / total, bMean: bSum / total };
}

/* ---------------- capture ---------------- */
// Render must have happened in the same task before this call; with
// preserveDrawingBuffer:true (selftest mode) the canvas survives regardless.
async function capturePixels(renderer) {
  const url = renderer.domElement.toDataURL('image/png');
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const w = renderer.domElement.width, h = renderer.domElement.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return { data: x.getImageData(0, 0, w, h).data, w, h };
}

function projectToScreen(camera, vec, wCss, hCss) {
  const v = vec.clone().project(camera);
  if (v.z > 1) return null;
  return { x: (v.x * 0.5 + 0.5) * wCss, y: (-v.y * 0.5 + 0.5) * hCss };
}

/* ---------------- report ---------------- */
function makeReportEl() {
  const old = document.getElementById('selftest-report');
  if (old) old.remove();
  const el = document.createElement('pre');
  el.id = 'selftest-report';
  el.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9999;max-width:100vw;max-height:60vh;overflow:auto;margin:0;padding:10px 12px;background:rgba(8,8,10,0.92);color:#e8e8e8;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;';
  const btn = document.createElement('button');
  btn.textContent = '✕ close self-test report';
  btn.style.cssText = 'display:block;margin:0 0 8px auto;background:#333;color:#fff;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer;';
  btn.onclick = () => el.remove();
  el.appendChild(btn);
  document.body.appendChild(el);
  return el;
}

/* ---------------- main audit ---------------- */
export async function runSelfTest(ctx) {
  const lines = [];
  const checks = [];
  const reportEl = makeReportEl();
  // Rebuild the text while keeping the close button on top.
  const setLines = () => {
    const btn = reportEl.querySelector('button');
    reportEl.textContent = lines.join('\n');
    if (btn) reportEl.prepend(btn);
  };
  const log2 = (status, name, value) => {
    lines.push(`${status}  ${name}  ${value}`);
    checks.push({ status, name, value: String(value) });
    setLines();
  };
  const check = async (name, fn) => {
    try {
      const { status, value } = await fn();
      log2(status, name, value);
    } catch (e) {
      log2('FAIL', name, 'threw: ' + (e && e.message ? e.message : e));
    }
  };
  log2('INFO', 'selftest_start', 'audit running — city loop paused');

  const { renderer, composer, scene, camera, houses, residents, fountain, dn, TYPES, Room3D } = ctx;
  const cssW = window.innerWidth, cssH = window.innerHeight;
  const pr = (renderer.getPixelRatio && renderer.getPixelRatio()) || 1;
  const render = () => { camera.updateMatrixWorld(); composer.render(); };

  ctx.pauseCity();

  /* ---- A. structural checks on the live scene graph ---- */
  await check('houses_16', async () => {
    const ok = houses.filter((h) => h.group && h.group.parent === scene && h.doorPos && h.tagEl).length;
    return { status: ok === 16 ? 'PASS' : 'FAIL', value: `${ok}/16 houses with group in scene + door + sign` };
  });
  await check('residents_16', async () => {
    const ok = residents.filter((r) => r.rig && r.rig.fruit && r.rig.group && r.rig.group.parent === scene).length;
    const fruits = residents.map((r) => (r.rig && r.rig.fruit) || '?').join(',');
    return { status: ok === 16 ? 'PASS' : 'FAIL', value: `${ok}/16 BlobRigs with fruit [${fruits}]` };
  });
  await check('fountain_tiers', async () => {
    const n = fountain && fountain.tiers;
    return { status: n === 3 ? 'PASS' : 'FAIL', value: `tiers=${n}` };
  });
  await check('fountain_mosaic', async () => {
    const n = fountain && fountain.mosaicCount;
    return { status: n === 16 ? 'PASS' : 'FAIL', value: `tiles=${n}` };
  });
  await check('fountain_statue', async () => {
    const ok = !!(fountain && fountain.statue && fountain.statue.parent === fountain.group);
    return { status: ok ? 'PASS' : 'FAIL', value: ok ? 'gold statue present in fountain group' : 'statue missing' };
  });
  await check('street_lamps', async () => {
    let count = 0;
    scene.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive && o.material.emissive.getHex &&
          o.material.emissive.getHex() === 0xffca7a) count++;
    });
    return { status: count >= 8 ? 'PASS' : 'FAIL', value: `${count} lamp heads (emissive 0xffca7a) in scene` };
  });
  await check('lit_windows', async () => {
    const total = houses.reduce((s, h) => s + (h.winMats ? h.winMats.length : 0), 0);
    const ok = houses.filter((h) => h.winMats && h.winMats.length > 0).length;
    return { status: ok === 16 && total > 0 ? 'PASS' : 'FAIL', value: `${ok}/16 houses, ${total} window materials` };
  });
  await check('room_specs', async () => {
    if (!Room3D.specInfo) return { status: 'FAIL', value: 'Room3D.specInfo missing' };
    const info = Room3D.specInfo();
    const unknown = [];
    for (const [k, pieces] of Object.entries(info.specs)) {
      for (const p of pieces) if (!info.furnitureKeys.includes(p)) unknown.push(`${k}:${p}`);
    }
    // NOTE: ROOM_SPECS carries 16 type specs plus a `_default` fallback, so
    // assert coverage of every type rather than an exact count of 16.
    const missing = TYPES.filter((t) => !info.specKeys.includes(t.key)).map((t) => t.key);
    const ok = missing.length === 0 && unknown.length === 0;
    return { status: ok ? 'PASS' : 'FAIL', value: `${info.specKeys.length} specs (16 types + fallback), ${info.furnitureKeys.length} furniture pieces${missing.length ? `, MISSING: ${missing.join(',')}` : ''}${unknown.length ? `, UNKNOWN: ${unknown.join(',')}` : ''}` };
  });
  await check('room_architecture', async () => {
    // 2026-10-25 coherence pass: interiors must derive from exteriors.
    // Two-story exteriors (infj tower, intj monolith, entj glass box) must
    // have a loft + staircase + loft furniture; every type's window shape
    // and wall style must come from the allowed vocabularies. Static spec
    // data, but it is the same spec buildRoom consumes — a missing loft
    // here means the room the user steps into has no second level.
    if (!Room3D.specInfo) return { status: 'FAIL', value: 'Room3D.specInfo missing' };
    const info = Room3D.specInfo();
    const arch = info.architecture || {};
    const problems = [];
    const twoStory = ['infj', 'intj', 'entj'];
    const winShapes = ['rect', 'round', 'slit', 'wide', 'tall', 'glass'];
    const wallStyles = ['plain', 'logs', 'planks', 'brick'];
    for (const t of TYPES) {
      const a = arch[t.key];
      if (!a) { problems.push(`${t.key}:no-arch`); continue; }
      if (a.levels !== 1 && a.levels !== 2) problems.push(`${t.key}:levels=${a.levels}`);
      if (!winShapes.includes(a.windowShape)) problems.push(`${t.key}:win=${a.windowShape}`);
      if (!wallStyles.includes(a.wallStyle)) problems.push(`${t.key}:wall=${a.wallStyle}`);
      if (twoStory.includes(t.key)) {
        if (a.levels !== 2 || !a.hasLoft) problems.push(`${t.key}:no-loft`);
        if (!a.loftPieces || a.loftPieces.length === 0) problems.push(`${t.key}:loft-empty`);
        for (const lp of (a.loftPieces || []))
          if (!info.furnitureKeys.includes(lp)) problems.push(`${t.key}:loft-unknown:${lp}`);
      } else if (a.levels === 2) {
        problems.push(`${t.key}:unexpected-2-level`);
      }
    }
    const ok = problems.length === 0;
    const lv2 = TYPES.filter((t) => arch[t.key] && arch[t.key].levels === 2).map((t) => t.key).join(',');
    return { status: ok ? 'PASS' : 'FAIL', value: ok ? `2-level: [${lv2}], all windows/walls in vocabulary` : `PROBLEMS: ${problems.join(' ')}` };
  });
  await check('room_lighting', async () => {
    // 2026-10-25 night-darkness fix: every interior must stay readable at
    // night — ambient floor high enough, a real lamp strong enough, and a
    // loft light wherever there is a second level. Static spec data, but
    // it is the same data buildRoom consumes for its lights.
    if (!Room3D.specInfo) return { status: 'FAIL', value: 'Room3D.specInfo missing' };
    const info = Room3D.specInfo();
    const lighting = info.lighting || {};
    const problems = [];
    for (const t of TYPES) {
      const L = lighting[t.key];
      if (!L) { problems.push(`${t.key}:no-lighting`); continue; }
      if (L.nightHemiI < 0.40) problems.push(`${t.key}:hemi=${L.nightHemiI}`);
      if (L.lampNightI < 24) problems.push(`${t.key}:lamp=${L.lampNightI}`);
      if (L.nightKeyI < 0.12) problems.push(`${t.key}:key=${L.nightKeyI}`);
      if ((info.architecture[t.key] || {}).levels === 2 && !L.hasLoftLight)
        problems.push(`${t.key}:no-loft-light`);
    }
    const ok = problems.length === 0;
    return { status: ok ? 'PASS' : 'FAIL', value: ok ? 'hemi>=0.40, lamp>=24, key>=0.12, loft lights on all 2-level rooms' : `PROBLEMS: ${problems.join(' ')}` };
  });
  await check('daynight_samples', async () => {
    const probe = createDayNight();
    const vals = {};
    for (const h of [0, 6, 12, 18, 22]) {
      const ms = new Date(2026, 0, 1, h, 0, 0).getTime();
      probe.tick(ms, true);
      probe.snap();
      vals[h] = probe.cur.night;
    }
    const finite = Object.values(vals).every(Number.isFinite);
    const ok = finite && vals[0] > 0.8 && vals[22] > 0.8 && vals[12] < 0.2;
    const str = Object.entries(vals).map(([h, v]) => `${h}h:${v.toFixed(2)}`).join(' ');
    return { status: ok ? 'PASS' : 'FAIL', value: `${finite ? 'finite' : 'NON-FINITE'} ${str}` };
  });
  await check('boot_errors', async () => {
    const errs = (ctx.getBootErrors && ctx.getBootErrors()) || [];
    return { status: errs.length === 0 ? 'PASS' : 'FAIL', value: errs.length === 0 ? '0 console/window errors during boot' : `${errs.length} errors, first: ${errs[0].slice(0, 160)}` };
  });

  /* ---- B. render probes (pixel sampling, no screenshots) ---- */
  // Probe 1: plaza overview — expect gold (the statue) near the fountain top.
  await check('probe_plaza_gold', async () => {
    const look = new THREE.Vector3(0, 1.5, 0);
    const theta = 0.7, phi = 0.92, radius = 44;
    camera.position.set(
      look.x + radius * Math.sin(phi) * Math.sin(theta),
      look.y + radius * Math.cos(phi),
      look.z + radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(look);
    render();
    const { data, w, h } = await capturePixels(renderer);
    const c = projectToScreen(camera, new THREE.Vector3(0, 6.2, 0), cssW, cssH);
    if (!c) return { status: 'FAIL', value: 'statue point behind camera' };
    const bx = Math.round(c.x * pr), by = Math.round(c.y * pr), half = Math.round(80 * pr);
    const frac = goldFraction(data, w, h, bx - half, by - half, bx + half, by + half);
    return { status: frac >= 0.03 ? 'PASS' : 'FAIL', value: `gold ${(frac * 100).toFixed(1)}% of 160px box around statue (need >=3%)` };
  });

  // Probe 2: fountain close-up from two angles — expect >= 6 distinct hues on the ring.
  // NOTE (2026-10-24 fix): the old probe sampled a SCREEN-SPACE CIRCLE around
  // the projected center. The ring is a horizontal circle, which projects to
  // an ELLIPSE from any elevated camera — so most circle samples landed on
  // pavement/water/basin instead of tiles (that was the [3,2]/union-4 FAIL).
  // Now every sample is the projection of an actual 3D ring point.
  await check('probe_mosaic_hues', async () => {
    const perView = [];
    let union = new Set();
    for (const [cx, cz] of [[0, 10], [10, 0]]) {
      camera.position.set(cx, 7, cz);
      camera.lookAt(new THREE.Vector3(0, 1, 0));
      render();
      const { data, w, h } = await capturePixels(renderer);
      const samples = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const p = projectToScreen(camera,
          new THREE.Vector3(Math.cos(a) * 2.64, 0.78, Math.sin(a) * 2.64), cssW, cssH);
        if (!p) continue;
        const x = Math.round(p.x * pr), y = Math.round(p.y * pr);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = (y * w + x) * 4;
        samples.push([data[j], data[j + 1], data[j + 2]]);
      }
      const buckets = new Set();
      for (const [r, g, b] of samples) {
        const { h: hue, s, l } = rgbToHsl(r, g, b);
        if (s > 0.3 && l > 0.22 && l < 0.92) buckets.add(Math.floor(hue / 30));
      }
      perView.push(buckets.size);
      buckets.forEach((b) => union.add(b));
    }
    return { status: union.size >= 6 ? 'PASS' : 'FAIL', value: `distinct hues per view [${perView.join(',')}], union ${union.size} (need >=6)` };
  });

  // Probe 3: house entry — resident present + greeting bubble in DOM.
  await check('probe_room_resident', async () => {
    Room3D.enter('enfp', {
      renderer: ctx.renderer, composer: ctx.composer, renderPass: ctx.renderPass,
      getNightF: () => dn.nightF,
    }, null);
    await sleep(1400); // arrival beat is 800ms; margin for the bubble to show
    const rig = Room3D.getResident();
    const gb = document.getElementById('greetBubble');
    const gtext = gb ? (gb.textContent || '').trim() : '';
    const shown = !!(gb && gb.classList.contains('show') && gtext);
    Room3D.exit();
    await sleep(200);
    const ok = !!rig && shown;
    return { status: ok ? 'PASS' : 'FAIL', value: ok ? `resident present, greeting "${gtext.slice(0, 80)}"` : `resident=${!!rig} greetingShown=${shown} text="${gtext.slice(0, 60)}"` };
  });

  // Probe 4: forced night — window brightness + dark sky.
  await check('probe_night', async () => {
    const savedOverride = dn.override;
    dn.override = 'night';
    dn.tick(Date.now(), true);
    dn.snap();
    ctx.applySky(0);
    const h0 = houses[0];
    const hp = h0.pos.clone();
    camera.position.set(hp.x * 0.35, 5, hp.z * 0.35);
    camera.lookAt(new THREE.Vector3(hp.x, 2, hp.z));
    render();
    const { data, w, h } = await capturePixels(renderer);
    // NOTE (2026-10-24 fix): the old probe sampled the house CENTER, which
    // for ENFP is door-top + plain wall (its windows sit at ±1.75) — so it
    // measured moonlit wall, not a window (hence 0% warm despite bright
    // emissive windows). Sample a real camera-facing window mesh instead.
    let wc = null;
    {
      const wp = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Quaternion();
      let bestDot = -Infinity;
      h0.group.traverse((o) => {
        if (!o.isMesh || !h0.winMats.includes(o.material)) return;
        o.getWorldPosition(wp);
        o.getWorldQuaternion(q);
        n.set(0, 0, 1).applyQuaternion(q);
        const d = n.dot(camera.position.clone().sub(wp).normalize());
        if (d > bestDot) {
          bestDot = d;
          wc = projectToScreen(camera, wp.clone(), cssW, cssH);
        }
      });
      if (bestDot <= 0) wc = null;
    }
    if (!wc) wc = projectToScreen(camera, new THREE.Vector3(hp.x, 2.5, hp.z), cssW, cssH);
    let winStr = 'no window point';
    let winOk = false;
    if (wc) {
      const half = Math.round(40 * pr);
      const st = regionStats(data, w, h, Math.round(wc.x * pr) - half, Math.round(wc.y * pr) - half, Math.round(wc.x * pr) + half, Math.round(wc.y * pr) + half);
      winOk = st.mean > 0.10 && st.warmFrac > 0.03;
      winStr = `window mean ${st.mean.toFixed(2)} warm ${(st.warmFrac * 100).toFixed(1)}%`;
    }
    const sky = regionStats(data, w, h, Math.round(w * 0.4), 0, Math.round(w * 0.6), Math.round(h * 0.08));
    const skyOk = sky.mean < 0.35 && sky.bMean > sky.rMean;
    const skyStr = `sky mean ${sky.mean.toFixed(2)} B>R=${sky.bMean > sky.rMean}`;
    const winEmissive = h0.winMats && h0.winMats.length ? h0.winMats[0].emissiveIntensity : 0;
    // Restore real-time sky.
    dn.override = savedOverride;
    dn.tick(Date.now(), true);
    dn.snap();
    ctx.applySky(0);
    const ok = winOk && skyOk;
    return { status: ok ? 'PASS' : 'FAIL', value: `${winStr} (winEmissive ${winEmissive.toFixed(1)}); ${skyStr}` };
  });

  /* ---- C. performance ---- */
  await check('perf_fps', async () => {
    // NOTE (2026-10-24 fix): the old probe measured while the city loop was
    // paused AND read renderer.info after composer.render() — whose final
    // pass is a fullscreen triangle, hence the meaningless "1 call, 1 tri".
    // Now: unpause the live loop and count real vsync frames for 3s, and
    // read calls/tris from one direct scene render (bypassing the composer
    // tail). The audit's final restore+resume still runs after this check.
    ctx.resumeCity();
    await sleep(150); // let the loop restart
    let frames = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const step = () => {
        frames++;
        if (performance.now() - t0 < 3000) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    const fps = frames / ((performance.now() - t0) / 1000);
    // Direct scene render for a true scene-frame call/triangle count.
    const prevAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = true;
    renderer.render(scene, camera);
    const calls = renderer.info.render.calls;
    const tris = renderer.info.render.triangles;
    renderer.info.autoReset = prevAutoReset;
    ctx.pauseCity();
    const ua = (navigator.userAgent || '').slice(0, 80);
    // WARN, not FAIL, below 20fps: the test machine's power is unknown.
    return { status: fps >= 20 ? 'PASS' : 'WARN', value: `${fps.toFixed(1)} fps (live loop), ${calls} scene calls, ${tris} tris [${ua}]` };
  });

  /* ---- restore + verdict ---- */
  try { ctx.restoreCity(); } catch (e) { /* restore is best-effort */ }
  try { ctx.resumeCity(); } catch (e) { /* resume is best-effort */ }
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const verdict = failed === 0 ? 'PASS' : 'FAIL';
  lines.push(`VERDICT: ${verdict}`);
  setLines();
  document.title = `SELFTEST: ${verdict}`;
  try { console.log('[selftest]', JSON.stringify({ verdict, checks })); } catch (e) { /* noop */ }
  return { verdict, checks };
}
