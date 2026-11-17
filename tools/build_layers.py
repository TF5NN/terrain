#!/usr/bin/env python3
"""Builds the terrain layers in v1/ from ArcticDEM 10 m mosaics.

Requires:  pip install numpy rasterio pyproj
Run:       python3 tools/build_layers.py /path/to/folder/with/10m/tifs

The folder holds the ArcticDEM v4.1 10 m mosaic files for Iceland, named as PGC
names them (for example 14_52_10m_v4.1_dem.tif). Squares that are missing are
treated as sea. See README.md for how to fetch them.

What it writes (all on the ArcticDEM map grid, EPSG:3413, row 0 = south):

  v1/near/<row>_<col>.bin.gz   40 m cells, 100 x 100 per tile (4 km), 16-bit,
                               value = highest ground in the cell / 2 m, rounded up
  v1/fine/<row>_<col>.bin.gz   100 m cells, 100 x 100 per tile (10 km), 8-bit,
                               value = highest ground in the cell / 20 m, rounded up
  v1/medium.bin.gz             1 km cells for the whole region, 16-bit, metres, rounded up
  v1/manifest.json             the grid, the layers and which tiles exist

Heights are above mean sea level. 0 means sea or no data; tiles that are all
sea are not written. Each tile row is stored as differences from the value to
its left (wrapping), which compresses much better; horizon.js undoes that.
"""
import base64, gzip, json, math, os, sys
import numpy as np, rasterio
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'v1')
ROWS, COLS = range(14, 19), range(50, 56)            # ArcticDEM 100 km squares covering Iceland
X0 = -4_000_000 + (COLS[0] - 1) * 100_000
Y0 = -4_000_000 + (ROWS[0] - 1) * 100_000
WIDTH, HEIGHT = len(COLS) * 100_000, len(ROWS) * 100_000
NEAR = dict(cell=40, tile=100, step=2, bits=16)
FINE = dict(cell=100, tile=100, step=20, bits=8)
MEDIUM = dict(cell=1000, bits=16)
SEA_LEVEL_M = 1.0                                     # at or below this counts as sea

GEOID = json.load(open(os.path.join(HERE, 'geoid.json')))
TO_LATLON = Transformer.from_crs(3413, 4326, always_xy=True)


def sea_level_offset(lat, lon):
    """Mean sea level above the ellipsoid (EGM96 table shared with Sightline), in metres."""
    g = GEOID; d = np.asarray(g['decimetres'], dtype=np.float64).reshape(g['rows'], g['cols']) / 10
    fr = np.clip((lat - g['south']) / g['step'], 0, g['rows'] - 1.001); fc = np.clip((lon - g['west']) / g['step'], 0, g['cols'] - 1.001)
    r = np.floor(fr).astype(int); c = np.floor(fc).astype(int); tr = fr - r; tc = fc - c
    return d[r, c]*(1-tr)*(1-tc) + d[r, c+1]*(1-tr)*tc + d[r+1, c]*tr*(1-tc) + d[r+1, c+1]*tr*tc


def geoid_grid(minx, miny, n):
    """Sea-level offset for an n x n grid of cell centres over one 100 km square (row 0 = south)."""
    k = 21; xs = np.linspace(minx, minx + 100_000, k); ys = np.linspace(miny, miny + 100_000, k)
    gx, gy = np.meshgrid(xs, ys); lon, lat = TO_LATLON.transform(gx, gy); coarse = sea_level_offset(lat, lon)
    f = (np.arange(n) + 0.5) / n * (k - 1); i = np.clip(np.floor(f).astype(int), 0, k - 2); t = f - i
    rows = coarse[i, :] * (1 - t)[:, None] + coarse[i + 1, :] * t[:, None]
    return rows[:, i] * (1 - t)[None, :] + rows[:, i + 1] * t[None, :]


def read_square(path, minx, miny):
    """One 100 km square as a 10000 x 10000 array of ellipsoid heights, row 0 = south, NaN = no data."""
    with rasterio.open(path) as d:
        a = d.read(1); t = d.transform
    assert abs(t.a - 10) < 1e-6 and d.crs.to_epsg() == 3413, path
    a = np.where(a < -1000, np.nan, a)
    full = np.full((10000, 10000), np.nan, dtype=np.float32)      # files can be cropped to where there is data
    c0 = round((t.c - minx) / 10); r0 = round(((miny + 100_000) - t.f) / 10)
    sr, sc, dr, dc = max(0, -r0), max(0, -c0), max(0, r0), max(0, c0)
    h = min(a.shape[0] - sr, 10000 - dr); w = min(a.shape[1] - sc, 10000 - dc)
    full[dr:dr + h, dc:dc + w] = a[sr:sr + h, sc:sc + w]
    return full[::-1]


