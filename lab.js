// The lab page: every way of drawing the terrain, with what each costs. See lab.html.
// It is also the worked example of using view.js the way an app would: the terrain on a canvas,
// the app's own marks (here a level line, compass marks and a made-up pass) on an SVG on top.

import { createView, buildScene, settingsFor, horizonOptions, redo, PRESETS, SETTINGS } from './v1/view.js';
import { openTerrainInBackground } from './v1/background.js';
import { angleAt } from './v1/horizon.js';

const SPOTS = [
  { name: 'Reykjavík, Öskjuhlíð hill', lat: 64.1293, lon: -21.919, yaw: 25 },
  { name: 'Foot of Esja, Kollafjörður', lat: 64.208, lon: -21.712, yaw: 30 },
  { name: 'Þingvellir', lat: 64.2559, lon: -21.1295, yaw: 0 },
  { name: 'Esja, steep south slope', lat: 64.2413, lon: -21.6251, yaw: 180 },
  { name: 'Esja, top plateau', lat: 64.247, lon: -21.628, yaw: 90 },
  { name: 'Úlfarsfell hilltop', lat: 64.1486, lon: -21.7119, yaw: 20 },
  { name: 'Vífilsfell, steep slope', lat: 64.038, lon: -21.556, yaw: 120 },
  { name: 'Landmannalaugar', lat: 63.9905, lon: -19.0605, yaw: 200 },
];
const $ = (id) => document.getElementById(id);
const stage = $('stage'), overlay = $('overlay'), readout = $('readout'), errorBox = $('error'), busy = $('busy');
const fmt = (n, d = 0) => Number(n).toLocaleString('en', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- State, kept in the link ----
const state = {
  preset: 'standard', settings: settingsFor('standard'), spot: { ...SPOTS[0] },
  camera: { yaw: SPOTS[0].yaw, pitch: 4, fieldDegrees: 110 }, shape: '0.75', renderer: 'webgl',
};
(function readLink() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (PRESETS[q.get('preset')]) state.preset = q.get('preset');
  const changes = {};
  for (const key of Object.keys(SETTINGS)) if (q.has(key)) { try { changes[key] = JSON.parse(q.get(key)); } catch { /* ignore */ } }
  // Colours follow the device's light or dark mode unless the link says otherwise.
  if (!('palette' in changes) && matchMedia('(prefers-color-scheme: dark)').matches) changes.palette = 'dark';
  state.settings = settingsFor(state.preset, changes);
  if (q.has('lat') && q.has('lon')) state.spot = { name: q.get('name') || 'Chosen spot', lat: +q.get('lat'), lon: +q.get('lon') };
  for (const k of ['yaw', 'pitch', 'fov']) if (q.has(k) && Number.isFinite(+q.get(k))) state.camera[k === 'fov' ? 'fieldDegrees' : k] = +q.get(k);
  if (q.has('shape')) state.shape = q.get('shape');
  if (q.get('renderer') === 'canvas') state.renderer = 'canvas';
})();
let linkTimer = 0;
function writeLink() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    const q = new URLSearchParams({ preset: state.preset });
    const base = PRESETS[state.preset];
    for (const key of Object.keys(SETTINGS)) if (JSON.stringify(state.settings[key]) !== JSON.stringify(base[key])) q.set(key, JSON.stringify(state.settings[key]));
    q.set('lat', state.spot.lat); q.set('lon', state.spot.lon); q.set('name', state.spot.name);
    const c = view?.camera ?? state.camera;
    q.set('yaw', c.yaw.toFixed(1)); q.set('pitch', c.pitch.toFixed(1));
    q.set('fov', Math.round(c.fieldDegrees)); q.set('shape', state.shape);
    if (state.renderer !== 'webgl') q.set('renderer', state.renderer);
    history.replaceState(null, '', `#${q}`);
  }, 300);
}

// ---- The view ----
let terrain = null, horizon = null, view = null, calcInfo = null, spinInfo = null, probe = null, longTasks = 0, calcToken = 0;
function makeView() {
  const old = $('canvas');
  const canvas = document.createElement('canvas');
  canvas.id = 'canvas'; canvas.setAttribute('aria-label', 'Terrain view');
  old.replaceWith(canvas);
  const camera = view ? view.camera : state.camera;
  view = createView(canvas, { settings: state.settings, camera, webgl: state.renderer === 'webgl', onDraw: drawOverlay });
  if (horizon) view.setScene(buildScene(horizon, state.settings));
  if (state.renderer === 'webgl' && view.info.renderer !== 'webgl') errorBox.textContent = 'This browser gave no WebGL, so the 2D fallback is drawing.';
}
function sizeStage() {
  const w = stage.clientWidth;
  const h = state.shape === 'fill' ? Math.max(240, innerHeight - stage.getBoundingClientRect().top - 12) : Math.round(w * +state.shape);
  stage.style.height = `${h}px`;
  overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
  view?.draw();
}

