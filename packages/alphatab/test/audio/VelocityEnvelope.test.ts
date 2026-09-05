import { describe, expect, it } from 'vitest';
import { Envelope } from '@coderline/alphatab/synth/synthesis/Envelope';
import { VoiceEnvelope } from '@coderline/alphatab/synth/synthesis/VoiceEnvelope';

describe('bank-authored velocity envelope timing', () => {
    it('combines key scaling and velocity in timecents once without changing the source', () => {
        // Regression: bank decay/release modulators were ignored, making hi-hat dynamics static.
        const source = new Envelope();
        source.decay = -1200;
        source.release = -2400;
        source.keynumToDecay = 100;
        source.velocityToDecay = { offset: 0, slope: 1200 };
        source.velocityToRelease = { offset: -1200, slope: 1200 };
        source.envToSecs(true);
        const before = { ...source };
        const voice = new VoiceEnvelope();
        voice.setup(source, 54, 64, true, 48000);
        expect(voice.parameters!.decay).toBeCloseTo(1);
        expect(voice.parameters!.release).toBeCloseTo(2 ** (-3000 / 1200));
        expect(source).toMatchObject(before);
        voice.setup(source, 60, 32, true, 48000);
        expect(voice.parameters!.decay).toBeLessThan(1);
        expect(source).toMatchObject(before);
    });
    it('retains static envelope conversion and bounds modulated times', () => {
        const source = new Envelope();
        source.decay = -1200;
        source.release = -2400;
        source.envToSecs(true);
        expect(source.decay).toBe(0.5);
        expect(source.release).toBe(0.25);
        const dynamic = new Envelope();
        dynamic.velocityToDecay = { offset: -20000, slope: 0 };
        dynamic.velocityToRelease = { offset: 20000, slope: 0 };
        dynamic.envToSecs(true);
        const voice = new VoiceEnvelope();
        voice.setup(dynamic, 60, 127, true, 48000);
        expect(voice.parameters!.decay).toBe(0);
        expect(voice.parameters!.release).toBeCloseTo(2 ** (8000 / 1200));
    });
    it('applies palm release damping after resolving the bank timing', () => {
        const source = new Envelope();
        source.velocityToRelease = { offset: 0, slope: 1200 };
        source.envToSecs(true);
        const open = new VoiceEnvelope();
        const palm = new VoiceEnvelope();
        open.setup(source, 59, 100, true, 48000);
        palm.setup(source, 59, 100, true, 48000, true);
        expect(palm.parameters!.release).toBeLessThan(open.parameters!.release);
        expect(palm.parameters!.decay).toBe(open.parameters!.decay);
        expect(palm.parameters!.sustain).toBe(open.parameters!.sustain);
    });
});
