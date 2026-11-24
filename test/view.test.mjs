// Checks the drawing side: the depth a horizon can give, the farDetail choices, and view.js's
// settings, projection and scene. The drawing itself needs a browser: tools/check_view.cjs.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { openTerrain, FAR_DETAIL, DEPTH_DISTANCES } from '../v1/horizon.js';
import { buildScene, settingsFor, horizonOptions, redo, project, unproject, frame, PRESETS, SETTINGS } from '../v1/view.js';

const base = new URL('../v1/', import.meta.url);
const fileFetch = async (url) => {
  try { return new Response(await readFile(new URL(url))); } catch { return new Response(null, { status: 404 }); }
};
const reference = JSON.parse(await readFile(new URL('./reference.json', import.meta.url), 'utf8'));
const terrain = await openTerrain(base.href, { fetch: fileFetch });
const OSKJUHLID = { lat: 64.1293, lon: -21.919 };

test('asking for depth changes nothing else', async () => {
  const plain = await terrain.horizon({ ...OSKJUHLID, closeDetail: true });
  const deep = await terrain.horizon({ ...OSKJUHLID, closeDetail: true, depth: true });
  assert.deepEqual(Array.from(deep.angles), Array.from(plain.angles));
  assert.equal(plain.depth, undefined);
});

test('depth edges rise with distance and end at the skyline', async () => {
  const h = await terrain.horizon({ ...OSKJUHLID, closeDetail: true, depth: true });
  const { distances, edges } = h.depth, n = h.angles.length;
  assert.equal(distances.length, 64);
  assert(Math.abs(distances[0] - 10) < 1e-3 && Math.abs(distances[63] - 100000) < 1);
  assert.equal(edges.length, 64 * n);
  for (let a = 0; a < n; a++) {
    for (let k = 1; k < 64; k++) assert(edges[k * n + a] >= edges[(k - 1) * n + a], `ray ${a} falls at step ${k}`);
    assert.equal(edges[63 * n + a], h.angles[a]);
  }
  // Ground closer than the nearest counted (10 m here) is not there at all.
  for (let a = 0; a < n; a++) assert.equal(edges[a], -90);
});

test("farDetail 'standard' is the default, and an unknown one is refused", async () => {
  const a = await terrain.horizon({ ...OSKJUHLID });
  const b = await terrain.horizon({ ...OSKJUHLID, farDetail: 'standard' });
  assert.deepEqual(Array.from(a.angles), Array.from(b.angles));
  await assert.rejects(terrain.horizon({ ...OSKJUHLID, farDetail: 'sharp' }), /farDetail/);
  assert.deepEqual(FAR_DETAIL, ['standard', 'smooth', 'fine', 'finest']);
});

// The finer choices blend between cells, so they may read a little lower than 'standard', but they
// must stay as close to the 10 m data as it is, and not cost much more than README.md says.
for (const farDetail of ['smooth', 'fine', 'finest']) {
  test(`farDetail '${farDetail}' agrees with the 10 m data`, async () => {
    let p95sum = 0, kb = 0;
    for (const spot of reference.spots) {
      const h = await (await openTerrain(base.href, { fetch: fileFetch })).horizon({ lat: spot.lat, lon: spot.lon, farDetail });
      const diff = Array.from(h.angles, (a, i) => a - spot.angles[i]);
      const mean = diff.reduce((s, d) => s + d, 0) / diff.length;
      const p95 = diff.map(Math.abs).sort((x, y) => x - y)[Math.floor(diff.length * 0.95)];
      assert(mean > (spot.steep ? -1.5 : -0.3) && mean < (spot.steep ? 1.5 : 0.8), `${spot.name}: mean ${mean.toFixed(2)}`);
      assert(p95 < (spot.steep ? 5 : 1.5), `${spot.name}: 95% within ${p95.toFixed(2)}`);
      p95sum += p95; kb += h.bytesFetched / 1024;
    }
    const n = reference.spots.length;
    assert(p95sum / n < 1.7, `average 95% within ${(p95sum / n).toFixed(2)} degrees`);
    assert(kb / n < { smooth: 80, fine: 250, finest: 800 }[farDetail], `${(kb / n).toFixed(0)} KB a horizon`);
    console.log(`  ${farDetail}: 95% within ${(p95sum / n).toFixed(2)} deg on average, ${(kb / n).toFixed(0)} KB`);
  });
}

