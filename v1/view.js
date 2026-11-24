// The look-around view: the terrain as seen from a point, drawn into a <canvas>.
//
// The apps draw everything else (the sky, a satellite's pass, the sun and moon, stations, labels)
// on top, in the same projection: view.project(az, el) says where any direction lands on the
// canvas, and view.behind(az, el) whether the drawn terrain hides it.
//
// The work is split in three, so that turning the view never stutters:
//   1. the calculation   terrain.horizon(horizonOptions(settings)): tiles and rays. Slow is fine:
//                        the visitor asked for it. Can run in a worker (background.js).
//   2. the scene         buildScene(horizon, settings): the shapes to draw, in degrees. Milliseconds.
//   3. a frame           the camera turns. WebGL draws the scene from the graphics card's memory,
//                        so a frame costs about the same at every detail level.
// Without WebGL it falls back to drawing on a 2D canvas, as the apps did before this file, with
// at most a few layers of ground.
//
// The projection is stereographic, as in Northbound's and Sightline's panorama code: shapes stay
// natural well away from the centre, so a wide view does not look stretched.
//
// Experimental: the settings and the functions here may still change until the apps use them.

import { DEPTH_DISTANCES, angleAt } from './horizon.js';

const RAD = Math.PI / 180;
/** Directions further than about 154 degrees from the view centre are far off screen and dropped. */
const BEHIND = -0.9;

// ---- Settings ----

/**
 * Every setting, with the part of the work a change to it redoes:
 * 1 = calculation (fetch and rays), 2 = scene (shapes), 3 = frame only.
 */
export const SETTINGS = {
  rayStep: { part: 1, choices: [1, 0.5, 0.25], about: 'degrees between rays: the skyline is known every this many degrees' },
  closeDetail: { part: 1, choices: [false, true], about: 'the nearest 500 m from the 10 m data, counted from 10 m out (see README.md)' },
  farDetail: { part: 1, choices: ['standard', 'smooth', 'fine', 'finest'], about: 'how finely ground from 2 km out is read' },
  antennaMetres: { part: 1, about: 'eye or antenna height above the ground' },
  style: { part: 2, choices: ['cardboard', 'layers', 'shaded'], about: 'one flat cut-out, a few cut-outs by distance, or ground shaded by distance' },
  layers: { part: 2, about: "for style 'layers': where one cut-out ends and the next begins, in metres" },
  shades: { part: 2, choices: [8, 16, 32, 63], about: "for style 'shaded': how many steps of distance" },
  skyline: { part: 2, choices: [false, true], about: 'a line along the skyline' },
  ridges: { part: 2, choices: [false, true], about: 'lines along ridges in front of the skyline' },
  lineWidth: { part: 2, about: 'skyline width, CSS pixels' },
  ridgeWidth: { part: 2, about: 'ridge line width, CSS pixels' },
  ridgeFade: { part: 2, about: 'how much far ridge lines fade into the haze: 0 none (as black as the skyline), 1 fully' },
  palette: { part: 3, about: "'light', 'dark' or an object of colours (see PALETTES)" },
  pixelRatio: { part: 3, about: 'canvas pixels per CSS pixel; null follows the screen, at most 2' },
};

/** Colours. near and far are the ground's nearest and farthest shades; ground is the cardboard;
 * line is the skyline and the ridges. */
export const PALETTES = {
  light: { ground: '#6b7a5a', near: '#3b4732', far: '#a9b9c6', line: '#1d2419' },
  dark: { ground: '#2c3427', near: '#1a2016', far: '#55636e', line: '#c9d3c2' },
};

const BASE = {
  rayStep: 0.5, closeDetail: true, farDetail: 'smooth', antennaMetres: 2,
  style: 'layers', layers: [2000, 15000], shades: 32, skyline: true, ridges: true, lineWidth: 1, ridgeWidth: 1, ridgeFade: 0,
  palette: 'light', pixelRatio: null,
};

/**
 * Three starting points. 'quick' is what the apps drew before this file. These are first guesses,
 * to be settled with the lab page (lab.html) on real phones.
 */
