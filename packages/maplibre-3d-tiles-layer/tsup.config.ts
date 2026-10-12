import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    // ESM only: 3d-tiles-renderer itself ships ESM only.
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    external: ['three', /^three\//, '3d-tiles-renderer', /^3d-tiles-renderer\//, 'maplibre-gl'],
});
