import { describe, expect, it } from 'vitest';
import { RenderTileCache } from '@coderline/alphatab/platform/javascript/RenderTileCache';

describe('RenderTileCache', () => {
    it('evicts least-recent detached tiles to both hard limits', () => {
        const cache = new RenderTileCache<string>(2, 10);

        expect(cache.set('a', 'A', 4)).toEqual([]);
        expect(cache.set('b', 'B', 4)).toEqual([]);
        expect(cache.take('a')).toBe('A');
        expect(cache.set('a', 'A2', 4)).toEqual([]);
        expect(cache.set('c', 'C', 4)).toEqual(['b']);
        expect(cache.stats).toEqual({ tileCount: 2, elementCount: 8 });

        expect(cache.configure(2, 5)).toEqual(['a']);
        expect(cache.stats).toEqual({ tileCount: 1, elementCount: 4 });
    });

    it('does not retain a single tile larger than the element budget', () => {
        const cache = new RenderTileCache<string>(8, 10);
        expect(cache.set('oversized', 'tile', 11)).toEqual(['oversized']);
        expect(cache.take('oversized')).toBeUndefined();
    });
});
