/* TypePop City — a top-down HD pixel-art MBTI town.
 *
 * Engine patterns (canvas + DOM labels, HD pre-rendered background, camera with
 * DPR-snapped zoom, pixel sprites via a Pix class, depth-sorted critters, zoom-
 * thresholded tags and speech bubbles) adapted from matank001/clodfarm (MIT).
 * The city, its residents, and the in-JS world simulation are original to
 * TypePop City. Static hosting only: no backend, no polling.
 */
"use strict";

/* ================================================================ utilities */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  el.replaceChildren(...kids.flat(3).filter(k => k != null && k !== false));
  return el;
}
function fill(el, ...kids) { el.replaceChildren(...kids.flat(3).filter(k => k != null && k !== false)); return el; }
function canvas(w, hgt) { const c = document.createElement("canvas"); c.width = w; c.height = hgt; return c; }

/* ================================================================ HD pixels
 * Same idea as the clodfarm engine: the world thinks in world pixels, and every
 * background + sprite is drawn on a grid twice as fine (HD = 2), so shading and
 * outlines stay crisp when the canvas is scaled to whole device pixels. */
const HD = 2;
const rgbOf = (hx) => [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)];
function mix(a, b, t) { const A = rgbOf(a), B = rgbOf(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16), f = (v) => clamp(Math.round(v + amt * 255), 0, 255);
  return "#" + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, "0")).join("");
}
class Pix {
  constructor(w, hgt) { this.w = w; this.h = hgt; this.p = new Array(w * hgt).fill(null); }
  set(x, y, c) { x = Math.floor(x); y = Math.floor(y); if (c && x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y * this.w + x] = c; return this; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.p[y * this.w + x] : null; }
  rect(x, y, w, hgt, c) { for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); return this; }
  oval(cx, cy, rx, ry, c, rot = 0) {
    const cs = Math.cos(rot), sn = Math.sin(rot), R = Math.max(rx, ry) + 1;
    for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, u = (dx * cs + dy * sn) / rx, v = (-dx * sn + dy * cs) / ry;
      if (u * u + v * v <= 1) this.set(x, y, typeof c === "function" ? c(x, y, u, v) : c);
    }
    return this;
  }
  line(x0, y0, x1, y1, c) { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1); for (let i = 0; i <= n; i++) this.set(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c); return this; }
  /** Ring every filled shape in `c` (the empty pixels next to a filled one). */
  outline(c, diag = false) {
    const add = [], f = (x, y) => !!this.get(x, y);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.p[y * this.w + x]) continue;
      if (f(x - 1, y) || f(x + 1, y) || f(x, y - 1) || f(x, y + 1) || (diag && (f(x - 1, y - 1) || f(x + 1, y - 1) || f(x - 1, y + 1) || f(x + 1, y + 1)))) add.push(y * this.w + x);
    }
    for (const i of add) this.p[i] = c;
    return this;
  }
  canvas() {
    const c = canvas(this.w, this.h), g = c.getContext("2d"), img = g.createImageData(this.w, this.h), d = img.data, memo = {};
    this.p.forEach((col, i) => { if (!col) return; const v = memo[col] || (memo[col] = rgbOf(col)); d[i * 4] = v[0]; d[i * 4 + 1] = v[1]; d[i * 4 + 2] = v[2]; d[i * 4 + 3] = 255; });
    g.putImageData(img, 0, 0);
    return c;
  }
}
const EYE = "#231815", SHINE = "#ffffff";
const hdRect = (g, x, y, w, hgt, c) => { g.fillStyle = c; g.fillRect(x, y, w, hgt); };
const G = { // meadow palette (adapted from the clodfarm engine)
  g0: "#4a6524", g1: "#577530", g2: "#648436", g3: "#71923c", g4: "#80a246", worn: "#8ea456",
  t0: "#1c3519", t1: "#28501f", t2: "#346a27", t3: "#468a31", t4: "#63a93f", t5: "#8cc65a", trunk: "#4b3421",
  r0: "#34343c", r1: "#55555e", r2: "#6f6f78", r3: "#8d8d96", r4: "#aeaeb5",
  w0: "#2a5a8a", w1: "#3f7fb8", w2: "#5b9ed0", w3: "#9fd0ee",
};
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
function valueNoise(seed) {
  const rnd = mulberry32(seed), N = 64, grid = Array.from({ length: N * N }, rnd);
  const at = (x, y) => grid[((y % N + N) % N) * N + ((x % N + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v);
  };
}
function pxCircle(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}
function pxEllipse(g, cx, cy, rx, ry, color) {
  g.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.6))));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}

