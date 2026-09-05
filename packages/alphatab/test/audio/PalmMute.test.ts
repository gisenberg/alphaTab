import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiEventType, NoteOnEvent } from '@coderline/alphatab/midi/MidiEvent';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';

function createSynth(program: number = 30, bank: number = 0) {
    const region = new Region();
    region.samples = Float32Array.from({ length: 24001 }, (_, i) =>
        0.3 * Math.sin(2 * Math.PI * 300 * i / 48000) + 0.3 * Math.sin(2 * Math.PI * 6000 * i / 48000));
    region.sampleRate = 48000;
    region.end = region.samples.length - 1;
    region.hiKey = 127;
    region.hiVel = 127;
    region.pitchKeyCenter = 60;
    region.pitchKeyTrack = 100;
    region.initialFilterFc = 13500;
    region.ampEnv.attack = 0.001;
    region.ampEnv.sustain = 1;
    region.ampEnv.release = 0.3;
    const preset = new Preset();
    preset.presetNumber = program;
    preset.bank = bank;
    preset.regions = [region];
    const synth = new TinySoundFont(48000);
    synth.presets = [preset];
    synth.channelSetPresetIndex(0, 0);
    return { synth, region };
}

function render(synth: TinySoundFont, frames: number = 7680) {
    const samples = new Float32Array(frames * 2);
    synth.synthesize(samples, 0, frames);
    return samples;
}

function energy(samples: Float32Array) {
    return samples.reduce((sum, value) => sum + value * value, 0);
}

describe('per-note palm mute', () => {
    it('carries the marking through generation and the worker JSON boundary', () => {
        const score = ScoreLoader.loadAlphaTex(':8 0.6 2.6');
        score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isPalmMute = true;
        const midi = new MidiFile();
        new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
        const events = midi.tracks.flatMap(track => track.events).filter(event => event.type === MidiEventType.NoteOn);
        expect(events.map(event => (event as NoteOnEvent).isPalmMute)).toEqual([true, false]);
        expect(events.map(event => (JsonConverter.jsObjectToMidiEvent(JsonConverter.midiEventToJsObject(event)) as NoteOnEvent).isPalmMute))
            .toEqual([true, false]);
    });

    it('keeps standard MIDI note bytes compatible and defaults old events to open notes', () => {
        const plain = new NoteOnEvent(0, 0, 0, 60, 100);
        const muted = new NoteOnEvent(0, 0, 0, 60, 100, true);
        const a = ByteBuffer.empty();
        const b = ByteBuffer.empty();
        plain.writeTo(a);
        muted.writeTo(b);
        expect(a.toArray()).toEqual(b.toArray());
        expect((JsonConverter.jsObjectToMidiEvent(JsonConverter.midiEventToJsObject(plain)) as NoteOnEvent).isPalmMute).toBe(false);
    });

    it('darkens held notes and damps release without modifying shared instrument parameters', () => {
        for (const program of [25, 30, 34]) {
            const open = createSynth(program);
            const muted = createSynth(program);
            const originalEnvelope = { ...muted.region.ampEnv };
            const originalFilter = muted.region.initialFilterFc;
            open.synth.channelNoteOn(0, 60, 1);
            muted.synth.channelNoteOn(0, 60, 1, true);
            const a = render(open.synth);
            const b = render(muted.synth);
            const brightness = (samples: Float32Array) => {
                let difference = 0;
                for (let i = 2; i < samples.length; i += 2) {
                    difference += (samples[i] - samples[i - 2]) ** 2;
                }
                return difference / energy(samples);
            };
            expect(energy(b)).toBeGreaterThan(0);
            expect(brightness(b.subarray(0, 960))).toBeLessThan(brightness(a.subarray(0, 960)));
            expect(energy(b.subarray(9600))).toBeLessThan(energy(a.subarray(9600)));
            expect({ ...muted.region.ampEnv }).toEqual(originalEnvelope);
            expect(muted.region.initialFilterFc).toBe(originalFilter);
            expect(b.every(Number.isFinite)).toBe(true);
            open.synth.channelNoteOff(0, 60);
            muted.synth.channelNoteOff(0, 60);
            const openTail = render(open.synth).subarray(4800);
            const mutedTail = render(muted.synth).subarray(4800);
            expect(energy(openTail)).toBeGreaterThan(0);
            expect(energy(mutedTail)).toBe(0);
        }
    });

    it('leaves simultaneous open notes and non-string instruments unchanged', () => {
        const mixed = createSynth();
        const open = createSynth();
        const muted = createSynth();
        mixed.synth.channelNoteOn(0, 60, 1, true);
        mixed.synth.channelNoteOn(0, 64, 1);
        muted.synth.channelNoteOn(0, 60, 1, true);
        open.synth.channelNoteOn(0, 64, 1);
        const a = render(open.synth);
        const b = render(muted.synth);
        const actual = render(mixed.synth);
        for (let i = 0; i < actual.length; i++) {
            expect(actual[i]).toBeCloseTo(a[i] + b[i], 6);
        }
        for (const [program, bank] of [[0, 0], [30, 128]]) {
            const one = createSynth(program, bank);
            const two = createSynth(program, bank);
            one.synth.channelNoteOn(0, 60, 1);
            two.synth.channelNoteOn(0, 60, 1, true);
            expect(render(one.synth)).toEqual(render(two.synth));
        }
    });

    it('retains audible post-attack energy for low-sustain guitar samples', () => {
        // MuseScore distortion regions have a very low sustain floor and a long
        // natural decay. Palm damping must not drop straight to that floor.
        const open = createSynth();
        const muted = createSynth();
        for (const { region } of [open, muted]) {
            region.ampEnv.decay = 10;
            region.ampEnv.sustain = 0.008;
        }
        open.synth.channelNoteOn(0, 60, 1);
        muted.synth.channelNoteOn(0, 60, 1, true);
        const a = render(open.synth);
        const b = render(muted.synth);
        // Ignore the pick transient and require a body within 20 dB of the
        // open source, while still quieter. Do not pin a particular EQ/tuning.
        const body = (samples: Float32Array) => energy(samples.subarray(2400, 7200));
        expect(Math.sqrt(body(b) / body(a))).toBeGreaterThan(0.1);
        expect(body(b)).toBeLessThan(body(a));
    });

    it('clears damping when a finished voice is reused for an open note', () => {
        const reused = createSynth();
        reused.synth.channelNoteOn(0, 60, 1, true);
        render(reused.synth, 26000);
        reused.synth.channelNoteOn(0, 60, 1);
        const fresh = createSynth();
        fresh.synth.channelNoteOn(0, 60, 1);
        expect(render(reused.synth)).toEqual(render(fresh.synth));
    });
});
