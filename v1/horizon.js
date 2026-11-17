// The terrain horizon around a point in Iceland.
//
// Give it a latitude and longitude and it returns, for every compass direction,
// how many degrees the ground rises above the level line. It reads three layers
// of "highest ground per cell" that live beside this file (see README.md):
//
//   near    40 m cells, heights in 2 m steps     used from 100 m to 2 km
//   fine    100 m cells, heights in 20 m steps   used from 2 km to 15 km
//   medium  1 km cells                           used from 15 km to 100 km
//
// Only the tiles under the look-out are fetched, about 40 KB for one horizon.
// Because each cell holds its highest ground, the horizon errs slightly high,
// which is the safe side for "will I see it?".
//
// Nothing in here knows about satellites, radio links or the page. It runs in
// a browser and in Node 18 or newer (it uses fetch and DecompressionStream).

// ---- The ArcticDEM map grid (EPSG:3413), as in Sightline's projection.js ----
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);
const TRUE_SCALE_LAT = (70 * Math.PI) / 180;
const CENTRAL_MERIDIAN = -45;
const tFactor = (phi) => {
  const s = Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - E * s) / (1 + E * s), E / 2);
};
const M_C = Math.cos(TRUE_SCALE_LAT) / Math.sqrt(1 - E2 * Math.sin(TRUE_SCALE_LAT) ** 2);
const T_C = tFactor(TRUE_SCALE_LAT);

/** Latitude and longitude in degrees to grid x and y in metres. */
export function toGrid(lat, lon) {
  const rho = (A * M_C * tFactor((lat * Math.PI) / 180)) / T_C;
  const lam = ((lon - CENTRAL_MERIDIAN) * Math.PI) / 180;
  return { x: rho * Math.sin(lam), y: -rho * Math.cos(lam) };
}

// ---- Geometry ----
const EARTH_RADIUS = 6371008.8;
const REFRACTION_K = 4 / 3; // radio and light both bend a little over the horizon
const DEG = Math.PI / 180;

/** The point a given distance away on a true bearing (spherical Earth; ample for 100 km). */
export function destination(lat, lon, bearingDeg, metres) {
  const d = metres / EARTH_RADIUS, b = bearingDeg * DEG, p1 = lat * DEG, l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: l2 / DEG };
}

// Where each layer is used, and how closely each ray is sampled, in metres.
// Ground closer than 100 m is left out. At that range 40 m cells say more about which cell
// you happen to stand in than about the terrain: on a hilltop or a steep slope they put up
// walls that are not there. From 100 m outward they agree with the 10 m data.
const ZONES = [
  { layer: 'near', from: 100, to: 2000, every: 20 },
  { layer: 'fine', from: 2000, to: 15000, every: 50 },
  { layer: 'medium', from: 15000, to: 100000, every: 250 },
];
const KNOT = 5000; // rays are projected exactly every 5 km and straight in between

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undo the row-wise differences and return plain heights in metres. */
function unpack(bytes, bits, cols, stepMetres) {
  const n = bits === 8 ? bytes.length : bytes.length / 2;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wrap = bits === 8 ? 0xff : 0xffff;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const raw = bits === 8 ? bytes[i] : view.getUint16(i * 2, true);
    previous = i % cols === 0 ? raw : (previous + raw) & wrap;
    out[i] = previous * stepMetres;
  }
  return out;
}

/**
 * Open the terrain layers.
 * @param {string} baseUrl  where manifest.json lives, ending in a slash
 * @param {{fetch?: typeof fetch}} [options]  a fetch to use instead of the global one
 */
