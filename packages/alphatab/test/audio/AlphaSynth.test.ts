import { describe, expect, it } from 'vitest';
import type { EventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { ControllerType } from '@coderline/alphatab/midi/ControllerType';
import {
    type ControlChangeEvent,
    type MidiEvent,
    MidiEventType,
    TempoChangeEvent
} from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import type { Score } from '@coderline/alphatab/model/Score';
import { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
import { AudioExportOptions } from '@coderline/alphatab/synth/IAudioExporter';
import { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { VorbisFile } from '@coderline/alphatab/synth/vorbis/VorbisFile';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';

class BufferedTestOutput extends TestOutput {
    private _pendingSamples: Float32Array[] = [];
    public finalBufferReceived: boolean = false;

    public override addSamples(samples: Float32Array, isFinal: boolean = false): void {
        this._pendingSamples.push(samples);
        this.finalBufferReceived ||= isFinal;
    }

    public override pause(): void {
        this._pendingSamples = [];
    }

    public override resetSamples(): void {
        this._pendingSamples = [];
    }

    public consumeNext(): boolean {
        const samples = this._pendingSamples.shift();
        if (!samples) {
            return false;
        }
        (this.samplesPlayed as EventEmitterOfT<number>).trigger(samples.length / SynthConstants.AudioChannels);
        return true;
    }
}

describe('AlphaSynthTests', () => {
    it('preserves the active playback range when MIDI is reloaded', async () => {
        const score = ScoreLoader.loadAlphaTex('\\tempo 120 . \\ts 4 4 :4 C4 D4 E4 F4 | G4 A4 B4 C5');
        const midi = new MidiFile();
        new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();

        const output = new TestOutput(false);
        const synth = new AlphaSynth(output, 500);
        synth.loadSoundFont(await TestPlatform.loadFile('test-data/audio/default.sf2'), false);
        synth.loadMidiFile(midi);

        const endTick = synth.loadedMidiInfo!.endTick;
        const range = new PlaybackRange();
        range.startTick = Math.floor(endTick / 4);
        range.endTick = Math.floor((endTick * 3) / 4);
        synth.playbackRange = range;
        synth.isLooping = true;

        synth.loadMidiFile(midi);

        expect(synth.playbackRange).not.toBeNull();
        expect(synth.playbackRange!.startTick).toBe(range.startTick);
        expect(synth.playbackRange!.endTick).toBe(range.endTick);
        expect(synth.tickPosition).toBeGreaterThanOrEqual(range.startTick);
        expect(synth.tickPosition).toBeLessThanOrEqual(range.startTick + 1);

        expect(synth.play()).toBe(true);
        for (let i = 0; i < 20; i++) {
            output.next();
            expect(synth.tickPosition).toBeGreaterThanOrEqual(range.startTick);
            expect(synth.tickPosition).toBeLessThanOrEqual(range.endTick);
        }
    });

    it('resumes from the last audible frame after buffered audio is discarded on pause', async () => {
        const score = ScoreLoader.loadAlphaTex('\\tempo 120 . \\ts 1 4 :8 C4 * 2');
        const midi = new MidiFile();
        new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();

        const output = new BufferedTestOutput(false);
        const synth = new AlphaSynth(output, 500);
        synth.loadSoundFont(await TestPlatform.loadFile('test-data/audio/default.sf2'), false);
        synth.loadMidiFile(midi);

        let finished = false;
        synth.finished.on(() => {
            finished = true;
        });

        expect(synth.play()).toBe(true);
        // Synthesize ahead without reporting any audible frames, then discard that queue.
        for (let i = 0; i < 4; i++) {
            output.next();
        }
        synth.pause();

        expect(synth.timePosition).toBe(0);
        expect(synth.play()).toBe(true);

        for (let i = 0; i < 1000 && !finished; i++) {
            output.next();
            while (output.consumeNext()) {
                // Drain every buffer produced by this request.
            }
        }

        expect(finished).toBe(true);
        expect(output.finalBufferReceived).toBe(true);
    });

    it('reports the exact future audio time for a slow-playback metronome event', async () => {
        const score = ScoreLoader.loadAlphaTex('\\tempo 140 . \\ts 7 8 :8 C4 * 28');
        const midi = new MidiFile();
        new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();

        const output = new BufferedTestOutput(false);
        const synth = new AlphaSynth(output, 500);
        synth.loadSoundFont(await TestPlatform.loadFile('test-data/audio/default.sf2'), false);
        synth.loadMidiFile(midi);
        synth.playbackSpeed = 0.4;
        synth.metronomeVolume = 1;
        synth.midiEventsPlayedFilter = [MidiEventType.AlphaTabMetronome];

        const observed: Array<{ tick: number; eventTime: number; reportedAt: number; isCountIn: boolean }> = [];
        synth.midiEventsPlayed.on(args => {
            args.events.forEach((event, index) => {
                observed.push({
                    tick: event.tick,
                    eventTime: args.eventTimes[index],
                    reportedAt: args.currentTime,
                    isCountIn: args.isCountIn
                });
            });
        });

        expect(synth.play()).toBe(true);
        for (let i = 0; i < 8; i++) {
            output.next();
        }

        for (let i = 0; i < 40 && observed.filter(event => event.tick >= 960).length === 0; i++) {
            if (!output.consumeNext()) {
                output.next();
            }
        }

        const secondBeat = observed.find(event => event.tick >= 960);
        expect(secondBeat).toBeDefined();
        expect(secondBeat!.eventTime).toBeCloseTo((60000 / 140) / 0.4, 6);
        expect(secondBeat!.isCountIn).toBe(false);
        // Callback delivery is only a coarse observation. Consumers use the
        // exact eventTime instead of treating callback delivery as the beat.
        expect(Math.abs(secondBeat!.reportedAt - secondBeat!.eventTime)).toBeLessThan(100);
    });

    it('pcm-generation', async () => {
        const data = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const tex: string =
            '\\tempo 102 \\tuning E4 B3 G3 D3 A2 E2 \\instrument 25 . r.8 (0.4 0.3 ).8 ' +
            '(-.3 -.4 ).2 {d } | (0.4 0.3 ).8 r.8 (3.3 3.4 ).8 r.8 (5.4 5.3 ).4 r.8 (0.4 0.3 ).8 |' +
            ' r.8 (3.4 3.3 ).8 r.8 (6.3 6.4 ).8 (5.4 5.3 ).4 {d }r.8 |' +
            ' (0.4 0.3).8 r.8(3.4 3.3).8 r.8(5.4 5.3).4 r.8(3.4 3.3).8 | ' +
            'r.8(0.4 0.3).8(-.3 - .4).2 { d } | ';
        const score = ScoreLoader.loadAlphaTex(tex);
        const midi = new MidiFile();
        const gen = new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi));
        gen.generate();
        const testOutput = new TestOutput();
        const synth = new AlphaSynth(testOutput, 500);
        synth.loadSoundFont(data, false);
        synth.loadMidiFile(midi);
        synth.play();
        let finished: boolean = false;
        synth.finished.on(() => {
            finished = true;
        });
        while (!finished) {
            testOutput.next();
        }
    });

    it('only-used-instruments-decoded-sf2', async () => {
        const data = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const tex: string = `
            \\tempo 120
            .
            \\track "T01"
            \\ts 1 4
            \\instrument 24
            4.4.4*4
            \\track "T02"
            \\instrument 30
            4.4.4*4`;
        const score = ScoreLoader.loadAlphaTex(tex);
        const midi = new MidiFile();
        const gen = new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi));
        gen.generate();
        const testOutput = new TestOutput();
        const synth = new AlphaSynth(testOutput, 500);
        synth.loadSoundFont(data, false);
        synth.loadMidiFile(midi);

        expect(synth.isReadyForPlayback).toBe(true);
        expect(synth.hasSamplesForProgram(24)).toBe(true);
        expect(synth.hasSamplesForProgram(30)).toBe(true);
        expect(synth.hasSamplesForProgram(1)).toBe(false);
        expect(synth.hasSamplesForProgram(35)).toBe(false);
        expect(synth.hasSamplesForPercussion(SynthConstants.MetronomeKey)).toBe(true);
    });

    it('only-used-instruments-decoded-sf3', async () => {
        const data = await TestPlatform.loadFile('test-data/audio/default.sf3');

        const tex: string = `
            \\tempo 120
            .
            \\track "T01"
            \\ts 1 4
            \\instrument 24
            4.4.4*4
            \\track "T02"
            \\instrument 30
            4.4.4*4`;
        const score = ScoreLoader.loadAlphaTex(tex);
        const midi = new MidiFile();
        const gen = new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi));
        gen.generate();
        const testOutput = new TestOutput();
        const synth = new AlphaSynth(testOutput, 500);
        synth.loadSoundFont(data, false);
        synth.loadMidiFile(midi);

        expect(synth.isReadyForPlayback).toBe(true);
        expect(synth.hasSamplesForProgram(24)).toBe(true);
        expect(synth.hasSamplesForProgram(30)).toBe(true);
        expect(synth.hasSamplesForProgram(1)).toBe(false);
        expect(synth.hasSamplesForProgram(35)).toBe(false);
        expect(synth.hasSamplesForPercussion(SynthConstants.MetronomeKey)).toBe(true);
    });

    async function testVorbisFile(name: string) {
        const data = await TestPlatform.loadFile(`test-data/audio/${name}.ogg`);
        const vorbis = new VorbisFile(ByteBuffer.fromBuffer(data));

        expect(vorbis.streams.length).toBe(1);
        expect(vorbis.streams[0].audioChannels).toBe(2);
        expect(vorbis.streams[0].audioSampleRate).toBe(44100);
        expect(vorbis.streams[0].samples.length).toBeGreaterThan(44100 * 0.05);

        const generated = vorbis.streams[0].samples;
        const reference = new DataView((await TestPlatform.loadFile(`test-data/audio/${name}_alphaTab.pcm`)).buffer);
        try {
            expect(generated.length).toBe(reference.buffer.byteLength / 4);

            for (let i = 0; i < generated.length; i++) {
                expect(generated[i], `Difference at index ${i}`).toBe(reference.getFloat32(i * 4, true));
            }
        } catch (e) {
            await TestPlatform.saveFile(
                `test-data/audio/${name}_alphaTab_new.pcm`,
                new Uint8Array(vorbis.streams[0].samples.buffer)
            );

            throw e;
        }
    }

    it('ogg-vorbis-short', async () => {
        await testVorbisFile('Short');
    });

    it('ogg-vorbis-example', { timeout: 30000 }, async () => {
        await testVorbisFile('Example');
    });

    async function testAudioExport(
        score: Score,
        fileName: string,
        prepareOptions: (options: AudioExportOptions) => void,
        verify?: (samples: Float32Array) => void,
        chunkMilliseconds: number = 300
    ) {
        // add a fake sync point to get time range (if there are not already sync points)
        const syncPoints = score.exportFlatSyncPoints();
        if (syncPoints.length === 0) {
            score.applyFlatSyncPoints([
                {
                    barIndex: 0,
                    barOccurence: 0,
                    barPosition: 0,
                    millisecondOffset: 0
                }
            ]);
        }

        const soundFont = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const synth = new AlphaSynth(new TestOutput(), 500);

        const midi: MidiFile = new MidiFile();
        const generator: MidiFileGenerator = new MidiFileGenerator(
            score,
            new Settings(),
            new AlphaSynthMidiFileHandler(midi)
        );
        generator.applyTranspositionPitches = false;
        generator.generate();

        const exportOptions = new AudioExportOptions();
        exportOptions.masterVolume = 1;
        exportOptions.metronomeVolume = 0;
        exportOptions.sampleRate = 44100;
        exportOptions.soundFonts = [soundFont];
        prepareOptions(exportOptions);

        const exporter = synth.exportAudio(exportOptions, midi, generator.syncPoints, generator.transpositionPitches);

        let generated: Float32Array = new Float32Array(
            exportOptions.sampleRate *
                (generator.syncPoints[generator.syncPoints.length - 1].syncTime / 1000) *
                SynthConstants.AudioChannels
        );

        let totalSamples = 0;
        while (true) {
            const chunk = exporter.render(chunkMilliseconds);
            if (chunk === undefined) {
                break;
            }

            const neededSize = totalSamples + chunk.samples.length;
            if (generated.length < neededSize) {
                const needed = neededSize - generated.length;
                const newBuffer = new Float32Array(generated.length + needed);
                newBuffer.set(generated, 0);
                generated = newBuffer;
            }

            generated.set(chunk.samples, totalSamples);
            totalSamples += chunk.samples.length;
        }

        if (totalSamples < generated.length) {
            generated = generated.subarray(0, totalSamples);
        }

        if (verify) {
            verify(generated);
            return;
        }
        // Deliberately opt in to one reference after validating a synthesis change.
        // Keep ordinary runs sample-exact rather than weakening the comparison.
        if (process.env.ALPHATAB_UPDATE_AUDIO_REFERENCE === fileName) {
            await TestPlatform.saveFile(
                `test-data/audio/${fileName}.pcm`,
                new Uint8Array(generated.buffer, generated.byteOffset, generated.byteLength)
            );
        }
        try {
            const reference = new DataView((await TestPlatform.loadFile(`test-data/audio/${fileName}.pcm`)).buffer);
            expect(generated.length).toBe(reference.buffer.byteLength / 4);

            for (let i = 0; i < generated.length; i++) {
                const expected = reference.getFloat32(i * 4, true);
                if (generated[i] !== expected) {
                    // custom check, chai assertion has quite huge overhead if called that often
                    expect(generated[i], `Difference at index ${i}`).toBe(expected);
                }
            }
        } catch (e) {
            await TestPlatform.saveFile(
                `test-data/audio/${fileName}-new.pcm`,
                new Uint8Array(generated.buffer, generated.byteOffset, generated.byteLength)
            );

            throw e;
        }
    }

    it('export-test', async () => {
        const tex: string = `
            \\tempo 120
            .
            \\ts 4 4
            :8 C4 * 8
        `;
        const settings = new Settings();
        const score = ScoreLoader.loadAlphaTex(tex, settings);

        await testAudioExport(score, 'export-test', _options => {
            // no settings
        });
    });

    it('export-silent-with-metronome', async () => {
        const tex: string = `
            \\tempo 120
            .
            \\ts 4 4
            :8 C4 * 8
        `;
        const settings = new Settings();
        const score = ScoreLoader.loadAlphaTex(tex, settings);

        await testAudioExport(score, 'export-silent-with-metronome', options => {
            options.metronomeVolume = 1;
            for (const t of score.tracks) {
                options.trackVolume.set(t.index, 0);
            }
        }, samples => {
            // Assert timing and silence, not a particular SoundFont or click tuning.
            const rate = 44100;
            const energy = (start: number, end: number) => samples.subarray(start * rate * 2, end * rate * 2)
                .reduce((sum, sample) => sum + sample * sample, 0);
            expect(samples.length).toBeGreaterThanOrEqual(rate * 2 * 2);
            expect(samples.every(Number.isFinite)).toBe(true);
            for (const beat of [0, 0.5, 1, 1.5]) {
                expect(energy(beat, beat + 0.1)).toBeGreaterThan(0);
                expect(energy(beat + 0.15, beat + 0.4)).toBe(0);
            }
        });
    });

    it('export-sync-points', async () => {
        const data = await TestPlatform.loadFile('test-data/audio/syncpoints-testfile.gp');
        const score = ScoreLoader.loadScoreFromBytes(data, new Settings());
        let reference: Float32Array = new Float32Array(0);
        const configure = (options: AudioExportOptions) => {
            options.useSyncPoints = true;
        };
        // Regression: advancing by the requested 300 ms instead of the actual
        // rounded microbuffers made the old PCM golden encode sync-point drift.
        // Different requests must now produce the exact same synchronized audio.
        await testAudioExport(score, 'export-sync-points', configure, samples => {
            reference = samples;
        }, 300);
        await testAudioExport(score, 'export-sync-points', configure, samples => {
            expect(samples.length).toBe(reference.length);
            for (let i = 0; i < samples.length; i++) {
                if (samples[i] !== reference[i]) {
                    expect(samples[i], `Chunk-dependent sample at ${i}`).toBe(reference[i]);
                }
            }
        }, 7);
    });

    it('midi-bank', () => {
        const score = ScoreLoader.loadAlphaTex(`
            \\track "T1" { instrument 25 bank 77 }
                C4 D4 E4 F4 | C4 { instrument 27 bank 1000 } D4 E4 F4

            \\track "T1" { instrument 25 bank 50 }
                C4 D4 E4 F4 | C4 D4 E4 { instrument 27 bank 4000 } F4
        `);

        const midi: MidiFile = new MidiFile();
        const generator: MidiFileGenerator = new MidiFileGenerator(
            score,
            new Settings(),
            new AlphaSynthMidiFileHandler(midi)
        );
        generator.applyTranspositionPitches = false;
        generator.generate();

        const bankChanges: ControlChangeEvent[] = [];
        for (const e of midi.events) {
            if (
                e.type === MidiEventType.ControlChange &&
                ((e as ControlChangeEvent).controller === ControllerType.BankSelectCoarse ||
                    (e as ControlChangeEvent).controller === ControllerType.BankSelectFine)
            ) {
                bankChanges.push(e as ControlChangeEvent);
            }
        }

        expect(bankChanges).toMatchSnapshot();

        const synth = new TinySoundFont(44100);

        let i = 0;
        function playTo(ticks: number) {
            while (i < bankChanges.length) {
                const nextEvent = bankChanges[i];
                if (nextEvent.tick <= ticks) {
                    synth.processMidiMessage(nextEvent);
                    i++;
                } else {
                    break;
                }
            }
        }

        playTo(0);
        expect(synth.channelGetPresetBank(0)).toBe(77);
        expect(synth.channelGetPresetBank(1)).toBe(77);
        expect(synth.channelGetPresetBank(2)).toBe(50);
        expect(synth.channelGetPresetBank(3)).toBe(50);

        playTo(3840);
        expect(synth.channelGetPresetBank(0)).toBe(1000);
        expect(synth.channelGetPresetBank(1)).toBe(1000);
        expect(synth.channelGetPresetBank(2)).toBe(50);
        expect(synth.channelGetPresetBank(3)).toBe(50);

        playTo(3840 * 2);
        expect(synth.channelGetPresetBank(0)).toBe(1000);
        expect(synth.channelGetPresetBank(1)).toBe(1000);
        expect(synth.channelGetPresetBank(2)).toBe(4000);
        expect(synth.channelGetPresetBank(3)).toBe(4000);
    });

    async function testPlaythrough(midi: MidiFile) {
        const testOutput = new TestOutput(false);
        const synth = new AlphaSynth(testOutput, 500);
        const soundFont = await TestPlatform.loadFile('test-data/audio/default.sf2');
        synth.loadSoundFont(soundFont, false);
        synth.loadMidiFile(midi);
        synth.play();
        let finished = false;
        synth.finished.on(() => {
            finished = true;
        });

        const start = Date.now();

        while (!finished) {
            const now = Date.now();
            if (now - start > 2000) {
                throw new Error(`play did not complete after ${2000}ms`);
            }
            testOutput.next();
        }
    }

    it('small-tempos', async () => {
        const score = ScoreLoader.loadScoreFromBytes(await TestPlatform.loadFile('test-data/audio/small-tempo.xml'));

        expect(score.masterBars[0].tempoAutomations[0].value).toBe(0.111);

        const midi = new MidiFile();
        const handler = new AlphaSynthMidiFileHandler(midi);
        const generator = new MidiFileGenerator(score, null, handler);
        generator.generate();

        const tempoChange: MidiEvent[] = midi.events.filter(e => e instanceof TempoChangeEvent);
        expect(tempoChange.length).toBe(1);
        expect((tempoChange[0] as TempoChangeEvent).beatsPerMinute).toBe(0.111);

        await testPlaythrough(midi);
    });

    it('zero-tempo', async () => {
        const score = ScoreLoader.loadScoreFromBytes(await TestPlatform.loadFile('test-data/audio/small-tempo.xml'));

        expect(score.masterBars[0].tempoAutomations[0].value).toBe(0.111);
        score.masterBars[0].tempoAutomations[0].value = 0;

        const midi = new MidiFile();
        const handler = new AlphaSynthMidiFileHandler(midi);
        const generator = new MidiFileGenerator(score, null, handler);
        generator.generate();

        const tempoChange: MidiEvent[] = midi.events.filter(e => e instanceof TempoChangeEvent);
        expect(tempoChange.length).toBe(1);
        expect((tempoChange[0] as TempoChangeEvent).beatsPerMinute).toBe(0);

        await testPlaythrough(midi);
    });
});
