import { describe, expect, it } from 'vitest';
import { VoiceLowPass } from '@coderline/alphatab/synth/synthesis/VoiceLowPass';

function response(resonance: number, frequency: number): number {
    const filter = new VoiceLowPass();
    filter.setResonance(resonance);
    filter.setup(4000 / 48000);
    let outputEnergy = 0;
    let inputEnergy = 0;
    for (let i = 0; i < 96000; i++) {
        const input = frequency ? Math.sin(2 * Math.PI * frequency * i / 48000) : 1;
        const output = filter.process(input);
        if (i >= 48000) {
            outputEnergy += output * output;
            inputEnergy += input * input;
        }
    }
    return Math.sqrt(outputEnergy / inputEnergy);
}

describe('SoundFont resonant low-pass filter', () => {
    it('has a flat non-resonant passband and a Butterworth cutoff at zero resonance', () => {
        expect(response(0, 0)).toBeCloseTo(1, 8);
        expect(response(0, 4000)).toBeCloseTo(Math.SQRT1_2, 6);
        expect(response(0, 8000)).toBeLessThan(response(0, 4000));
    });

    it('compensates DC gain by half the resonance instead of boosting the whole signal', () => {
        // 200 centibels is 20 dB resonance, requiring 10 dB DC attenuation.
        expect(20 * Math.log10(response(200, 0))).toBeCloseTo(-10, 6);
        expect(response(200, 4000) / response(0, 4000)).toBeCloseTo(Math.sqrt(10), 6);
    });

    it.each([8000, 16000, 24000, 44100, 48000, 96000, 192000])('stays stable under cutoff modulation at %i Hz', sampleRate => {
        const filter = new VoiceLowPass();
        filter.setResonance(960);
        for (const cents of [-12000, 1500, 9000, 13500, 25500]) {
            filter.setCutoff(cents, sampleRate);
            expect(filter.active).toBe(true);
            // Jury conditions for the two feedback poles to remain inside the unit circle.
            expect(Math.abs(filter.b2)).toBeLessThan(1);
            expect(1 + filter.b1 + filter.b2).toBeGreaterThan(0);
            expect(1 - filter.b1 + filter.b2).toBeGreaterThan(0);
            for (let i = 0; i < 4096; i++) {
                expect(Number.isFinite(filter.process(i === 0 ? 1 : 0))).toBe(true);
            }
        }
    });

    it('only bypasses an open filter when it has no resonance', () => {
        const filter = new VoiceLowPass();
        filter.setResonance(0);
        filter.setCutoff(20000, 48000);
        expect(filter.active).toBe(false);
        filter.setResonance(120);
        filter.setCutoff(20000, 48000);
        expect(filter.active).toBe(true);
    });
});