/* ============================================ background pieces (HD pixels) */
function drawTreeHD(g, x, y, r, rnd) {
  pxEllipse(g, x + 4, y + r - 2, r + 3, Math.max(5, Math.round(r / 3)), "rgba(20,32,10,.32)");
  hdRect(g, x - 4, y + r - 15, 8, 15, G.trunk); hdRect(g, x - 4, y + r - 15, 2, 15, "#5e4330"); hdRect(g, x + 2, y + r - 15, 2, 15, "#35241a");
  hdRect(g, x - 6, y + r - 2, 3, 2, G.trunk); hdRect(g, x + 3, y + r - 2, 3, 2, "#35241a");
  const blobs = [[0, 0, 1], [-0.5, -0.15, 0.62], [0.5, -0.1, 0.6], [0, -0.52, 0.62], [-0.3, 0.3, 0.55], [0.35, 0.32, 0.5]].map(([dx, dy, k]) => [x + dx * r, y + dy * r, Math.max(3, r * k)]);
  for (const [bx, by, br] of blobs) pxCircle(g, bx, by, br + 2, G.t0);
  for (const [bx, by, br] of blobs) pxCircle(g, bx, by, br, G.t1);
  for (const [bx, by, br] of blobs) pxCircle(g, bx - br * 0.18, by - br * 0.22, br * 0.78, G.t2);
  for (const [bx, by, br] of blobs) if (by < y + r * 0.2) pxCircle(g, bx - br * 0.32, by - br * 0.38, br * 0.46, G.t3);
  for (const [bx, by, br] of blobs.slice(1, 4)) pxCircle(g, bx - br * 0.4, by - br * 0.46, br * 0.2, G.t4);
  for (let i = 0; i < r * 2.2; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * r * 0.95, lx = Math.round(x + Math.cos(a) * d), ly = Math.round(y + Math.sin(a) * d * 0.9);
    hdRect(g, lx, ly, 2, 1, ly < y ? G.t4 : G.t1); if (ly < y - r * 0.3) hdRect(g, lx, ly - 1, 1, 1, G.t5);
  }
}
function drawRockHD(g, r) {
  const cx = Math.round(r.x * HD), rx = r.w, ry = Math.round(r.h * 0.9), cy = Math.round((r.y + r.h) * HD - ry);
  pxEllipse(g, cx + 3, cy + ry, rx + 2, 4, "rgba(20,32,10,.38)");
  pxEllipse(g, cx, cy, rx + 1, ry + 1, G.r0); pxEllipse(g, cx, cy, rx, ry, G.r1);
  pxEllipse(g, cx - Math.round(rx * 0.15), cy - Math.round(ry * 0.2), Math.round(rx * 0.72), Math.round(ry * 0.62), G.r2);
  pxEllipse(g, cx - Math.round(rx * 0.35), cy - Math.round(ry * 0.45), Math.round(rx * 0.32), Math.round(ry * 0.22), G.r3);
  pxEllipse(g, cx + Math.round(rx * 0.3), cy - ry + 1, Math.round(rx * 0.32), 1, "#5f8a34"); hdRect(g, cx + Math.round(rx * 0.2), cy - ry, 3, 1, "#86b04a");
}
function drawPathHD(g, pts, rnd) {
  const seg = (a, b, pad, c) => { const x0 = Math.min(a.x, b.x) * HD - pad, y0 = Math.min(a.y, b.y) * HD - pad; hdRect(g, x0, y0, Math.abs(a.x - b.x) * HD + pad * 2, Math.abs(a.y - b.y) * HD + pad * 2, c); };
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i], 8, "#7f6a3d");
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i], 7, "#a88a58");
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i], 5, "#b69866");
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.round((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * 0.8);
    for (let k = 0; k < n; k++) { const t = rnd(), px = Math.round(lerp(a.x, b.x, t) * HD + (rnd() - 0.5) * 11), py = Math.round(lerp(a.y, b.y, t) * HD + (rnd() - 0.5) * 11); hdRect(g, px, py, 2, 1, rnd() < 0.5 ? "#cdb07c" : "#8b7045"); }
  }
}
function drawPondHD(g, P, rnd) {
  const cx = P.cx * HD, cy = P.cy * HD, rx = P.rx * HD, ry = P.ry * HD;
  pxEllipse(g, cx, cy + 2, rx + 7, ry + 6, "#8e7a4c");
  pxEllipse(g, cx, cy + 1, rx + 5, ry + 4, "#c8b27a");
  pxEllipse(g, cx, cy + 1, rx + 2, ry + 2, "#3d5a22");
  pxEllipse(g, cx, cy, rx, ry, G.w0);
  pxEllipse(g, cx, cy + 2, rx - 1, ry - 1, G.w1);
  pxEllipse(g, cx - 6, cy - 3, rx - 14, ry - 8, G.w2);
  for (let i = 0; i < 10; i++) hdRect(g, Math.round(cx - rx * 0.6 + rnd() * rx * 1.2), Math.round(cy - ry * 0.5 + rnd() * ry), 4 + Math.round(rnd() * 4), 1, G.w3);
  for (const [dx, dy, s] of [[-0.45, 0.2, 1], [0.35, -0.15, 0.8], [0.15, 0.45, 0.7]]) {
    const px = cx + dx * rx, py = cy + dy * ry, r = 5 * s + 2;
    pxEllipse(g, px, py, r + 1, r * 0.6 + 1, "#1f4d1d"); pxEllipse(g, px, py, r, r * 0.6, "#4f9a3a"); hdRect(g, px, py - 1, Math.ceil(r), 2, G.w1); hdRect(g, px - r * 0.5, py - 2, 3, 1, "#7cc35a");
  }
  hdRect(g, cx - rx * 0.45 - 1, cy + ry * 0.2 - 4, 3, 3, "#f59cc0"); hdRect(g, cx - rx * 0.45, cy + ry * 0.2 - 3, 1, 1, "#fff4c2");
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
    const rxp = Math.round(cx + s * (rx - 6 + i * 4)), top = cy - 10 - i * 3 - (i % 2) * 3;
    hdRect(g, rxp, top, 1, cy + 4 - top, i % 2 ? "#2f5a1f" : "#3f7a2a"); hdRect(g, rxp - 1, top - 1, 3, 5, "#6b4a2b"); hdRect(g, rxp, top - 3, 1, 2, "#3f7a2a");
  }
}
const FLOWER_C = ["#f4f1e8", "#f5c542", "#f59cc0", "#b9d9ff", "#ff8f6b", "#c99bf0"];
function drawDecorHD(g, d, rnd) {
  const x = Math.round(d.x * HD), y = Math.round(d.y * HD);
  if (d.kind === "flowers") for (let i = 0; i < 3 + Math.floor(rnd() * 4); i++) {
    const fx = x + Math.round((rnd() - 0.5) * 16), fy = y + Math.round((rnd() - 0.5) * 8), c = FLOWER_C[(d.c + i) % FLOWER_C.length];
    hdRect(g, fx, fy, 1, 3, "#3f7a2a"); hdRect(g, fx - 1, fy - 2, 3, 1, c); hdRect(g, fx, fy - 3, 1, 3, c); hdRect(g, fx, fy - 2, 1, 1, "#f5c542");
  }
  if (d.kind === "bush") {
    pxEllipse(g, x + 2, y + 1, 12, 4, "rgba(20,32,10,.3)");
    for (const [dx, dy, r] of [[-5, -4, 6], [5, -4, 6], [0, -8, 6], [0, -3, 7]]) pxCircle(g, x + dx, y + dy, r + 1, G.t0);
    for (const [dx, dy, r] of [[-5, -4, 6], [5, -4, 6], [0, -8, 6], [0, -3, 7]]) { pxCircle(g, x + dx, y + dy, r, G.t2); pxCircle(g, x + dx - 1, y + dy - 2, r * 0.55, G.t3); }
    if (d.c % 2) for (const [dx, dy] of [[-6, -5], [3, -9], [6, -3], [-1, -2]]) { hdRect(g, x + dx, y + dy, 2, 2, "#d6334a"); hdRect(g, x + dx, y + dy, 1, 1, "#ff8a9a"); }
  }
  if (d.kind === "mushrooms") for (const [dx, s] of [[-3, 1], [3, 0.7], [0, 0.55]]) {
    const px = x + dx, r = 3 * s + 1;
    hdRect(g, px - 1, y - 4 * s, 2, 4 * s, "#f4ecd8"); pxEllipse(g, px, y - 4 * s - 1, r + 1, r * 0.7 + 1, "#5c130e"); pxEllipse(g, px, y - 4 * s - 1, r, r * 0.7, "#d6334a"); hdRect(g, px - 1, y - 4 * s - 2, 1, 1, "#fff"); hdRect(g, px + 1, y - 4 * s - 1, 1, 1, "#fff");
  }
}
/** The plaza fountain: stone basin, water, pillar. World coords. */
function drawFountainHD(g, f) {
  const x = Math.round(f.x * HD), y = Math.round(f.y * HD);
  pxEllipse(g, x + 3, y + 14, 22, 7, "rgba(20,32,10,.3)");
  pxEllipse(g, x, y + 8, 21, 7, "#5b5b64"); pxEllipse(g, x, y + 7, 19, 6, "#8d8d96");
  pxEllipse(g, x, y + 6, 15, 5, G.w0); pxEllipse(g, x, y + 5, 14, 4, G.w1);
  pxEllipse(g, x - 5, y + 3, 7, 2, G.w2); pxEllipse(g, x - 5, y + 2, 2, 1, G.w3);
  hdRect(g, x - 3, y - 16, 6, 22, "#7d7d86"); hdRect(g, x - 3, y - 16, 2, 22, "#9d9da6");
  pxEllipse(g, x, y - 18, 9, 4, "#5b5b64"); pxEllipse(g, x, y - 19, 7, 3, G.w0); pxEllipse(g, x, y - 20, 4, 2, G.w3);
  if (!REDUCED) { hdRect(g, x + 8, y - 8, 2, 1, G.w3); hdRect(g, x - 10, y - 4, 2, 1, G.w3); }
}
/** Wooden type-code sign by a house door, with its code in pixel type. */
function drawSignHD(g, s) {
  const x = Math.round(s.x * HD), y = Math.round(s.y * HD);
  hdRect(g, x - 1, y + 4, 3, 16, "#3a2616"); hdRect(g, x, y + 4, 1, 16, "#8a6038"); hdRect(g, x - 3, y + 19, 8, 2, "rgba(20,32,10,.35)");
  const bw = 48;
  hdRect(g, x - bw / 2, y - 6, bw, 14, "#3a2616"); hdRect(g, x - bw / 2 + 2, y - 4, bw - 4, 10, "#c9964a"); hdRect(g, x - bw / 2 + 2, y - 4, bw - 4, 2, "#dcae62");
  g.fillStyle = "#3a2616"; g.font = "10px PressStart, monospace"; g.textAlign = "center"; g.textBaseline = "top";
  g.fillText(s.text, x, y - 3);
}
const shadowCache = new Map();
function shadowSprite(rx, ry) {
  const k = rx + "x" + ry;
  if (!shadowCache.has(k)) { const P = new Pix(rx * 2 + 2, ry * 2 + 2); P.oval(rx + 1, ry + 1, rx, ry, "#14200c"); shadowCache.set(k, P.canvas()); }
  return shadowCache.get(k);
}
const SPARKLE = ["#fff4c2", "#ffd59e", "#f2a07a", "#ffffff"].map(c => { const P = new Pix(7, 7); P.rect(3, 1, 1, 5, c); P.rect(1, 3, 5, 1, c); P.set(3, 3, "#ffffff"); P.set(3, 0, shade(c, -0.1)); P.set(3, 6, shade(c, -0.1)); P.set(0, 3, shade(c, -0.1)); P.set(6, 3, shade(c, -0.1)); return P.canvas(); });
const ZED = (() => { const P = new Pix(6, 6); P.rect(0, 0, 5, 1, "#f4f1e8"); P.line(4, 1, 0, 4, "#f4f1e8"); P.rect(0, 4, 5, 1, "#f4f1e8"); return P.outline("#3c4a6b").canvas(); })();
const ARROW_SEL = (() => { const P = new Pix(9, 7); for (let y = 0; y < 5; y++) P.rect(y, y, 9 - y * 2, 1, "#ffffff"); P.set(1, 0, shade("#ffffff", -0.2)); return P.outline("#1f2a44").canvas(); })();

/* ================================================================ type data
 * Per-type configs from the TypePop app (personality-test/app/src/types.ts):
 * palName, color, prop, and one-liners. The nine types whose palName was the
 * "Pip" stub get the unique names the demo spec assigned (Quill, Boogie, …). */
