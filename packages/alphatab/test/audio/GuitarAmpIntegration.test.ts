import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiEventType, type ProgramChangeEvent } from '@coderline/alphatab/midi/MidiEvent';
import { AlphaSynth, AlphaSynthAudioExporter } from '@coderline/alphatab/synth/AlphaSynth';
import { AudioExportOptions } from '@coderline/alphatab/synth/IAudioExporter';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';

function midiFor(program: number): MidiFile {
    const score = ScoreLoader.loadAlphaTex('\\tempo 120 . :4 C4 E4 G4 C5');
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
    for (const track of midi.tracks) {
        for (const event of track.events) {
            if (event.type === MidiEventType.ProgramChange) { (event as ProgramChangeEvent).program = program; }
        }
    }
    return midi;
}

describe('experimental guitar live/export consistency', () => {
    it('renders identical samples and replaces routing when another MIDI file is loaded', async () => {
        const bank = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const output = new TestOutput();
        const live = new AlphaSynth(output, 500, false, true);
        live.masterVolume = 0.35;
        live.loadSoundFont(bank, false);
        const renders: Float32Array[] = [];
        for (const program of [30, 26, 30]) {
            const midi = midiFor(program);
            live.loadMidiFile(midi);
            output.samples = [];
            output.sampleCount = 0;
            expect(live.play()).toBe(true);
            for (let i = 0; i < 20 && output.sampleCount < 8820; i++) { output.next(); }
            const options = new AudioExportOptions();
            options.sampleRate = output.sampleRate;
            options.masterVolume = 0.35;
            options.enableExperimentalGuitarAmp = true;
            const exporter = new AlphaSynthAudioExporter(options);
            exporter.loadMidiFile(midi);
            exporter.loadSoundFont(bank);
            exporter.setup();
            const expected = exporter.render(100)!.samples;
            const actual = new Float32Array(output.sampleCount);
            let offset = 0;
            for (const samples of output.samples) { actual.set(samples, offset); offset += samples.length; }
            expect(actual.length).toBeGreaterThanOrEqual(expected.length);
            expect(actual.subarray(0, expected.length)).toEqual(expected);
            expect(expected.some(sample => sample !== 0)).toBe(true);
            renders.push(expected);
        }
        expect(renders[0]).toEqual(renders[2]);
        expect(renders[0]).not.toEqual(renders[1]);
        const dryOptions = new AudioExportOptions();
        dryOptions.sampleRate = output.sampleRate;
        dryOptions.masterVolume = 0.35;
        const dry = new AlphaSynthAudioExporter(dryOptions);
        dry.loadMidiFile(midiFor(30));
        dry.loadSoundFont(bank);
        dry.setup();
        // Both paths accidentally bypassing the amp would otherwise still compare equal.
        expect(renders[0]).not.toEqual(dry.render(100)!.samples);
        live.destroy();
    });
});
