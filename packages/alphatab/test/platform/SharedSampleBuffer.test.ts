import { describe, expect, it } from 'vitest';
import { SharedSampleBuffer } from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';

describe('SharedSampleBuffer', () => {
    it('preserves interleaved samples across wraparound without copying through messages', () => {
        const writer = SharedSampleBuffer.create(8);
        const reader = SharedSampleBuffer.fromDescriptor(writer.descriptor);

        expect(writer.write(new Float32Array([1, 2, 3, 4, 5, 6])).writtenSamples).toBe(6);
        const first = new Float32Array(4);
        expect(reader.read(first, 0, first.length)).toBe(4);
        expect(Array.from(first)).toEqual([1, 2, 3, 4]);

        expect(writer.write(new Float32Array([7, 8, 9, 10, 11, 12])).writtenSamples).toBe(6);
        const second = new Float32Array(8);
        expect(reader.read(second, 0, second.length)).toBe(8);
        expect(Array.from(second)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
        expect(reader.countSamples).toBe(0);
    });

    it('tracks generation, final buffers, commits, and dropped frames', () => {
        const writer = SharedSampleBuffer.create(4);
        const reader = SharedSampleBuffer.fromDescriptor(writer.descriptor);

        const result = writer.write(new Float32Array([1, 2, 3, 4, 5, 6]), true);
        expect(result).toEqual({ writtenSamples: 4, droppedSamples: 2 });
        expect(reader.writeSequence).toBe(1);
        expect(reader.isFinal).toBe(true);
        expect(reader.takeDroppedFrames()).toBe(1);
        expect(reader.takeDroppedFrames()).toBe(0);

        const generation = reader.generation;
        writer.resetSamples();
        expect(reader.generation).toBe(generation + 1);
        expect(reader.countSamples).toBe(0);
        expect(reader.isFinal).toBe(false);
        expect(reader.writeSequence).toBe(1);
    });
});
