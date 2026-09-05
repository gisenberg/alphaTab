import { describe, expect, it } from 'vitest';
import { OutputLevelMeter } from '@coderline/alphatab/synth/OutputLevelMeter';

describe('post-output level measurement', () => {
    it('retains transient peaks and averages power across both channels and callbacks', () => {
        const meter = new OutputLevelMeter(40);
        expect(meter.push(new Float32Array([1, 0]), new Float32Array(2))).toBeNull();
        const level = meter.push(new Float32Array(2), new Float32Array([0, -0.5]));
        expect(level?.peak).toBe(1);
        expect(level?.rms).toBeCloseTo(Math.sqrt(1.25 / 8));
        expect(meter.push(new Float32Array(4), new Float32Array(4))).toEqual({ peak: 0, rms: 0 });
    });

    it('never reports more than ten times per audio second', () => {
        const meter = new OutputLevelMeter(44100);
        const channel = new Float32Array(128);
        let reports = 0;
        for (let frame = 0; frame + channel.length <= 44100; frame += channel.length) {
            if (meter.push(channel, channel)) {
                reports++;
            }
        }
        expect(reports).toBeGreaterThan(0);
        expect(reports).toBeLessThanOrEqual(10);
    });

    it('drops pre-seek measurements on reset and does not retain caller buffers', () => {
        const meter = new OutputLevelMeter(40);
        const channel = new Float32Array([1, 1]);
        meter.push(channel, channel);
        channel.fill(0);
        expect(meter.push(channel, channel)?.rms).toBeCloseTo(Math.sqrt(0.5));
        meter.push(new Float32Array([1]), new Float32Array([1]));
        meter.reset();
        expect(meter.push(channel, channel)).toBeNull();
        expect(meter.push(channel, channel)).toEqual({ peak: 0, rms: 0 });
    });

    it('rejects invalid sample rates', () => {
        for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => new OutputLevelMeter(rate)).toThrow(RangeError);
        }
    });
});
