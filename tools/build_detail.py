#!/usr/bin/env python3
"""Builds the detail layer in v1/detail/ from ArcticDEM 10 m mosaics.

Requires:  pip install numpy rasterio pyproj
Run:       python3 tools/build_detail.py /path/to/folder/with/10m/tifs   (after build_layers.py)

Unlike the other layers, this one is not "highest ground per cell": it is the 10 m data itself,
cell for cell on ArcticDEM's own grid, so that a terrain profile read from it matches one read
from ArcticDEM. Sightline uses it for the first draft of a profile.

What it writes (EPSG:3413, row 0 = south):
  v1/detail/<ty>_<tx>.bin.gz   200 x 200 cells of 10 m (a 2 km tile), 16-bit, packed like the other layers
                               value = height above mean sea level, to the nearest metre
                               0 = sea level or below; 65535 = no data in ArcticDEM (a hole)
  v1/detail/tiles.bin          which tiles exist, one bit each, row by row (bit 0 of byte 0 is tile 0_0)
  v1/manifest.json             gains layers.detail

Tiles that are all sea level are not written; a missing tile reads as sea.
Needs about 3 GB of memory and half an hour.
"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_layers as bl

DETAIL = dict(cell=10, tile=200, step=1, bits=16)
NO_DATA = 65535


def main(src):
    out = os.path.join(bl.OUT, 'detail'); os.makedirs(out, exist_ok=True)
    span = DETAIL['cell'] * DETAIL['tile']; per = DETAIL['tile']
    cols, rows = bl.WIDTH // span, bl.HEIGHT // span
    exists = np.zeros(rows * cols, dtype=np.uint8); total = 0; holes = 0; land = 0
    for r in bl.ROWS:
        for c in bl.COLS:
            path = os.path.join(src, f'{r}_{c}_10m_v4.1_dem.tif')
            if not os.path.exists(path): continue
            minx, miny = -4_000_000 + (c - 1) * 100_000, -4_000_000 + (r - 1) * 100_000
            a = bl.read_square(path, minx, miny)
            n = 100_000 // DETAIL['cell']
            gap = np.isnan(a)
            m = a - bl.geoid_grid(minx, miny, n).astype(np.float32); del a
            q = np.clip(np.rint(np.where(gap, 0, m)), 0, NO_DATA - 1).astype(np.uint16); del m
            q[gap] = NO_DATA
            ty0, tx0 = (miny - bl.Y0) // span, (minx - bl.X0) // span
            for i in range(n // per):
                for j in range(n // per):
                    t = q[i * per:(i + 1) * per, j * per:(j + 1) * per]
                    real = t != NO_DATA
                    if not (t[real] > 0).any(): continue          # all sea, or all hole with nothing known: reads as sea
                    data = bl.pack(t, DETAIL['bits']); ty, tx = ty0 + i, tx0 + j
                    with open(os.path.join(out, f'{ty}_{tx}.bin.gz'), 'wb') as fh: fh.write(data)
                    exists[ty * cols + tx] = 1; total += len(data); holes += int((~real).sum()); land += int(real.sum())
            print(f'{r}_{c} done, {total / 1e6:.0f} MB so far', flush=True)
    with open(os.path.join(out, 'tiles.bin'), 'wb') as fh: fh.write(np.packbits(exists, bitorder='little').tobytes())
    mpath = os.path.join(bl.OUT, 'manifest.json'); manifest = json.load(open(mpath))
    manifest['layers']['detail'] = dict(
        cellMetres=DETAIL['cell'], cellsPerTile=per, heightStepMetres=DETAIL['step'], bits=DETAIL['bits'], noData=NO_DATA,
        tileCols=cols, tileRows=rows, tileCount=int(exists.sum()), totalBytes=total, tilesFile='detail/tiles.bin',
        heights='metres above mean sea level to the nearest metre, cell for cell as in the ArcticDEM 10 m mosaic (not the highest ground per cell); 0 = sea level or below; 65535 = no data')
    with open(mpath, 'w') as fh: json.dump(manifest, fh, indent=1)
    print(f'{int(exists.sum())} tiles, {total / 1e6:.0f} MB; holes in written tiles: {holes / max(1, holes + land) * 100:.2f}% of cells')


if __name__ == '__main__':
    main(sys.argv[1])