export const PRESETS = {
  quick: { ...BASE, farDetail: 'standard', style: 'cardboard', skyline: false, ridges: false },
  standard: { ...BASE },
  detailed: { ...BASE, rayStep: 0.25, farDetail: 'fine', style: 'shaded' },
};

/** Full settings: a preset with any of its settings changed. */
export const settingsFor = (preset = 'standard', changes = {}) => {
  if (!PRESETS[preset]) throw new Error(`Unknown preset '${preset}'`);
  return { ...PRESETS[preset], ...changes };
};

/** The options for terrain.horizon() that the settings need. */
export const horizonOptions = (s) => ({
  stepDegrees: s.rayStep, closeDetail: s.closeDetail, farDetail: s.farDetail, antennaMetres: s.antennaMetres, depth: true,
});

/** Which part of the work has to be redone when settings change from `a` to `b`: 1, 2, 3, or 0 for none. */
export function redo(a, b) {
  let part = 0;
  for (const key of Object.keys(SETTINGS)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) part = part === 0 ? SETTINGS[key].part : Math.min(part, SETTINGS[key].part);
  }
  return part;
}

// ---- The projection (the same as the apps' panorama code) ----

/** @typedef {{ yaw: number, pitch: number, fieldDegrees?: number }} Camera  degrees; fieldDegrees is the width of view */
/** @typedef {{ width: number, height: number, scale: number }} Frame  CSS pixels */

/** A frame whose width shows `fieldDegrees` of the surroundings. */
export const frame = (width, height, fieldDegrees = 110) => ({ width, height, scale: width / 2 / (2 * Math.tan((fieldDegrees / 4) * RAD)) });

/**
 * Where a direction lands in the frame, in CSS pixels from the top left, or null when it is behind
 * the viewer.
 * @param {Camera} camera
 * @param {Frame} f
 * @param {number} az true bearing, degrees
 * @param {number} el degrees above the level line
 * @returns {[number, number] | null}
 */
export function project(camera, f, az, el) {
  const d = (az - camera.yaw) * RAD, e = el * RAD, p = camera.pitch * RAD;
  const x = Math.cos(e) * Math.sin(d), up = Math.sin(e), ahead = Math.cos(e) * Math.cos(d);
  const y = up * Math.cos(p) - ahead * Math.sin(p), z = up * Math.sin(p) + ahead * Math.cos(p);
  if (z < BEHIND) return null;
  const k = (2 * f.scale) / (1 + z);
  return [f.width / 2 + x * k, f.height / 2 - y * k];
}

/** The direction at a point in the frame (the reverse of project). */
export function unproject(camera, f, px, py) {
  const X = (px - f.width / 2) / (2 * f.scale), Y = (f.height / 2 - py) / (2 * f.scale), r2 = X * X + Y * Y;
  // Inverse stereographic: the unit vector (x, y, z) in camera space, z towards the view centre.
  const x = (2 * X) / (1 + r2), y = (2 * Y) / (1 + r2), z = (1 - r2) / (1 + r2), p = camera.pitch * RAD;
  const up = y * Math.cos(p) + z * Math.sin(p), ahead = -y * Math.sin(p) + z * Math.cos(p);
  return { az: (((camera.yaw + Math.atan2(x, ahead) / RAD) % 360) + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, up))) / RAD };
}

// ---- The scene ----

const FLOATS_GROUND = 5; // az, el, shade, centre az, centre el
const FLOATS_LINE = 8; // az A, el A, az B, el B, end, side, shade, width
const TALL = 3; // degrees: taller pieces of ground are cut up, so they follow the projection's curve

/** How far along from near to far a distance is, 0 to 1, on a log scale. */
const shadeOf = (metres, nearest) => Math.max(0, Math.min(1, Math.log(metres / nearest) / Math.log(100000 / nearest)));

/**
 * The shapes to draw, in degrees: bands of ground, each between two edges, and lines.
 * Pure: no canvas needed, so it can be tested and could run in a worker.
 * @param {{angles: ArrayLike<number>, stepDegrees: number, nearestMetres?: number, depth?: {distances: ArrayLike<number>, edges: ArrayLike<number>}}} horizon
 *   from terrain.horizon() with horizonOptions(settings); without depth, only 'cardboard' is possible
 * @param {object} settings  from settingsFor()
 */
