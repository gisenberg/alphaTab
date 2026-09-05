import { describe, expect, it } from 'vitest';
import { SynthesisReleaseTail } from '@coderline/alphatab/synth/SynthesisReleaseTail';
import { AlphaSynth, AlphaSynthAudioExporter } from '@coderline/alphatab/synth/AlphaSynth';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';
import { AudioExportOptions } from '@coderline/alphatab/synth/IAudioExporter';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { EndOfTrackEvent, NoteOnEvent, NoteOffEvent, ProgramChangeEvent, TempoChangeEvent } from '@coderline/alphatab/midi/MidiEvent';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';
import { LoopMode } from '@coderline/alphatab/synth/synthesis/LoopMode';

class InspectableSynth extends AlphaSynth {
    public get isPlayingMain(): boolean { return this.sequencer.isPlayingMain; }
}

function exporter(tailSeconds: number, release: number, limiter = false) {
    const options = new AudioExportOptions();
    options.sampleRate = 48000;
    options.releaseTailSeconds = tailSeconds;
    options.enablePeakLimiter = limiter;
    const result = new AlphaSynthAudioExporter(options);
    const midi = new MidiFile();
    midi.addEvent(new ProgramChangeEvent(0, 0, 0, 0));
    midi.addEvent(new NoteOnEvent(0, 0, 0, 60, 100));
    midi.addEvent(new NoteOffEvent(0, 960, 0, 60, 0));
    midi.addEvent(new EndOfTrackEvent(0, 960));
    result.loadMidiFile(midi);
    const region = new Region();
    region.samples = new Float32Array(1024).fill(0.1);
    region.sampleRate = 48000;
    region.end = 1023;
    region.loopEnd = 1022;
    region.loopMode = LoopMode.Continuous;
    region.hiKey = region.hiVel = 127;
    region.pitchKeyCenter = 60;
    region.pitchKeyTrack = 0;
    region.ampEnv.sustain = 1;
    region.ampEnv.release = release;
    region.initialFilterFc = 14000;
    const preset = new Preset();
    preset.regions = [region];
    result.loadPresets([preset]);
    result.setup();
    return result;
}

function render(source: AlphaSynthAudioExporter, chunkMs: number): Float32Array {
    const blocks: Float32Array[] = [];
    for (let i = 0; i < 10000; i++) {
        const block = source.render(chunkMs);
        if (!block) {
            const samples = new Float32Array(blocks.reduce((sum, b) => sum + b.length, 0));
            let offset = 0;
            for (const b of blocks) { samples.set(b, offset); offset += b.length; }
            return samples;
        }
        expect(block.samples.length).toBeGreaterThan(0);
        blocks.push(block.samples);
    }
    throw new Error('Export did not finish');
}

