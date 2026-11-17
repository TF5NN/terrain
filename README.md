# Terrain layers for Iceland

Small terrain files for the whole of Iceland and one calculation on top of
them: the **horizon** around a point, meaning how many degrees the ground
rises above the level line in every compass direction.

It is shared by [Northbound](https://github.com/TF5NN/sat-track) (will a
satellite pass clear the mountains?) and
[Sightline](https://github.com/TF5NN/sightline). It is published as plain
files at `https://tf5nn.github.io/terrain/`; there is no server.

## Using it

```js
import { openTerrain, angleAt } from 'https://tf5nn.github.io/terrain/v1/horizon.js';

const terrain = await openTerrain('https://tf5nn.github.io/terrain/v1/');
if (await terrain.covers(64.1293, -21.919)) {
  const horizon = await terrain.horizon({ lat: 64.1293, lon: -21.919 });
  angleAt(horizon, 35);        // degrees the ground rises on a bearing of 35°
  horizon.groundMetres;        // ground height above sea level at the point
}
```

- `horizon.angles[i]` is the angle on true bearing `i × horizon.stepDegrees`
  (every half degree by default).
- `antennaMetres` (default 2) is the height of the eye or antenna above ground.
- `covers()` is true on land in Iceland and false everywhere else.
- It runs in browsers and in Node 20 or newer. Tiles are remembered, so a
  second horizon nearby is quick.

One horizon fetches about 25–55 KB in 8–18 small requests and takes well
under a second.

## The idea

Each cell of a layer holds the **highest ground inside it**, like the maximum
elevation figures on an aeronautical chart. Coarse cells are enough far away,
because the angle to a mountain barely depends on fine detail at a distance;
fine cells are only needed close in.

| Layer | Cell | Height step | Used for | Files | Size |
|---|---|---|---|---|---|
| `near` | 40 m | 2 m | out to 2 km | 7,391 tiles of 4 km | 29 MB |
| `fine` | 100 m | 20 m | 2 km to 15 km | 1,279 tiles of 10 km | 2.2 MB |
| `medium` | 1 km | 1 m | 15 km to 100 km | one file | 155 KB |

Because cells hold their highest ground and heights are rounded up, the
horizon reads slightly high. That is deliberate: it is the safe side for
"will I see it?".

Height steps matter in opposite ways near and far. Twenty metres of rounding
is nothing on a ridge 5 km away, but on ground 40 m away it would be a 27°
mistake, so the near layer keeps 2 m steps.

## How good it is

`npm test` compares the calculation with horizons computed straight from the
10 m ArcticDEM data at three spots:

| Spot | Average difference | 95% of directions within |
|---|---|---|
| Reykjavík, Öskjuhlíð hill | +0.12° | 0.37° |
| Foot of Esja, Kollafjörður | +0.37° | 1.09° |
| Þingvellir | +0.20° | 0.45° |

Near the horizon a satellite climbs about a degree every 10–20 seconds, so
this is a few seconds of pass time. In a trial with 792 real satellite passes
per spot, 95% of rise and set times through terrain were within 6–13 seconds
of the full-data answer. The worst cases, up to about 100 seconds, are passes
that skim along a ridge line, where any small difference moves the time a lot.

What it does not know:

- Buildings and trees are only partly in the data, and nothing built or grown
  since the survey is.
- Nothing closer than 40 m, so not the wall you are standing beside.
- Anywhere outside Iceland.

## File format (version 1)

Everything is in `v1/`. A change that would break readers goes in a new
folder, so `v1/` stays as it is.

- `manifest.json` describes the grid and the layers, and holds a bitmap of
  which tiles exist. Tiles that are all sea are not stored.
- The grid is ArcticDEM's own: EPSG:3413, metres, with the origin and size in
  the manifest. Row 0 is the southern edge.
- `near/<row>_<col>.bin.gz` and `fine/<row>_<col>.bin.gz` are 100 × 100 cells.
  `near` is 16-bit little-endian, `fine` is 8-bit. A value times the layer's
  height step is metres above mean sea level; 0 is sea or no data.
- Each row is stored as differences from the value to its left, wrapping,
  then gzipped. `horizon.js` undoes both.

## Rebuilding the layers

Needed only if ArcticDEM publishes a new version.

```sh
pip install numpy rasterio pyproj
# fetch the 10 m mosaics for the squares listed in v1/manifest.json (about 2.9 GB) from
# https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1/10m/<square>/<square>_10m_v4.1_dem.tif
python3 tools/build_layers.py /path/to/the/tifs       # about three minutes
python3 tools/make_reference.py /path/to/the/tifs     # reference horizons for the tests
npm test
```

`tools/geoid.json` is the sea-level table from Sightline (EGM96, every half
degree), used to turn ArcticDEM's ellipsoid heights into heights above sea
level.

## Publishing

In the repository's **Settings → Pages**, choose **Deploy from a branch**,
branch `main`, folder `/ (root)`. The empty `.nojekyll` file tells GitHub to
serve the files as they are.

## Credits and licence

DEMs provided by the Polar Geospatial Center under NSF-OPP awards 1043681,
1559691, 1542736, 1810976, and 2129685.

Porter, Claire, et al., 2023, "ArcticDEM, Version 4.1",
https://doi.org/10.7910/DVN/3VDC4W, Harvard Dataverse, V1.

The code and this arrangement of the data are by Gunnar B. Guðlaugsson
(TF5NN), licensed CC BY 4.0; see [`LICENSE`](LICENSE). The underlying
elevation data keeps PGC's terms.