const TYPES = [
  { key: "enfp", name: "ENFP", nickname: "The Hype Machine", palName: "Pip", color: "#FF8C69", prop: "party popper", lines: [
    "Plot twist: the floor is lava. GO GO GO!", "I have seventeen plans today and I'm doing ALL of them!", "New idea!! Okay hear me out—", "I waved at a stranger and we're best friends now." ] },
  { key: "intj", name: "INTJ", nickname: "The Chess Player", palName: "Nova", color: "#3B4A6B", prop: "chess piece", lines: [
    "Efficiency is my love language.", "I have already simulated this conversation. It went well.", "Your schedule has been optimized. I did not ask." ] },
  { key: "enfj", name: "ENFJ", nickname: "The Cheerleader", palName: "Sunny", color: "#FF6B6B", prop: "megaphone", lines: [
    "You did AMAZING today and I need you to know that.", "Group hug! Attendance is mandatory.", "You are the protagonist today. I make the rules." ] },
  { key: "entj", name: "ENTJ", nickname: "The Commander", palName: "Rex", color: "#8B5CF6", prop: "scepter", lines: [
    "I made a 5-year plan for us. You're welcome.", "Excuses: zero. Results: incoming.", "Nap efficiency is up 40%. Keep it up." ] },
  { key: "entp", name: "ENTP", nickname: "The Debater", palName: "Zip", color: "#F59E0B", prop: "lightbulb", lines: [
    "Devil's advocate here: what if naps are a conspiracy?", "New invention idea! It is DEFINITELY safe.", "What if the rug… was a trampoline?" ] },
  { key: "infj", name: "INFJ", nickname: "The Counselor", palName: "Milo", color: "#6D9DC5", prop: "lantern", lines: [
    "I knew you were going to tap me. I always know.", "I have been saving you a spot by the window.", "Tell me about your day. I'll read between the lines." ] },
  { key: "infp", name: "INFP", nickname: "The Dreamer", palName: "Wisp", color: "#A8E6CF", prop: "flower", lines: [
    "I wrote a poem about this rug. Want to hear it?", "What if naps were a form of time travel?", "That cloud told me a secret. Want to know?" ] },
  { key: "intp", name: "INTP", nickname: "The Thinker", palName: "Quill", color: "#8B9BB4", prop: "beaker", lines: [
    "Hypothesis: snacks improve everything. Testing now.", "Interesting… tell me more. For science." ] },
  { key: "esfp", name: "ESFP", nickname: "The Entertainer", palName: "Boogie", color: "#FFD93D", prop: "maraca", lines: [
    "Dance break! No arguments!", "This fountain? My stage now." ] },
  { key: "esfj", name: "ESFJ", nickname: "The Caregiver", palName: "Hazel", color: "#FFB59E", prop: "gift box", lines: [
    "I saved you the good cushion. Obviously.", "Does everyone have a snack? Snacks matter." ] },
  { key: "estp", name: "ESTP", nickname: "The Daredevil", palName: "Dash", color: "#FF5A3C", prop: "lightning bolt", lines: [
    "Bet I can hop higher than you. Watch.", "Pond? Race you around it!" ] },
  { key: "estj", name: "ESTJ", nickname: "The Executive", palName: "Marble", color: "#4A5F8A", prop: "clipboard", lines: [
    "The nap schedule has been optimized. You're welcome.", "Let's put the fountain on a rota." ] },
  { key: "isfp", name: "ISFP", nickname: "The Artist", palName: "Inky", color: "#4ECDC4", prop: "paint palette", lines: [
    "This wall needs more… everything. Hold my brush.", "The sunset over the plaza today? A masterpiece." ] },
  { key: "istp", name: "ISTP", nickname: "The Crafter", palName: "Gadget", color: "#8A9A5B", prop: "wrench", lines: [
    "I fixed the wobble in the table. You're welcome.", "Give me ten minutes and a paperclip." ] },
  { key: "isfj", name: "ISFJ", nickname: "The Defender", palName: "Maple", color: "#E8B84B", prop: "shield", lines: [
    "I'll keep watch while you rest. It's what I do.", "I brought extra blankets. Just in case." ] },
  { key: "istj", name: "ISTJ", nickname: "The Inspector", palName: "Ledger", color: "#7B8BA3", prop: "wristwatch", lines: [
    "Nap logged at 14:32. Duration: optimal.", "The plaza stones are misaligned. Noted." ] },
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.key, t]));
const line = (t) => t.lines[Math.floor(Math.random() * t.lines.length)];

/* ================================================================ sprites
 * SPRITES manifest: an asset worker generates PNGs into assets/; until (or
 * unless) they exist, Pix-drawn placeholders stand in. blob_{type}_{state}.png
 * where state is open | happy | sleep; house_{type}.png. When a real PNG loads
 * it simply takes over — no code change needed. */
const SPR = { loaded: {}, pending: 0, onHouse: null };
function loadSprite(key, url) {
  SPR.pending++;
  const img = new Image();
  img.onload = () => { SPR.loaded[key] = img; SPR.pending--; if (key.startsWith("house_") && SPR.onHouse) SPR.onHouse(); };
  img.onerror = () => { SPR.pending--; };
  img.src = url;
}
const BLOB_STATES = ["open", "happy", "sleep"];
for (const t of TYPES) {
  for (const s of BLOB_STATES) loadSprite(`blob_${t.key}_${s}`, `assets/blob_${t.key}_${s}.png`);
  loadSprite(`house_${t.key}`, `assets/house_${t.key}.png`);
}
/** A smooth-clay blob in the type's color (the TypePop v5 direction): open /
 * happy / sleep faces. 16 x 17 world px (32 x 34 HD). */
const blobCache = new Map();
function drawBlobHD(color, state) {
  const k = color + state;
  if (blobCache.has(k)) return blobCache.get(k);
  const P = new Pix(32, 34);
  const pal = { o: mix(shade(color, -0.5), "#1a1216", 0.25), l: shade(color, 0.2), h: shade(color, 0.09), b: color, s: shade(color, -0.13), d: shade(color, -0.3), k: mix(color, "#ff9f9f", 0.4) };
  P.oval(16, 20, 11, 11.5, (x, y, u, v) => {
    let c = pal.b;
    if (u * u + v * v > 0.72) c = pal.s;
    if (u < -0.35 && v < -0.3) c = pal.l;
    else if (u < -0.15 && v < -0.05) c = pal.h;
    if (v > 0.72) c = pal.d;
    return c;
  });
  P.oval(16, 27, 10.5, 3.5, pal.s);
  P.outline(pal.o);
  const ey = 16;
  for (const ex of [11, 21]) {
    if (state === "sleep") { P.set(ex - 1, ey + 3, EYE); P.set(ex, ey + 4, EYE); P.set(ex + 1, ey + 3, EYE); }
    else if (state === "happy") { P.set(ex - 1, ey + 3, EYE); P.set(ex, ey + 2, EYE); P.set(ex + 1, ey + 3, EYE); }
    else { P.rect(ex - 1, ey - 1, 3, 4, EYE); P.set(ex - 1, ey - 1, SHINE); P.set(ex - 1, ey, SHINE); }
  }
  P.rect(8, ey + 6, 2, 1, pal.k); P.rect(22, ey + 6, 2, 1, pal.k); // blush
  if (state === "happy") { P.rect(14, ey + 6, 4, 1, EYE); P.rect(14, ey + 7, 4, 1, "#c8505a"); }
  else if (state === "open") { P.rect(15, ey + 6, 2, 1, EYE); }
  const c = P.canvas();
  blobCache.set(k, c);
  return c;
}
/** A little cottage tinted by the type color, 46 x 38 world px (92 x 76 HD).
 * Returns { canvas, windows } with window rects in house-local world px. */
const houseCache = new Map();
function drawHouseHD(color) {
  if (houseCache.has(color)) return houseCache.get(color);
  const P = new Pix(92, 76);
  const ink = "#2d1f14", wall = mix(color, "#f5ead6", 0.42), wallS = mix(color, "#e8d6b8", 0.25),
    roofC = shade(color, -0.32), roofD = shade(color, -0.45), trim = "#f6f0dd";
  // walls
  P.rect(10, 32, 72, 38, wall);
  for (let x = 10; x < 82; x += 8) P.rect(x, 32, 1, 38, wallS);
  P.rect(10, 32, 72, 2, trim);
  P.rect(10, 68, 72, 2, shade(wall, -0.12)); // stone footing
  // roof: a stepped gable
  for (let i = 0; i < 28; i++) {
    const inset = Math.round((28 - i) * 1.7), rx = 8 + inset - 8, rw = 84 - (inset - 8) * 2;
    P.rect(Math.max(0, rx), 4 + i, Math.min(92, rw), 1, i % 4 === 3 ? roofD : roofC);
    if (i % 4 !== 3) for (let sx = rx + 4 + ((i >> 2) % 2) * 5; sx < rx + rw - 4; sx += 10) P.set(sx, 4 + i, roofD);
  }
  P.rect(2, 30, 88, 3, trim);
  // chimney
  P.rect(66, 8, 9, 22, "#8a5a3a"); P.rect(66, 8, 9, 3, "#5e3a24");
  // door
  P.rect(40, 48, 13, 22, "#4a2c18"); P.rect(41, 49, 11, 20, "#6b4226"); P.set(49, 59, "#ffd24a");
  // windows
  P.rect(16, 42, 14, 12, trim); P.rect(18, 44, 10, 8, "#233241");
  P.rect(62, 42, 14, 12, trim); P.rect(64, 44, 10, 8, "#233241");
  P.outline(ink);
  const c = P.canvas();
  const res = { canvas: c, windows: [{ x: 18, y: 44, w: 10, h: 8 }, { x: 64, y: 44, w: 10, h: 8 }] };
  houseCache.set(color, res);
  return res;
}
/** Resident sprite: real PNG if it loaded, else the Pix placeholder. */
function blobSprite(type, state, t) {
  const img = SPR.loaded[`blob_${type.key}_${state}`];
  if (img) return img;
  return drawBlobHD(type.color, state);
}
/** House image on the background: real PNG if loaded, else the Pix house. */
function houseArt(type) {
  const img = SPR.loaded[`house_${type.key}`];
  if (img) return { canvas: img, png: true, windows: [] };
  return { canvas: drawHouseHD(type.color).canvas, png: false, windows: drawHouseHD(type.color).windows };
}

/* ================================================================ layout
 * 16 houses ring a central plaza with a fountain; a park with a pond sits
 * outside the ring; dirt paths connect everything; trees ring the world. */