describe('bounded export release tails', () => {
    it.each(['loop', 'range', 'count-in'])('does not delay %s transitions', async mode => {
        const bank = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const midi = new MidiFile();
        midi.addEvent(new TempoChangeEvent(0, 500000));
        midi.addEvent(new ProgramChangeEvent(0, 0, 0, 26));
        midi.addEvent(new NoteOnEvent(0, 0, 0, 60, 100));
        midi.addEvent(new NoteOffEvent(0, 960, 0, 60, 0));
        midi.addEvent(new EndOfTrackEvent(0, 960));
        const runs: Float32Array[] = [];
        for (const tail of [0, 2]) {
            const output = new TestOutput();
            const live = new InspectableSynth(output, 500, false, false, tail);
            live.loadSoundFont(bank, false);
            live.loadMidiFile(midi);
            if (mode === 'loop') { live.isLooping = true; }
            if (mode === 'range') { live.playbackRange = { startTick: 0, endTick: 960 }; }
            if (mode === 'count-in') { live.countInVolume = 1; }
            expect(live.play()).toBe(true);
            let finishes = 0;
            live.finished.on(() => { finishes++; });
            for (let i = 0; i < 1000; i++) {
                output.next();
                if (mode === 'count-in' ? live.isPlayingMain : finishes > 0) { break; }
            }
            if (mode === 'count-in') { expect(live.isPlayingMain).toBe(true); }
            else { expect(finishes).toBe(1); }
            const samples = new Float32Array(output.sampleCount);
            let offset = 0;
            for (const block of output.samples) { samples.set(block, offset); offset += block.length; }
            runs.push(samples);
            live.destroy();
        }
        expect(runs[1]).toEqual(runs[0]);
    });

    it.each([false, true])('keeps live playback and export identical through EOF (limiter %s)', async limiter => {
        const bank = await TestPlatform.loadFile('test-data/audio/default.sf2');
        const midi = new MidiFile();
        midi.addEvent(new ProgramChangeEvent(0, 0, 0, 26));
        midi.addEvent(new NoteOnEvent(0, 0, 0, 60, 100));
        midi.addEvent(new NoteOffEvent(0, 960, 0, 60, 0));
        midi.addEvent(new EndOfTrackEvent(0, 960));
        const output = new TestOutput();
        const live = new AlphaSynth(output, 500, limiter, false, 0.5);
        live.masterVolume = 0.35;
        live.loadSoundFont(bank, false);
        const options = new AudioExportOptions();
        options.sampleRate = output.sampleRate;
        options.masterVolume = 0.35;
        options.enablePeakLimiter = limiter;
        options.releaseTailSeconds = 0.5;
        const offline = new AlphaSynthAudioExporter(options);
        offline.loadMidiFile(midi);
        offline.loadSoundFont(bank);
        offline.setup();
        const expected = render(offline, 20);
        // Replay/reload must reset the completed release, not truncate the next play.
        for (let run = 0; run < 2; run++) {
            live.loadMidiFile(midi);
            output.samples = [];
            output.sampleCount = 0;
            expect(live.play()).toBe(true);
            for (let i = 0; i < 1000 && live.state === PlayerState.Playing; i++) { output.next(); }
            expect(live.state).toBe(PlayerState.Paused);
            const actual = new Float32Array(output.sampleCount);
            let offset = 0;
            for (const block of output.samples) { actual.set(block, offset); offset += block.length; }
            expect(actual).toEqual(expected);
        }
        live.destroy();
    });

    it('retains the release after the musical endpoint instead of truncating it', () => {
        const dry = render(exporter(0, 0.2), 20);
        const tailed = render(exporter(0.4, 0.2), 20);
        expect(dry.some(sample => Math.abs(sample) > 0.01)).toBe(true);
        expect(tailed.subarray(0, dry.length)).toEqual(dry);
        expect(tailed.length).toBeGreaterThan(dry.length + 4800);
        expect(tailed.subarray(dry.length, dry.length + 4800).some(x => Math.abs(x) > 0.001)).toBe(true);
        expect(Math.abs(tailed[tailed.length - 1])).toBeLessThan(0.00001);
        expect(tailed.length).toBeLessThanOrEqual(dry.length + 48000 * 2 * 0.4);
    });

    it('bounds long releases with a stereo-linked fade to zero', () => {
        const dry = render(exporter(0, 20), 20);
        const tailed = render(exporter(0.1, 20), 20);
        expect(tailed.length).toBe(dry.length + 48000 * 2 * 0.1);
        expect(tailed[tailed.length - 1]).toBe(0);
        expect(tailed[tailed.length - 2]).toBe(0);
        expect(Math.abs(tailed[tailed.length - 4])).toBeLessThan(Math.abs(tailed[tailed.length - 800]));
    });

    it('is independent of caller chunk size and flushes limiter lookahead only after the tail', () => {
        const plain = render(exporter(0.4, 0.2), 20);
        expect(render(exporter(0.4, 0.2), 1)).toEqual(plain);
        expect(render(exporter(0.4, 0.2, true), 1)).toEqual(plain);
        expect(render(exporter(0.4, 0.2, true), 300)).toEqual(plain);
    });

    it('does not mistake a quiet but active voice for EOF and resets its state', () => {
        const tail = new SynthesisReleaseTail(48000, 0.2);
        const silence = new Float32Array(4800 * 2);
        expect(tail.process(silence, 0, 4800, true)).toBe(4800);
        expect(tail.finished).toBe(false);
        expect(tail.process(silence, 0, 4800, false)).toBeLessThan(4800);
        expect(tail.finished).toBe(true);
        tail.reset();
        expect(tail.finished).toBe(false);
        expect(() => new SynthesisReleaseTail(48000, Infinity)).toThrow();
    });
});