export function buildScene(horizon, settings) {
  const started = performance.now();
  const s = { ...BASE, ...settings };
  const count = horizon.angles.length, step = horizon.stepDegrees, nearest = horizon.nearestMetres ?? 100;
  const depth = horizon.depth, D = depth?.distances ?? DEPTH_DISTANCES, N = D.length;
  const edge = (k, a) => (k >= N - 1 || !depth ? horizon.angles[a] : depth.edges[k * count + a]);
  const style = depth ? s.style : 'cardboard';

  // Which edges bound the bands, nearest first; the last is always the skyline. Each band has
  // the shade of its near and far edge, 0 near to 1 far.
  let bands;
  if (style === 'cardboard') bands = [{ k: N - 1, near: 0, far: 0 }];
  else if (style === 'layers') {
    const ks = [...new Set(s.layers.map((m) => closest(D, m)))].filter((k) => k < N - 1).sort((a, b) => a - b);
    bands = [...ks, N - 1].map((k, j, all) => ({ k, near: j / (all.length - 1 || 1), far: j / (all.length - 1 || 1) }));
  } else {
    const first = Math.max(0, closest(D, nearest)), n = Math.max(2, Math.min(N - 1 - first, s.shades));
    bands = [];
    for (let j = 1; j <= n; j++) {
      const k = first + Math.round(((N - 1 - first) * j) / n), below = j === 1 ? first : bands[bands.length - 1].k;
      if (!bands.length || k > bands[bands.length - 1].k) bands.push({ k, near: shadeOf(D[below], nearest), far: shadeOf(D[k], nearest) });
    }
    bands[0].near = 0;
  }

  // Ground: between ray a and a+1, each band runs from the band below's edge up to its own. Where
  // both are equal no ground of that band shows, and nothing is drawn.
  const ground = [];
  const quad = (az0, az1, b0, t0, b1, t1, sb, st) => {
    const rows = Math.max(1, Math.ceil(Math.max(t0 - b0, t1 - b1) / TALL));
    const cAz = (az0 + az1) / 2;
    for (let r = 0; r < rows; r++) {
      const f0 = r / rows, f1 = (r + 1) / rows;
      const p = [
        [az0, b0 + (t0 - b0) * f0, sb + (st - sb) * f0], [az1, b1 + (t1 - b1) * f0, sb + (st - sb) * f0],
        [az1, b1 + (t1 - b1) * f1, sb + (st - sb) * f1], [az0, b0 + (t0 - b0) * f1, sb + (st - sb) * f1],
      ];
      // Each small piece carries its own centre: the shader drops a piece whose centre is behind
      // the viewer. A shared centre for a tall column would let the piece right behind through,
      // and the projection stretches that one across the whole screen.
      const cEl = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
      for (const i of [0, 1, 2, 0, 2, 3]) ground.push(p[i][0], p[i][1], p[i][2], cAz, cEl);
    }
  };
  for (let a = 0; a < count; a++) {
    const b = (a + 1) % count, az0 = a * step, az1 = (a + 1) * step;
    let lo0 = -90, lo1 = -90;
    for (const band of bands) {
      const hi0 = Math.max(lo0, edge(band.k, a)), hi1 = Math.max(lo1, edge(band.k, b));
      if (hi0 > lo0 + 1e-4 || hi1 > lo1 + 1e-4) quad(az0, az1, lo0, hi0, lo1, hi1, band.near, band.far);
      lo0 = hi0; lo1 = hi1;
    }
  }

  // Lines: each segment is two triangles, widened on the screen (see the line shader).
  const lines = [];
  const segment = (azA, elA, azB, elB, shade, width) => {
    for (const [end, side] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]) lines.push(azA, elA, azB, elB, end, side, shade, width);
  };
  let ridgeCount = 0;
  if (s.ridges && depth) ridgeCount = ridges(depth.edges, horizon.angles, count, step, D, nearest, s.ridgeWidth, s.ridgeFade, segment);
  if (s.skyline) for (let a = 0; a < count; a++) segment(a * step, horizon.angles[a], (a + 1) * step, horizon.angles[(a + 1) % count], 0, s.lineWidth);

  return {
    style, settings: s, horizon,
    ground: Float32Array.from(ground), lines: Float32Array.from(lines),
    bands: bands.length, edges: bands.map((b) => b.k), ridgeSegments: ridgeCount,
    triangles: ground.length / FLOATS_GROUND / 3 + lines.length / FLOATS_LINE / 3,
    bytes: (ground.length + lines.length) * 4, buildMs: performance.now() - started,
  };
}