async function calculate() {
  const token = ++calcToken;
  busy.classList.add('on'); errorBox.textContent = '';
  const t0 = performance.now();
  try {
    if (!(await terrain.covers(state.spot.lat, state.spot.lon))) throw new Error('No terrain there: the layers cover land in Iceland only.');
    const h = await terrain.horizon({ lat: state.spot.lat, lon: state.spot.lon, ...horizonOptions(state.settings) });
    if (token !== calcToken) return; // a newer calculation was asked for meanwhile
    horizon = h;
    calcInfo = { ms: performance.now() - t0, kb: h.bytesFetched / 1024, requests: h.requests, ground: h.groundMetres };
    rebuild();
  } catch (e) {
    if (token === calcToken) errorBox.textContent = e.message;
  } finally {
    if (token === calcToken) busy.classList.remove('on');
  }
}
function rebuild() {
  if (!horizon) return;
  view.setSettings(state.settings);
  view.setScene(buildScene(horizon, state.settings));
  showReadout();
}

function changeSettings(next) {
  const part = redo(state.settings, next);
  state.settings = next;
  syncControls(); writeLink();
  if (part === 1) calculate();
  else if (part === 2) rebuild();
  else if (part === 3) { view.setSettings(next); showReadout(); }
}

// ---- What the app would draw on top: level line, compass, a pass, a probe ----
const ring = Array.from({ length: 181 }, (_, i) => ({ az: i * 2, el: 0 }));
const PASS = Array.from({ length: 121 }, (_, i) => { const t = i / 120; return { az: 150 + 180 * t, el: 26 * Math.sin(Math.PI * t) - 1 }; });
function path(points) {
  let d = '', pen = false;
  for (const p of points) {
    const at = view.project(p.az, p.el);
    if (at && Math.abs(at[0]) < 1e5 && Math.abs(at[1]) < 1e5) d += `${pen ? 'L' : 'M'}${at[0].toFixed(1)},${at[1].toFixed(1)}`;
    pen = !!at;
  }
  return d;
}
function drawOverlay(v) {
  const f = v.frame, parts = [`<path class="level" d="${path(ring)}"/>`];
  for (let az = 0; az < 360; az += 15) {
    const a = v.project(az, 0), b = v.project(az, -1.2), l = v.project(az, -4);
    if (!a || !b || a[0] < -40 || a[0] > f.width + 40) continue;
    parts.push(`<path class="tick" d="M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}"/>`);
    if (l) parts.push(`<text x="${l[0].toFixed(1)}" y="${l[1].toFixed(1)}" text-anchor="middle">${az % 90 === 0 ? ['N', 'E', 'S', 'W'][az / 90] : `${az}°`}</text>`);
  }
  // The pass: solid where it clears the drawn skyline, dashed where the terrain hides it.
  if (v.scene) {
    let run = null;
    const runs = [];
    PASS.forEach((p, i) => {
      const hidden = v.behind(p.az, p.el);
      if (!run || run.hidden !== hidden) { run = { hidden, points: i ? [PASS[i - 1], p] : [p] }; runs.push(run); } else run.points.push(p);
    });
    for (const r of runs) parts.push(`<path class="pass${r.hidden ? ' hidden' : ''}" d="${path(r.points)}"/>`);
    const top = v.project(PASS[60].az, PASS[60].el);
    if (top) parts.push(`<text x="${top[0].toFixed(1)}" y="${(top[1] - 8).toFixed(1)}" text-anchor="middle">made-up pass</text>`);
  }
  if (probe) {
    const p = v.project(probe.az, probe.el);
    if (p) parts.push(`<circle class="probe" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"/>`);
  }
  overlay.innerHTML = parts.join('');
  $('fovValue').textContent = `${Math.round(v.camera.fieldDegrees)}°`;
  showFrame();
}

