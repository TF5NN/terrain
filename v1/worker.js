// The terrain calculation in a web worker, so that a slow calculation never holds up the page.
// Started by background.js; not meant to be used on its own.
//
// Messages in:  { id, method, args }   method is 'open' (args: [baseUrl]) or one of the terrain's
//                                      own: covers, heightAt, horizon, sight, profile
// Messages out: { id, result } or { id, error }

import { openTerrain } from './horizon.js';

let terrain = null;
const METHODS = ['covers', 'heightAt', 'horizon', 'sight', 'profile'];

/** The typed arrays in a result, to hand over rather than copy. Shared tables are copied. */
function transferables(value, out = [], seen = new Set()) {
  if (ArrayBuffer.isView(value)) {
    if (!seen.has(value.buffer)) { seen.add(value.buffer); out.push(value.buffer); }
  } else if (value && typeof value === 'object') for (const v of Object.values(value)) transferables(v, out, seen);
  return out;
}

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    let result;
    if (method === 'open') {
      terrain = await openTerrain(args[0]);
      result = { manifest: terrain.manifest, hasDetail: terrain.hasDetail };
    } else if (METHODS.includes(method) && terrain) {
      result = await terrain[method](...args);
      // depth.distances is a table shared by every horizon: send a copy, keep the original.
      if (result?.depth) result.depth = { ...result.depth, distances: Float32Array.from(result.depth.distances) };
    } else throw new Error(terrain ? `Unknown method '${method}'` : 'Terrain not opened');
    self.postMessage({ id, result }, transferables(result));
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