const closest = (D, metres) => {
  let best = 0;
  for (let k = 1; k < D.length; k++) if (Math.abs(Math.log(D[k] / metres)) < Math.abs(Math.log(D[best] / metres))) best = k;
  return best;
};

/**
 * Ridges in front of the skyline: on each ray, ground that can be seen with ground hidden behind
 * it, for at least half as far again. Joined to the same on the next ray when they line up, and
 * kept only where a ridge runs on for SHORTEST degrees or more: shorter bits are mostly noise.
 */
function ridges(E, angles, count, step, D, nearest, width, fade, segment) {
  const N = D.length, RUN = 3, FLAT = 0.03, BELOW_SKYLINE = 0.1, JOIN = 0.6, SHORTEST = 2;
  const at = (k, a) => E[k * count + a];
  const crests = Array.from({ length: count }, () => []);
  for (let a = 0; a < count; a++) {
    for (let k = 1; k < N - RUN; k++) {
      const e = at(k, a);
      if (e <= -80 || !(e > at(k - 1, a) + 1e-4)) continue; // nothing new seen here
      if (at(k + RUN, a) - e > FLAT) continue; // ground just behind it shows: not a ridge
      if (angles[a] - e < BELOW_SKYLINE) continue; // that is the skyline itself
      crests[a].push(k);
    }
  }
  // Link each crest to the best one on the next ray; each crest is taken by at most one.
  const next = crests.map((row) => row.map(() => -1)), taken = crests.map((row) => row.map(() => false));
  for (let a = 0; a < count; a++) {
    const b = (a + 1) % count;
    crests[a].forEach((k, i) => {
      let best = -1, gap = JOIN;
      crests[b].forEach((k2, j) => {
        const g = Math.abs(at(k2, b) - at(k, a));
        if (!taken[b][j] && Math.abs(k2 - k) <= 2 && g < gap) { gap = g; best = j; }
      });
      if (best >= 0) { next[a][i] = best; taken[b][best] = true; }
    });
  }
  // Follow each chain from its start; draw it only if it is long enough. A ridge that goes all the
  // way round has no start and is drawn as it is.
  const drawn = crests.map((row) => row.map(() => false)), seen = crests.map((row) => row.map(() => false));
  const shortest = Math.ceil(SHORTEST / step);
  let n = 0;
  const follow = (a, i, draw) => {
    let length = 0;
    for (let guard = 0; guard < count && next[a][i] >= 0 && !drawn[a][i]; guard++) {
      const b = (a + 1) % count, j = next[a][i];
      seen[a][i] = true;
      if (draw) {
        drawn[a][i] = true;
        segment(a * step, at(crests[a][i], a), (a + 1) * step, at(crests[b][j], b), fade * shadeOf(D[crests[a][i]], nearest), width);
        n++;
      }
      length++; a = b; i = j;
    }
    return length;
  };
  for (let a = 0; a < count; a++) crests[a].forEach((_, i) => { if (!taken[a][i] && follow(a, i, false) >= shortest) follow(a, i, true); });
  for (let a = 0; a < count; a++) crests[a].forEach((_, i) => { if (!seen[a][i] && next[a][i] >= 0) follow(a, i, true); });
  return n;
}

// ---- Drawing ----

const parseColour = (c) => {
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16) / 255);
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(c);
  if (m) return [m[1], m[2], m[3]].map((v) => +v / 255);
  throw new Error(`Colour '${c}': give #rgb, #rrggbb or rgb()`);
};
const paletteOf = (p) => (typeof p === 'string' ? PALETTES[p] ?? PALETTES.light : { ...PALETTES.light, ...p });

