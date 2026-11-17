#!/usr/bin/env python3
"""Reference lines of sight for the tests, computed straight from the 10 m ArcticDEM data.

Requires:  pip install numpy rasterio pyproj
Run:       python3 tools/make_sight_reference.py /path/to/folder/with/10m/tifs
Writes:    test/sight-reference.json

From a set of look-outs (some chosen, some scattered at random over Iceland) to a set of
hilltop sites, it finds the least height of the straight line between the two antennas above
the ground, sampling every 10 m and leaving out the 100 m at each end, with the same 4/3 Earth
radius as horizon.js. Antennas: 2 m at the look-out, 10 m at the site. Needs about 10 GB of
memory, as paths across the country touch most of the 10 m squares.
"""
import json, math, os, random, sys
import numpy as np
from pyproj import Geod, Transformer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_layers as bl

SITES = {'Skalafell': (64.23889, -21.46472), 'Blafjoll': (63.97639, -21.63500), 'Burfell': (64.07500, -19.82194), 'Vadlaheidi': (65.73028, -18.00722),
         'Strutur': (64.74900, -20.68130), 'Thrandarhlidarfjall': (65.41127, -19.49982), 'Perlan': (64.12900, -21.91870), 'Skeljanes': (64.12550, -21.94967)}
CHOSEN = [(64.1293, -21.9190), (64.2080, -21.7120), (64.2559, -21.1295), (64.1486, -21.7119), (63.9990, -22.5560), (64.3200, -22.0800), (63.9330, -21.0000), (65.6830, -18.1000)]
SCATTERED = 52
NEAREST, FROM_ANTENNA, TO_ANTENNA = 100, 2, 10
T = Transformer.from_crs(4326, 3413, always_xy=True); GEOD = Geod(ellps='WGS84'); KR = 6371008.8 * 4 / 3


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

    def sea_level(lat, lon):
        """Height above mean sea level at points given by latitude and longitude; sea and gaps read 0."""
        x, y = T.transform(lon, lat); h = height(np.asarray(x), np.asarray(y))
        return np.where(np.isnan(h), 0.0, h - bl.sea_level_offset(np.asarray(lat), np.asarray(lon)))

    rng = random.Random(7); lookouts = list(CHOSEN)
    while len(lookouts) < len(CHOSEN) + SCATTERED:       # scattered look-outs must be on land
        lat, lon = rng.uniform(63.4, 66.5), rng.uniform(-24.0, -13.6)
        x, y = T.transform(lon, lat)
        if not np.isnan(height(np.array([x]), np.array([y]))[0]): lookouts.append((round(lat, 5), round(lon, 5)))
    cases = []
    for lat, lon in lookouts:
        for site, (slat, slon) in SITES.items():
            bearing, _, D = GEOD.inv(lon, lat, slon, slat)
            if D < 500: continue
            d = np.arange(NEAREST, D - NEAREST, 10.0)
            lo, la, _ = GEOD.fwd(np.full(d.shape, lon), np.full(d.shape, lat), np.full(d.shape, bearing), d)
            ground = sea_level(np.asarray(la), np.asarray(lo))
            ha = float(sea_level(np.array([lat]), np.array([lon]))[0]) + FROM_ANTENNA; hb = float(sea_level(np.array([slat]), np.array([slon]))[0]) + TO_ANTENNA
            clearance = ha + (hb - ha) * d / D - ground - d * (D - d) / (2 * KR)
            i = int(np.argmin(clearance))
            cases.append({'from': [lat, lon], 'to': [slat, slon], 'site': site, 'distanceMetres': round(D), 'clearanceMetres': round(float(clearance[i]), 1), 'worstAtMetres': round(float(d[i]))})
        print(f'{lat:.4f}, {lon:.4f}: ' + ', '.join(f"{c['site'][:4]} {c['clearanceMetres']:.0f}" for c in cases[-len(SITES):]), flush=True)
    about = ('Least height of the line between two antennas above the ground, in metres, computed from the ArcticDEM v4.1 10 m mosaic every 10 m, '
             'leaving out 100 m at each end, with a 2 m antenna at "from", a 10 m antenna at "to" and 4/3 Earth radius. Made by tools/make_sight_reference.py.')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'sight-reference.json'), 'w') as fh:
        json.dump({'about': about, 'fromAntennaMetres': FROM_ANTENNA, 'toAntennaMetres': TO_ANTENNA, 'cases': cases}, fh)


if __name__ == '__main__':
    main(sys.argv[1])
