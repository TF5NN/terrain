// Checks horizon.js against horizons computed straight from the 10 m ArcticDEM data.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { openTerrain, angleAt, toGrid, destination } from '../v1/horizon.js';

const base = new URL('../v1/', import.meta.url);
const fileFetch = async (url) => {
  try { return new Response(await readFile(new URL(url))); } catch { return new Response(null, { status: 404 }); }
};
const reference = JSON.parse(await readFile(new URL('./reference.json', import.meta.url), 'utf8'));
const terrain = await openTerrain(base.href, { fetch: fileFetch });

test('map grid matches the reference projection library', () => {
  // Values from PROJ (EPSG:4326 to EPSG:3413).
  const g = toGrid(64.1466, -21.9426);
  assert(Math.abs(g.x - 1115121) < 1 && Math.abs(g.y + 2619760) < 1, JSON.stringify(g));
});

test('a point 10 km north is 10 km north', () => {
  const p = destination(64, -22, 0, 10000);
  assert(Math.abs(p.lon + 22) < 1e-9 && Math.abs((p.lat - 64) * 111195 - 10000) < 20);
});

for (const spot of reference.spots) {
  test(`horizon at ${spot.name} agrees with the 10 m data`, async () => {
    const h = await terrain.horizon({ lat: spot.lat, lon: spot.lon });
    assert.equal(h.angles.length, spot.angles.length);
    const diff = Array.from(h.angles, (a, i) => a - spot.angles[i]);
    const mean = diff.reduce((s, d) => s + d, 0) / diff.length;
    const sorted = diff.map(Math.abs).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    // Cells hold their highest ground, so on gentle ground the layers may read high, never much
    // low. On hilltops and steep slopes 40 m cells are coarse for the nearest few hundred metres,
    // and the limits are wider.
    const limit = spot.steep ? { low: -1.5, high: 1.5, p95: 5 } : { low: -0.1, high: 0.8, p95: 1.5 };
    assert(mean > limit.low && mean < limit.high, `mean difference ${mean.toFixed(2)} degrees`);
    assert(p95 < limit.p95, `95% of directions within ${p95.toFixed(2)} degrees`);
    assert(Math.abs(h.groundMetres - spot.groundMetres) < (spot.steep ? 12 : 6), `ground ${h.groundMetres} vs ${spot.groundMetres}`);
    assert(h.bytesFetched < 120 * 1024, `fetched ${h.bytesFetched} bytes`);
    console.log(`  ${spot.name}: mean ${mean >= 0 ? '+' : ''}${mean.toFixed(2)} deg, 95% within ${p95.toFixed(2)} deg, ground ${h.groundMetres.toFixed(0)} m (reference ${spot.groundMetres} m), ${(h.bytesFetched / 1024).toFixed(0)} KB`);
  });
}

// With closeDetail the ground under the viewer and the closest 500 m come from the 10 m data.
for (const spot of reference.spots) {
  test(`horizon with closeDetail at ${spot.name}`, async () => {
    const fresh = await openTerrain(base.href, { fetch: fileFetch });
    const plain = await fresh.horizon({ lat: spot.lat, lon: spot.lon });
    const h = await (await openTerrain(base.href, { fetch: fileFetch })).horizon({ lat: spot.lat, lon: spot.lon, closeDetail: true });
    assert.equal(plain.closeDetail, false);
    assert.equal(h.closeDetail, true);
    const p95 = (r) => Array.from(r.angles, (a, i) => Math.abs(a - spot.angles[i])).sort((a, b) => a - b)[Math.floor(r.angles.length * 0.95)];
    const mean = Array.from(h.angles, (a, i) => a - spot.angles[i]).reduce((s, d) => s + d, 0) / h.angles.length;
    // Never noticeably worse than without it, and within tighter limits on hilltops and slopes.
    assert(p95(h) < p95(plain) + 0.1, `95% within ${p95(h).toFixed(2)} degrees, against ${p95(plain).toFixed(2)} without`);
    assert(p95(h) < (spot.steep ? 3.5 : 1.5) && Math.abs(mean) < (spot.steep ? 1.5 : 0.8), `mean ${mean.toFixed(2)}, 95% within ${p95(h).toFixed(2)} degrees`);
    // The viewer's ground is the 10 m data's own, closer to the reference than the 40 m layer's on a slope.
    assert(Math.abs(h.groundMetres - spot.groundMetres) < (spot.steep ? 6 : 3), `ground ${h.groundMetres} vs ${spot.groundMetres}`);
    assert(h.bytesFetched < 260 * 1024, `fetched ${h.bytesFetched} bytes`);
    console.log(`  ${spot.name}: 95% within ${p95(h).toFixed(2)} deg (${p95(plain).toFixed(2)} without), ground ${h.groundMetres.toFixed(0)} m (reference ${spot.groundMetres} m), ${(h.bytesFetched / 1024).toFixed(0)} KB (${(plain.bytesFetched / 1024).toFixed(0)} without)`);
  });
}

test('angleAt blends between directions and wraps at north', async () => {
  const h = { angles: Float32Array.from([1, 3, 5, 7]), stepDegrees: 90 };
  assert.equal(angleAt(h, 45), 2);
  assert.equal(angleAt(h, 315), 4);
  assert.equal(angleAt(h, -90), 7);
  assert.equal(angleAt(h, 720), 1);
});

test('coverage: land in Iceland only', async () => {
  assert.equal(await terrain.covers(64.1293, -21.919), true);
  assert.equal(await terrain.covers(64.3, -22.8), false, 'sea');
  assert.equal(await terrain.covers(51.5, -0.12), false, 'London');
  await assert.rejects(() => terrain.horizon({ lat: 51.5, lon: -0.12 }), /No terrain data/);
});

test('every tile the manifest lists exists, and none is oversized', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  for (const name of ['near', 'fine']) {
    const files = await readdir(new URL(`./${name}/`, base));
    assert.equal(files.length, terrain.manifest.layers[name].tileCount);
    for (const f of files.slice(0, 200)) assert((await stat(new URL(`./${name}/${f}`, base))).size < 20000);
  }
});
