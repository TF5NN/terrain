#!/usr/bin/env python3
"""Reference heights for the detail layer's test, straight from the ArcticDEM 10 m mosaics.

Requires:  pip install numpy rasterio pyproj
Run:       python3 tools/make_detail_reference.py /path/to/folder/with/10m/tifs
Writes:    test/detail-reference.json

Picks points at random in four squares (coast, lowland, highland, the north) and blends the four
10 m cells around each, the way Sightline reads ArcticDEM. Heights are above mean sea level, not
rounded; below sea level reads 0; a point whose four cells are all holes reads null.
"""
import json, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_layers as bl

SQUARES = [(16, 51), (16, 53), (17, 54), (18, 54)]
PER_SQUARE = 150


def main(src):
    rng = random.Random(11); points = []
    for r, c in SQUARES:
        minx, miny = -4_000_000 + (c - 1) * 100_000, -4_000_000 + (r - 1) * 100_000
        a = bl.read_square(os.path.join(src, f'{r}_{c}_10m_v4.1_dem.tif'), minx, miny)
        for _ in range(PER_SQUARE):
            x, y = minx + rng.uniform(50, 99_950), miny + rng.uniform(50, 99_950)
            fx, fy = (x - minx) / 10 - 0.5, (y - miny) / 10 - 0.5; ix, iy = int(np.floor(fx)), int(np.floor(fy)); tx, ty = fx - ix, fy - iy
            lon, lat = bl.TO_LATLON.transform(x, y); sea = float(bl.sea_level_offset(np.array([lat]), np.array([lon]))[0])
            total = weight = 0.0
            for dy, dx, w in ((0, 0, (1 - tx) * (1 - ty)), (0, 1, tx * (1 - ty)), (1, 0, (1 - tx) * ty), (1, 1, tx * ty)):
                v = a[iy + dy, ix + dx]
                if np.isnan(v) or w <= 0: continue
                total += max(0.0, float(v) - sea) * w; weight += w
            points.append({'x': round(x, 2), 'y': round(y, 2), 'metres': round(total / weight, 2) if weight > 0 else None})
        print(f'{r}_{c}: {sum(1 for p in points[-PER_SQUARE:] if p["metres"] is None)} holes, {sum(1 for p in points[-PER_SQUARE:] if p["metres"] == 0)} at sea level', flush=True)
    about = ('Heights above mean sea level in metres at grid positions (EPSG:3413), blended from the four ArcticDEM v4.1 10 m cells around each; '
             'null where all four are holes. Made by tools/make_detail_reference.py.')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'detail-reference.json'), 'w') as fh:
        json.dump({'about': about, 'points': points}, fh)


if __name__ == '__main__':
    main(sys.argv[1])