export async function openTerrain(baseUrl, options = {}) {
  const get = options.fetch ?? fetch;
  const stats = { bytes: 0, requests: 0 };
  async function load(path) {
    const response = await get(baseUrl + path);
    if (!response.ok) throw new Error(`Terrain file ${path}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    stats.bytes += buffer.byteLength;
    stats.requests += 1;
    return buffer;
  }
  const manifest = JSON.parse(new TextDecoder().decode(await load('manifest.json')));
  if (manifest.format !== 1) throw new Error('Unknown terrain format');
  const { x0, y0, widthMetres, heightMetres, layers } = manifest;

  const present = {};
  for (const name of ['near', 'fine']) {
    const bits = Uint8Array.from(atob(layers[name].tiles), (c) => c.charCodeAt(0));
    present[name] = (ty, tx) => {
      const L = layers[name];
      if (tx < 0 || ty < 0 || tx >= L.tileCols || ty >= L.tileRows) return false;
      const i = ty * L.tileCols + tx;
      return (bits[i >> 3] >> (i & 7)) & 1;
    };
  }

  const tiles = new Map(); // "layer/ty_tx" -> Promise<Float32Array | null>
  function tile(name, ty, tx) {
    const key = `${name}/${ty}_${tx}`;
    if (!tiles.has(key)) {
      const L = layers[name];
      tiles.set(key, present[name](ty, tx)
        ? load(`${key}.bin.gz`).then(gunzip).then((b) => unpack(b, L.bits, L.cellsPerTile, L.heightStepMetres))
        : Promise.resolve(null)); // all sea
    }
    return tiles.get(key);
  }
  let mediumGrid = null;
  function medium() {
    mediumGrid ??= load(layers.medium.file).then(gunzip).then((b) => unpack(b, 16, layers.medium.cols, 1));
    return mediumGrid;
  }

  const inside = (x, y) => x >= x0 && y >= y0 && x < x0 + widthMetres && y < y0 + heightMetres;

  /** True where the layers have ground: on land in Iceland. */
  async function covers(lat, lon) {
    const { x, y } = toGrid(lat, lon);
    if (!inside(x, y)) return false;
    const grid = await medium();
    return grid[Math.floor((y - y0) / 1000) * layers.medium.cols + Math.floor((x - x0) / 1000)] > 0;
  }

  /** Reads one layer at many grid points at once. Missing ground reads as 0 (sea). */
  async function sample(name, xs, ys) {
    const out = new Float32Array(xs.length);
    if (name === 'medium') {
      const grid = await medium(), cols = layers.medium.cols;
      for (let i = 0; i < xs.length; i++) {
        if (inside(xs[i], ys[i])) out[i] = grid[Math.floor((ys[i] - y0) / 1000) * cols + Math.floor((xs[i] - x0) / 1000)];
      }
      return out;
    }
    const L = layers[name], cell = L.cellMetres, per = L.cellsPerTile, span = cell * per;
    const wanted = new Map();
    for (let i = 0; i < xs.length; i++) {
      const tx = Math.floor((xs[i] - x0) / span), ty = Math.floor((ys[i] - y0) / span);
      const key = ty * 100000 + tx;
      if (!wanted.has(key)) wanted.set(key, tile(name, ty, tx));
    }
    const loaded = new Map(await Promise.all([...wanted].map(async ([key, p]) => [key, await p])));
    for (let i = 0; i < xs.length; i++) {
      const gx = (xs[i] - x0) / cell, gy = (ys[i] - y0) / cell;
      const tx = Math.floor(gx / per), ty = Math.floor(gy / per);
      const data = loaded.get(ty * 100000 + tx);
      if (data) out[i] = data[(Math.floor(gy) - ty * per) * per + (Math.floor(gx) - tx * per)];
    }
    return out;
  }

  /**
   * Ground height above sea level at a point, in metres, from the 40 m layer.
   * The layer stores the highest ground in each cell, so the four cells around
   * the point are blended and half a height step is taken off.
   */
  async function heightAt(lat, lon) {
    const { x, y } = toGrid(lat, lon);
    const cell = layers.near.cellMetres;
    const fx = (x - x0) / cell - 0.5, fy = (y - y0) / cell - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const xs = [], ys = [];
    for (const dy of [0, 1]) for (const dx of [0, 1]) { xs.push(x0 + (ix + dx + 0.5) * cell); ys.push(y0 + (iy + dy + 0.5) * cell); }
    const h = await sample('near', Float64Array.from(xs), Float64Array.from(ys));
    const blended = h[0] * (1 - tx) * (1 - ty) + h[1] * tx * (1 - ty) + h[2] * (1 - tx) * ty + h[3] * tx * ty;
    return Math.max(0, blended - layers.near.heightStepMetres / 2);
  }

  /**
   * The horizon seen from a point.
   * @param {{lat: number, lon: number, antennaMetres?: number, stepDegrees?: number}} at
   * @returns angles[i] is the terrain's elevation angle, in degrees, on true bearing i * stepDegrees
   */
  async function horizon({ lat, lon, antennaMetres = 2, stepDegrees = 0.5 }) {
    if (!(await covers(lat, lon))) throw new Error('No terrain data here (outside Iceland, or at sea)');
    const before = { ...stats };
    const ground = await heightAt(lat, lon);
    const eye = ground + antennaMetres;
    const count = Math.round(360 / stepDegrees);
    const angles = new Float32Array(count).fill(-90);
    const knots = Math.round(ZONES[ZONES.length - 1].to / KNOT) + 1;
    // Exact grid positions along every ray, every 5 km.
    const kx = new Float64Array(count * knots), ky = new Float64Array(count * knots);
    for (let a = 0; a < count; a++) {
      for (let k = 0; k < knots; k++) {
        const p = k === 0 ? { lat, lon } : destination(lat, lon, a * stepDegrees, k * KNOT);
        const g = toGrid(p.lat, p.lon);
        kx[a * knots + k] = g.x; ky[a * knots + k] = g.y;
      }
    }
    for (const zone of ZONES) {
      const steps = Math.floor((zone.to - zone.from) / zone.every);
      const xs = new Float64Array(count * steps), ys = new Float64Array(count * steps);
      for (let a = 0; a < count; a++) {
        for (let s = 0; s < steps; s++) {
          const d = zone.from + s * zone.every, k = Math.min(knots - 2, Math.floor(d / KNOT)), t = d / KNOT - k;
          xs[a * steps + s] = kx[a * knots + k] * (1 - t) + kx[a * knots + k + 1] * t;
          ys[a * steps + s] = ky[a * knots + k] * (1 - t) + ky[a * knots + k + 1] * t;
        }
      }
      const heights = await sample(zone.layer, xs, ys);
      for (let a = 0; a < count; a++) {
        let best = angles[a];
        for (let s = 0; s < steps; s++) {
          const d = zone.from + s * zone.every;
          const rise = heights[a * steps + s] - eye - (d * d) / (2 * REFRACTION_K * EARTH_RADIUS);
          const angle = Math.atan2(rise, d) / DEG;
          if (angle > best) best = angle;
        }
        angles[a] = best;
      }
    }
    return {
      angles, stepDegrees, groundMetres: ground, eyeMetres: eye,
      bytesFetched: stats.bytes - before.bytes, requests: stats.requests - before.requests,
    };
  }

  return { manifest, covers, heightAt, horizon, stats };
}

/** The horizon's angle on any bearing, blended between the two nearest directions. */
export function angleAt(result, bearingDeg) {
  const n = result.angles.length, f = ((((bearingDeg % 360) + 360) % 360) / result.stepDegrees);
  const i = Math.floor(f) % n, t = f - Math.floor(f);
  return result.angles[i] * (1 - t) + result.angles[(i + 1) % n] * t;
}