test('presets fill in every setting, and quick is what the apps drew before', () => {
  for (const name of Object.keys(PRESETS)) for (const key of Object.keys(SETTINGS)) assert(key in settingsFor(name), `${name} lacks ${key}`);
  const quick = settingsFor('quick');
  assert.equal(quick.style, 'cardboard');
  assert.equal(quick.skyline, false);
  assert.deepEqual(horizonOptions(quick), { stepDegrees: 0.5, closeDetail: true, farDetail: 'standard', antennaMetres: 2, depth: true });
  assert.equal(settingsFor('standard', { style: 'shaded' }).style, 'shaded');
  assert.throws(() => settingsFor('fancy'), /preset/);
});

test('redo says which part of the work a change needs', () => {
  const s = settingsFor('standard');
  assert.equal(redo(s, { ...s }), 0);
  assert.equal(redo(s, { ...s, palette: 'dark' }), 3);
  assert.equal(redo(s, { ...s, style: 'shaded' }), 2);
  assert.equal(redo(s, { ...s, layers: [3000] }), 2);
  assert.equal(redo(s, { ...s, farDetail: 'fine', palette: 'dark' }), 1);
});

test('project and unproject are each other\'s reverse', () => {
  const f = frame(400, 300, 110);
  for (const camera of [{ yaw: 0, pitch: 0 }, { yaw: 123, pitch: 20 }, { yaw: 350, pitch: 70 }]) {
    const centre = project(camera, f, camera.yaw, camera.pitch);
    assert(Math.abs(centre[0] - 200) < 1e-9 && Math.abs(centre[1] - 150) < 1e-9);
    for (const [az, el] of [[camera.yaw + 30, 5], [camera.yaw - 50, -10], [camera.yaw + 5, 40]]) {
      const p = project(camera, f, az, el), back = unproject(camera, f, p[0], p[1]);
      assert(Math.abs(((back.az - az + 540) % 360) - 180) < 1e-6 && Math.abs(back.el - el) < 1e-6, JSON.stringify({ camera, az, el, back }));
    }
  }
  assert.equal(project({ yaw: 0, pitch: 0 }, f, 180, 0), null); // right behind the viewer
});

test('scenes: the right bands, the skyline on top, nothing missing', async () => {
  const h = await terrain.horizon({ ...OSKJUHLID, closeDetail: true, depth: true });
  const n = h.angles.length;
  const cardboard = buildScene(h, settingsFor('quick'));
  assert.equal(cardboard.bands, 1);
  assert.equal(cardboard.lines.length, 0);
  const layers = buildScene(h, settingsFor('standard'));
  assert.equal(layers.bands, 3);
  assert.equal(layers.lines.length, n * 6 * 8); // the skyline: one piece a ray, two triangles each
  const shaded = buildScene(h, settingsFor('detailed', { shades: 16 }));
  assert(shaded.bands > 8 && shaded.bands <= 16, `${shaded.bands} bands`);
  assert(shaded.ridgeSegments > 0);
  for (const s of [cardboard, layers, shaded]) {
    assert(!s.ground.some(Number.isNaN) && !s.lines.some(Number.isNaN), 'no NaN');
    // The top of the ground on each ray is the skyline, whatever the style.
    const top = new Float32Array(n).fill(-90);
    for (let i = 0; i < s.ground.length; i += 5) {
      const ray = Math.round(s.ground[i] / h.stepDegrees) % n;
      top[ray] = Math.max(top[ray], s.ground[i + 1]);
    }
    for (let a = 0; a < n; a++) assert(Math.abs(top[a] - h.angles[a]) < 1e-3, `${s.style}: ray ${a} tops at ${top[a]}, skyline ${h.angles[a]}`);
  }
});

test('a horizon without depth can still be drawn as cardboard', async () => {
  const h = await terrain.horizon({ ...OSKJUHLID });
  const s = buildScene(h, settingsFor('detailed'));
  assert.equal(s.style, 'cardboard');
  assert.equal(s.bands, 1);
});

test('the depth table is the one view.js expects', () => {
  assert.equal(DEPTH_DISTANCES.length, 64);
});
