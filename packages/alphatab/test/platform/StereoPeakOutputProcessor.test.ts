import { describe, expect, it } from 'vitest';
import { StereoPeakOutputProcessor } from '@coderline/alphatab/platform/javascript/StereoPeakOutputProcessor';
import { SamplePeakLimiter } from '@coderline/alphatab/synth/SamplePeakLimiter';

describe('StereoPeakOutputProcessor', () => {
    it('matches the synthesis limiter sample-for-sample across variable render quanta', () => {
        const reference = new SamplePeakLimiter(48000);
        const processor = new StereoPeakOutputProcessor(48000);
        const left = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.1) * (i < 700 ? 3 : 0.1));
        const right = Float32Array.from(left, value => value * -0.25);
        const expected = new Float32Array(left.length * 2);
        for (let i = 0; i < left.length; i++) {
            expected[i * 2] = left[i];
            expected[i * 2 + 1] = right[i];
        }
        reference.processInterleaved(expected, 0, left.length);
        const actualLeft = new Float32Array(left.length);
        const actualRight = new Float32Array(right.length);
        // Neither quantum size nor stereo imbalance may change gain linking.
        for (let offset = 0; offset < left.length; offset += 193) {
            processor.process(
                [left.subarray(offset, offset + 193), right.subarray(offset, offset + 193)],
                [actualLeft.subarray(offset, offset + 193), actualRight.subarray(offset, offset + 193)]
            );
        }
        for (let i = 0; i < left.length; i++) {
            expect(actualLeft[i]).toBe(expected[i * 2]);
            expect(actualRight[i]).toBe(expected[i * 2 + 1]);
            expect(Math.abs(actualLeft[i])).toBeLessThanOrEqual(1);
        }
        expect(processor.latencyFrames).toBe(reference.latencyFrames);
    });

    it('drains delayed mono audio after input disconnects and resets without a stale tail', () => {
        const processor = new StereoPeakOutputProcessor(48000);
        const impulse = new Float32Array(128);
        impulse[0] = 0.2;
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        processor.process([impulse], [left, right]);
        expect(left.every(value => value === 0)).toBe(true);
        processor.process([], [left, right]);
        expect(left.some(value => value > 0)).toBe(true);
        expect(left).toEqual(right);
        processor.reset();
        processor.process([], [left, right]);
        expect(left.every(value => value === 0)).toBe(true);
        expect(right).toEqual(left);
    });
});
