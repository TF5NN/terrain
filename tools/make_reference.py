#!/usr/bin/env python3
"""Reference horizons for the tests, computed straight from the 10 m ArcticDEM data.

Requires:  pip install numpy rasterio pyproj
Run:       python3 tools/make_reference.py /path/to/folder/with/10m/tifs
Writes:    test/reference.json

It walks every half degree of true bearing from 100 m out to 100 km (10 m steps to 3 km,
30 m to 30 km, 100 m beyond), with the same 2 m antenna and 4/3 Earth radius
as horizon.js. Needs several gigabytes of memory, as it holds the 10 m squares
around each spot.
"""
import json, math, os, sys
import numpy as np
from pyproj import Geod, Transformer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_layers as bl

SPOTS = {  # gentle ground first, then hilltops and steep slopes, where the layers have the hardest time
    'Reykjavik, Oskjuhlid hill': (64.1293, -21.9190), 'Foot of Esja, Kollafjordur': (64.2080, -21.7120), 'Thingvellir': (64.2559, -21.1295),
    'Esja, steep south slope': (64.2413, -21.6251), 'Esja, top plateau': (64.2470, -21.6280), 'Ulfarsfell hilltop': (64.1486, -21.7119), 'Vifilsfell, steep slope': (64.0380, -21.5560)}
STEEP = {'Esja, steep south slope', 'Esja, top plateau', 'Ulfarsfell hilltop', 'Vifilsfell, steep slope'}
NEAREST = 100   # ground closer than this is left out, as in horizon.js
T = Transformer.from_crs(4326, 3413, always_xy=True); GEOD = Geod(ellps='WGS84'); KR = 6371008.8 * 4 / 3
AZ = np.arange(0, 360, 0.5)
DIST = np.concatenate([np.arange(NEAREST, 3000, 10), np.arange(3000, 30000, 30), np.arange(30000, 100001, 100)])


def main(src):
    squares = {}

    def height(x, y):
        """Ellipsoid height at grid points; NaN where there is no data."""
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

    result = {'about': 'Horizon angles in degrees every 0.5 degree of true bearing from north, computed from the ArcticDEM v4.1 10 m mosaic '
                       'from 100 m outward, with a 2 m antenna, 4/3 Earth radius and 100 km range. Made by tools/make_reference.py.', 'spots': []}
    for name, (lat, lon) in SPOTS.items():
        x, y = T.transform(lon, lat); ground = float(height(np.array([x]), np.array([y]))[0])
        az = np.repeat(AZ, len(DIST)); d = np.tile(DIST, len(AZ))
        lo, la, _ = GEOD.fwd(np.full(az.shape, lon), np.full(az.shape, lat), az, d)
        px, py = T.transform(lo, la); h = height(px, py); h = np.where(np.isnan(h), -100.0, h)
        ang = np.degrees(np.arctan2(h - (ground + 2) - d ** 2 / (2 * KR), d)).reshape(len(AZ), -1).max(axis=1)
        asl = ground - float(bl.sea_level_offset(np.array([lat]), np.array([lon]))[0])
        result['spots'].append({'name': name, 'steep': name in STEEP, 'lat': lat, 'lon': lon, 'groundMetres': round(asl, 1), 'angles': [round(float(v), 2) for v in ang]})
        print(f'{name}: ground {asl:.1f} m above sea level, highest horizon {ang.max():.1f} degrees')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'reference.json'), 'w') as fh:
        json.dump(result, fh)


if __name__ == '__main__':
    main(sys.argv[1])
