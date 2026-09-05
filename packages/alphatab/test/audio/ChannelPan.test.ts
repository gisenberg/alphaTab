import { describe, expect, it } from 'vitest';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { ControllerType } from '@coderline/alphatab/midi/ControllerType';
import { rightPanGain } from '@coderline/alphatab/synth/synthesis/StereoPan';

function createSynth(regionPan = 0): TinySoundFont {
    const region = new Region();
    region.samples = new Float32Array(48001).fill(0.1);
    region.sampleRate = 48000;
    region.end = 48000;
    region.hiKey = region.hiVel = 127;
    region.pitchKeyCenter = 60;
    region.pitchKeyTrack = 0;
    region.ampEnv.sustain = 1;
    region.initialFilterFc = 14000;
    region.pan = regionPan;
    const preset = new Preset();
    preset.regions = [region];
    const synth = new TinySoundFont(48000);
    synth.presets = [preset];
    synth.channelSetPresetIndex(0, 0);
    return synth;
}

function render(synth: TinySoundFont): Float32Array {
    const output = new Float32Array(128);
    synth.synthesize(output, 0, 64);
    return output;
}

describe('channel pan contract', () => {
    it('uses a symmetric constant-power trigonometric curve with exact hard endpoints', () => {
        expect(rightPanGain(-0.5)).toBe(0);
        expect(rightPanGain(0.5)).toBe(1);
        let previous = 0;
        for (let step = 0; step <= 1000; step++) {
            const position = step / 1000 - 0.5;
            const left = rightPanGain(-position);
            const right = rightPanGain(position);
            expect(right).toBeGreaterThanOrEqual(previous);
            expect(left * left + right * right).toBeCloseTo(1, 12);
            previous = right;
        }
        // Quarter-pan amplitude ratio distinguishes the chosen law from square-root panning.
        expect(rightPanGain(-0.25) / rightPanGain(0.25)).toBeCloseTo(Math.SQRT2 - 1, 12);
    });

    it('maps MIDI coarse center and fine increments without shifting center toward the right', () => {
        const synth = createSynth();
        synth.channelMidiControl(0, ControllerType.PanCoarse, 64);
        expect(synth.channelGetPan(0)).toBe(0.5);
        synth.channelNoteOn(0, 60, 1);
        const output = render(synth);
        for (let i = 0; i < output.length; i += 2) {
            expect(output[i]).toBe(output[i + 1]);
        }
        synth.channelMidiControl(0, ControllerType.PanFine, 1);
        expect(synth.channelGetPan(0)).toBe(0.5 + 1 / 16384);
        synth.channelMidiControl(0, ControllerType.PanFine, 0);
        expect(synth.channelGetPan(0)).toBe(0.5);
        synth.channelMidiControl(0, ControllerType.PanCoarse, 0);
        expect(synth.channelGetPan(0)).toBe(0);
        // SoundFont's discrete controller range stops below +1; the public API still reaches hard right.
        synth.channelMidiControl(0, ControllerType.PanCoarse, 127);
        expect(synth.channelGetPan(0)).toBe(127 / 128);
    });

    it('rejects non-finite controls before changing a sounding voice and clamps finite out-of-range values', () => {
        const synth = createSynth();
        synth.channelNoteOn(0, 60, 1);
        render(synth);
        const centered = render(synth);
        for (const pan of [NaN, Infinity, -Infinity]) {
            expect(() => synth.channelSetPan(0, pan)).toThrow(RangeError);
            expect(synth.channelGetPan(0)).toBe(0.5);
            expect(render(synth)).toEqual(centered);
        }
        synth.channelSetPan(0, -2);
        expect(synth.channelGetPan(0)).toBe(0);
        synth.channelSetPan(0, 2);
        expect(synth.channelGetPan(0)).toBe(1);
    });

    it('does not create non-finite audio from skipped or unsupported sample regions', () => {
        const synth = createSynth();
        const unsupported = new Region(synth.presets![0].regions![0]);
        unsupported.samples = new Float32Array(0);
        synth.presets![0].regions!.push(unsupported);
        const reference = createSynth();
        for (const engine of [synth, reference]) { engine.channelNoteOn(0, 60, 1); }
        const actual = render(synth);
        expect(actual.every(Number.isFinite)).toBe(true);
        expect(actual).toEqual(render(reference));
        expect(synth.activeVoiceCount).toBe(reference.activeVoiceCount);
    });

    it('returns the public left-to-right value rather than subtracting the center offset twice', () => {
        const synth = createSynth();
        expect(synth.channelGetPan(0)).toBe(0.5);
        expect(synth.channelGetPan(20)).toBe(0.5);
        for (const pan of [0, 0.1875, 0.5, 0.8125, 1]) {
            synth.channelSetPan(0, pan);
            expect(synth.channelGetPan(0)).toBe(pan);
        }
    });

    it('applies the same pan to sounding notes as notes started after the update', () => {
        for (const regionPan of [-0.2, 0, 0.2]) {
            const sounding = createSynth(regionPan);
            sounding.channelNoteOn(0, 60, 1);
            render(sounding);
            for (const pan of [0, 0.1875, 0.5, 0.8125, 1]) {
                sounding.channelSetPan(0, pan);
                const fresh = createSynth(regionPan);
                fresh.channelSetPan(0, pan);
                fresh.channelNoteOn(0, 60, 1);
                render(fresh);
                const actual = render(sounding);
                const expected = render(fresh);
                expect(actual).toEqual(expected);
                expect(actual.some(value => value !== 0)).toBe(true);
            }
        }
    });

    it('does not pan another channel\'s sounding notes', () => {
        const synth = createSynth();
        synth.channelNoteOn(0, 60, 1);
        render(synth);
        const centered = render(synth);
        synth.channelSetPan(1, 0);
        expect(render(synth)).toEqual(centered);
        expect(synth.channelGetPan(0)).toBe(0.5);
    });
});