function layoutCity(W, H) {
  const T = clamp(Math.round(Math.min(W, H) * 0.08), 26, 44);
  const play = { x0: T + 2, y0: T + 8, x1: W - T - 2, y1: H - T - 6 };
  const cx = W / 2, cy = (play.y0 + play.y1) / 2;
  const plaza = { cx, cy, rx: 56, ry: 40 };
  const fountain = { x: cx, y: cy };
  // the houses: an ellipse ring round the plaza, each with its own type
  const houses = [];
  const ringRx = Math.max(120, W / 2 - 78), ringRy = Math.max(100, H / 2 - 72);
  TYPES.forEach((type, i) => {
    const a = -Math.PI / 2 + (i / 16) * Math.PI * 2;
    let hx = cx + Math.cos(a) * ringRx, hy = cy + Math.sin(a) * ringRy;
    hx = clamp(hx, play.x0 + 34, play.x1 - 34); hy = clamp(hy, play.y0 + 34, play.y1 - 30);
    const hw = 46, hh = 38;
    const dx = cx - hx, dy = cy - hy, dd = Math.hypot(dx, dy) || 1;
    // home spot: just outside the house, on the plaza side
    const home = { x: hx + (dx / dd) * (hw / 2 + 10), y: hy + (dy / dd) * (hh / 2 + 10) };
    const sign = { x: home.x + 15, y: home.y + 4, text: type.name };
    houses.push({ type, x: hx - hw / 2, y: hy - hh / 2, w: hw, h: hh, home, sign });
  });
  // the park pond: the open corner farthest from any house
  const pond = { cx: play.x1 - 52, cy: play.y1 - 46, rx: 34, ry: 16 };
  // dirt paths: a ring round the plaza, spokes to every house door, and a stroll to the pond
  const paths = [];
  const ring = [];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; ring.push({ x: cx + Math.cos(a) * (plaza.rx + 13), y: cy + Math.sin(a) * (plaza.ry + 9) }); }
  paths.push(ring);
  for (const hs of houses) paths.push([{ x: cx + (hs.home.x - cx) * 0.62, y: cy + (hs.home.y - cy) * 0.62 }, { x: hs.home.x, y: hs.home.y }]);
  paths.push([{ x: cx + plaza.rx + 12, y: cy + 14 }, { x: pond.cx - pond.rx - 12, y: pond.cy - pond.ry - 8 }, { x: pond.cx - pond.rx - 4, y: pond.cy + pond.ry + 10 }]);
  const rocks = [], decor = [], trees = [];
  const content = { x: play.x0, y: play.y0, w: play.x1 - play.x0, h: play.y1 - play.y0 };
  return { W, H, T, play, plaza, fountain, houses, pond, paths, rocks, decor, trees, content, z: 0 };
}
function blocked(L, x, y) {
  for (const hs of L.houses) if (x > hs.x - 7 && x < hs.x + hs.w + 7 && y > hs.y - 8 && y < hs.y + hs.h + 8) return true;
  if (((x - L.fountain.x) / 26) ** 2 + ((y - L.fountain.y) / 22) ** 2 < 1) return true;
  if (((x - L.pond.cx) / (L.pond.rx + 8)) ** 2 + ((y - L.pond.cy) / (L.pond.ry + 6)) ** 2 < 1) return true;
  if (L.rocks.some(r => Math.abs(x - r.x) < r.w / 2 + 6 && y > r.y - 4 && y < r.y + r.h + 4)) return true;
  return L.decor.some(d => d.r && Math.abs(x - d.x) < d.r + 5 && y > d.y - d.r - 2 && y < d.y + 5);
}

/* ================================================================ background
 * Pre-rendered once to an offscreen canvas at HD scale (the same pattern as
 * the clodfarm engine's buildWorld): grass from two octaves of value noise,
 * the plaza, paths, pond, fountain, houses, decor, and a ring of trees. */
function buildCity(L, seed = 7) {
  const W = L.W, H = L.H, rnd = mulberry32(seed);
  const bg = canvas(W * HD, H * HD), g = bg.getContext("2d");
  g.imageSmoothingEnabled = false;
  // grass: two octaves of value noise, ordered dithering across the tones
  const lo = canvas(W, H), lg = lo.getContext("2d");
  const n1 = valueNoise(seed + 1), n2 = valueNoise(seed + 2), img = lg.createImageData(W, H), d = img.data;
  const tones = [G.g0, G.g1, G.g2, G.g3, G.g4].map(rgbOf);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = n1(x / 22, y / 22) * 0.62 + n2(x / 7, y / 7) * 0.38;
    t += (BAYER[y & 3][x & 3] / 16 - 0.5) * 0.14;
    const k = clamp(Math.floor((t - 0.18) * 5.2), 0, 4), i = (y * W + x) * 4;
    [d[i], d[i + 1], d[i + 2]] = tones[k]; d[i + 3] = 255;
  }
  lg.putImageData(img, 0, 0);
  g.drawImage(lo, 0, 0, W * HD, H * HD);
  // blades and flecks
  for (let i = 0; i < (W * H) / 40; i++) {
    const x = Math.floor(rnd() * W * HD), y = Math.floor(rnd() * H * HD), r = rnd();
    if (r < 0.55) { const c = rnd() < 0.5 ? G.g0 : G.g1; hdRect(g, x, y, 1, 3, c); hdRect(g, x + 2, y + 1, 1, 2, c); hdRect(g, x + 1, y + 2, 1, 1, c); }
    else if (r < 0.85) hdRect(g, x, y, 1, 2, rnd() < 0.5 ? G.g4 : "#93b552");
    else { const c = FLOWER_C[Math.floor(rnd() * FLOWER_C.length)]; hdRect(g, x - 1, y, 3, 1, c); hdRect(g, x, y - 1, 1, 3, c); hdRect(g, x, y, 1, 1, "#f5e27a"); }
  }
  // the plaza: worn stone ellipse with a tiled ring
  const pz = L.plaza;
  pxEllipse(g, pz.cx * HD, pz.cy * HD, (pz.rx + 5) * HD, (pz.ry + 4) * HD, "#6e6a55");
  pxEllipse(g, pz.cx * HD, pz.cy * HD, pz.rx * HD, pz.ry * HD, "#8f8a72");
  pxEllipse(g, pz.cx * HD, pz.cy * HD, (pz.rx - 8) * HD, (pz.ry - 6) * HD, "#a39c80");
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const x0 = pz.cx * HD + Math.cos(a) * (pz.rx - 4) * HD, y0 = pz.cy * HD + Math.sin(a) * (pz.ry - 3) * HD;
    const x1 = pz.cx * HD + Math.cos(a) * (pz.rx + 2) * HD, y1 = pz.cy * HD + Math.sin(a) * (pz.ry + 1) * HD;
    g.strokeStyle = "#6e6a55"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  for (const pts of L.paths) drawPathHD(g, pts, rnd);
  drawPondHD(g, L.pond, rnd);
  // rocks and bits of nature where nothing else is
  const clear = (x, y, pad) => !blocked(L, x, y) && !L.paths.some(pts => pts.some((p, i) => i > 0 && x > Math.min(p.x, pts[i - 1].x) - pad && x < Math.max(p.x, pts[i - 1].x) + pad && y > Math.min(p.y, pts[i - 1].y) - pad && y < Math.max(p.y, pts[i - 1].y) + pad));
  for (let tries = 0, want = clamp(Math.round((W * H) / 52000), 2, 8); L.rocks.length < want && tries < 400; tries++) {
    const w = 12 + Math.floor(rnd() * 8), r = { x: L.play.x0 + 10 + rnd() * (L.play.x1 - L.play.x0 - 20), y: L.play.y0 + rnd() * (L.play.y1 - L.play.y0 - 12), w, h: Math.round(w * 0.75) };
    if (clear(r.x, r.y, 12) && clear(r.x, r.y + r.h, 12) && L.rocks.every(o => Math.hypot(o.x - r.x, o.y - r.y) > 60)) L.rocks.push(r);
  }
  const KINDS = [["flowers", 0.5, 0], ["bush", 0.28, 7], ["mushrooms", 0.22, 0]];
  for (let tries = 0, want = clamp(Math.round((W * H) / 3200), 10, 60); L.decor.length < want && tries < 900; tries++) {
    const x = L.play.x0 + 8 + rnd() * (L.play.x1 - L.play.x0 - 16), y = L.play.y0 + 12 + rnd() * (L.play.y1 - L.play.y0 - 16);
    let p = rnd(), kind = KINDS[0];
    for (const k of KINDS) { if (p < k[1]) { kind = k; break; } p -= k[1]; }
    if (!clear(x, y, 9) || L.decor.some(o => Math.hypot(o.x - x, o.y - y) < 24) || L.rocks.some(o => Math.hypot(o.x - x, o.y - y) < 20)) continue;
    L.decor.push({ kind: kind[0], x, y, r: kind[2], c: Math.floor(rnd() * 6) });
  }
  // flower beds round the fountain and the pond
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 5)
    L.decor.push({ kind: "flowers", x: pz.cx + Math.cos(a) * (pz.rx + 9), y: pz.cy + Math.sin(a) * (pz.ry + 7), r: 0, c: Math.floor(rnd() * 6) });
  L.decor.push({ kind: "flowers", x: L.pond.cx - L.pond.rx - 10, y: L.pond.cy + 8, r: 0, c: 2 }, { kind: "flowers", x: L.pond.cx + L.pond.rx + 10, y: L.pond.cy + 6, r: 0, c: 4 });
  L.rocks.forEach(r => drawRockHD(g, r));
  L.decor.sort((a, b) => a.y - b.y).forEach(dd => drawDecorHD(g, dd, rnd));
  // houses: the real PNG if the asset worker has landed it, else the Pix cottage
  for (const hs of L.houses) {
    const art = houseArt(hs.type);
    const x = Math.round(hs.x * HD), y = Math.round(hs.y * HD), w = Math.round(hs.w * HD), hh = Math.round(hs.h * HD);
    pxEllipse(g, x + w / 2 + 4, y + hh + 2, w / 2 + 8, 5, "rgba(20,32,10,.32)");
    if (art.png) {
      g.drawImage(art.canvas, x, y, w, hh);
      hs.windows = [];
    } else {
      g.drawImage(art.canvas, x, y, w, hh);
      hs.windows = art.windows.map(wr => ({ x: hs.x + wr.x, y: hs.y + wr.y, w: wr.w, h: wr.h }));
    }
  }
  // type-code signs by each door
  for (const hs of L.houses) drawSignHD(g, hs.sign);
  drawFountainHD(g, L.fountain);
  // trees round the edge: back rows on the background, the bottom row in front (its own strip)
  const trees = [], T = L.T;
  for (let x = -6; x < W + 12; x += 12 + rnd() * 9) { trees.push([x, 2 + rnd() * (T - 16), 10 + rnd() * 5]); if (rnd() < 0.6) trees.push([x + 6, -6 + rnd() * 8, 11 + rnd() * 4]); }
  for (let y = T - 4; y < H - T + 6; y += 12 + rnd() * 8) {
    trees.push([2 + rnd() * (T - 14), y, 9 + rnd() * 5]); trees.push([W - 2 - rnd() * (T - 14), y, 9 + rnd() * 5]);
    if (rnd() < 0.5) trees.push([-4, y + 6, 11]); if (rnd() < 0.5) trees.push([W + 4, y + 6, 11]);
  }
  const front = [];
  for (let x = -6; x < W + 12; x += 12 + rnd() * 9) front.push([x, H - T + 12 + rnd() * 10, 11 + rnd() * 5]);
  trees.sort((a, b) => a[1] - b[1]).forEach(([x, y, r]) => drawTreeHD(g, Math.round(x * HD), Math.round(y * HD), Math.round(r * HD), rnd));
  const fgY = Math.max(0, H - T - 8), fg = canvas(W * HD, (H - fgY) * HD), f = fg.getContext("2d");
  f.imageSmoothingEnabled = false;
  front.sort((a, b) => a[1] - b[1]).forEach(([x, y, r]) => drawTreeHD(f, Math.round(x * HD), Math.round((y - fgY) * HD), Math.round(r * HD), rnd));
  // stars for the night sky, and firefly seeds
  const stars = [];
  for (let i = 0; i < 90; i++) stars.push({ x: rnd() * W, y: rnd() * H * 0.5, s: rnd(), tw: rnd() * 7 });
  return { L, bg, fg, fgY, stars };
}

