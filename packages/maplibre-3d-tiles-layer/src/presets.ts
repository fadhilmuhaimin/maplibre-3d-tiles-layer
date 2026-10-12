export type QualityPreset = 'balanced' | 'max';

export interface QualitySettings {
    /**
     * Screen-space error (px) at which traversal stops refining.
     * `0` refines every non-leaf tile, i.e. always loads leaf detail.
     */
    errorTarget: number;
    /**
     * Multiplier on the canvas size reported to the tile selector. Higher
     * values make tiles look bigger on screen, which pushes refinement deeper.
     */
    resolutionMultiplier: number;
    /** Maximum tile tree depth to traverse. */
    maxDepth: number;
    /** Per-layer LRU cache limits. Loaded tiles are evicted above `maxBytes`/`maxTiles`. */
    cache: {
        minBytes: number;
        maxBytes: number;
        minTiles: number;
        maxTiles: number;
    };
    /** Concurrent tile downloads per server origin. */
    downloadJobs: number;
    /** Concurrent parse/decode jobs (Draco decoding is CPU-heavy). */
    parseJobs: number;
}

/** Partial settings merged over the `balanced` preset. */
export type QualityOverrides = Partial<Omit<QualitySettings, 'cache'>> & {
    cache?: Partial<QualitySettings['cache']>;
};

const GB = 1024 ** 3;

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, Readonly<QualitySettings>>> = {
    /**
     * Library-default budgets (0.4 GB cache, 25 downloads, 5 parsers). Once
     * the cache is full, loading stops instead of growing memory, so it is
     * safe on phones and for larger tilesets.
     *
     * errorTarget was tuned on a 119 MB drone photogrammetry tileset with a
     * 2048×1536 canvas: 0.25 → 133 tiles / 327 MB and looks nearly as sharp
     * as `max` (497 tiles / 2.4 GB) at street zoom; 2 → 15 tiles, visibly blurry.
     */
    balanced: {
        errorTarget: 0.25,
        resolutionMultiplier: 1,
        maxDepth: Infinity,
        cache: { minBytes: 0.3 * GB, maxBytes: 0.4 * GB, minTiles: 6000, maxTiles: 8000 },
        downloadJobs: 25,
        parseJobs: 5,
    },
    /**
     * Loads and keeps every leaf tile, like CesiumJS at maximum quality.
     * Intended for a single photogrammetry site of a few hundred MB on
     * desktop. The 4 GB cache can exhaust memory on phones or with
     * city-scale tilesets.
     */
    max: {
        errorTarget: 0,
        resolutionMultiplier: 4,
        maxDepth: Infinity,
        cache: { minBytes: 3 * GB, maxBytes: 4 * GB, minTiles: 16000, maxTiles: 20000 },
        downloadJobs: 50,
        parseJobs: 10,
    },
};

/**
 * Resolve the `quality` option. A preset name returns that preset; an object
 * is merged over `balanced`, so `{ errorTarget: 0 }` only changes that field.
 */
export function resolveQuality(
    quality: QualityPreset | QualityOverrides = 'balanced'
): QualitySettings {
    if (typeof quality === 'string') {
        const preset = QUALITY_PRESETS[quality];
        if (!preset) throw new Error(`[maplibre-3d-tiles-layer] Unknown quality preset "${quality}"`);
        return { ...preset, cache: { ...preset.cache } };
    }
    const base = QUALITY_PRESETS.balanced;
    return {
        ...base,
        ...quality,
        cache: { ...base.cache, ...quality.cache },
    };
}