const PROJECT_GLSL = `
uniform float uYaw, uPitch, uScale;
uniform vec2 uSize;
vec3 dir(vec2 ae) {
  float d = radians(ae.x) - uYaw, e = radians(ae.y);
  float x = cos(e) * sin(d), up = sin(e), ahead = cos(e) * cos(d);
  return vec3(x, up * cos(uPitch) - ahead * sin(uPitch), up * sin(uPitch) + ahead * cos(uPitch));
}
vec2 proj(vec3 v) { return v.xy * (2.0 * uScale / (1.0 + v.z)); }
const vec4 GONE = vec4(0.0, 0.0, -2.0, 1.0); // outside the clip volume: the whole piece is dropped
`;
// Every corner of a piece carries the piece's centre; a piece whose centre is far behind the viewer
// is dropped whole, so that nothing stretches across the screen from behind.
const GROUND_VS = `precision highp float;${PROJECT_GLSL}
attribute vec2 aPos; attribute float aShade; attribute vec2 aCentre;
varying float vShade;
void main() {
  vShade = aShade;
  if (dir(aCentre).z < -0.8) { gl_Position = GONE; return; }
  gl_Position = vec4(proj(dir(aPos)) / (uSize * 0.5), 0.0, 1.0);
}`;
const GROUND_FS = `precision mediump float;
uniform vec3 uNear, uFar; varying float vShade;
void main() { gl_FragColor = vec4(mix(uNear, uFar, vShade), 1.0); }`;
const LINE_VS = `precision highp float;${PROJECT_GLSL}
attribute vec4 aSeg; attribute vec4 aInfo; // end, side, shade, width
varying float vShade;
void main() {
  vShade = aInfo.z;
  vec3 a = dir(aSeg.xy), b = dir(aSeg.zw);
  if (a.z < -0.8 || b.z < -0.8) { gl_Position = GONE; return; }
  vec2 pa = proj(a), pb = proj(b), t = pb - pa;
  float len = length(t), w = aInfo.w * 0.5;
  t = len > 1e-4 ? t / len : vec2(1.0, 0.0);
  vec2 p = (aInfo.x < 0.5 ? pa - t * w : pb + t * w) + vec2(-t.y, t.x) * aInfo.y * w;
  gl_Position = vec4(p / (uSize * 0.5), 0.0, 1.0);
}`;
const LINE_FS = `precision mediump float;
uniform vec3 uLine, uFar; varying float vShade;
void main() { gl_FragColor = vec4(mix(uLine, uFar, vShade), 1.0); }`;

/**
 * Make a canvas into a look-around view.
 * @param {HTMLCanvasElement} canvas  sized by CSS; the view follows its size
 * @param {{ settings?: object, camera?: Camera, webgl?: boolean, onDraw?: (view) => void }} [options]
 *   webgl: false to use the 2D fallback (for testing it); onDraw is called after every frame
 */
