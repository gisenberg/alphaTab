import { describe, expect, it, vi } from 'vitest';
import { MetronomeClick } from '@coderline/alphatab/synth/MetronomeClick';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

describe('bank-independent metronome', () => {
    it('uses the same continuous-time strike at different device sample rates', () => {
        for (const accent of [false, true]) {
            const low = MetronomeClick.createSamples(24000, accent);
            const high = MetronomeClick.createSamples(48000, accent);
            let difference = 0;
            let energy = 0;
            for (let i = 0; i < low.length; i++) {
                difference += (low[i] - high[i * 2]) ** 2;
                energy += low[i] ** 2;
            }
            // A new random sequence per device rate would radically change the
            // strike. Only tiny envelope/normalization discretization is allowed.
            expect(difference / energy).toBeLessThan(0.00001);
        }
    });

    it('prepares the two click buffers before synthesis and reuses them on every beat', () => {
        const generate = vi.spyOn(MetronomeClick, 'createSamples');
        try {
            const synth = new TinySoundFont(48000);
            expect(generate).toHaveBeenCalledTimes(2);
            generate.mockClear();
            synth.metronomeVolume = 1;
            for (let beat = 0; beat < 8; beat++) {
                synth.dispatchEvent(SynthEvent.newMetronomeEvent(0, 0, beat % 4, 960, 500));
                synth.synthesize(new Float32Array(256), 0, 128);
            }
            expect(generate).not.toHaveBeenCalled();
        } finally {
            generate.mockRestore();
        }
    });

    it('rejects sample rates that would produce unbounded or aliased buffers', () => {
        for (const rate of [NaN, Infinity, 0, 7999, 192001]) {
            expect(() => MetronomeClick.createSamples(rate, false)).toThrow();
        }
    });

    for (const sampleRate of [22050, 44100, 48000, 96000]) {
        it(`has a bounded, decaying and accented waveform at ${sampleRate} Hz`, () => {
            const regular = MetronomeClick.createSamples(sampleRate, false);
            const accent = MetronomeClick.createSamples(sampleRate, true);
            const energy = (samples: Float32Array) => samples.reduce((sum, x) => sum + x * x, 0);
            expect(regular[0]).toBe(0);
            expect(Math.abs(regular[regular.length - 1])).toBe(0);
            expect(regular.every(x => Number.isFinite(x) && Math.abs(x) < 1)).toBe(true);
            expect(accent.every(x => Number.isFinite(x) && Math.abs(x) < 1)).toBe(true);
            expect(energy(accent)).toBeGreaterThan(energy(regular));
            const half = regular.length >> 1;
            expect(energy(regular.subarray(half))).toBeLessThan(energy(regular.subarray(0, half)));
        });
    }

    it('renders the shared click in stereo without any loaded SoundFont', () => {
        const synth = new TinySoundFont(48000);
        synth.metronomeVolume = 0.5;
        synth.masterVolume = 0.5;
        const expected = MetronomeClick.createSamples(48000, true);
        synth.dispatchEvent(SynthEvent.newMetronomeEvent(0, 0, 0, 960, 500));
        const actual = new Float32Array(expected.length * 2);
        synth.synthesize(actual, 0, expected.length);
        for (let i = 0; i < expected.length; i++) {
            expect(actual[i * 2]).toBeCloseTo(expected[i] * 0.25);
            expect(actual[i * 2 + 1]).toBe(actual[i * 2]);
        }
    });

    it('does not leak clicks after reset, silent seek, or disabling the metronome', () => {
        for (const stop of ['reset', 'resetSoft', 'seek', 'mute'] as const) {
            const synth = new TinySoundFont(48000);
            synth.metronomeVolume = 1;
            synth.dispatchEvent(SynthEvent.newMetronomeEvent(0, 0, 1, 960, 500));
            synth.synthesize(new Float32Array(128), 0, 64);
            if (stop === 'seek') {
                synth.synthesizeSilent(64);
            } else if (stop === 'mute') {
                synth.metronomeVolume = 0;
            } else {
                synth[stop]();
            }
            const after = new Float32Array(128);
            synth.synthesize(after, 0, 64);
            expect(after.every(x => x === 0)).toBe(true);
        }
    });
});