/* ================================================================ residents
 * One blob per MBTI type. Modes cycle: home (at its own house) -> wander (the
 * plaza, the park) -> visit (another type's house) -> home … and sleep at its
 * house all night. Adapted from the clodfarm engine's Critter movement AI
 * (targets, waits, walk phases, blinks, bob) with a mode machine on top. */
const MODE_LABEL = { home: "Home", wander: "Strolling", visit: "Visiting", sleep: "Sleeping" };
class Blob {
  constructor(type, home) {
    const hx = home.x + (Math.random() - 0.5) * 8, hy = home.y + (Math.random() - 0.5) * 6;
    Object.assign(this, { type, key: type.key, x: hx, y: hy, tx: hx, ty: hy, wait: 1 + Math.random() * 3,
      dir: 0, moving: false, phase: 0, phaseT: 0, blinkT: 2 + Math.random() * 3, blink: 0,
      born: performance.now(), speed: 22 + Math.random() * 6 });
    this.mode = "home"; this.modeT = 4 + Math.random() * 8;
    this.seed = (hashStr(this.key) % 97) / 7; this.look = 0; this.lookT = 1 + Math.random() * 4; this.step = 0;
    this.cheerUntil = 0; this.bubble = null; this.bubbleT = 2 + Math.random() * 6; this.bubbleUntil = 0;
    this.label = `${type.palName} · ${type.name}`;
    this.activity = "Settling in";
    this.home = home;
    this.seedX = Math.random() * 1000;
  }
  think(dt, sim) {
    // the mode machine: night forces sleep at home; day cycles home -> wander -> visit
    const night = sim.nightness > 0.5;
    if (night && this.mode !== "sleep") { this.mode = "sleep"; this.tx = this.home.x; this.ty = this.home.y; this.activity = "Heading home to sleep"; this.bubble = null; }
    else if (!night && this.mode === "sleep") { this.mode = "home"; this.modeT = 3 + Math.random() * 5; this.tx = this.home.x; this.ty = this.home.y; this.activity = "Waking up"; }
    if (this.mode !== "sleep" && !night) {
      this.modeT -= dt;
      if (this.modeT <= 0) {
        if (this.mode === "home") {
          this.mode = Math.random() < 0.55 ? "wander" : "visit";
          if (this.mode === "wander") { const p = sim.randomSpot(); this.tx = p.x; this.ty = p.y; this.activity = "Strolling through town"; }
          else { const other = sim.randomHouse(this); this.tx = other.home.x; this.ty = other.home.y; this.activity = `Visiting ${other.type.palName}`; this.visitWho = other; }
          this.modeT = 14 + Math.random() * 22;
        } else if (this.mode === "wander") {
          this.mode = "visit";
          const other = sim.randomHouse(this); this.tx = other.home.x; this.ty = other.home.y; this.activity = `Visiting ${other.type.palName}`; this.visitWho = other;
          this.modeT = 14 + Math.random() * 18;
        } else { // visit done: back home, happy about the company
          this.mode = "home"; this.tx = this.home.x; this.ty = this.home.y; this.activity = "Heading home";
          this.cheerUntil = performance.now() + 1500; this.modeT = 8 + Math.random() * 10;
        }
      }
      // while wandering, pick a fresh spot each time one is reached
      if (this.mode === "wander" && !this.moving && Math.abs(this.tx - this.x) + Math.abs(this.ty - this.y) < 1.5) {
        this.wait -= dt;
        if (this.wait <= 0) { const p = sim.randomSpot(); this.tx = p.x; this.ty = p.y; this.wait = 2 + Math.random() * 5; }
      }
      // arriving at a visit: say hi, be happy for a bit
      if (this.mode === "visit" && !this.moving && Math.abs(this.tx - this.x) + Math.abs(this.ty - this.y) < 2) {
        if (!this.cheering) { this.cheering = true; this.cheerUntil = performance.now() + 2200; this.bubble = { icon: "👋", text: `Hi ${this.visitWho.type.palName}!` }; this.bubbleUntil = performance.now() + 3200; }
      } else if (this.cheering && Math.abs(this.tx - this.x) + Math.abs(this.ty - this.y) > 4) this.cheering = false;
    }
    // the speech bubble: sleep has its own, then timed mood / one-liner bubbles
    const now = performance.now();
    if (this.mode === "sleep" && !this.moving) this.bubble = { icon: "💤", text: "Recharging…" };
    else if (this.mode === "sleep") this.bubble = null;
    else if (now > this.bubbleUntil) {
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) {
        this.bubbleT = 7 + Math.random() * 9; this.bubbleUntil = now + 4500 + Math.random() * 2500;
        const nowCheer = now < this.cheerUntil;
        const icons = nowCheer ? ["😄", "✨", "🎉"] : ["💬", "💭", "😌"];
        this.bubble = { icon: icons[Math.floor(Math.random() * icons.length)], text: line(this.type).slice(0, 44) };
      } else if (now > this.bubbleUntil) this.bubble = null;
    }
  }
  update(dt, sim) {
    this.think(dt, sim);
    const L = sim.L;
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blink = 0.14; this.blinkT = 2 + Math.random() * 4; }
    this.blink = Math.max(0, this.blink - dt);
    this.lookT -= dt;
    if (this.lookT < 0) { this.look = this.look ? 0 : Math.random() < 0.5 ? -1 : 1; this.lookT = this.look ? 0.8 + Math.random() : 2 + Math.random() * 4; }
    const dx = this.tx - this.x, dy = this.ty - this.y;
    if (Math.abs(dx) + Math.abs(dy) < 1.2) { this.moving = false; this.phase = 0; this.step = 0; }
    else {
      const dist = Math.hypot(dx, dy);
      this.moving = true;
      const sp = this.speed * dt * (REDUCED ? 0.7 : 1);
      const nx = this.x + (dx / dist) * Math.min(sp, dist), ny = this.y + (dy / dist) * Math.min(sp, dist);
      if (!blocked(L, nx, ny)) { this.x = nx; this.y = ny; }
      else if (!blocked(L, nx, this.y)) this.x = nx;
      else if (!blocked(L, this.x, ny)) this.y = ny;
      else { const p = sim.randomSpot(); this.tx = p.x; this.ty = p.y; }
      this.dir = Math.abs(dx) > 0.5 ? Math.sign(dx) : this.dir;
      this.phaseT += dt; // the walk: step, pass, the other step, pass
      if (this.phaseT > 0.11) { this.phaseT = 0; this.step = (this.step + 1) % 4; this.phase = [1, 0, 2, 0][this.step]; }
    }
  }
  sprite(t) {
    const now = performance.now();
    const sleeping = this.mode === "sleep" && !this.moving;
    const happy = !sleeping && (now < this.cheerUntil || now - this.born < 1800);
    const state = sleeping ? "sleep" : happy ? "happy" : "open";
    return { img: blobSprite(this.type, state, t), happy };
  }
  /** How far it's lifted this frame, in world pixels (halved: the HD grid). */
  bob(t) {
    if (REDUCED) return 0;
    if (this.moving) return this.step % 2 ? -0.5 : 0;
    if (this.mode === "sleep") return Math.sin(t * 1.6 + this.seed) > 0.2 ? 0.5 : 0; // breathing
    if (performance.now() < this.cheerUntil) return -Math.round(Math.abs(Math.sin(t * 8)) * 5) / 2; // a happy hop
    return Math.sin(t * 2 + this.seed) > 0.7 ? -0.5 : 0; // idle breathing
  }
}

