import { describe, expect, it } from 'vitest';
import { AntialiasedSoftClipper, GuitarAmpProcessor } from '@coderline/alphatab/synth/synthesis/GuitarAmpProcessor';

const signal = (frames: number) =>
    Float32Array.from(
        { length: frames * 2 },
        (_, i) => Math.sin((Math.floor(i / 2) * 2 * Math.PI * 220) / 48000) * (i % 2 ? 0.02 : 0.06)
    );

describe('experimental guitar amp processing', () => {
    it('is invariant to buffer partition and resets all stereo state', () => {
        const source = signal(4096);
        const whole = source.slice();
        const split = source.slice();
        const a = new GuitarAmpProcessor(48000);
        const b = new GuitarAmpProcessor(48000);
        a.process(whole, 4096);
        for (let start = 0; start < split.length; start += 74) {
            const block = split.subarray(start, start + 74);
            b.process(block, block.length / 2);
        }
        expect(split).toEqual(whole);
        b.reset();
        b.process(source, 4096);
        expect(source).toEqual(whole);
    });

    it.each([
        8000, 24000, 44100, 48000, 96000, 192000
    ])('bounds output and preserves channel isolation at %s Hz', rate => {
        const amp = new GuitarAmpProcessor(rate, 64, 0.5);
        const samples = Float32Array.from({ length: 4000 }, (_, i) => (i % 2 ? 0 : Math.sin(i) * 100));
        samples[0] = NaN;
        samples[2] = Infinity;
        amp.process(samples, samples.length / 2);
        expect(samples.every(Number.isFinite)).toBe(true);
        expect(samples.every(x => Math.abs(x) <= 0.5)).toBe(true);
        expect(samples.filter((_, i) => i % 2 === 1).every(x => x === 0)).toBe(true);
    });

    it('decays after a note and rejects invalid configuration', () => {
        const amp = new GuitarAmpProcessor(48000);
        const active = signal(2048);
        amp.process(active, 2048);
        const silence = new Float32Array(48000 * 2);
        amp.process(silence, 48000);
        expect(silence.subarray(-100).every(x => Math.abs(x) < 1e-6)).toBe(true);
        expect(() => new GuitarAmpProcessor(NaN)).toThrow();
        expect(() => new GuitarAmpProcessor(48000, 0)).toThrow();
        expect(() => amp.process(active, active.length)).toThrow();
    });

    it('reduces a folded harmonic relative to naive clipping, not just the fundamental level', () => {
        const aa = new AntialiasedSoftClipper();
        const frames = 48000;
        let naiveAliasRe = 0,
            naiveAliasIm = 0,
            aaAliasRe = 0,
            aaAliasIm = 0;
        let naiveFundRe = 0,
            naiveFundIm = 0,
            aaFundRe = 0,
            aaFundIm = 0;
        for (let i = 0; i < frames + 1000; i++) {
            const x = 3 * Math.sin((2 * Math.PI * 7000 * i) / 48000);
            const clipped = Math.abs(x) >= 1 ? Math.sign(x) : 1.5 * x - 0.5 * x ** 3;
            const filtered = aa.process(x);
            if (i < 1000) {
                continue;
            }
            const alias = (2 * Math.PI * 1000 * i) / 48000; // 7th harmonic at 49 kHz folds to 1 kHz.
            const fundamental = (2 * Math.PI * 7000 * i) / 48000;
            naiveAliasRe += clipped * Math.cos(alias);
            naiveAliasIm += clipped * Math.sin(alias);
            aaAliasRe += filtered * Math.cos(alias);
            aaAliasIm += filtered * Math.sin(alias);
            naiveFundRe += clipped * Math.cos(fundamental);
            naiveFundIm += clipped * Math.sin(fundamental);
            aaFundRe += filtered * Math.cos(fundamental);
            aaFundIm += filtered * Math.sin(fundamental);
        }
        const naiveRatio = Math.hypot(naiveAliasRe, naiveAliasIm) / Math.hypot(naiveFundRe, naiveFundIm);
        const aaRatio = Math.hypot(aaAliasRe, aaAliasIm) / Math.hypot(aaFundRe, aaFundIm);
        expect(aaRatio).toBeLessThan(naiveRatio / 2);
    });
});
