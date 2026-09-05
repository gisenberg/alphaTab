import { describe, expect, it } from 'vitest';
import { SamplePeakLimiter } from '@coderline/alphatab/synth/SamplePeakLimiter';

describe('SamplePeakLimiter', () => {
    it('leaves below-ceiling audio unchanged apart from its declared latency', () => {
        const limiter = new SamplePeakLimiter(48000);
        const input = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 17) * 0.4);
        const buffer = new Float32Array(input.length + limiter.latencyFrames * 2);
        buffer.set(input);
        limiter.processInterleaved(buffer, 0, buffer.length / 2);
        expect(buffer.subarray(0, limiter.latencyFrames * 2).every(x => x === 0)).toBe(true);
        expect(buffer.subarray(limiter.latencyFrames * 2)).toEqual(input);
    });

    it('contains isolated and sustained overloads while preserving stereo ratios', () => {
        for (const rate of [22050, 44100, 48000, 96000]) {
            const limiter = new SamplePeakLimiter(rate);
            const frames = rate / 2;
            const buffer = new Float32Array((frames + limiter.latencyFrames) * 2);
            for (let i = 0; i < frames; i++) {
                const sample = i % 997 === 0 ? 20 : Math.sin(i / 7) * 2;
                buffer[i * 2] = sample;
                buffer[i * 2 + 1] = -sample / 4;
            }
            limiter.processInterleaved(buffer, 0, buffer.length / 2);
            expect(buffer.every(x => Number.isFinite(x) && Math.abs(x) <= 0.950001)).toBe(true);
            for (let i = 0; i < buffer.length; i += 2) {
                expect(buffer[i + 1]).toBeCloseTo(-buffer[i] / 4);
            }
        }
    });

    it('is independent of chunk size and supports offsets', () => {
        const whole = new SamplePeakLimiter(48000);
        const chunked = new SamplePeakLimiter(48000);
        const a = Float32Array.from({ length: 12340 }, (_, i) => Math.sin(i / 9) * (i % 97));
        const b = a.slice();
        whole.processInterleaved(a, 0, a.length / 2);
        for (let offset = 0; offset < b.length; offset += 74) {
            chunked.processInterleaved(b, offset, Math.min(74, b.length - offset) / 2);
        }
        expect(b).toEqual(a);
    });

    it('resets buffered audio and recovers from invalid input without poisoning later frames', () => {
        const limiter = new SamplePeakLimiter(48000);
        const input = new Float32Array(1000).fill(4);
        input[4] = Number.NaN;
        input[7] = Infinity;
        limiter.processInterleaved(input, 0, input.length / 2);
        expect(input.every(Number.isFinite)).toBe(true);
        limiter.reset();
        const silence = new Float32Array(1000);
        limiter.processInterleaved(silence, 0, silence.length / 2);
        expect(silence.every(x => x === 0)).toBe(true);
    });

    it('ramps attenuation before a transient and recovers instead of permanently lowering gain', () => {
        const rate = 48000;
        const limiter = new SamplePeakLimiter(rate);
        const transient = 1000;
        const buffer = new Float32Array(rate * 2).fill(0.2);
        buffer[transient * 2] = 4;
        buffer[transient * 2 + 1] = -4;
        limiter.processInterleaved(buffer, 0, buffer.length / 2);
        // The otherwise constant bed must fade down before the delayed transient,
        // not jump abruptly at the strike as an instantaneous limiter would.
        const before = buffer[transient * 2];
        const halfway = buffer[(transient + Math.floor(limiter.latencyFrames / 2)) * 2];
        const nearStrike = buffer[(transient + limiter.latencyFrames - 1) * 2];
        expect(before).toBeGreaterThan(halfway);
        expect(halfway).toBeGreaterThan(nearStrike);
        expect(nearStrike).toBeGreaterThan(0);
        expect(buffer[buffer.length - 1]).toBeGreaterThan(before * 0.99);
    });

    it('bounds arbitrary stereo signals at the supported rate and lookahead extremes', () => {
        let seed = 17;
        for (const rate of [8000, 192000]) {
            for (const lookahead of [0, 20]) {
                const limiter = new SamplePeakLimiter(rate, lookahead, 0.8);
                const buffer = Float32Array.from({ length: 30000 }, () => {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    return (seed / 0x100000000 - 0.5) * 100;
                });
                limiter.processInterleaved(buffer, 0, buffer.length / 2);
                expect(buffer.every(value => Math.abs(value) <= 0.800001)).toBe(true);
            }
        }
    });

    it('rejects configurations that cannot produce a bounded delay and gain', () => {
        for (const rate of [NaN, Infinity, 0, 7999, 192001]) {
            expect(() => new SamplePeakLimiter(rate)).toThrow();
        }
        for (const lookahead of [NaN, Infinity, -1, 21]) {
            expect(() => new SamplePeakLimiter(48000, lookahead)).toThrow();
        }
        for (const ceiling of [NaN, Infinity, 0, -1, 1.01]) {
            expect(() => new SamplePeakLimiter(48000, 3, ceiling)).toThrow();
        }
    });
});