/* ================================================================ the world sim
 * Replaces the clodfarm engine's api/state poll: everything the town does is
 * computed right here in JS. Day/night auto-cycles; friendships spark when two
 * residents bump into each other. */
const Sim = {
  L: null, blobs: [], friendships: 0, dayN: 1,
  mode: "auto", cycleT: 20, DAY: 150, NIGHT: 60, TRANS: 6, nightness: 0,
  sparkles: [], pairCool: new Map(), fireflies: [],
  randomSpot() {
    const L = this.L, r = Math.random();
    for (let i = 0; i < 60; i++) {
      let x, y;
      if (r < 0.55) { // the plaza ring
        const a = Math.random() * Math.PI * 2, rr = 0.8 + Math.random() * 0.7;
        x = L.plaza.cx + Math.cos(a) * L.plaza.rx * rr * 1.7; y = L.plaza.cy + Math.sin(a) * L.plaza.ry * rr * 1.9;
      } else if (r < 0.8) { // the park / pond
        x = L.pond.cx + (Math.random() - 0.5) * 130; y = L.pond.cy + (Math.random() - 0.5) * 80;
      } else { // anywhere playable
        x = L.play.x0 + 10 + Math.random() * (L.play.x1 - L.play.x0 - 20); y = L.play.y0 + 14 + Math.random() * (L.play.y1 - L.play.y0 - 20);
      }
      if (!blocked(L, x, y)) return { x, y };
    }
    return { x: L.plaza.cx, y: L.plaza.cy + 20 };
  },
  randomHouse(blob) {
    const others = this.blobs.filter(b => b !== blob);
    return others[Math.floor(Math.random() * others.length)];
  },
  sparkle(x, y, n = 12, color) {
    if (this.sparkles.length > 300) return;
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = 8 + Math.random() * 22;
      this.sparkles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 10, life: 0.6 + Math.random() * 0.5, k: i % 4, c: color || null }); }
  },
  friend(a, b) {
    const key = [a.key, b.key].sort().join("+"), now = performance.now();
    if (now - (this.pairCool.get(key) || 0) < 120000) return;
    this.pairCool.set(key, now);
    this.friendships++;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 6;
    this.sparkle(mx, my, 16);
    for (const c of [a, b]) {
      c.cheerUntil = now + 3000;
      c.bubble = { icon: "✨", text: `New friend: ${c === a ? b.type.palName : a.type.palName}!` };
      c.bubbleUntil = now + 5000;
    }
    UI.updateHud();
  },
  update(dt) {
    // day / night
    const total = this.DAY + this.NIGHT;
    this.cycleT += dt;
    if (this.cycleT >= total) { this.cycleT -= total; this.dayN++; UI.updateHud(); }
    const inNight = this.cycleT > this.DAY;
    const target = this.mode === "night" ? 1 : this.mode === "day" ? 0 : inNight ? 1 : 0;
    const step = dt / this.TRANS;
    this.nightness += clamp(target - this.nightness, -step, step);
    // residents
    for (const b of this.blobs) b.update(dt, this);
    // friendships: two residents within a few px, not asleep
    for (let i = 0; i < this.blobs.length; i++) for (let j = i + 1; j < this.blobs.length; j++) {
      const a = this.blobs[i], b = this.blobs[j];
      if (a.mode === "sleep" || b.mode === "sleep") continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 8) this.friend(a, b);
    }
    this.sparkles = this.sparkles.filter(p => (p.life -= dt) > 0);
    for (const p of this.sparkles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 40 * dt; }
  },
};

/* ================================================================ the scene
 * Canvas, camera (drag-pan, wheel/pinch zoom, zoom snapped to whole device
 * pixels), the rAF loop, depth-sorted drawing, and DOM tags + speech bubbles
 * that only show when zoomed in far enough — the clodfarm engine's recipe. */
