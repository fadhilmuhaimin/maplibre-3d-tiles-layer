import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, resolveQuality } from '../src/presets';

describe('resolveQuality', () => {
    it('defaults to balanced', () => {
        expect(resolveQuality()).toEqual(QUALITY_PRESETS.balanced);
    });

    it('returns a copy, so callers cannot mutate the presets', () => {
        const q = resolveQuality('max');
        q.cache.maxBytes = 1;
        expect(QUALITY_PRESETS.max.cache.maxBytes).toBe(4 * 1024 ** 3);
    });

    it('merges partial settings over balanced, including nested cache', () => {
        const q = resolveQuality({ errorTarget: 0, cache: { maxBytes: 1e9 } });
        expect(q.errorTarget).toBe(0);
        expect(q.cache.maxBytes).toBe(1e9);
        expect(q.cache.minTiles).toBe(QUALITY_PRESETS.balanced.cache.minTiles);
        expect(q.downloadJobs).toBe(QUALITY_PRESETS.balanced.downloadJobs);
    });

    it('rejects unknown preset names', () => {
        expect(() => resolveQuality('ultra' as never)).toThrow(/Unknown quality preset/);
    });
});
