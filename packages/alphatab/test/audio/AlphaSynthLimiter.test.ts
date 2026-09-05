import { describe, expect, it } from 'vitest';
import type { EventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { TestOutput } from 'test/audio/TestOutput';
import { TestPlatform } from 'test/TestPlatform';

class BufferedOutput extends TestOutput {
    private _pending: Float32Array[] = [];
    public captured: number[] = [];
    public override addSamples(samples: Float32Array): void {
        this._pending.push(samples);
    }
    public override pause(): void {
        this._pending = [];
    }
    public override resetSamples(): void {
        this._pending = [];
    }
    public consume(): void {
        const samples = this._pending.shift();
        if (samples) {
            this.captured.push(...samples);
            (this.samplesPlayed as EventEmitterOfT<number>).trigger(samples.length / 2);
        }
    }
}

async function create(limited: boolean, volume: number) {
    const score = ScoreLoader.loadAlphaTex('\\tempo 120 . \\ts 4 4 :8 C4 * 8');
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
    const output = new BufferedOutput(false);
    const synth = new AlphaSynth(output, 500, limited);
    synth.loadSoundFont(await TestPlatform.loadFile('test-data/audio/default.sf2'), false);
    synth.loadMidiFile(midi);
    synth.masterVolume = volume;
    synth.metronomeVolume = 1;
    return { output, synth };
}

function drain(synth: AlphaSynth, output: BufferedOutput): Float32Array {
    for (let i = 0; i < 10000 && synth.state === PlayerState.Playing; i++) {
        output.next();
        output.consume();
    }
    expect(synth.state).toBe(PlayerState.Paused);
    return Float32Array.from(output.captured);
}

function expectSame(actual: Float32Array, expected: Float32Array): void {
    expect(actual.length).toBe(expected.length);
    const mismatch = actual.findIndex((value, index) => value !== expected[index]);
    expect(mismatch, mismatch < 0 ? 'Identical audio' : `Sample ${mismatch}: ${actual[mismatch]} versus ${expected[mismatch]}`).toBe(-1);
}

describe('AlphaSynth limiter transport', () => {
    it('keeps below-ceiling playback frame-identical, including count-in and EOF', async () => {
        for (const countIn of [0, 1]) {
            const dry = await create(false, 0.1);
            const wet = await create(true, 0.1);
            dry.synth.countInVolume = countIn;
            wet.synth.countInVolume = countIn;
            expect(dry.synth.play()).toBe(true);
            expect(wet.synth.play()).toBe(true);
            expectSame(drain(wet.synth, wet.output), drain(dry.synth, dry.output));
        }
    });

    it('discards lookahead audio on pause or seek without skipping the resumed attack', async () => {
        for (const action of ['pause', 'seek']) {
            const results: Float32Array[] = [];
            for (const limited of [false, true]) {
                const { synth, output } = await create(limited, 0.1);
                synth.play();
                for (let i = 0; i < 4; i++) {
                    output.next();
                }
                if (action === 'pause') {
                    synth.pause();
                    // Regression: worker refill messages can arrive after pause.
                    // An idle request must not finish the stream for the next play.
                    output.next();
                    output.next();
                    output.consume();
                    output.consume();
                    synth.play();
                } else {
                    synth.tickPosition = 0;
                }
                results.push(drain(synth, output));
            }
            // Seeking deliberately quick-releases existing voices. Preserve that
            // behavior, but never replay a stale limiter buffer from before the seek.
            expectSame(results[1], results[0]);
        }
    });

    it('limits overload and survives repeated loop transitions', async () => {
        const { synth, output } = await create(true, 20);
        let loops = 0;
        synth.isLooping = true;
        synth.finished.on(() => {
            loops++;
            if (loops === 3) {
                synth.isLooping = false;
            }
        });
        synth.play();
        const samples = drain(synth, output);
        expect(loops).toBeGreaterThanOrEqual(3);
        expect(samples.some(value => Math.abs(value) > 0.1)).toBe(true);
        expect(samples.every(value => Number.isFinite(value) && Math.abs(value) <= 0.950001)).toBe(true);
    });
});
