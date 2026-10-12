# maplibre-3d-tiles-layer

A headless [MapLibre GL JS](https://maplibre.org/) custom layer that streams
3D Tiles photogrammetry with three.js and
[3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS).

```bash
npm install maplibre-3d-tiles-layer three 3d-tiles-renderer maplibre-gl
# or
bun add maplibre-3d-tiles-layer three 3d-tiles-renderer maplibre-gl
```

Usage, options and how it works: [package README](packages/maplibre-3d-tiles-layer/README.md).

## Repository layout

```
packages/maplibre-3d-tiles-layer   the library (tsup, vitest)
examples/basic                     Vite demo with a progress panel
```

## Develop

```bash
bun install
bun run test        # unit tests (projection math, presets)
bun run typecheck
bun run build       # packages/maplibre-3d-tiles-layer/dist
bun run dev         # demo on http://localhost:5174
```

The demo imports the library source for hot reload. To check the built
package instead: `cd examples/basic && USE_DIST=1 bunx vite build`.

### Demo URL parameters

| Parameter | |
| --- | --- |
| `tileset` | `tileset.json` URL. Default: Cesium's public sample dragon |
| `quality` | `balanced` or `max` |
| `alt` | Initial altitude offset (m) |
| `lng`, `lat` | Anchor. Computed from the tileset bounds when omitted |
| `basemap` | `osm` for OSM raster instead of OpenFreeMap Positron |

Local tilesets go in `examples/basic/public/tiles/` (gitignored), for example
a symlink to a project's data, then open `?tileset=/tiles/tileset.json`.

## License

[MIT](LICENSE)
