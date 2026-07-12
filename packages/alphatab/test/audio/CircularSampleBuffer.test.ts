import { describe, expect, it } from 'vitest';
import { CircularSampleBuffer } from '@coderline/alphatab/synth/ds/CircularSampleBuffer';

describe('CircularSampleBuffer', () => {
    it('clears positions without reallocating its real-time backing store', () => {
        const buffer = new CircularSampleBuffer(8);
        const originalBackingStore = Reflect.get(buffer, '_buffer') as Float32Array;

        buffer.write(new Float32Array([1, 2, 3, 4]), 0, 4);
        buffer.clear();

        expect(buffer.count).toBe(0);
        expect(Reflect.get(buffer, '_buffer')).toBe(originalBackingStore);

        buffer.write(new Float32Array([5, 6]), 0, 2);
        const read = new Float32Array(2);
        expect(buffer.read(read, 0, 2)).toBe(2);
        expect(Array.from(read)).toEqual([5, 6]);
    });
});
