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

### Can one antenna see another?

```js
const seen = await terrain.sight({
  from: { lat: 64.208, lon: -21.712, antennaMetres: 2 },
  to: { lat: 63.97639, lon: -21.635, antennaMetres: 10 },
});
seen.clearanceMetres;   // least height of the line above the ground; negative = ground above the line
seen.worstAtMetres;     // how far from `from` that is
seen.distanceMetres; seen.bearingDegrees; seen.angleDegrees;   // where the far antenna is
```

`terrain.profile({ from, to })` gives the ground along the same path instead:
`distances` (metres from `from`) and `ground` (metres above sea level, without
the Earth's curve), first and last being the two ends. One path on its own
fetches about 10–85 KB depending on its length (the longest was 256 km); the
same eight sites from one point came to about 180 KB.
Sightline runs its radio link estimate on it for a first look at each station.
Compared with the same estimate on the 10 m data, over 343 paths at 145 MHz:
the margin differed by 0.6 dB in the middle case, 90% of paths were within
−4 to +1 dB, and 338 landed in the same band (good, marginal, unlikely), the
other five in the band next to it.

`sight()` gives `null` when either end is outside the layers. It reads the
40 m layer within 2 km of either end and the 100 m layer elsewhere; the middle
of a long path is tried on the 1 km layer first and read finer only when that
comes near the line. Ground within 100 m of either end is left out. One line
on its own fetches about 10–35 KB; lines from the same spot share tiles, so
eight hilltop sites around Iceland from one point came to about 105 KB.

Read the answer in three bands: 0 m or more is clear; down to −40 m is
marginal (the line may in truth just clear); below that is blocked. Against
the 10 m data, over 343 lines from 43 look-outs to eight hilltop sites: no
blocked line was called clear, no clear line was called blocked, 310 of the
330 blocked lines were called blocked outright and 10 of the 13 clear lines
clear; the rest fell in the marginal band. It is plain geometry: no Fresnel
zone and no bending over ridges, which Sightline's full profile works out.

## The idea

Each cell of a layer holds the **highest ground inside it**, like the maximum
elevation figures on an aeronautical chart. Coarse cells are enough far away,
because the angle to a mountain barely depends on fine detail at a distance;
fine cells are only needed close in.

| Layer | Cell | Height step | Used for | Files | Size |
|---|---|---|---|---|---|
| `near` | 40 m | 2 m | 100 m to 2 km | 7,391 tiles of 4 km | 29 MB |
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
10 m ArcticDEM data, counting terrain from 100 m outward:

| Spot | Average difference | 95% of directions within |
|---|---|---|
| Reykjavík, Öskjuhlíð hill | +0.12° | 0.37° |
| Foot of Esja, Kollafjörður | +0.37° | 1.09° |
| Þingvellir | +0.20° | 0.45° |
| Esja, top plateau | −0.14° | 0.99° |
| Úlfarsfell hilltop | +0.65° | 2.48° |
| Esja, steep south slope | −0.94° | 3.69° |
| Vífilsfell, steep slope | +0.22° | 3.85° |

On gentle ground it is within about a degree and errs high. On hilltops and
steep slopes, 40 m cells are coarse for the nearest few hundred metres, so the
error is a few degrees and can go either way.

Near the horizon a satellite climbs about a degree every 10–20 seconds, so on
gentle ground this is a few seconds of pass time. In a trial with 792 real
satellite passes at each of the first three spots, 95% of rise and set times
through terrain were within 6–13 seconds of the full-data answer. The worst
cases, up to about 100 seconds, are passes that skim along a ridge line, where
any small difference moves the time a lot.

What it does not know:

- **Anything closer than 100 m.** At that range 40 m cells say more about
  which cell you stand in than about the terrain, and on a hilltop or slope
  they put up walls that are not there. So the wall beside you is not counted,
  and on a steep slope the hillside right behind you counts for less than it
  should: on the Esja slope above, the ground 10–100 m away rises 43° but the
  horizon reports 19°.
- The ground height at the spot is good to a couple of metres on gentle
  ground and reads up to about 10 m high on steep slopes.
- Buildings and trees are only partly in the data, and nothing built or grown
  since the survey is.
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
python3 tools/make_sight_reference.py /path/to/the/tifs   # reference lines of sight for the tests
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
