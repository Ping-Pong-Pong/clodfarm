/* TypePop City 3D — real-local-time 24h lighting model.
 *
 * createDayNight() owns the full lighting rig across a 24-hour day, driven by
 * the browser's local time (new Date() — no geolocation, no API calls).
 *
 * The rig is keyframed: a set of STOPS across the day (deep night → dawn →
 * morning → noon → golden afternoon → sunset → dusk → night), with smooth
 * (cosine-eased) interpolation between stops, so there is no popping at the
 * boundaries. Sun elevation follows a sine that peaks at solar noon; azimuth
 * sweeps east → west during the day and the moon continues the sweep at night.
 *
 * Cadence contract (kept cheap for iOS):
 *   tick(nowMs)  — re-interpolates the TARGET rig. No-op unless ~30s elapsed
 *                  or the override changed. Call once on load, on
 *                  visibilitychange, and each frame (it early-outs).
 *   smooth(dt)   — eases the LIVE rig (cur) toward the target with an
 *                  exponential ease, so override flips and keyframe edges
 *                  never pop. Per-frame cost is a handful of lerps.
 *   snap()       — jump the live rig to the target instantly (first load).
 *
 * main.js reads dn.cur every frame to drive the city; room3d.js interiors
 * consume dn.nightF through the existing api.getNightF() wiring.
 */
import * as THREE from 'three';

export const DAYNIGHT_TICK_MS = 30000;

// One keyframe stop. hour in [0,24]. night: 0 = full day, 1 = deep night
// (drives lamps, windows, fireflies, resident sleep — the old nightF).
// lamp: window/lamp emissive factor; firefly/dust: particle opacities.
const STOPS = [
  // deep night (0–5)
  { h: 0.0,  sky: 0x0b1026, sunC: 0x7d94c9, sunI: 0.14, hemiI: 0.18, hemiSky: 0x27334f, hemiGnd: 0x141a26, lamp: 1.00, firefly: 1.00, dust: 0.12, night: 1.00 },
  { h: 5.0,  sky: 0x0b1026, sunC: 0x7d94c9, sunI: 0.14, hemiI: 0.18, hemiSky: 0x27334f, hemiGnd: 0x141a26, lamp: 1.00, firefly: 1.00, dust: 0.12, night: 1.00 },
  // pre-dawn lift (5–7 → dawn)
  { h: 6.0,  sky: 0x1a2340, sunC: 0x8d9cc8, sunI: 0.16, hemiI: 0.20, hemiSky: 0x2c3a5c, hemiGnd: 0x171d2c, lamp: 1.00, firefly: 0.90, dust: 0.15, night: 0.96 },
  // dawn (7): warm low sun, pink-orange sky
  { h: 7.0,  sky: 0xe8a37e, sunC: 0xffb36b, sunI: 0.85, hemiI: 0.48, hemiSky: 0xd8a88e, hemiGnd: 0x5c5148, lamp: 0.55, firefly: 0.25, dust: 0.35, night: 0.22 },
  // morning (7–11): dawn burns off fast, then bright warm-white
  { h: 8.5,  sky: 0xaedcf2, sunC: 0xfff2dc, sunI: 1.30, hemiI: 0.72, hemiSky: 0xc4e6ff, hemiGnd: 0x6e9362, lamp: 0.06, firefly: 0.00, dust: 0.65, night: 0.01 },
  { h: 11.0, sky: 0x9fd4ef, sunC: 0xfff0d8, sunI: 1.38, hemiI: 0.76, hemiSky: 0xbfe3ff, hemiGnd: 0x6a8f5f, lamp: 0.02, firefly: 0.00, dust: 0.68, night: 0.00 },
  // noon (11–15): bright, high sun
  { h: 13.0, sky: 0xa8ddff, sunC: 0xfff6e8, sunI: 1.50, hemiI: 0.80, hemiSky: 0xc8ecff, hemiGnd: 0x749a66, lamp: 0.00, firefly: 0.00, dust: 0.70, night: 0.00 },
  // golden afternoon (15–17)
  { h: 16.5, sky: 0xf2c189, sunC: 0xffd9a0, sunI: 1.10, hemiI: 0.62, hemiSky: 0xe8cba0, hemiGnd: 0x6d7a52, lamp: 0.08, firefly: 0.00, dust: 0.55, night: 0.05 },
  // sunset (17–19): low orange sun, long mood
  { h: 18.5, sky: 0xe8825a, sunC: 0xff9448, sunI: 0.65, hemiI: 0.38, hemiSky: 0xc98a6a, hemiGnd: 0x4a4038, lamp: 0.45, firefly: 0.15, dust: 0.30, night: 0.34 },
  // dusk / blue hour (19–21): lamps coming up
  { h: 20.5, sky: 0x1c2547, sunC: 0x8fa3d4, sunI: 0.20, hemiI: 0.22, hemiSky: 0x2c3a5c, hemiGnd: 0x1a2030, lamp: 0.90, firefly: 0.80, dust: 0.18, night: 0.90 },
  // night (21–24)
  { h: 22.5, sky: 0x0d1228, sunC: 0x7d94c9, sunI: 0.14, hemiI: 0.18, hemiSky: 0x27334f, hemiGnd: 0x141a26, lamp: 1.00, firefly: 1.00, dust: 0.12, night: 1.00 },
  { h: 24.0, sky: 0x0b1026, sunC: 0x7d94c9, sunI: 0.14, hemiI: 0.18, hemiSky: 0x27334f, hemiGnd: 0x141a26, lamp: 1.00, firefly: 1.00, dust: 0.12, night: 1.00 },
];

const lerp = (a, b, k) => a + (b - a) * k;
const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

