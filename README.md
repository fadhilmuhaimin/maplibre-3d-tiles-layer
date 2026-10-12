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

## Releasing

Publishing runs in GitHub Actions ([`publish.yml`](.github/workflows/publish.yml))
with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): no
npm token is stored anywhere, and npm attaches provenance to each release.

1. Bump `version` in `packages/maplibre-3d-tiles-layer/package.json` and commit.
2. Tag that commit with the same version and push both:

   ```bash
   git tag v0.1.1
   git push origin main v0.1.1
   ```

The workflow refuses to publish if the tag and `package.json` version differ.
Running it manually from the Actions tab does a dry run without publishing.

## License

[MIT](LICENSE)
