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
