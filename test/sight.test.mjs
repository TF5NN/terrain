// Checks sight() against lines of sight computed straight from the 10 m ArcticDEM data.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { openTerrain, span } from '../v1/horizon.js';

const base = new URL('../v1/', import.meta.url);
const fileFetch = async (url) => {
  try { return new Response(await readFile(new URL(url))); } catch { return new Response(null, { status: 404 }); }
};
const reference = JSON.parse(await readFile(new URL('./sight-reference.json', import.meta.url), 'utf8'));
const terrain = await openTerrain(base.href, { fetch: fileFetch });
const MARGINAL = 40; // a line less than this far below the layers' ground may in truth just clear

test('distance and bearing between two points', () => {
  const north = span(64, -22, 64.1, -22);
  assert(Math.abs(north.metres - 11119.5) < 5 && Math.abs(north.bearing) < 1e-6, JSON.stringify(north));
  const east = span(64, -22, 64, -21.9);
  assert(Math.abs(east.bearing - 90) < 0.1 && Math.abs(east.metres - 4874) < 10, JSON.stringify(east));
});

test('lines of sight agree with the 10 m data', async () => {
  let compared = 0, clear = 0, blocked = 0, blockedSeen = 0, bytes = 0;
  for (const c of reference.cases) {
    const got = await terrain.sight({
      from: { lat: c.from[0], lon: c.from[1], antennaMetres: reference.fromAntennaMetres },
      to: { lat: c.to[0], lon: c.to[1], antennaMetres: reference.toAntennaMetres },
    });
    if (!got) continue; // a look-out at sea
    compared += 1; bytes += got.bytesFetched;
    const where = `${c.from} to ${c.site}: 10 m data ${c.clearanceMetres} m, layers ${got.clearanceMetres.toFixed(1)} m`;
    assert(Math.abs(got.distanceMetres - c.distanceMetres) < c.distanceMetres * 0.004 + 5, `distance, ${where}`);
    if (c.clearanceMetres >= 0) {
      clear += 1;
      assert(got.clearanceMetres >= -MARGINAL, `a clear line is never called blocked, ${where}`);
    } else {
      blocked += 1;
      assert(got.clearanceMetres < 0, `a blocked line is never called clear, ${where}`);
      if (got.clearanceMetres < -MARGINAL) blockedSeen += 1;
    }
  }
  assert(compared > 300 && clear >= 10, `${compared} compared, ${clear} clear`);
  assert(blockedSeen / blocked > 0.9, `${blockedSeen} of ${blocked} blocked lines were called blocked outright`);
  assert(bytes / compared < 12 * 1024, `${Math.round(bytes / compared)} bytes per line on average`);
});

test('no answer outside the layers, and a point sees itself', async () => {
  assert.equal(await terrain.sight({ from: { lat: 64.1293, lon: -21.919 }, to: { lat: 51.5, lon: -0.12 } }), null);
  const here = await terrain.sight({ from: { lat: 64.1293, lon: -21.919, antennaMetres: 2 }, to: { lat: 64.1293, lon: -21.919, antennaMetres: 10 } });
  assert(here.clearanceMetres >= 2 && here.distanceMetres < 1);
});

test('the profile along a path has the same ends and the same tightest spot as sight()', async () => {
  const ends = { from: { lat: 64.208, lon: -21.712, antennaMetres: 2 }, to: { lat: 63.97639, lon: -21.635, antennaMetres: 10 } };
  const p = await terrain.profile(ends), seen = await terrain.sight(ends);
  assert.equal(p.distances[0], 0);
  assert(Math.abs(p.distances[p.distances.length - 1] - seen.distanceMetres) < 1e-6);
  assert(p.distances.every((d, i) => i === 0 || d > p.distances[i - 1]), 'distances increase');
  assert(Math.abs(p.ground[0] - seen.fromGroundMetres) < 1e-3 && Math.abs(p.ground[p.ground.length - 1] - seen.toGroundMetres) < 1e-3);
  const D = seen.distanceMetres, hA = p.ground[0] + 2, hB = p.ground[p.ground.length - 1] + 10;
  let least = Infinity;
  for (let i = 1; i < p.distances.length - 1; i++) {
    const d = p.distances[i];
    least = Math.min(least, hA + ((hB - hA) * d) / D - p.ground[i] - (d * (D - d)) / (2 * (4 / 3) * 6371008.8));
  }
  assert(Math.abs(least - seen.clearanceMetres) < 3, `${least} against ${seen.clearanceMetres}`);
  assert(p.bytesFetched < 40 * 1024);
  assert.equal(await terrain.profile({ from: ends.from, to: { lat: 51.5, lon: -0.12 } }), null);
});