// ---- Readout ----
function showReadout() {
  const s = view?.scene, lines = [];
  if (calcInfo) lines.push(`<b>1 · Calculation</b> ${fmt(calcInfo.ms)} ms · ${fmt(calcInfo.kb)} KB in ${calcInfo.requests} requests · ${terrain.background ? 'in a worker' : '<span class="bad">on the page (no worker)</span>'} · ground ${fmt(calcInfo.ground)} m`);
  if (s) lines.push(`<b>2 · Scene</b> ${s.style}, ${s.bands} band${s.bands > 1 ? 's' : ''}${s.ridgeSegments ? `, ${fmt(s.ridgeSegments)} ridge pieces` : ''} · ${fmt(s.triangles / 1000)}k triangles · ${fmt(s.bytes / 1048576, 1)} MB · built in ${fmt(s.buildMs)} ms`);
  lines.push('<span id="frameLine"></span>');
  if (spinInfo) lines.push(`<b>Spin test</b> ${fmt(spinInfo.fps)} fps · <span class="${spinInfo.late ? 'bad' : ''}">${spinInfo.late} late</span> of ${spinInfo.frames} frames · worst gap ${fmt(spinInfo.worst, 1)} ms (screen refresh ${fmt(spinInfo.median, 1)} ms)`);
  if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) lines.push(`<b>Page held up</b> <span class="${longTasks ? 'bad' : ''}">${longTasks}</span> time${longTasks === 1 ? '' : 's'} over 50 ms since the last calculation began`);
  readout.innerHTML = lines.join('<br>');
  showFrame();
}
function showFrame() {
  const el = document.getElementById('frameLine');
  if (!el || !view) return;
  const c = view.camera;
  el.innerHTML = `<b>3 · Frame</b> ${view.info.renderer === 'webgl' ? 'WebGL' : '2D canvas'} · ${fmt(view.info.lastFrameMs, 2)} ms to draw (slowest ${fmt(view.info.slowestFrameMs, 1)}) · ${$('canvas').width}×${$('canvas').height} px · looking ${fmt(c.yaw)}°, ${fmt(c.pitch)}° up, ${fmt(c.fieldDegrees)}° wide`;
}
if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  new PerformanceObserver((list) => { longTasks += list.getEntries().length; showReadout(); }).observe({ type: 'longtask' });
}

// ---- Turning, zooming, probing ----
const pointers = new Map();
let gesture = null;
const clampPitch = (p) => Math.max(-30, Math.min(85, p));
const clampFov = (f) => Math.max(15, Math.min(170, f));
stage.tabIndex = 0;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...pointers.values()], cam = view.camera;
  gesture = pts.length === 1
    ? { kind: 'drag', x: e.clientX, y: e.clientY, cam, moved: 0, at: performance.now() }
    : { kind: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), cam };
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.kind === 'drag') {
    // Degrees turned per pixel dragged, so the scene follows the finger near the centre.
    const perPixel = 180 / Math.PI / view.frame.scale;
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
    view.setCamera({ yaw: gesture.cam.yaw - (e.clientX - gesture.x) * perPixel, pitch: clampPitch(gesture.cam.pitch + (e.clientY - gesture.y) * perPixel) });
  } else if (pointers.size >= 2) {
    const pts = [...pointers.values()], dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (dist > 10) view.setCamera({ fieldDegrees: clampFov(gesture.cam.fieldDegrees * (gesture.dist / dist)) });
  }
  writeLink();
});
const release = (e) => {
  if (gesture?.kind === 'drag' && gesture.moved < 6 && performance.now() - gesture.at < 400) {
    const r = stage.getBoundingClientRect(), dir = view.unproject(e.clientX - r.left, e.clientY - r.top);
    probe = dir;
    const sky = horizon ? angleAt(horizon, dir.az) : NaN;
    errorBox.textContent = `Probe: bearing ${fmt(dir.az, 1)}°, ${fmt(dir.el, 1)}° up · skyline there ${fmt(sky, 2)}° · ${view.behind(dir.az, dir.el) ? 'behind the terrain' : 'clear of it'}`;
    view.draw();
  }
  pointers.delete(e.pointerId);
  gesture = pointers.size === 1 ? { kind: 'drag', ...[...pointers.values()][0], cam: view.camera, moved: 99, at: 0 } : null;
};
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('wheel', (e) => { e.preventDefault(); view.setCamera({ fieldDegrees: clampFov(view.camera.fieldDegrees * Math.exp(e.deltaY * 0.0015)) }); writeLink(); }, { passive: false });
stage.addEventListener('keydown', (e) => {
  const c = view.camera, step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 2], ArrowDown: [0, -2] }[e.key];
  if (step) { e.preventDefault(); view.setCamera({ yaw: c.yaw + step[0], pitch: clampPitch(c.pitch + step[1]) }); writeLink(); }
  if (e.key === '+' || e.key === '-') view.setCamera({ fieldDegrees: clampFov(c.fieldDegrees * (e.key === '+' ? 0.85 : 1.18)) });
});