def block_max(a, f):
    n = a.shape[0] // f
    with np.errstate(all='ignore'):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            return np.nanmax(a.reshape(n, f, n, f), axis=(1, 3))


def pack(values, bits):
    """Row-wise differences (wrapping), little-endian, gzip."""
    dt = np.uint8 if bits == 8 else np.dtype('<u2')
    q = values.astype(dt); d = q.copy(); d[:, 1:] = q[:, 1:] - q[:, :-1]
    return gzip.compress(d.tobytes(), compresslevel=9, mtime=0)


def main(src):
    os.makedirs(os.path.join(OUT, 'near'), exist_ok=True); os.makedirs(os.path.join(OUT, 'fine'), exist_ok=True)
    medium = np.zeros((HEIGHT // 1000, WIDTH // 1000), dtype=np.float32)
    exists = {'near': set(), 'fine': set()}; total = {'near': 0, 'fine': 0}; used = []
    for r in ROWS:
        for c in COLS:
            path = os.path.join(src, f'{r}_{c}_10m_v4.1_dem.tif')
            if not os.path.exists(path): continue
            minx, miny = -4_000_000 + (c - 1) * 100_000, -4_000_000 + (r - 1) * 100_000
            a = read_square(path, minx, miny); used.append(f'{r}_{c}')
            for name, L in (('near', NEAR), ('fine', FINE)):
                n = 100_000 // L['cell']; m = block_max(a, L['cell'] // 10) - geoid_grid(minx, miny, n)
                m = np.where(np.isnan(m) | (m <= SEA_LEVEL_M), 0, m)
                q = np.clip(np.ceil(m / L['step']), 0, 2 ** L['bits'] - 1)
                if name == 'fine':
                    asl = block_max(a, 10) - geoid_grid(minx, miny, 1000); asl = np.where(np.isnan(asl) | (asl <= SEA_LEVEL_M), 0, asl)
                    iy, ix = (miny - Y0) // 1000, (minx - X0) // 1000
                    medium[iy:iy + 100, ix:ix + 100] = asl.reshape(100, 10, 100, 10).max(axis=(1, 3))
                per = L['tile']; ty0 = (miny - Y0) // (L['cell'] * per); tx0 = (minx - X0) // (L['cell'] * per)
                for i in range(n // per):
                    for j in range(n // per):
                        t = q[i * per:(i + 1) * per, j * per:(j + 1) * per]
                        if not t.any(): continue
                        data = pack(t, L['bits']); ty, tx = ty0 + i, tx0 + j
                        with open(os.path.join(OUT, name, f'{ty}_{tx}.bin.gz'), 'wb') as fh: fh.write(data)
                        exists[name].add((ty, tx)); total[name] += len(data)
            print(f'{r}_{c} done', flush=True)
    med = pack(np.clip(np.ceil(medium), 0, 65535), 16)
    with open(os.path.join(OUT, 'medium.bin.gz'), 'wb') as fh: fh.write(med)

    def bitmap(name, L):
        cols = WIDTH // (L['cell'] * L['tile']); rows = HEIGHT // (L['cell'] * L['tile'])
        bits = np.zeros(rows * cols, dtype=np.uint8)
        for ty, tx in exists[name]: bits[ty * cols + tx] = 1
        return cols, rows, base64.b64encode(np.packbits(bits, bitorder='little').tobytes()).decode()
    layers = {}
    for name, L in (('near', NEAR), ('fine', FINE)):
        cols, rows, bm = bitmap(name, L)
        layers[name] = dict(cellMetres=L['cell'], cellsPerTile=L['tile'], heightStepMetres=L['step'], bits=L['bits'], tileCols=cols, tileRows=rows,
                            tileCount=len(exists[name]), totalBytes=total[name], tiles=bm)
    layers['medium'] = dict(cellMetres=1000, heightStepMetres=1, bits=16, cols=WIDTH // 1000, rows=HEIGHT // 1000, file='medium.bin.gz', totalBytes=len(med))
    manifest = dict(format=1, grid='EPSG:3413', x0=X0, y0=Y0, widthMetres=WIDTH, heightMetres=HEIGHT, rowOrder='south to north',
                    heights='metres above mean sea level (EGM96); 0 = sea or no data; each value is the highest ground in its cell, rounded up',
                    encoding='gzip of row-wise differences (wrapping), little-endian',
                    source='ArcticDEM v4.1 10 m mosaic, Polar Geospatial Center', squares=used, layers=layers)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh: json.dump(manifest, fh, indent=1)
    print(json.dumps({k: (v['tileCount'] if 'tileCount' in v else 1, round(v['totalBytes'] / 1e6, 2)) for k, v in layers.items()}))


if __name__ == '__main__':
    main(sys.argv[1])