const Scene = {
  cv: $("#world"), ctx: null, S: 3, world: null, cam: { x: 0, y: 0, z: 3, auto: true }, goal: null, dpr: 1,
  labels: $("#labels"), selected: null, hover: null, t: 0,
  TAGS_AT: 2.6, BUBBLES_AT: 1.9,
  init() {
    this.ctx = this.cv.getContext("2d", { alpha: false });
    addEventListener("resize", () => { clearTimeout(this.resizeT); this.resizeT = setTimeout(() => this.resize(), 80); });
    const watchDpr = () => {
      const m = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
      m.addEventListener?.("change", () => { this.resize(); watchDpr(); }, { once: true });
    };
    watchDpr();
    this.bindPointer();
    this.resize();
    let last = performance.now();
    const loop = (now) => { const dt = Math.min(0.05, (now - last) / 1000); last = now; this.t += dt; this.frame(dt); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },
  viewBox() {
    const w = innerWidth, hh = innerHeight, phone = w < 760;
    return { w, h: hh, S: clamp(Math.round(Math.min(w / 340, hh / 220)), 2, 6), top: phone ? 64 : 12, bottom: phone ? 116 : 104, left: 0, right: 0 };
  },
  snap(z, down = false) {
    const Zr = z * this.dpr;
    if (Zr < 2) return z;
    const step = Zr >= 4 && this.dpr >= 1.5 ? 2 : 1, n = down ? Math.floor(Zr / step + 1e-6) : Math.round(Zr / step);
    return Math.max(step, n * step) / this.dpr;
  },
  resize() {
    this.dpr = Math.min(3, devicePixelRatio || 1);
    const v = this.viewBox(), S = v.S;
    this.S = S;
    this.cv.width = Math.round(v.w * this.dpr); this.cv.height = Math.round(v.h * this.dpr);
    this.cv.style.width = v.w + "px"; this.cv.style.height = v.h + "px";
    const zS = this.snap(S, true);
    // the town has a fixed minimum size so the 16-house ring always fits; on a
    // phone the camera starts zoomed out on it and the player pans / pinches in
    const W = Math.max(Math.ceil(v.w / zS), 560), H = Math.max(Math.ceil(v.h / zS), 520);
    const L = layoutCity(W, H); L.z = zS;
    Sim.L = L;
    this.world = buildCity(L, 7);
    if (this.cam.auto) this.fit(); else { this.cam.z = Math.max(this.cam.z, L.z); this.clampCam(); }
    this.goal = null;
    // (re)home the residents on the new layout
    Sim.blobs.forEach((b, i) => {
      const hs = L.houses[i % L.houses.length];
      b.house = hs; b.home = hs.home;
      if (b.x > L.W || b.y > L.H || blocked(L, b.x, b.y)) { b.x = hs.home.x; b.y = hs.home.y; }
      b.tx = b.x; b.ty = b.y;
    });
  },
  fit() {
    const L = this.world.L, v = this.viewBox(), c = this.cam, box = L.content;
    c.z = this.fitZoom(); c.auto = true;
    c.x = box.x + box.w / 2 - v.w / 2 / c.z;
    const vh = v.h - v.top - v.bottom;
    c.y = box.y + box.h / 2 - (v.top + vh / 2) / c.z;
    this.clampCam();
  },
  clampCam(c = this.cam) {
    const L = this.world.L, z = this.snap(c.z), vw = innerWidth / z, vh = innerHeight / z;
    c.x = L.W <= vw ? (L.W - vw) / 2 : clamp(c.x, 0, L.W - vw);
    c.y = L.H <= vh ? (L.H - vh) / 2 : clamp(c.y, 0, L.H - vh);
  },
  /** Zoom that shows the whole town inside the window's insets. */
  fitZoom() {
    const L = this.world.L, v = this.viewBox(), box = L.content;
    return clamp(Math.min(v.w / box.w, (v.h - v.top - v.bottom) / box.h), 0.75, L.z);
  },
  zoomLimits() { const z0 = this.world.L.z; return [Math.min(this.fitZoom() * 0.95, z0), Math.max(8, z0 * 3)]; },
  zoomAt(sx, sy, factor) {
    const c = this.cam, [lo, hi] = this.zoomLimits(), z0 = this.snap(c.z), wx = c.x + sx / z0, wy = c.y + sy / z0;
    this.goal = null;
    c.z = clamp(c.z * factor, lo, hi);
    const z1 = this.snap(c.z); c.x = wx - sx / z1; c.y = wy - sy / z1; c.auto = false;
    this.clampCam();
  },
  focus(x, y, z) {
    const [lo, hi] = this.zoomLimits();
    z = this.snap(clamp(z || Math.max(this.cam.z, this.TAGS_AT + 0.6, this.S), lo, hi));
    const g = { x: x - innerWidth / 2 / z, y: y - innerHeight / 2 / z, z };
    this.clampCam(g); this.goal = g; this.cam.auto = false;
  },
  focusBlob(b) { if (b) { this.focus(b.x, b.y - 6); this.selected = b; } },
  // ------------------------------------------------------------------- input
  toWorld(e) { const r = this.rt; return r ? { x: (e.clientX * r.dpr - r.ox) / r.Zr, y: (e.clientY * r.dpr - r.oy) / r.Zr } : { x: this.cam.x + e.clientX / this.cam.z, y: this.cam.y + e.clientY / this.cam.z }; },
  bindPointer() {
    const cv = this.cv, pts = new Map();
    let drag = null, pinch = null;
    cv.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* fine */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (drag) drag.moved = true;
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) { if (e.pointerType === "mouse") this.onMove(e); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.zoomAt(mx, my, (pinch.z * d / pinch.d) / this.cam.z);
        this.cam.x -= (mx - pinch.mx) / this.cam.z; this.cam.y -= (my - pinch.my) / this.cam.z; this.clampCam();
        pinch.mx = mx; pinch.my = my;
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; cv.classList.add("grabbing"); }
        if (drag.moved) { this.goal = null; this.cam.auto = false; this.cam.x = drag.cx - dx / this.cam.z; this.cam.y = drag.cy - dy / this.cam.z; this.clampCam(); }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        if (drag && !drag.moved && e.type === "pointerup") this.onClick(e);
        drag = null; cv.classList.remove("grabbing");
      } else if (drag) { const [p] = [...pts.values()]; drag = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y, moved: true }; }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * (e.ctrlKey ? 0.012 : 0.0018)));
    }, { passive: false });
    cv.addEventListener("pointerleave", () => { this.hover = null; });
  },
  hit(p) {
    let best = null;
    for (const b of Sim.blobs) {
      if (p.x > b.x - 8 && p.x < b.x + 8 && p.y > b.y - 16 && p.y < b.y + 2 && (!best || b.y > best.y)) best = b;
    }
    if (best) return { blob: best };
    for (const hs of this.world.L.houses) {
      if (p.x > hs.x && p.x < hs.x + hs.w && p.y > hs.y && p.y < hs.y + hs.h) return { house: hs };
    }
    return null;
  },
  onMove(e) {
    const r = this.hit(this.toWorld(e));
    this.hover = r?.blob || null;
    this.cv.classList.toggle("pointing", !!r);
  },
  onClick(e) {
    const r = this.hit(this.toWorld(e));
    if (!r) { this.selected = null; UI.closeCard(); return; }
    if (r.blob) { this.selected = r.blob; this.focus(r.blob.x, r.blob.y - 6); UI.openResident(r.blob); }
    else if (r.house) { this.selected = null; const b = Sim.blobs.find(b => b.house === r.house); this.focus(r.house.x + r.house.w / 2, r.house.y); UI.openHouse(r.house, b); }
  },
  // ------------------------------------------------------------------- frame
  frame(dt) {
    Sim.update(dt);
    const g = this.ctx, w = this.world, L = w.L, t = this.t, cam = this.cam, now = performance.now();
    if (this.goal) { // glide
      const k = 1 - Math.exp(-dt * 7), G2 = this.goal;
      cam.x = lerp(cam.x, G2.x, k); cam.y = lerp(cam.y, G2.y, k); cam.z = lerp(cam.z, G2.z, k);
      if (Math.abs(cam.x - G2.x) + Math.abs(cam.y - G2.y) < 0.3 && Math.abs(cam.z - G2.z) < 0.01) { Object.assign(cam, { x: G2.x, y: G2.y, z: G2.z }); this.goal = null; }
    }
    const dpr = this.dpr, z = this.snap(cam.z), Zr = z * dpr, ox = Math.round(-cam.x * Zr), oy = Math.round(-cam.y * Zr);
    this.rt = { z, Zr, ox, oy, dpr };
    const vx0 = -ox / Zr, vy0 = -oy / Zr, vx1 = vx0 + this.cv.width / Zr, vy1 = vy0 + this.cv.height / Zr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (vx0 < 0 || vy0 < 0 || vx1 > L.W || vy1 > L.H) { g.fillStyle = G.t0; g.fillRect(0, 0, this.cv.width, this.cv.height); }
    g.setTransform(Zr, 0, 0, Zr, ox, oy);
    g.imageSmoothingEnabled = false;
    const sx = Math.max(0, Math.floor(vx0)), sy = Math.max(0, Math.floor(vy0));
    const sw = Math.min(L.W, Math.ceil(vx1) + 1) - sx, sh = Math.min(L.H, Math.ceil(vy1) + 1) - sy;
    if (sw > 0 && sh > 0) g.drawImage(w.bg, sx * HD, sy * HD, sw * HD, sh * HD, sx, sy, sw, sh);
    const seen = (x, y, m = 24) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m + 20;
    const hx = (v) => Math.round(v * HD) / HD;
    // residents, depth-sorted; only the ones in view are drawn
    const list = Sim.blobs;
    list.sort((a, c) => a.y - c.y);
    const vis = [], shB = shadowSprite(7, 2);
    for (const b of list) {
      if (!seen(b.x, b.y)) continue;
      vis.push(b);
      const { img } = b.sprite(t), bob = b.bob(t), X = hx(b.x), Y = hx(b.y);
      const fade = clamp((now - b.born) / 350, 0, 1);
      g.globalAlpha = fade * 0.35; g.drawImage(shB, X - shB.width / 4, Y - shB.height / 4, shB.width / 2, shB.height / 2);
      g.globalAlpha = fade;
      if (img instanceof Image) g.drawImage(img, X - 8, Y - 16 + bob, 16, 16);
      else g.drawImage(img, X - 8, Y - 17 + bob, 16, 17);
      g.globalAlpha = 1;
      if (b.mode === "sleep" && !b.moving && !REDUCED) for (let k = 0; k < 2; k++) { // Zzz
        const ph = (t * 0.4 + k * 0.5 + b.seed) % 1;
        g.globalAlpha = fade * Math.min(1, (1 - ph) * 1.6);
        g.drawImage(ZED, hx(X + 5 + ph * 4 + Math.sin(ph * 6 + k) * 1.5), hx(Y - 14 - ph * 11), 3, 3);
      }
      g.globalAlpha = 1;
      if (b === this.selected) g.drawImage(ARROW_SEL, X - 2.25, hx(Y - 24 + Math.sin(t * 5) * 1.5), 4.5, 3.5);
    }
    const fy0 = Math.max(sy, w.fgY), fh = Math.min(L.H, sy + sh) - fy0;
    if (sw > 0 && fh > 0) g.drawImage(w.fg, sx * HD, (fy0 - w.fgY) * HD, sw * HD, fh * HD, sx, fy0, sw, fh);
    for (const p of Sim.sparkles) { // friendship sparkles
      if (!seen(p.x, p.y)) continue;
      if (p.life < 0.3 && Math.floor(p.life * 20) % 2) continue;
      if (p.c) { g.fillStyle = p.c; g.fillRect(hx(p.x), hx(p.y), 1, 1); continue; }
      g.drawImage(SPARKLE[p.k], hx(p.x - 1.75), hx(p.y - 1.75), 3.5, 3.5);
    }
    // night: a blue tint over the town, lit windows, stars, fireflies
    const nn = Sim.nightness;
    if (nn > 0.01) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = `rgba(14,22,58,${0.52 * nn})`;
      g.fillRect(0, 0, this.cv.width, this.cv.height);
      g.setTransform(Zr, 0, 0, Zr, ox, oy);
      for (const s of w.stars) { // stars
        if (!seen(s.x, s.y)) continue;
        g.globalAlpha = nn * (0.35 + 0.65 * Math.abs(Math.sin(t * 1.5 + s.tw)));
        g.fillStyle = "#fff";
        const sz = s.s > 0.7 ? 1.4 : 1;
        g.fillRect(hx(s.x), hx(s.y), sz, sz);
      }
      g.globalAlpha = 1;
      for (const hs of L.houses) { // lit windows
        if (!hs.windows || !hs.windows.length || !seen(hs.x + hs.w / 2, hs.y + hs.h / 2, 40)) continue;
        for (const wr of hs.windows) {
          g.fillStyle = `rgba(255,190,90,${0.28 * nn})`;
          g.fillRect(hx(wr.x - 3), hx(wr.y - 3), wr.w + 6, wr.h + 6);
          g.fillStyle = "#ffdf8a";
          g.fillRect(hx(wr.x), hx(wr.y), wr.w, wr.h);
        }
      }
      if (!REDUCED) for (const f of Sim.fireflies) { // fireflies
        const fx = f.bx + Math.sin(t * f.sp + f.ph) * 14, fy = f.by + Math.cos(t * f.sp * 0.7 + f.ph) * 10;
        if (!seen(fx, fy)) continue;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 3 + f.ph));
        g.globalAlpha = nn * tw;
        g.fillStyle = "#ffe98a";
        g.fillRect(hx(fx), hx(fy), 1.2, 1.2);
      }
      g.globalAlpha = 1;
    }
    this.placeLabels(list, vis);
  },
  /** Speech bubbles and name tags (DOM, so they stay crisp): only for residents
   * in view, and only when zoomed in far enough to read them (or on focus). */
  placeLabels(list, vis) {
    const r = this.rt, z = r.z, px = (x) => Math.round((r.ox + x * r.Zr) / r.dpr), py = (y) => Math.round((r.oy + y * r.Zr) / r.dpr);
    const put = (el, x, y, above) => {
      if (el._w == null) { el._w = el.offsetWidth; el._h = el.offsetHeight; }
      const tr = `translate(${x - Math.round(el._w / 2)}px, ${above ? y - el._h : y}px)`;
      if (el._tr !== tr) { el._tr = tr; el.style.transform = tr; }
    };
    const inView = new Set(vis);
    for (const b of list) {
      const focus = b === this.selected || b === this.hover;
      let want = inView.has(b) ? b.bubble : null;
      if (want && !focus && z < this.BUBBLES_AT) want = null;
      if (want) {
        if (!b.el) { b.el = h("div", { class: "bubble" }); this.labels.append(b.el); }
        const sig = want.icon + "|" + (want.text || "");
        if (b.el.dataset.sig !== sig) {
          b.el.dataset.sig = sig; b.el._w = null;
          fill(b.el, h("span", { class: "bemo", text: want.icon }), want.text ? h("span", { text: want.text }) : null);
        }
        put(b.el, px(b.x), py(b.y - 24), true);
      } else if (b.el) { b.el.remove(); b.el = null; }
      const showTag = inView.has(b) && b.label && (focus || (z >= this.TAGS_AT && b.mode !== "sleep"));
      if (showTag) {
        if (!b.tagEl) { b.tagEl = h("div", { class: "tag" }); this.labels.append(b.tagEl); }
        if (b.tagEl.textContent !== b.label) { b.tagEl.textContent = b.label; b.tagEl._w = null; }
        b.tagEl.classList.toggle("sel", focus);
        put(b.tagEl, px(b.x), py(b.y + 2.5), false);
      } else if (b.tagEl) { b.tagEl.remove(); b.tagEl = null; }
    }
  },
};

