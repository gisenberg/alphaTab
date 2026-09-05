import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { AlphaSynthAudioExporter } from '@coderline/alphatab/synth/AlphaSynth';
import { AudioExportOptions } from '@coderline/alphatab/synth/IAudioExporter';

function makeExporter(limited: boolean, volume: number) {
    const score = ScoreLoader.loadAlphaTex('\\tempo 120 . \\ts 1 4 :4 C4');
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
    const options = new AudioExportOptions();
    options.sampleRate = 44100;
    options.enablePeakLimiter = limited;
    options.metronomeVolume = 1;
    options.masterVolume = volume;
    const exporter = new AlphaSynthAudioExporter(options);
    exporter.loadMidiFile(midi);
    exporter.setup();
    return { exporter, midi };
}

function render(exporter: AlphaSynthAudioExporter, milliseconds: number) {
    const output: number[] = [];
    for (let i = 0; i < 10000; i++) {
        const chunk = exporter.render(milliseconds);
        if (!chunk) {
            return Float32Array.from(output);
        }
        // Regression: rounded microbuffers must not accumulate requested-duration drift.
        expect(chunk.currentTime).toBeCloseTo(output.length / 2 / 44100 * 1000, 8);
        expect(chunk.samples.length).toBeGreaterThan(0);
        output.push(...chunk.samples);
    }
    throw new Error('Exporter did not finish');
}

describe('AlphaSynthAudioExporter', () => {
    it('places beats at authored sync times rather than only being chunk-independent', () => {
        const score = ScoreLoader.loadAlphaTex('\\tempo 120 . \\ts 4 4 :4 C4 * 4 | C4 * 4');
        score.applyFlatSyncPoints([
            { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 0 },
            { barIndex: 1, barOccurence: 0, barPosition: 0, millisecondOffset: 4000 }
        ]);
        const midi = new MidiFile();
        const generator = new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi));
        generator.generate();
        const options = new AudioExportOptions();
        options.sampleRate = 44100;
        options.metronomeVolume = 1;
        options.enablePeakLimiter = true;
        const exporter = new AlphaSynthAudioExporter(options);
        exporter.loadMidiFile(midi);
        exporter.updateSyncPoints(generator.syncPoints);
        exporter.setup();
        const samples = render(exporter, 7);
        const energy = (start: number, end: number) => samples.subarray(start * 44100 * 2, end * 44100 * 2)
            .reduce((sum, sample) => sum + sample * sample, 0);
        for (const second of [0, 1, 2, 3]) {
            expect(energy(second, second + 0.12)).toBeGreaterThan(0);
            expect(energy(second + 0.2, second + 0.8)).toBe(0);
        }
    });

    it('preserves the exact low-level signal with sub-lookahead requests and at EOF', () => {
        const reference = render(makeExporter(false, 0.1).exporter, 20);
        for (const milliseconds of [1, 7, 20]) {
            expect(render(makeExporter(true, 0.1).exporter, milliseconds)).toEqual(reference);
        }
    });

    it('bounds overload without dropping or adding frames and can reload after EOF', () => {
        const reference = render(makeExporter(false, 20).exporter, 20);
        expect(reference.some(value => Math.abs(value) > 1)).toBe(true);
        const { exporter, midi } = makeExporter(true, 20);
        const limited = render(exporter, 1);
        expect(limited.length).toBe(reference.length);
        expect(limited.every(value => Math.abs(value) <= 0.950001)).toBe(true);
        exporter.loadMidiFile(midi);
        exporter.setup();
        expect(render(exporter, 7)).toEqual(limited);
    });
});
