// Checks the detail layer against heights read straight from the ArcticDEM 10 m mosaics.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { openTerrain, toGrid } from '../v1/horizon.js';

const base = new URL('../v1/', import.meta.url);
const fileFetch = async (url) => {
  try { return new Response(await readFile(new URL(url))); } catch { return new Response(null, { status: 404 }); }
};
const reference = JSON.parse(await readFile(new URL('./detail-reference.json', import.meta.url), 'utf8'));
const terrain = await openTerrain(base.href, { fetch: fileFetch });

test('the detail layer is ArcticDEM\'s 10 m data to the nearest metre', async () => {
  assert(terrain.hasDetail);
  const got = await terrain.detail(reference.points.map((p) => p.x), reference.points.map((p) => p.y));
  let worst = 0, sum = 0, n = 0, holes = 0;
  reference.points.forEach((p, i) => {
    if (p.metres === null) { holes += 1; assert(Number.isNaN(got[i]), `a hole reads as a hole at ${p.x}, ${p.y}, not ${got[i]}`); return; }
    assert(!Number.isNaN(got[i]), `ground at ${p.x}, ${p.y} reads as a hole`);
    const d = got[i] - p.metres; worst = Math.max(worst, Math.abs(d)); sum += d; n += 1;
  });
  assert(n > 500, `${n} points compared`);
  // Rounding to the nearest metre gives up to half a metre; the sea-level table is blended a little differently.
  assert(worst < 0.8, `largest difference ${worst.toFixed(2)} m`);
  assert(Math.abs(sum / n) < 0.1, `mean difference ${(sum / n).toFixed(3)} m: not biased high or low`);
});

test('outside the data reads as a hole, and a path\'s worth of points costs little', async () => {
  // ArcticDEM has no data over the open sea, nor do the layers reach London: both are holes, not sea level.
  const ocean = toGrid(63.3, -22.5), london = toGrid(51.5, -0.12);
  const far = await terrain.detail([ocean.x, london.x], [ocean.y, london.y]);
  assert(Number.isNaN(far[0]) && Number.isNaN(far[1]), `${Array.from(far)}`);
  // 30 km from the foot of Esja towards Bláfjöll, a point every 10 m
  const a = toGrid(64.2423, -21.7186), b = toGrid(63.97639, -21.635), xs = [], ys = [];
  for (let i = 0; i <= 3000; i++) { xs.push(a.x + ((b.x - a.x) * i) / 3000); ys.push(a.y + ((b.y - a.y) * i) / 3000); }
  const before = terrain.stats.bytes;
  const heights = await terrain.detail(xs, ys);
  assert(heights.every((h) => h >= 0 && h < 1200));
  assert(Math.max(...heights) > 400, 'the path crosses high ground');
  assert(terrain.stats.bytes - before < 400 * 1024, `${terrain.stats.bytes - before} bytes for 30 km`);
});