/* ================================================================ UI
 * HUD chip + stats, the chunky pixel dock (Residents | Houses | day/night |
 * About), list panels, and tap-to-open resident / house info cards. */
const UI = {
  updateHud() {
    const night = Sim.nightness > 0.5;
    fill($("#stats"), `👥 ${Sim.blobs.length} · 📅 Day ${Sim.dayN} · ✨ ${Sim.friendships} ${night ? "🌙" : "☀️"}`);
    const dn = $("#dn-emo"), lbl = $("#dn-lbl");
    if (Sim.mode === "auto") { dn.textContent = night ? "🌙" : "☀️"; lbl.textContent = "AUTO"; }
    else if (Sim.mode === "day") { dn.textContent = "☀️"; lbl.textContent = "DAY"; }
    else { dn.textContent = "🌙"; lbl.textContent = "NIGHT"; }
  },
  cycleDayNight() {
    Sim.mode = Sim.mode === "auto" ? "day" : Sim.mode === "day" ? "night" : "auto";
    if (Sim.mode === "day") { Sim.cycleT = 10; Sim.nightness = Math.min(Sim.nightness, 0.01); }
    if (Sim.mode === "night") { Sim.cycleT = Sim.DAY + 5; Sim.nightness = Math.max(Sim.nightness, 0.99); }
    this.updateHud();
  },
  openSheet(title, rows) {
    $("#sheet-title").textContent = title;
    fill($("#sheet-body"), rows);
    $("#sheet").hidden = false;
  },
  closeSheet() { $("#sheet").hidden = true; },
  openResidents() {
    const rows = [...Sim.blobs].sort((a, b) => a.type.name.localeCompare(b.type.name)).map(b =>
      h("button", { class: "row", onclick: () => { Scene.focusBlob(b); this.openResident(b); this.closeSheet(); } },
        h("span", { class: "dot", style: `background:${b.type.color}` }),
        h("span", { class: "who" }, h("b", { text: `${b.type.palName} · ${b.type.name}` }), h("span", { text: b.type.nickname })),
        h("span", { class: "st", text: MODE_LABEL[b.mode] })));
    this.openSheet("RESIDENTS", rows);
  },
  openHouses() {
    const rows = Sim.world.L.houses.map(hs => {
      const b = Sim.blobs.find(x => x.house === hs);
      return h("button", { class: "row", onclick: () => { Scene.focus(hs.x + hs.w / 2, hs.y); Scene.selected = null; this.openHouse(hs, b); this.closeSheet(); } },
        h("span", { class: "dot", style: `background:${hs.type.color}` }),
        h("span", { class: "who" }, h("b", { text: `${hs.type.name} house` }), h("span", { text: hs.type.nickname })),
        h("span", { class: "st", text: b ? b.type.palName : "" }));
    });
    this.openSheet("HOUSES", rows);
  },
  openAbout() {
    this.openSheet("ABOUT", h("div", { class: "about-txt" },
      h("p", { text: "TypePop City: a living pixel-art town where one blob per MBTI type lives, strolls, visits neighbours, makes friends, and sleeps through the night. Tap anyone (or any house) to say hi." }),
      h("p", { text: "Day runs ~150s, night ~60s. The ☀️/🌙 dock button cycles Auto → Day → Night." }),
      h("p", { class: "credit", text: "Engine adapted from matank001/clodfarm (MIT). Town, residents and simulation are original TypePop work." })));
  },
  closeCard() { $("#card").hidden = true; },
  sprPreview(type, state = "open") {
    const c = canvas(64, 64), g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(blobSprite(type, state), 0, 0, 64, 64);
    c.className = "card-spr";
    return c;
  },
  openResident(b) {
    const t = b.type;
    const mood = b.mode === "sleep" ? "😴 Sleepy" : b.bubble ? `${b.bubble.icon} ${b.bubble.text}` : "😌 Content";
    fill($("#card-body"),
      h("div", { class: "card-top" }, this.sprPreview(t), h("div", { class: "card-id" },
        h("b", { text: t.palName }), h("div", { class: "sub", text: `${t.name} · ${t.nickname}` }))),
      h("div", { class: "card-meta" },
        h("div", {}, h("span", { class: "k", text: "Mood: " }), h("span", { text: mood })),
        h("div", {}, h("span", { class: "k", text: "Now: " }), h("span", { text: MODE_LABEL[b.mode] + " — " + b.activity })),
        h("div", {}, h("span", { class: "k", text: "Treasured prop: " }), h("span", { text: t.prop }))),
      h("div", { class: "card-actions" },
        h("button", { class: "btn", onclick: () => { Scene.focus(b.house.x + b.house.w / 2, b.house.y); this.closeCard(); }, text: "🏠 Focus house" }),
        h("button", { class: "btn ghost", onclick: () => this.closeCard(), text: "Close" })));
    $("#card-title").textContent = t.palName;
    $("#card").hidden = false;
  },
  openHouse(hs, b) {
    const t = hs.type;
    fill($("#card-body"),
      h("div", { class: "card-top" }, b ? this.sprPreview(t) : null, h("div", { class: "card-id" },
        h("b", { text: `${t.name} house` }), h("div", { class: "sub", text: t.nickname }))),
      h("div", { class: "card-meta" },
        h("div", {}, h("span", { class: "k", text: "Resident: " }), h("span", { text: b ? `${t.palName} (${t.name})` : "—" })),
        h("div", {}, h("span", { class: "k", text: "Treasured prop: " }), h("span", { text: t.prop })),
        h("div", {}, h("span", { class: "k", text: "Now: " }), h("span", { text: b ? MODE_LABEL[b.mode] + " — " + b.activity : "—" }))),
      h("div", { class: "card-actions" },
        b ? h("button", { class: "btn", onclick: () => { Scene.focusBlob(b); this.openResident(b); }, text: "🐾 Focus resident" }) : null,
        h("button", { class: "btn ghost", onclick: () => this.closeCard(), text: "Close" })));
    $("#card-title").textContent = `${t.palName}'s house`;
    $("#card").hidden = false;
  },
};

/* ================================================================ boot */
function boot() {
  // fireflies wander the town at night
  for (let i = 0; i < 26; i++) Sim.fireflies.push({ bx: 60 + Math.random() * 560, by: 80 + Math.random() * 420, ph: Math.random() * 7, sp: 0.4 + Math.random() * 0.6 });
  Scene.init();
  // the residents, one per house
  Scene.world.L.houses.forEach(hs => { const b = new Blob(hs.type, hs.home); b.house = hs; Sim.blobs.push(b); });
  // dock
  $$(".dock .tool").forEach(btn => btn.addEventListener("click", () => {
    const act = btn.dataset.act;
    if (act === "residents") { UI.openResidents(); btn.classList.add("on"); setTimeout(() => btn.classList.remove("on"), 300); }
    else if (act === "houses") UI.openHouses();
    else if (act === "daynight") UI.cycleDayNight();
    else if (act === "about") UI.openAbout();
    UI.closeCard(); Scene.selected = null;
  }));
  $$("[data-close]").forEach(x => x.addEventListener("click", () => { x.closest(".sheet").hidden = true; }));
  // if real house PNGs land after first paint, repaint the background to use them
  SPR.onHouse = () => { if (Scene.world) Scene.world = buildCity(Scene.world.L, 7); };
  // once the pixel font is in, repaint so the type-code signs render in it
  if (document.fonts?.ready) document.fonts.ready.then(() => { if (Scene.world) Scene.world = buildCity(Scene.world.L, 7); });
  UI.updateHud();
  setInterval(() => UI.updateHud(), 1000);
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot); else boot();