// The spin test: one turn in 4 seconds, drawing in step with the screen, timing every gap.
$('spin').addEventListener('click', () => {
  const start = view.camera.yaw, gaps = [];
  let first = 0, last = 0;
  const tick = (now) => {
    if (!first) first = last = now;
    else { gaps.push(now - last); last = now; }
    const t = Math.min(1, (now - first) / 4000);
    view.setCamera({ yaw: start + 360 * t });
    view.draw();
    if (t < 1) requestAnimationFrame(tick);
    else {
      const sorted = [...gaps].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
      spinInfo = { frames: gaps.length, median, worst: sorted[sorted.length - 1], late: gaps.filter((g) => g > median * 1.5).length, fps: 1000 / (gaps.reduce((s, g) => s + g, 0) / gaps.length) };
      showReadout();
    }
  };
  requestAnimationFrame(tick);
});
$('copy').addEventListener('click', async () => {
  clearTimeout(linkTimer); writeLink();
  setTimeout(async () => { try { await navigator.clipboard.writeText(location.href); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed'; } setTimeout(() => ($('copy').textContent = 'Copy link'), 1500); }, 350);
});

// ---- Controls ----
const fields = [...document.querySelectorAll('[data-key]')];
function syncControls() {
  // The page's own colours follow the terrain's palette, so the sky behind it matches.
  if (typeof state.settings.palette === 'string') document.documentElement.dataset.theme = state.settings.palette;
  for (const el of fields) {
    const v = state.settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.type === 'km') el.value = v.map((m) => m / 1000).join(', ');
    else if (el.dataset.type === 'ratio') el.value = v == null ? 'auto' : String(v);
    else el.value = String(v);
  }
  for (const b of $('presets').children) b.classList.toggle('on', b.dataset.preset === state.preset && [0, 3].includes(redo(state.settings, PRESETS[state.preset])));
  $('fov').value = view?.camera.fieldDegrees ?? state.camera.fieldDegrees;
  $('shape').value = state.shape; $('renderer').value = state.renderer;
  const style = state.settings.style;
  fields.find((f) => f.dataset.key === 'layers').closest('label').style.opacity = style === 'layers' ? 1 : 0.45;
  fields.find((f) => f.dataset.key === 'shades').closest('label').style.opacity = style === 'shaded' ? 1 : 0.45;
}
for (const el of fields) {
  el.addEventListener('change', () => {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.type === 'number') v = +el.value;
    else if (el.dataset.type === 'ratio') v = el.value === 'auto' ? null : +el.value;
    else if (el.dataset.type === 'km') v = el.value.split(/[ ,;]+/).map(Number).filter((n) => n > 0).map((n) => n * 1000).sort((a, b) => a - b);
    else v = el.value;
    changeSettings({ ...state.settings, [el.dataset.key]: v });
  });
}
for (const name of Object.keys(PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name[0].toUpperCase() + name.slice(1); b.dataset.preset = name;
  // A preset keeps the view settings (colours, resolution) as they are.
  b.addEventListener('click', () => { state.preset = name; changeSettings(settingsFor(name, { palette: state.settings.palette, pixelRatio: state.settings.pixelRatio })); });
  $('presets').append(b);
}
$('fov').addEventListener('input', (e) => { view.setCamera({ fieldDegrees: +e.target.value }); writeLink(); });
$('shape').addEventListener('change', (e) => { state.shape = e.target.value; sizeStage(); writeLink(); });
$('renderer').addEventListener('change', (e) => { state.renderer = e.target.value; makeView(); sizeStage(); showReadout(); writeLink(); });
addEventListener('resize', sizeStage);

const spotSelect = $('spot');
spotSelect.innerHTML = SPOTS.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('') + '<option value="custom" hidden>Chosen spot</option>';
function goTo(spot, yaw) {
  state.spot = spot;
  const i = SPOTS.findIndex((s) => s.lat === spot.lat && s.lon === spot.lon);
  spotSelect.value = i >= 0 ? String(i) : 'custom';
  $('latlon').value = `${spot.lat}, ${spot.lon}`;
  if (yaw != null) view.setCamera({ yaw });
  probe = null; longTasks = 0;
  writeLink(); calculate();
}
spotSelect.addEventListener('change', () => { const s = SPOTS[+spotSelect.value]; if (s) goTo({ ...s }, s.yaw); });
$('go').addEventListener('click', () => {
  const [lat, lon] = $('latlon').value.split(/[ ,;]+/).filter(Boolean).map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) goTo({ name: 'Chosen spot', lat, lon }); else errorBox.textContent = 'Give latitude and longitude, like 64.1293, -21.919';
});
$('here').addEventListener('click', () => {
  if (!navigator.geolocation) { errorBox.textContent = 'This browser cannot give a location.'; return; }
  errorBox.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (p) => goTo({ name: 'My location', lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) }),
    (err) => { errorBox.textContent = `No location: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---- Start ----
makeView();
syncControls();
sizeStage();
$('latlon').value = `${state.spot.lat}, ${state.spot.lon}`;
const known = SPOTS.findIndex((s) => s.lat === state.spot.lat && s.lon === state.spot.lon);
spotSelect.value = known >= 0 ? String(known) : 'custom';
terrain = await openTerrainInBackground('./v1/');
await calculate();
