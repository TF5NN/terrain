// openTerrain, in a web worker: the same terrain functions, but the calculation runs beside the
// page instead of in it, so the page stays smooth while a fine horizon is worked out.
//
//   import { openTerrainInBackground } from 'https://tf5nn.github.io/terrain/v1/background.js';
//   const terrain = await openTerrainInBackground('https://tf5nn.github.io/terrain/v1/');
//   const horizon = await terrain.horizon({ lat, lon });   // as with openTerrain
//   terrain.background   // true in a worker; false if the browser could not start one
//
// Where a worker cannot be started it quietly uses openTerrain on the page, which works the same,
// only less smoothly. The tile cache lives in the worker; terrain.detail() and terrain.stats are
// not offered here.

import { openTerrain } from './horizon.js';

const READY_WITHIN_MS = 8000;

/** Start the worker. A page on another site may not start a worker from here directly; then a
 * one-line worker of its own that imports this one is used instead. */
function startWorker() {
  const url = new URL('./worker.js', import.meta.url).href;
  try {
    return new Worker(url, { type: 'module' });
  } catch {
    const shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: 'text/javascript' }));
    return new Worker(shim, { type: 'module' });
  }
}

/**
 * @param {string} baseUrl  where manifest.json lives, ending in a slash
 * @returns the terrain functions covers, heightAt, horizon, sight and profile, each returning a
 *   Promise, plus manifest, hasDetail and background
 */
export async function openTerrainInBackground(baseUrl) {
  const base = new URL(baseUrl, globalThis.location?.href).href;
  let worker;
  try {
    worker = startWorker();
  } catch {
    return onPage(base);
  }
  const waiting = new Map();
  let next = 1;
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    if ('error' in data) w.reject(new Error(data.error)); else w.resolve(data.result);
  };
  const failed = (error) => { for (const w of waiting.values()) w.reject(error); waiting.clear(); };
  worker.onerror = (e) => { e.preventDefault?.(); failed(new Error(e.message || 'Terrain worker failed')); };

  // A browser that cannot run module workers fails here, by error or by silence.
  let opened;
  try {
    opened = await Promise.race([
      call('open', base),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Terrain worker did not start')), READY_WITHIN_MS)),
    ]);
  } catch {
    worker.terminate();
    return onPage(base);
  }
  const api = { ...opened, background: true, close: () => worker.terminate() };
  for (const m of ['covers', 'heightAt', 'horizon', 'sight', 'profile']) api[m] = (...args) => call(m, ...args);
  return api;
}

async function onPage(base) {
  const t = await openTerrain(base);
  return {
    manifest: t.manifest, hasDetail: t.hasDetail, background: false, close() {},
    covers: t.covers, heightAt: t.heightAt, horizon: t.horizon, sight: t.sight, profile: t.profile,
  };
}
