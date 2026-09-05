import { describe, expect, it } from 'vitest';
import { SamplePeakLimiterStream } from '@coderline/alphatab/synth/SamplePeakLimiterStream';

describe('SamplePeakLimiterStream', () => {
    it('preserves every frame and alignment, including streams shorter than lookahead', () => {
        for (const frames of [0, 1, 143, 144, 145, 4096]) {
            for (const chunkFrames of [1, 64, 257, 4096]) {
                const stream = new SamplePeakLimiterStream(48000);
                const input = Float32Array.from({ length: frames * 2 }, (_, i) => Math.sin(i / 5) * 0.3);
                const output: number[] = [];
                for (let pos = 0; pos < input.length; pos += chunkFrames * 2) {
                    output.push(...stream.process(input.slice(pos, pos + chunkFrames * 2), false));
                }
                output.push(...stream.process(new Float32Array(0), true));
                expect(Float32Array.from(output)).toEqual(input);
            }
        }
    });

    it('accepts the final data and drain together and rejects duplicate drains', () => {
        const stream = new SamplePeakLimiterStream(48000);
        const input = new Float32Array(10).fill(0.3);
        expect(stream.process(input, true)).toEqual(input);
        expect(() => stream.process(new Float32Array(0), true)).toThrow();
        stream.reset();
        expect(stream.process(input, true)).toEqual(input);
    });

    it('does not retain audio or gain reduction across a seek/reset', () => {
        const stream = new SamplePeakLimiterStream(48000);
        stream.process(new Float32Array(1000).fill(10), false);
        stream.reset();
        const input = new Float32Array(512).fill(0.25);
        expect(stream.process(input, true)).toEqual(input);
    });
});
