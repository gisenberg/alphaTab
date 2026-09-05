import { describe, expect, it } from 'vitest';
import { Envelope } from '@coderline/alphatab/synth/synthesis/Envelope';
import { VoiceEnvelope, VoiceEnvelopeSegment } from '@coderline/alphatab/synth/synthesis/VoiceEnvelope';

describe('SoundFont voice envelope', () => {
    it('keeps palm-muted notes present until the sequencer note-off, then damps the release', () => {
        // Regression: the sequencer already shortens palm-muted notes. A second
        // decay erased their body before note-off and buried them in the mix.
        const source = new Envelope();
        source.hold = 2;
        source.decay = 30;
        source.sustain = 0.008;
        source.release = 0.4;
        const open = new VoiceEnvelope();
        const muted = new VoiceEnvelope();
        open.setup(source, 59, 100, true, 48000);
        muted.setup(source, 59, 100, true, 48000, true);
        for (let i = 0; i < 3840; i++) {
            open.process(1, 48000);
            muted.process(1, 48000);
            expect(muted.level).toBe(open.level);
        }
        open.nextSegment(VoiceEnvelopeSegment.Sustain, 48000);
        muted.nextSegment(VoiceEnvelopeSegment.Sustain, 48000);
        for (let i = 0; i < 2400; i++) {
            open.process(1, 48000);
            muted.process(1, 48000);
        }
        expect(muted.level).toBe(0);
        expect(open.level).toBeGreaterThan(0);
        expect(source.release).toBe(0.4);
    });

    it.each([1, 0.008])('preserves a pitched palm-mute body with bank sustain %s', sustain => {
        // Regression: treating a short damping time as the SF2 full-range decay
        // drove the voice to its sustain floor after only a few pitch periods.
        const parameters = new Envelope();
        parameters.decay = 10;
        parameters.sustain = sustain;
        parameters.release = 0.3;
        const envelope = new VoiceEnvelope();
        const key = 59; // B3 in Twilight Tavern's opening palm-muted lead.
        const frequency = 440 * 2 ** ((key - 69) / 12);
        envelope.setup(parameters, key, 100, true, 48000, true);
        for (let frame = 0; frame < Math.round(8 / frequency * 48000); frame++) {
            envelope.process(1, 48000);
        }
        expect([VoiceEnvelopeSegment.Decay, VoiceEnvelopeSegment.Sustain]).toContain(envelope.segment);
        expect(envelope.level).toBeGreaterThan(0.25);
        expect(envelope.level).toBeLessThanOrEqual(1);
        expect(parameters.sustain).toBe(sustain);
    });

    it('advances a falling modulation envelope during decay and release', () => {
        const parameters = new Envelope();
        parameters.decay = 1;
        parameters.sustain = 0.25;
        parameters.release = 1;
        const envelope = new VoiceEnvelope();
        envelope.setup(parameters, 60, 100, false, 48000);
        expect(envelope.segment).toBe(VoiceEnvelopeSegment.Decay);
        // Regression: a positive-only slope check froze modulation decay at its peak.
        envelope.process(12000, 48000);
        expect(envelope.level).toBeCloseTo(0.75);
        envelope.process(24000, 48000);
        expect(envelope.segment).toBe(VoiceEnvelopeSegment.Sustain);
        expect(envelope.level).toBeCloseTo(0.25);
        envelope.nextSegment(VoiceEnvelopeSegment.Sustain, 48000);
        envelope.process(24000, 48000);
        expect(envelope.level).toBeCloseTo(0.125);
        envelope.process(24000, 48000);
        expect(envelope.segment).toBe(VoiceEnvelopeSegment.Done);
        expect(envelope.level).toBe(0);
    });

    it.each([false, true])('resolves signed key-scaled times without modifying shared parameters (amplitude=%s)', amplitude => {
        const parameters = new Envelope();
        parameters.hold = -1200;
        parameters.decay = -1200;
        parameters.keynumToHold = -100;
        parameters.keynumToDecay = -100;
        parameters.sustain = 0;
        parameters.envToSecs(amplitude);
        const original = { ...parameters };
        const low = new VoiceEnvelope();
        const high = new VoiceEnvelope();
        low.setup(parameters, 48, 100, amplitude, 48000);
        high.setup(parameters, 72, 100, amplitude, 48000);
        // +/- 12 keys at -100 timecents per key shift one octave of duration.
        expect(low.parameters!.hold).toBeCloseTo(0.25);
        expect(high.parameters!.hold).toBeCloseTo(1);
        expect(low.parameters!.decay).toBeCloseTo(0.25);
        expect(high.parameters!.decay).toBeCloseTo(1);
        expect(parameters).toEqual(original);
    });

    it('preserves exponential amplitude decay', () => {
        const parameters = new Envelope();
        parameters.decay = 1;
        parameters.sustain = 0.1;
        const envelope = new VoiceEnvelope();
        envelope.setup(parameters, 60, 100, true, 48000);
        envelope.process(64, 48000);
        expect(envelope.level).toBeGreaterThan(parameters.sustain);
        expect(envelope.level).toBeLessThan(1);
        const previous = envelope.level;
        envelope.process(64, 48000);
        expect(envelope.level).toBeLessThan(previous);
    });
});
