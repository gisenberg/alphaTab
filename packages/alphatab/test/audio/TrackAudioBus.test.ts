import { describe, expect, it } from 'vitest';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { TrackAudioBus, type ITrackAudioProcessor } from '@coderline/alphatab/synth/synthesis/TrackAudioBus';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';
import { AlphaTabMetronomeEvent } from '@coderline/alphatab/midi/MidiEvent';
import { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

function synth() {
    const region = new Region();
    region.samples = new Float32Array(48001).fill(0.1);
    region.sampleRate = 48000;
    region.end = region.samples.length - 1;
    region.hiKey = 127;
    region.hiVel = 127;
    region.pitchKeyCenter = 60;
    region.pitchKeyTrack = 0;
    region.ampEnv.sustain = 1;
    region.initialFilterFc = 14000;
    const preset = new Preset();
    preset.regions = [region];
    const result = new TinySoundFont(48000);
    result.presets = [preset];
    for (const channel of [0, 1, 9]) { result.channelSetPresetIndex(channel, 0); }
    return result;
}

class Square implements ITrackAudioProcessor {
    public buffers = new Set<Float32Array>();
    public resets = 0;
    public process(buffer: Float32Array, frames: number): void {
        this.buffers.add(buffer);
        for (let i = 0; i < frames * 2; i++) { buffer[i] *= buffer[i]; }
    }
    public reset(): void { this.resets++; }
}

function render(engine: TinySoundFont, frames = 256) {
    const result = new Float32Array(frames * 2);
    engine.synthesize(result, 0, frames);
    return result;
}

describe('worker track processing boundary', () => {
    it('selects clean source samples for drive programs without rerouting ringing clean notes', () => {
        const engine = synth();
        const source = new Preset();
        source.presetNumber = 27;
        const sourceRegion = new Region(engine.presets![0].regions![0]);
        sourceRegion.samples = new Float32Array(48001).fill(0.2);
        source.regions = [sourceRegion];
        const distorted = new Preset();
        distorted.presetNumber = 30;
        distorted.regions = engine.presets![0].regions;
        engine.presets!.push(source, distorted);
        const processor = new Square();
        engine.setTrackAudioBuses([new TrackAudioBus([0], processor, new Map([[30, 27]]))]);
        engine.channelNoteOn(0, 60, 1);
        const clean = render(engine)[0];
        engine.channelSetPresetNumber(0, 30);
        engine.channelNoteOn(0, 64, 1);
        // The old clean voice stays dry, while the new note alone enters the drive bus.
        expect(render(engine)[0]).toBeCloseTo(clean + (clean * 2) ** 2, 7);
        engine.channelSetPresetNumber(0, 0);
        expect(render(engine)[0]).toBeCloseTo(clean + (clean * 2) ** 2, 7);
        expect(() => engine.setTrackAudioBuses([])).toThrow('Stop active voices');
    });

    it('falls back to the original voice when replacement samples are not loaded or do not cover the note', () => {
        for (const coverage of ['unloaded', 'wrong-key']) {
            const engine = synth();
            const dry = synth();
            const source = new Preset();
            source.presetNumber = 27;
            const region = new Region();
            region.samples = coverage === 'unloaded' ? new Float32Array() : new Float32Array([0.5]);
            region.loKey = 100;
            region.hiKey = 127;
            region.hiVel = 127;
            source.regions = [region];
            engine.presets!.push(source);
            engine.setTrackAudioBuses([new TrackAudioBus([0], new Square(), new Map([[0, 27]]))]);
            for (const synth of [engine, dry]) { synth.channelNoteOn(0, 60, 1); }
            expect(render(engine)).toEqual(render(dry));
        }
    });

    it('sums a guitar\'s channels before nonlinear processing, with bounded scratch reuse', () => {
        const engine = synth();
        const dry = synth();
        const processor = new Square();
        engine.setTrackAudioBuses([new TrackAudioBus([0, 1], processor)]);
        for (const source of [engine, dry]) {
            source.channelNoteOn(0, 60, 1);
            source.channelNoteOn(1, 64, 1);
        }
        const expected = render(dry);
        const actual = render(engine);
        for (let i = 0; i < expected.length; i++) { expect(actual[i]).toBeCloseTo(expected[i] ** 2, 7); }
        render(engine);
        expect(processor.buffers.size).toBe(1);
    });

    it('keeps master and track faders after distortion, including active-note fader changes', () => {
        const loud = synth();
        const quiet = synth();
        for (const source of [loud, quiet]) {
            source.setTrackAudioBuses([new TrackAudioBus([0, 1], new Square())]);
            source.channelNoteOn(0, 60, 1);
            render(source);
        }
        quiet.masterVolume = 0.5;
        quiet.channelSetMixVolume(1, 0.5);
        expect(quiet.channelGetMixVolume(0)).toBe(quiet.channelGetMixVolume(1));
        const a = render(loud);
        const b = render(quiet);
        for (let i = 0; i < a.length; i++) { expect(b[i]).toBeCloseTo(a[i] * 0.25, 7); }
    });

    it('leaves unrelated drum audio and the metronome unchanged', () => {
        const processed = synth();
        const dry = synth();
        processed.setTrackAudioBuses([new TrackAudioBus([0, 1], new Square())]);
        for (const source of [processed, dry]) {
            source.channelNoteOn(9, 60, 1);
            source.metronomeVolume = 0.5;
            source.dispatchEvent(new SynthEvent(0, new AlphaTabMetronomeEvent(0, 0, 0, 4, 4)));
        }
        expect(render(processed)).toEqual(render(dry));
    });

    it('advances tails through silence, gates them on mute, and resets them on seek', () => {
        const engine = synth();
        let tail = 0.1;
        const processor: ITrackAudioProcessor = {
            process: (buffer, frames) => { buffer.fill(tail, 0, frames * 2); },
            reset: () => { tail = 0; }
        };
        engine.setTrackAudioBuses([new TrackAudioBus([0], processor)]);
        tail = 0.1;
        expect(render(engine)[0]).toBeGreaterThan(0);
        engine.channelSetMute(0, true);
        expect(render(engine).every(x => x === 0)).toBe(true);
        engine.channelSetMute(0, false);
        engine.synthesizeSilent(64);
        expect(render(engine).every(x => x === 0)).toBe(true);
        tail = 0.1;
        engine.resetSoft();
        expect(render(engine).every(x => x === 0)).toBe(true);
    });

    it('rejects overlapping routing without replacing the previous configuration', () => {
        const engine = synth();
        const processor = new Square();
        engine.setTrackAudioBuses([new TrackAudioBus([0], processor)]);
        const resets = processor.resets;
        expect(() => engine.setTrackAudioBuses([new TrackAudioBus([0], processor), new TrackAudioBus([0], processor)])).toThrow();
        expect(processor.resets).toBe(resets);
        expect(() => new TrackAudioBus([], processor)).toThrow();
    });

    it('honors output offsets and matches microbuffer-by-microbuffer rendering', () => {
        const whole = synth();
        const split = synth();
        for (const engine of [whole, split]) {
            engine.setTrackAudioBuses([new TrackAudioBus([0], new Square())]);
            engine.channelNoteOn(0, 60, 1);
        }
        const actual = new Float32Array(520);
        actual.fill(-1, 0, 4);
        actual.fill(-1, 516);
        whole.synthesize(actual, 4, 256);
        const expected = new Float32Array(512);
        for (let frame = 0; frame < 256; frame += 64) { split.synthesize(expected, frame * 2, 64); }
        expect(actual.subarray(4, 516)).toEqual(expected);
        expect([...actual.subarray(0, 4), ...actual.subarray(516)]).toEqual(new Array(8).fill(-1));
    });
});
