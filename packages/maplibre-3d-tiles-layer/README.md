# maplibre-3d-tiles-layer

A headless [MapLibre GL JS](https://maplibre.org/) custom layer that streams
[3D Tiles](https://www.ogc.org/standard/3dtiles/) with three.js and
[3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS), sharing
MapLibre's WebGL context. It is tuned for drone/photogrammetry tilesets (b3dm,
glTF, Draco) of a single site or district.

```ts
import { Map } from 'maplibre-gl';
import { ThreeDTilesLayer } from 'maplibre-3d-tiles-layer';

const map = new Map({ container: 'map', style, center: [119.4048, -5.1457], zoom: 16, pitch: 55 });

map.on('load', () => {
    map.addLayer(
        new ThreeDTilesLayer({
            id: 'site',
            url: '/tiles/tileset.json',
            origin: { lng: 119.4048, lat: -5.1457 },
            onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
        })
    );
});
```

## Why another 3D Tiles layer?

[MapLibre's example](https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-tiles-using-threejs/)
and [maplibre-gl-3d-tiles](https://github.com/opengeos/maplibre-gl-3d-tiles)
(a control with a UI panel) are good starting points. This layer is headless
and fixes problems that show up with real photogrammetry:

| Problem | What the layer does |
| --- | --- |
| Geometry shimmers or breaks apart at high zoom (Float32 precision) | Splits the transform so large ECEF/Mercator numbers stay on the CPU in Float64 |
| Model stretches upward as you zoom in | Outputs Z in metres; MapLibre's MVP scales it, not us |
| Full detail never loads unless you zoom right in | Separate fixed selection camera decides what to load (see below) |
| Parent and child LODs z-fight while loading | Keeps parents until children are ready and cross-fades them |
| Inside-out tile "skirts" visible from the side | Front faces only, no polygon offset |
| Blurry textures at a pitched view | Max anisotropic filtering |
| Map repaints 60 fps forever | Repaints only while tiles are streaming, then stops |
| Settings leak into other tile renderers on the page | Own cache and queues per layer |

## Install

```bash
npm install maplibre-3d-tiles-layer three 3d-tiles-renderer maplibre-gl
# or
bun add maplibre-3d-tiles-layer three 3d-tiles-renderer maplibre-gl
```

Peer dependencies: `maplibre-gl` 5 or 6, `three` ≥ 0.167, `3d-tiles-renderer` ^0.5.3.
ESM only (as is 3d-tiles-renderer).

> **Vite + MapLibre 6:** add `optimizeDeps: { exclude: ['maplibre-gl'] }`,
> otherwise MapLibre's worker fails to load in dev. This is unrelated to this
> package.

## Options

| Option | Default | |
| --- | --- | --- |
| `id` | — | MapLibre layer id |
| `url` | — | Root `tileset.json` |
| `origin` | — | `{ lng, lat }` inside the tileset; see [Origin](#origin) |
| `altitudeOffset` | `0` | Metres added to height. Raise it if the model is underground |
| `quality` | `'balanced'` | `'balanced'`, `'max'`, or partial settings merged over `balanced` |
| `selectionCamera` | `{ height: 500, fov: 90 }` | See [How tile selection works](#how-tile-selection-works) |
| `material` | `'auto'` | `'auto'`: textured meshes unlit, untextured lit. `'unlit'` / `'original'` force one |
| `fade` | `{ duration: 500, maxFadeOutTiles: 100 }` | LOD cross-fade, `false` to disable |
| `draco` | bundled decoder (three ≥ r185) or Google CDN | `{ decoderPath }` or `false` |
| `ktx2Loader` | — | A `KTX2Loader` with its transcoder path set |
| `meshoptDecoder` | — | `MeshoptDecoder` from `three/addons/libs/meshopt_decoder.module.js` |
| `fetchOptions` | — | Passed to every request, e.g. auth headers |
| `clearDepth` | `true` | Clear depth before drawing so map layers can't hide the tiles |
| `repaintInterval` | `50` | ms between repaints while streaming |
| `onLoadTileset` / `onProgress` / `onError` | — | Callbacks. Errors are `console.warn`ed if no `onError` |
| `debug` | `false` | Log stats every 2 s |

KTX2 and meshopt are opt-in so their decoders are only bundled when you use them:

```ts
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

new ThreeDTilesLayer({
    /* … */
    ktx2Loader: new KTX2Loader().setTranscoderPath('/basis/'),
    meshoptDecoder: MeshoptDecoder,
});
```

## Methods

- `getStats()` → `{ progress, queued, downloading, parsing, loaded, failed, visible, active, refused, cachedTiles, cachedBytes }`
- `setAltitudeOffset(metres)`: move the model without reloading
- `tilesRenderer`: the underlying `TilesRenderer`, for advanced use

Hide and show the layer with `map.setLayoutProperty(id, 'visibility', 'none' | 'visible')`.
`map.removeLayer(id)` disposes everything.

## Quality presets

| | `balanced` (default) | `max` |
| --- | --- | --- |
| `errorTarget` | 0.25 | 0 (always load leaves) |
| `resolutionMultiplier` | 1 | 4 |
| Cache | 0.4 GB | 4 GB |
| Downloads / parsers | 25 / 5 | 50 / 10 |

Measured on a 119 MB drone tileset (497 tiles) at 2048×1536: `balanced` loaded
133 tiles / 327 MB and looked nearly as sharp as `max` (497 tiles / 2.4 GB) at
street zoom. Detail scales with canvas size, so a 1× display loads fewer tiles.

Use `max` only for a single site on desktop: the 4 GB budget can exhaust
memory on phones. With `balanced`, loading stops once the cache is full rather
than using more memory.

## How tile selection works

3d-tiles-renderer chooses detail by how big each tile looks from its camera. If
that camera is the map camera, zooming out drops to coarse tiles, and full
detail only appears when you are very close.

Instead, the layer registers a fixed **selection camera** `height` metres above
`origin`, looking straight down with a `fov`° field of view. What gets loaded
depends on that camera, not on the map view; the map camera is only used to
draw. That matches what you usually want for one site: load it once at good
detail, then pan and zoom freely.

Limits that follow from this:

- Built for site- or district-scale tilesets. Tiles outside the selection
  camera's view (about ±`height` metres around `origin` at the default 90°)
  are culled and not drawn. For a larger area, raise `height`, or wait for a
  view-dependent mode.
- The ECEF→Mercator mapping is a tangent-plane approximation at `origin`,
  accurate to a few km around it.
- Mercator projection only; globe projection is not supported.

## Origin

`origin` must sit inside the tileset. You can read it from the tileset's root
bounding volume:

```ts
import { ecefToLngLat } from 'maplibre-3d-tiles-layer';

const { root } = await (await fetch(url)).json();
const [x, y, z] = root.boundingVolume.box ?? root.boundingVolume.sphere; // apply root.transform if present
const { lng, lat } = ecefToLngLat(x, y, z);
```

`examples/basic/src/main.ts` has a version that handles `transform` and `region`.

## Math helpers

The projection math is exported and has no three.js dependency:
`lngLatToEcef`, `ecefToLngLat`, `enuBasis`, `lngLatToMercator`,
`mercatorUnitsPerMetre`, `ecefToMercatorMatrix`, `splitCameraRelative`.
Matrices are column-major 16-element arrays.

## License

[MIT](LICENSE)