function mkRig() {
  return {
    night: 0, sunI: 1.35, hemiI: 0.75, lamp: 0, firefly: 0, dust: 0.6,
    elevDeg: 51, azimDeg: 0,
    sky: new THREE.Color(0x9fd4ef),
    sunC: new THREE.Color(0xfff2dd),
    hemiSky: new THREE.Color(0xbfe3ff),
    hemiGnd: new THREE.Color(0x6a8f5f),
    sunPos: new THREE.Vector3(28, 42, 18),
  };
}

const _c = new THREE.Color();

function sampleStops(h, out) {
  let i = 0;
  while (i < STOPS.length - 2 && h >= STOPS[i + 1].h) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const s = smooth01((h - a.h) / (b.h - a.h));
  out.night = lerp(a.night, b.night, s);
  out.sunI = lerp(a.sunI, b.sunI, s);
  out.hemiI = lerp(a.hemiI, b.hemiI, s);
  out.lamp = lerp(a.lamp, b.lamp, s);
  out.firefly = lerp(a.firefly, b.firefly, s);
  out.dust = lerp(a.dust, b.dust, s);
  out.sky.setHex(a.sky).lerp(_c.setHex(b.sky), s);
  out.sunC.setHex(a.sunC).lerp(_c.setHex(b.sunC), s);
  out.hemiSky.setHex(a.hemiSky).lerp(_c.setHex(b.hemiSky), s);
  out.hemiGnd.setHex(a.hemiGnd).lerp(_c.setHex(b.hemiGnd), s);
}

const SUN_R = 52; // matches the old fixed sun's distance (~53.6), keeps shadow framing
function sampleSun(h, out) {
  let elevDeg, azimDeg;
  if (h >= 6 && h < 18) {
    // daylight: elevation sine peaking at solar noon, azimuth east → west
    const dayT = (h - 6) / 12;
    elevDeg = 62 * Math.sin(Math.PI * dayT);
    azimDeg = -80 + 160 * dayT;
  } else {
    // night: moonlight — dim cool light that rises where the sun set and
    // sets where the sun will rise, so the light position never jumps.
    const nightT = (((h - 18) + 24) % 24) / 12;
    elevDeg = 32;
    azimDeg = 80 - 160 * nightT;
  }
  out.elevDeg = elevDeg;
  out.azimDeg = azimDeg;
  const el = elevDeg * Math.PI / 180, az = azimDeg * Math.PI / 180;
  out.sunPos.set(
    SUN_R * Math.cos(el) * Math.cos(az),
    SUN_R * Math.sin(el),
    SUN_R * Math.cos(el) * Math.sin(az),
  );
}

function copyRig(dst, src) {
  dst.night = src.night; dst.sunI = src.sunI; dst.hemiI = src.hemiI;
  dst.lamp = src.lamp; dst.firefly = src.firefly; dst.dust = src.dust;
  dst.elevDeg = src.elevDeg; dst.azimDeg = src.azimDeg;
  dst.sky.copy(src.sky); dst.sunC.copy(src.sunC);
  dst.hemiSky.copy(src.hemiSky); dst.hemiGnd.copy(src.hemiGnd);
  dst.sunPos.copy(src.sunPos);
}

export function createDayNight() {
  const cur = mkRig();    // live, smoothed rig — what the renderer reads
  const target = mkRig(); // keyframed target — what tick() writes
  let lastTick = -Infinity;
  let lastOverride = null;

  const dn = {
    cur, target,
    override: 'auto', // 'auto' | 'day' | 'night' — set by the dock pill
    hour: 12,         // last sampled local hour (for debugging / labels)

    // Recompute the target rig from local time (or the override hold).
    // Cheap: no-op unless ~30s elapsed or the override changed since last tick.
    tick(nowMs, force = false) {
      if (!force && nowMs - lastTick < DAYNIGHT_TICK_MS && lastOverride === dn.override) return false;
      lastTick = nowMs;
      lastOverride = dn.override;
      const d = new Date(nowMs);
      let h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      if (dn.override === 'day') h = 12.5;       // hold: high noon
      else if (dn.override === 'night') h = 0.5; // hold: deep night
      dn.hour = h;
      sampleStops(h, target);
      sampleSun(h, target);
      return true;
    },

    // Jump the live rig to the target (first load — open on the true sky).
    snap() { copyRig(cur, target); },

    // Ease the live rig toward the target. Called every frame; ~15 lerps.
    smooth(dt) {
      const k = 1 - Math.exp(-dt * 0.9); // ~5s time constant, no popping
      cur.night += (target.night - cur.night) * k;
      cur.sunI += (target.sunI - cur.sunI) * k;
      cur.hemiI += (target.hemiI - cur.hemiI) * k;
      cur.lamp += (target.lamp - cur.lamp) * k;
      cur.firefly += (target.firefly - cur.firefly) * k;
      cur.dust += (target.dust - cur.dust) * k;
      cur.elevDeg += (target.elevDeg - cur.elevDeg) * k;
      cur.azimDeg += (target.azimDeg - cur.azimDeg) * k;
      cur.sky.lerp(target.sky, k);
      cur.sunC.lerp(target.sunC, k);
      cur.hemiSky.lerp(target.hemiSky, k);
      cur.hemiGnd.lerp(target.hemiGnd, k);
      cur.sunPos.lerp(target.sunPos, k);
    },

    // The old nightF (0 = full day, 1 = deep night) — drives sleep, interiors.
    get nightF() { return cur.night; },
    get isNight() { return cur.night > 0.5; },
    // Sun elevation/azimuth in degrees (day: true sun path; night: moon path).
    get sunElevation() { return cur.elevDeg; },
    get sunAzimuth() { return cur.azimDeg; },
  };
  return dn;
}
