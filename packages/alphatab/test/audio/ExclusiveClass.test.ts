import { describe, expect, it } from 'vitest';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';

function createSynth(group: number, layers: number = 2) {
    const preset = new Preset();
    preset.bank = 128;
    preset.regions = Array.from({ length: layers }, (_, index) => {
        const region = new Region();
        region.samples = new Float32Array(24001).fill(0.1);
        region.sampleRate = 48000;
        region.end = region.samples.length - 1;
        region.hiKey = 127;
        region.hiVel = 127;
        region.pitchKeyCenter = 60;
        region.pitchKeyTrack = 0;
        region.ampEnv.sustain = 1;
        region.ampEnv.release = 0.3;
        region.initialFilterFc = 14000;
        region.group = group;
        region.pan = index === 0 ? -0.5 : 0.5;
        return region;
    });
    const synth = new TinySoundFont(48000);
    synth.presets = [preset];
    synth.channelSetPresetIndex(0, 0);
    synth.channelSetPresetIndex(1, 0);
    return synth;
}

function render(synth: TinySoundFont) {
    const pcm = new Float32Array(8192);
    synth.synthesize(pcm, 0, pcm.length / 2);
    return pcm;
}

describe('SoundFont exclusive-class choke groups', () => {
    it('does not let stereo layers from one note choke each other', () => {
        // Previously the second region ended the first region before it could sound fully.
        const grouped = createSynth(1);
        const ungrouped = createSynth(0);
        grouped.channelNoteOn(0, 60, 1);
        ungrouped.channelNoteOn(0, 60, 1);
        expect(render(grouped)).toEqual(render(ungrouped));
    });

    it('keeps matching presets on different channels independent', () => {
        const grouped = createSynth(1, 1);
        const ungrouped = createSynth(0, 1);
        for (const synth of [grouped, ungrouped]) {
            synth.channelNoteOn(0, 60, 1);
            render(synth);
            synth.channelNoteOn(1, 62, 1);
        }
        expect(render(grouped)).toEqual(render(ungrouped));
    });

    it('still chokes all layers of an earlier note on the same channel', () => {
        const synth = createSynth(1);
        synth.channelNoteOn(0, 60, 1);
        render(synth);
        synth.channelNoteOn(0, 62, 1);
        const actual = render(synth);
        const fresh = createSynth(1);
        fresh.channelNoteOn(0, 62, 1);
        const expected = render(fresh);
        expect(actual.subarray(-512)).toEqual(expected.subarray(-512));
        expect(expected[expected.length - 2]).toBeGreaterThan(0);
        expect(expected[expected.length - 1]).toBeGreaterThan(0);
    });
});
