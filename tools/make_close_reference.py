#!/usr/bin/env python3
"""True horizons for the closeDetail test: the ground close to the viewer from ArcticDEM's 2 m data.

Requires:  pip install numpy rasterio pyproj, and a connection (it reads small windows of the
           2 m mosaics straight from PGC's public storage)
Run:       python3 tools/make_close_reference.py /path/to/folder/with/10m/tifs
Writes:    test/close-reference.json

For each test spot it reads a 1 km window of the 2 m mosaic around it and works out the horizon
every half degree from 4 m out: the 2 m data to 500 m (every 2 m), the 10 m mosaic beyond
(as make_reference.py does), seen from 2 m above the 2 m data's ground, with 4/3 Earth radius.
That is as near to the real skyline as ArcticDEM gives. Buildings, masts and trees in the 2 m
data count as ground.
"""
import json, os, sys
import numpy as np, rasterio
from rasterio.windows import from_bounds
from pyproj import Geod, Transformer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_layers as bl
from make_reference import SPOTS, STEEP

os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'; os.environ['CPL_VSIL_CURL_ALLOWED_EXTENSIONS'] = '.tif'
BASE = 'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1/2m'
T = Transformer.from_crs(4326, 3413, always_xy=True); GEOD = Geod(ellps='WGS84'); KR = 6371008.8 * 4 / 3
AZ = np.arange(0, 360, 0.5); REACH = 520


def window_2m(x, y):
    """The 2 m mosaic for REACH metres around a grid position: (heights, left, top, pixel)."""
    col = int((x + 4_000_000) // 100_000) + 1; row = int((y + 4_000_000) // 100_000) + 1
    minx, miny = -4_000_000 + (col - 1) * 100_000, -4_000_000 + (row - 1) * 100_000
    qx = 2 if x - minx >= 50_000 else 1; qy = 2 if y - miny >= 50_000 else 1
    for q in ([f'{qy}_{qx}'] if qx == qy else [f'{qy}_{qx}', f'{qx}_{qy}']):     # the order of the two quarter numbers is not documented
        with rasterio.open(f'/vsicurl/{BASE}/{row:02d}_{col:02d}/{row:02d}_{col:02d}_{q}_2m_v4.1_dem.tif') as d:
            b = d.bounds
            if not (b.left <= x - REACH and x + REACH <= b.right and b.bottom <= y - REACH and y + REACH <= b.top): continue
            w = from_bounds(x - REACH, y - REACH, x + REACH, y + REACH, d.transform).round_offsets().round_lengths()
            a = d.read(1, window=w); t = d.window_transform(w)
            return np.where(a < -1000, np.nan, a).astype(np.float32), t.c, t.f, t.a
    raise SystemExit(f'No 2 m file holds {x:.0f}, {y:.0f} with {REACH} m to spare')


def main(src):
    squares = {}

    def h10(x, y):
        out = np.full(x.shape, np.nan, dtype=np.float32)
        col = np.floor((x + 4_000_000) / 100_000).astype(int) + 1; row = np.floor((y + 4_000_000) / 100_000).astype(int) + 1
        for r, c in {(int(a), int(b)) for a, b in zip(row.ravel(), col.ravel())}:
            if (r, c) not in squares:
                path = os.path.join(src, f'{r}_{c}_10m_v4.1_dem.tif')
                squares[(r, c)] = bl.read_square(path, -4_000_000 + (c - 1) * 100_000, -4_000_000 + (r - 1) * 100_000) if os.path.exists(path) else None
            a = squares[(r, c)]
            if a is None: continue
            m = (row == r) & (col == c)
            i = np.floor((y[m] - (-4_000_000 + (r - 1) * 100_000)) / 10).astype(int); j = np.floor((x[m] - (-4_000_000 + (c - 1) * 100_000)) / 10).astype(int)
            out[m] = a[i, j]
        return out

    spots = []
    for name, (lat, lon) in SPOTS.items():
        x, y = T.transform(lon, lat); a, left, top, px = window_2m(x, y)

        def h2(gx, gy):
            fx = (gx - left) / px - 0.5; fy = (top - gy) / px - 0.5
            ix = np.clip(np.floor(fx).astype(int), 0, a.shape[1] - 2); iy = np.clip(np.floor(fy).astype(int), 0, a.shape[0] - 2); tx = fx - ix; ty = fy - iy
            return a[iy, ix] * (1 - tx) * (1 - ty) + a[iy, ix + 1] * tx * (1 - ty) + a[iy + 1, ix] * (1 - tx) * ty + a[iy + 1, ix + 1] * tx * ty
        eye = float(h2(np.array([x]), np.array([y]))[0]) + 2

        def ring(dist, heights):
            az = np.repeat(AZ, len(dist)); d = np.tile(dist, len(AZ))
            lo, la, _ = GEOD.fwd(np.full(az.shape, lon), np.full(az.shape, lat), az, d)
            gx, gy = T.transform(lo, la); h = heights(np.asarray(gx), np.asarray(gy)); h = np.where(np.isnan(h), -100.0, h)
            return np.degrees(np.arctan2(h - eye - d ** 2 / (2 * KR), d)).reshape(len(AZ), -1)
        close = np.arange(4, 500, 2.0); near = ring(close, h2)
        far = ring(np.concatenate([np.arange(500, 3000, 10), np.arange(3000, 30000, 30), np.arange(30000, 100001, 100)]), h10).max(axis=1)
        angles = np.maximum(near.max(axis=1), far)
        spots.append({'name': name, 'steep': name in STEEP, 'lat': lat, 'lon': lon, 'angles': [round(float(v), 2) for v in angles],
                      'steepestWithin25': round(float(near[:, close < 25].max()), 1), 'steepestWithin100': round(float(near[:, close < 100].max()), 1)})
        print(f'{name}: highest horizon {angles.max():.1f} degrees; ground within 25 m reaches {spots[-1]["steepestWithin25"]} degrees', flush=True)
    about = ('True horizon angles in degrees every 0.5 degree of true bearing from north: the ArcticDEM v4.1 2 m mosaic from 4 m to 500 m, the 10 m mosaic '
             'from there to 100 km, seen from 2 m above the ground as the 2 m data has it, 4/3 Earth radius. Made by tools/make_close_reference.py.')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'close-reference.json'), 'w') as fh:
        json.dump({'about': about, 'spots': spots}, fh)


if __name__ == '__main__':
    main(sys.argv[1])