export function createView(canvas, options = {}) {
  let settings = { ...BASE, ...options.settings };
  let camera = { yaw: 0, pitch: 10, fieldDegrees: 110, ...options.camera };
  let scene = null, f = frame(1, 1, camera.fieldDegrees), pending = 0;
  const info = { renderer: 'none', frames: 0, lastFrameMs: 0, slowestFrameMs: 0 };
  const gl = options.webgl === false ? null : canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true });
  const ctx = gl ? null : canvas.getContext('2d');
  info.renderer = gl ? 'webgl' : 'canvas';

  // WebGL: two programs and two buffers, filled once per scene.
  let programs = null, buffers = null, counts = { ground: 0, lines: 0 };
  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const at = (name) => gl.getAttribLocation(p, name), un = (name) => gl.getUniformLocation(p, name);
    return { p, at, un };
  }
  function setUp() {
    programs = { ground: compile(GROUND_VS, GROUND_FS), lines: compile(LINE_VS, LINE_FS) };
    buffers = { ground: gl.createBuffer(), lines: gl.createBuffer() };
    if (scene) upload();
  }
  function upload() {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ground); gl.bufferData(gl.ARRAY_BUFFER, scene.ground, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.lines); gl.bufferData(gl.ARRAY_BUFFER, scene.lines, gl.STATIC_DRAW);
    counts = { ground: scene.ground.length / FLOATS_GROUND, lines: scene.lines.length / FLOATS_LINE };
  }
  if (gl) {
    setUp();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); programs = null; });
    canvas.addEventListener('webglcontextrestored', () => { setUp(); schedule(); });
  }

  function size() {
    const ratio = settings.pixelRatio ?? Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    const pw = Math.round(w * ratio), ph = Math.round(h * ratio);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    f = frame(w, h, camera.fieldDegrees);
    return ratio;
  }

  function drawGL() {
    if (!programs) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!scene) return;
    const pal = paletteOf(settings.palette), cardboard = scene.style === 'cardboard';
    const common = (pr) => {
      gl.useProgram(pr.p);
      gl.uniform1f(pr.un('uYaw'), camera.yaw * RAD); gl.uniform1f(pr.un('uPitch'), camera.pitch * RAD);
      gl.uniform1f(pr.un('uScale'), f.scale); gl.uniform2f(pr.un('uSize'), f.width, f.height);
    };
    const attrib = (pr, name, size, stride, offset) => {
      const loc = pr.at(name);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      return loc;
    };
    const g = programs.ground;
    common(g);
    gl.uniform3fv(g.un('uNear'), parseColour(cardboard ? pal.ground : pal.near));
    gl.uniform3fv(g.un('uFar'), parseColour(cardboard ? pal.ground : pal.far));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ground);
    const used = [attrib(g, 'aPos', 2, FLOATS_GROUND, 0), attrib(g, 'aShade', 1, FLOATS_GROUND, 2), attrib(g, 'aCentre', 2, FLOATS_GROUND, 3)];
    gl.drawArrays(gl.TRIANGLES, 0, counts.ground);
    used.forEach((loc) => gl.disableVertexAttribArray(loc));
    if (counts.lines) {
      const l = programs.lines;
      common(l);
      gl.uniform3fv(l.un('uLine'), parseColour(pal.line));
      gl.uniform3fv(l.un('uFar'), parseColour(pal.far));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.lines);
      const used2 = [attrib(l, 'aSeg', 4, FLOATS_LINE, 0), attrib(l, 'aInfo', 4, FLOATS_LINE, 4)];
      gl.drawArrays(gl.TRIANGLES, 0, counts.lines);
      used2.forEach((loc) => gl.disableVertexAttribArray(loc));
    }
  }

  // The 2D fallback: today's way of drawing, from the same scene, culled to the part in view. At
  // most four bands, so that a frame stays quick on a 2D canvas too.
  function draw2D(ratio) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, f.width, f.height);
    if (!scene) return;
    const pal = paletteOf(settings.palette), h = scene.horizon, count = h.angles.length, step = h.stepDegrees;
    const depth = h.depth, N = DEPTH_DISTANCES.length, cardboard = scene.style === 'cardboard';
    const all = scene.edges, edgesK = cardboard || !depth ? [N - 1]
      : all.length <= 4 ? all : [...new Set([0, 1, 2, 3].map((i) => all[Math.round((i * (all.length - 1)) / 3)]))];
    const edgeAt = (k, az) => {
      const fa = ((((az % 360) + 360) % 360) / step), a = Math.floor(fa) % count, b = (a + 1) % count, t = fa - Math.floor(fa);
      const e = (i) => (k >= N - 1 || !depth ? h.angles[i] : depth.edges[k * count + i]);
      return Math.max(-89, e(a) * (1 - t) + e(b) * t);
    };
    const near = parseColour(cardboard ? pal.ground : pal.near), far = parseColour(cardboard ? pal.ground : pal.far);
    const colour = (t) => `rgb(${near.map((v, i) => Math.round((v + (far[i] - v) * t) * 255)).join(',')})`;
    const span = Math.min(180, camera.fieldDegrees * 1.2), every = Math.max(step, span / 240);
    // Small four-cornered pieces, as the apps drew it: a piece partly behind the viewer is simply
    // left out (such pieces are far off screen). Farthest band first, each down to 10 degrees
    // below the level line; nearer ones paint over it; then coarser rows below, in the nearest shade.
    const piece = (az, w, top, bottom) => {
      const c = [project(camera, f, az, top(az)), project(camera, f, az + w, top(az + w)), project(camera, f, az + w, bottom), project(camera, f, az, bottom)];
      if (!c.every(Boolean)) return;
      ctx.moveTo(c[0][0], c[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]); ctx.closePath();
    };
    for (let j = edgesK.length - 1; j >= 0; j--) {
      ctx.fillStyle = colour(edgesK.length > 1 ? j / (edgesK.length - 1) : 0);
      ctx.beginPath();
      const top = (az) => Math.max(-8, edgeAt(edgesK[j], az));
      for (let az = camera.yaw - span; az < camera.yaw + span; az += every) piece(az, every, top, -10);
      if (j === 0) {
        for (const [hi, lo] of [[-9, -25], [-24, -45], [-44, -70], [-69, -89]]) {
          for (let az = camera.yaw - 180; az < camera.yaw + 180; az += 5) piece(az, 5, () => hi, lo);
        }
      }
      ctx.fill();
    }
    // Lines: the skyline and ridges, straight from the scene, grouped by width and shade so that
    // each group is one stroke. Pieces off the screen or behind the viewer are left out.
    const line = parseColour(pal.line), haze = parseColour(pal.far), groups = new Map(), L = scene.lines;
    for (let i = 0; i < L.length; i += 6 * FLOATS_LINE) {
      const a = project(camera, f, L[i], L[i + 1]), b = project(camera, f, L[i + 2], L[i + 3]);
      if (!a || !b || (Math.max(a[0], b[0]) < 0 || Math.min(a[0], b[0]) > f.width || Math.max(a[1], b[1]) < 0 || Math.min(a[1], b[1]) > f.height)) continue;
      const key = `${L[i + 7]}|${Math.round(L[i + 6] * 10)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a, b);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [key, points] of groups) {
      const [width, shade] = key.split('|').map(Number);
      ctx.strokeStyle = `rgb(${line.map((v, i) => Math.round((v + (haze[i] - v) * (shade / 10)) * 255)).join(',')})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let j = 0; j < points.length; j += 2) { ctx.moveTo(points[j][0], points[j][1]); ctx.lineTo(points[j + 1][0], points[j + 1][1]); }
      ctx.stroke();
    }
  }

  function draw() {
    pending = 0;
    const t0 = performance.now();
    const ratio = size();
    if (gl) drawGL(); else draw2D(ratio);
    const ms = performance.now() - t0;
    info.frames++; info.lastFrameMs = ms; info.slowestFrameMs = Math.max(info.slowestFrameMs, ms);
    options.onDraw?.(view);
  }
  // Many moves within one frame (a drag sends more events than the screen shows) are drawn once.
  function schedule() {
    if (!pending) pending = requestAnimationFrame(draw);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(canvas);

  const view = {
    info,
    /** Show a scene from buildScene(). */
    setScene(s) {
      scene = s;
      if (gl && programs) upload();
      schedule();
    },
    /** Change settings that need no new scene (palette, pixelRatio). Others need buildScene again. */
    setSettings(s) { settings = { ...settings, ...s }; schedule(); },
    /** Turn the view. Drawn at the next frame. */
    setCamera(c) {
      camera = { ...camera, ...c, yaw: ((((c.yaw ?? camera.yaw) % 360) + 360) % 360) };
      f = frame(f.width, f.height, camera.fieldDegrees);
      schedule();
    },
    get camera() { return camera; },
    get frame() { return f; },
    get scene() { return scene; },
    /** Draw now rather than at the next frame. */
    draw,
    /** Where a direction lands on the canvas, in CSS pixels, or null when behind the viewer. */
    project: (az, el) => project(camera, f, az, el),
    /** The direction at a point on the canvas, in CSS pixels. */
    unproject: (x, y) => unproject(camera, f, x, y),
    /** Whether the drawn skyline hides a direction. */
    behind: (az, el) => !!scene && el <= angleAt(scene.horizon, az),
  };
  return view;
}
