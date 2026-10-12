import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// By default the example imports the package source for instant HMR.
// `USE_DIST=1 bun run build` resolves the built package instead, which
// checks the published entry point actually works.
const useDist = process.env.USE_DIST === '1';

export default defineConfig({
    resolve: {
        alias: useDist
            ? {}
            : {
                  'maplibre-3d-tiles-layer': fileURLToPath(
                      new URL('../../packages/maplibre-3d-tiles-layer/src/index.ts', import.meta.url)
                  ),
              },
    },
    // main.ts uses top-level await to read the tileset bounds before creating the map.
    build: { target: 'es2022' },
    server: { port: 5174 },
    // MapLibre 6 ships ESM with a separate worker module; Vite's dependency
    // pre-bundling breaks the worker URL, so serve it as-is.
    optimizeDeps: { exclude: ['maplibre-gl'] },
});
