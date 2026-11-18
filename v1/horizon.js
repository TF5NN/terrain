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

/** Distance in metres and true bearing in degrees from one point to another (spherical Earth). */
export function span(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const bearing = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return { metres: 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h))), bearing: ((bearing / DEG) + 360) % 360 };
}

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
const NEAREST = 100; // ground closer than this to an antenna is left out
const CLOSE_IN = 500; // the horizon is read from the 10 m data out to here, where there is any
const END_REACH = 2000; // a profile is read from the 10 m data this far from each end
const END_NEAREST = 10; // and with it, ground counts from this close to an antenna
const SURE_METRES = 100; // a path this far above the 1 km layer needs no finer look
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
   * Reads one layer at many grid points, blended between the four cells around each point.
   * Up close a single 40 m cell fills many degrees of the view; taking cells whole draws the
   * skyline in flat steps. Blending follows the slope between them instead.
   */
  async function sampleBlended(name, xs, ys) {
    const cell = layers[name].cellMetres, n = xs.length;
    const cx = new Float64Array(n * 4), cy = new Float64Array(n * 4), wx = new Float32Array(n), wy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fx = (xs[i] - x0) / cell - 0.5, fy = (ys[i] - y0) / cell - 0.5, ix = Math.floor(fx), iy = Math.floor(fy);
      wx[i] = fx - ix; wy[i] = fy - iy;
      for (let c = 0; c < 4; c++) {
        cx[i * 4 + c] = x0 + (ix + (c & 1) + 0.5) * cell;
        cy[i * 4 + c] = y0 + (iy + (c >> 1) + 0.5) * cell;
      }
    }
    const h = await sample(name, cx, cy), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = h[i * 4] * (1 - wx[i]) * (1 - wy[i]) + h[i * 4 + 1] * wx[i] * (1 - wy[i]) + h[i * 4 + 2] * (1 - wx[i]) * wy[i] + h[i * 4 + 3] * wx[i] * wy[i];
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
    // With the detail layer, the ground under the viewer and the closest 500 m come from the 10 m
    // data itself: up close, 40 m cells are coarse, and on a slope they put the viewer too high.
    const here = toGrid(lat, lon);
    const own = layers.detail ? (await detail([here.x], [here.y]))[0] : NaN;
    const ground = Number.isNaN(own) ? await heightAt(lat, lon) : own;
    const zones = Number.isNaN(own) ? ZONES : [{ layer: 'detail', from: NEAREST, to: CLOSE_IN, every: 5 }, { ...ZONES[0], from: CLOSE_IN }, ...ZONES.slice(1)];
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
    for (const zone of zones) {
      const steps = Math.floor((zone.to - zone.from) / zone.every);
      const xs = new Float64Array(count * steps), ys = new Float64Array(count * steps);
      for (let a = 0; a < count; a++) {
        for (let s = 0; s < steps; s++) {
          const d = zone.from + s * zone.every, k = Math.min(knots - 2, Math.floor(d / KNOT)), t = d / KNOT - k;
          xs[a * steps + s] = kx[a * knots + k] * (1 - t) + kx[a * knots + k + 1] * t;
          ys[a * steps + s] = ky[a * knots + k] * (1 - t) + ky[a * knots + k + 1] * t;
        }
      }
      let heights;
      if (zone.layer === 'detail') {
        heights = await detail(xs, ys);
        if (heights.some(Number.isNaN)) { // holes (open sea): the 40 m layer's answer there
          const spare = await sampleBlended('near', xs, ys);
          heights.forEach((h, i) => { if (Number.isNaN(h)) heights[i] = spare[i]; });
        }
      } else heights = await (zone.layer === 'near' ? sampleBlended : sample)(zone.layer, xs, ys);
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

  /**
   * Whether one antenna can see another over the terrain between them.
   *
   * Works on the straight line between the two antennas with the Earth's curve added to the
   * ground (4/3 radius). Within 2 km of either end it reads the 40 m layer, elsewhere the
   * 100 m layer; the middle of a long path is first tried on the 1 km layer and only read
   * finer if that comes close to the line. Ground within 100 m of either end is left out.
   * Cells hold their highest ground, so a line reported clear is clear; a line reported
   * blocked by a small amount may in fact just clear.
   *
   * @param {{from: {lat: number, lon: number, antennaMetres?: number}, to: {lat: number, lon: number, antennaMetres?: number}}} ends
   * @returns clearanceMetres is the least height of the line above the ground (negative: the
   *   ground is above the line); worstAtMetres is how far from `from` that is; angleDegrees is
   *   how high the far antenna stands above the level line as seen from `from`. Null when
   *   either end is outside the layers.
   */
  async function sight({ from, to }) {
    if (!(await covers(from.lat, from.lon)) || !(await covers(to.lat, to.lon))) return null;
    const before = { ...stats };
    const { metres: D, bearing } = span(from.lat, from.lon, to.lat, to.lon);
    const groundA = await heightAt(from.lat, from.lon), groundB = await heightAt(to.lat, to.lon);
    const hA = groundA + (from.antennaMetres ?? 2), hB = groundB + (to.antennaMetres ?? 2);
    const bulge = (d) => (d * (D - d)) / (2 * REFRACTION_K * EARTH_RADIUS);
    const angleDegrees = Math.atan2(hB - hA - (D * D) / (2 * REFRACTION_K * EARTH_RADIUS), D) / DEG;
    const result = (clearance, at) => ({
      distanceMetres: D, bearingDegrees: bearing, clearanceMetres: clearance, worstAtMetres: at, angleDegrees,
      fromGroundMetres: groundA, toGroundMetres: groundB,
      bytesFetched: stats.bytes - before.bytes, requests: stats.requests - before.requests,
    });
    if (D <= 2 * NEAREST) return result(Math.min(hA - groundA, hB - groundB), 0);
    // Exact grid positions along the path every 5 km, straight in between.
    const knots = Math.ceil(D / KNOT) + 1, kx = new Float64Array(knots + 1), ky = new Float64Array(knots + 1);
    for (let k = 0; k <= knots; k++) {
      const p = k === 0 ? from : destination(from.lat, from.lon, bearing, k * KNOT);
      const g = toGrid(p.lat, p.lon);
      kx[k] = g.x; ky[k] = g.y;
    }
    /** Least clearance over the stretch of path whose distance to the nearer end is in [lo, hi). */
    async function stretch(layer, every, lo, hi) {
      const ds = [];
      for (let d = NEAREST; d <= D - NEAREST; d += every) {
        const m = Math.min(d, D - d);
        if (m >= lo && m < hi) ds.push(d);
      }
      const xs = new Float64Array(ds.length), ys = new Float64Array(ds.length);
      ds.forEach((d, i) => {
        const k = Math.floor(d / KNOT), t = d / KNOT - k;
        xs[i] = kx[k] * (1 - t) + kx[k + 1] * t;
        ys[i] = ky[k] * (1 - t) + ky[k + 1] * t;
      });
      const heights = await sample(layer, xs, ys);
      let least = Infinity, at = 0;
      ds.forEach((d, i) => {
        const clearance = hA + ((hB - hA) * d) / D - heights[i] - bulge(d);
        if (clearance < least) { least = clearance; at = d; }
      });
      return { least, at };
    }
    const parts = [await stretch('near', 20, 0, 2000), await stretch('fine', 50, 2000, 15000)];
    let middle = await stretch('medium', 250, 15000, Infinity);
    // The 1 km layer reads high. Only when it comes near the line is the middle read again, finer.
    // Not worth it when the ends already show the path well blocked.
    const ends = Math.min(parts[0].least, parts[1].least);
    if (middle.least < SURE_METRES && ends > -SURE_METRES) middle = await stretch('fine', 50, 15000, Infinity);
    parts.push(middle);
    const worst = parts.reduce((a, b) => (b.least < a.least ? b : a));
    return result(worst.least, worst.at);
  }

  /**
   * The ground along the straight path between two points, for working out a radio link.
   *
   * Within 2 km of either end it reads the 10 m data itself (the detail layer), counting the
   * ground from 10 m out: a link is decided close to the antennas more often than anywhere else,
   * and on a hilltop the ground just around the antenna is what gets in the way. In between it
   * reads the 100 m layer, whose cells hold their highest ground, so that stretch reads a
   * little high: obstacles are never missed, and a loss worked out from it errs on the large
   * side. Layers without a detail layer use the 40 m layer near the ends and leave out the
   * nearest 100 m.
   *
   * @param {{from: {lat: number, lon: number}, to: {lat: number, lon: number}}} ends
   * @returns distances[i] in metres from `from` and ground[i] in metres above sea level (the
   *   Earth's curve is not added), first and last being the two ends. Null when either end is
   *   outside the layers.
   */
  async function profile({ from, to }) {
    if (!(await covers(from.lat, from.lon)) || !(await covers(to.lat, to.lon))) return null;
    const before = { ...stats };
    const { metres: D, bearing } = span(from.lat, from.lon, to.lat, to.lon);
    const fine10 = !!layers.detail, nearest = fine10 ? END_NEAREST : NEAREST;
    const ds = [0];
    for (let d = nearest; d <= D - nearest; d += Math.min(d, D - d) < END_REACH ? (fine10 ? 10 : 20) : 50) ds.push(d);
    ds.push(D);
    const distances = Float64Array.from(ds), ground = new Float32Array(ds.length);
    const knots = Math.ceil(D / KNOT) + 1, kx = new Float64Array(knots + 1), ky = new Float64Array(knots + 1);
    for (let k = 0; k <= knots; k++) {
      const p = k === 0 ? from : destination(from.lat, from.lon, bearing, k * KNOT);
      const g = toGrid(p.lat, p.lon);
      kx[k] = g.x; ky[k] = g.y;
    }
    const endB = toGrid(to.lat, to.lon);
    const place = (i) => {
      if (i === ds.length - 1) return [endB.x, endB.y];
      const k = Math.floor(ds[i] / KNOT), t = ds[i] / KNOT - k;
      return [kx[k] * (1 - t) + kx[k + 1] * t, ky[k] * (1 - t) + ky[k + 1] * t];
    };
    // Near the ends (and the ends themselves): the 10 m data where there is any, otherwise the 40 m layer.
    const close = [], far = [];
    for (let i = 0; i < ds.length; i++) (i === 0 || i === ds.length - 1 || Math.min(ds[i], D - ds[i]) < END_REACH ? close : far).push(i);
    for (const [index, layer] of [[close, fine10 ? 'detail' : 'near'], [far, 'fine']]) {
      const xs = new Float64Array(index.length), ys = new Float64Array(index.length);
      index.forEach((i, j) => { [xs[j], ys[j]] = place(i); });
      let heights = layer === 'detail' ? await detail(xs, ys) : await sample(layer, xs, ys);
      if (layer === 'detail' && heights.some(Number.isNaN)) { // holes (open sea): the 40 m layer's answer there
        const spare = await sample('near', xs, ys);
        heights = heights.map((h, j) => (Number.isNaN(h) ? spare[j] : h));
      }
      index.forEach((i, j) => { ground[i] = heights[j]; });
    }
    if (!fine10) { ground[0] = await heightAt(from.lat, from.lon); ground[ds.length - 1] = await heightAt(to.lat, to.lon); }
    return {
      distances, ground, distanceMetres: D, bearingDegrees: bearing,
      bytesFetched: stats.bytes - before.bytes, requests: stats.requests - before.requests,
    };
  }

  // ---- The detail layer: ArcticDEM's 10 m data itself, cell for cell ----
  // Not "highest ground per cell" like the layers above, so it is of no use for a safe horizon. It is
  // for a terrain profile that should match one read from ArcticDEM, at a fraction of the download.
  let detailBits = null;
  const detailTiles = new Map(); // "ty_tx" -> Promise<Uint16Array | 'holes' | null>; null = all sea
  function detailTile(L, ty, tx) {
    const key = `${ty}_${tx}`;
    if (!detailTiles.has(key)) {
      detailTiles.set(key, (async () => {
        if (tx < 0 || ty < 0 || tx >= L.tileCols || ty >= L.tileRows) return 'holes'; // outside the layers
        detailBits ??= Promise.all([load(L.tilesFile), load(L.holesFile)]).then((list) => list.map((b) => new Uint8Array(b)));
        const [bits, holes] = await detailBits, i = ty * L.tileCols + tx;
        if ((holes[i >> 3] >> (i & 7)) & 1) return 'holes';
        if (!((bits[i >> 3] >> (i & 7)) & 1)) return null; // all sea
        const bytes = await gunzip(await load(`detail/${key}.bin.gz`));
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Uint16Array(bytes.length / 2);
        let previous = 0;
        for (let k = 0; k < out.length; k++) {
          const raw = view.getUint16(k * 2, true);
          previous = k % L.cellsPerTile === 0 ? raw : (previous + raw) & 0xffff;
          out[k] = previous;
        }
        return out;
      })());
    }
    return detailTiles.get(key);
  }

  /**
   * Heights from the detail layer at grid positions (EPSG:3413 metres; see toGrid).
   * Each is blended from the four cells around the point, as Sightline blends ArcticDEM's own
   * files. Metres above mean sea level; sea reads 0; a hole in ArcticDEM reads NaN, never 0,
   * and where only some of the four cells are holes the rest are blended.
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>} ys
   * @returns {Promise<Float32Array>}
   */
  async function detail(xs, ys) {
    const L = layers.detail;
    if (!L) throw new Error('These terrain layers have no detail layer');
    const cell = L.cellMetres, per = L.cellsPerTile, n = xs.length;
    const ix = new Int32Array(n), iy = new Int32Array(n), wx = new Float32Array(n), wy = new Float32Array(n);
    const wanted = new Map();
    for (let i = 0; i < n; i++) {
      const fx = (xs[i] - x0) / cell - 0.5, fy = (ys[i] - y0) / cell - 0.5;
      ix[i] = Math.floor(fx); iy[i] = Math.floor(fy); wx[i] = fx - ix[i]; wy[i] = fy - iy[i];
      for (let c = 0; c < 4; c++) {
        const tx = Math.floor((ix[i] + (c & 1)) / per), ty = Math.floor((iy[i] + (c >> 1)) / per), key = ty * 100000 + tx;
        if (!wanted.has(key)) wanted.set(key, detailTile(L, ty, tx));
      }
    }
    const loaded = new Map(await Promise.all([...wanted].map(async ([key, p]) => [key, await p])));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, weights = 0;
      for (let c = 0; c < 4; c++) {
        const cx = ix[i] + (c & 1), cy = iy[i] + (c >> 1), tx = Math.floor(cx / per), ty = Math.floor(cy / per);
        const w = (c & 1 ? wx[i] : 1 - wx[i]) * (c >> 1 ? wy[i] : 1 - wy[i]);
        if (!(w > 0)) continue;
        const data = loaded.get(ty * 100000 + tx);
        if (data === 'holes') continue;
        const raw = data ? data[(cy - ty * per) * per + (cx - tx * per)] : 0; // no tile: sea
        if (raw === L.noData) continue;
        sum += raw * L.heightStepMetres * w; weights += w;
      }
      out[i] = weights > 0 ? sum / weights : NaN;
    }
    return out;
  }

  return { manifest, covers, heightAt, horizon, sight, profile, detail, hasDetail: !!layers.detail, stats };
}

/** The horizon's angle on any bearing, blended between the two nearest directions. */
export function angleAt(result, bearingDeg) {
  const n = result.angles.length, f = ((((bearingDeg % 360) + 360) % 360) / result.stepDegrees);
  const i = Math.floor(f) % n, t = f - Math.floor(f);
  return result.angles[i] * (1 - t) + result.angles[(i + 1) % n] * t;
}
