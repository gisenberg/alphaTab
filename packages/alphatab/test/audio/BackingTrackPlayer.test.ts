import { describe, expect, it } from 'vitest';
import { EventEmitter, EventEmitterOfT, type IEventEmitter, type IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import { BackingTrackPlayer, type IBackingTrackSynthOutput } from '@coderline/alphatab/synth/BackingTrackPlayer';
import type { ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';
import type { MidiEventsPlayedEventArgs } from '@coderline/alphatab/synth/MidiEventsPlayedEventArgs';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { TestPlatform } from 'test/TestPlatform';
import { Settings } from '@coderline/alphatab/Settings';

interface ScheduledClick {
    time: number;
    accent: boolean;
    volume: number;
}

/**
 * A media output which records what the player asks of it. The media never advances on its own:
 * tests report positions explicitly, like the audio element does through its time updates.
 */
class RecordingBackingTrackOutput implements IBackingTrackSynthOutput {
    public readonly sampleRate: number = 44100;
    public backingTrackDuration: number = 16000;
    public playbackRate: number = 1;
    public masterVolume: number = 1;
    public seekTimes: number[] = [];
    public playCalls: number = 0;
    public pauseCalls: number = 0;
    public metronomeClicks: ScheduledClick[] = [];
    public countInClicks: ScheduledClick[] = [];
    public countInDurations: number[] = [];
    public cancelledClicks: number = 0;

    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly samplesPlayed: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly timeUpdate: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly sampleRequest: IEventEmitter = new EventEmitter();

    public reportTime(time: number): void {
        (this.timeUpdate as EventEmitterOfT<number>).trigger(time);
    }

    public seekTo(time: number): void {
        this.seekTimes.push(time);
    }
    public loadBackingTrack(_backingTrack: BackingTrack): void {}
    public scheduleMetronomeClick(backingTrackTime: number, accent: boolean, volume: number): void {
        this.metronomeClicks.push({ time: backingTrackTime, accent, volume });
    }
    public cancelScheduledMetronomeClicks(): void {
        this.cancelledClicks++;
    }
    public scheduleCountInClick(offsetMilliseconds: number, accent: boolean, volume: number): void {
        this.countInClicks.push({ time: offsetMilliseconds, accent, volume });
    }
    public playAfterCountIn(durationMilliseconds: number): void {
        this.countInDurations.push(durationMilliseconds);
    }
    public open(_bufferTimeInMilliseconds: number): void {
        (this.ready as EventEmitter).trigger();
    }
    public play(): void {
        this.playCalls++;
    }
    public pause(): void {
        this.pauseCalls++;
    }
    public destroy(): void {}
    public addSamples(_samples: Float32Array): void {}
    public resetSamples(): void {}
    public activate(): void {}
    public async enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return [];
    }
    public async setOutputDevice(_device: ISynthOutputDevice | null): Promise<void> {}
    public async getOutputDevice(): Promise<ISynthOutputDevice | null> {
        return null;
    }
}

/** A media output without count-in support, like a custom external media integration. */
class PlainBackingTrackOutput extends RecordingBackingTrackOutput {
    public constructor() {
        super();
        const optional = this as { scheduleCountInClick?: unknown; playAfterCountIn?: unknown };
        optional.scheduleCountInClick = undefined;
        optional.playAfterCountIn = undefined;
    }
}

function createMidi(): MidiFile {
    // 8 bars of quarter notes at 120bpm -> 16 seconds, one note every 500ms.
    const bar = ':4 C4 D4 E4 F4';
    const score = ScoreLoader.loadAlphaTex(`\\tempo 120 . \\ts 4 4 ${new Array(8).fill(bar).join(' | ')}`);
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
    return midi;
}

function createPlayer(output: RecordingBackingTrackOutput): BackingTrackPlayer {
    const player = new BackingTrackPlayer(output, 500);
    player.loadMidiFile(createMidi());
    // Loading rewinds the media; the tests only care about the seeks they cause themselves.
    output.seekTimes = [];
    return player;
}

describe('BackingTrackPlayer', () => {
    it.each([0.5, 1, 1.5])('finishes the synchronized backing fixture once at its media endpoint at speed %s', async speed => {
        const score = ScoreLoader.loadScoreFromBytes(await TestPlatform.loadFile('test-data/audio/syncpoints-testfile.gp'), new Settings());
        const midi = new MidiFile();
        const generator = new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi));
        generator.generate();
        const output = new RecordingBackingTrackOutput();
        output.backingTrackDuration = 42000;
        const player = new BackingTrackPlayer(output, 500);
        player.loadMidiFile(midi);
        player.updateSyncPoints(generator.syncPoints);
        player.playbackSpeed = speed;
        player.timePosition = 48000 / speed;
        expect(output.seekTimes[output.seekTimes.length - 1]).toBe(output.backingTrackDuration);
        player.timePosition = 0;
        let finished = 0;
        player.finished.on(() => finished++);
        player.play();
        for (let time = 0; time <= output.backingTrackDuration; time += 50) {
            output.reportTime(time);
        }
        // Regression: rounded imported sync points left this fixture five ticks short.
        expect(finished).toBe(1);
        expect(player.state).toBe(PlayerState.Paused);
        output.reportTime(output.backingTrackDuration);
        expect(finished).toBe(1);
    });

    it('updates paused media seeks without scheduling fresh metronome clicks', () => {
        const output = new RecordingBackingTrackOutput();
        const player = createPlayer(output);
        player.metronomeVolume = 1;
        player.play();
        output.reportTime(0);
        player.pause();
        const clickCount = output.metronomeClicks.length;
        output.reportTime(8000);
        expect(player.timePosition).toBe(8000);
        expect(output.metronomeClicks).toHaveLength(clickCount);
        expect(player.state).toBe(PlayerState.Paused);
    });
    it('plays the count-in ahead of the media and hands the transport back on the first media update', () => {
        const output = new RecordingBackingTrackOutput();
        const player = createPlayer(output);
        player.countInVolume = 0.8;
        player.timePosition = 8000;
        expect(output.seekTimes).toEqual([8000]);
        output.seekTimes = [];

        expect(player.play()).toBe(true);
        expect(player.state).toBe(PlayerState.Playing);

        // The media waits for the count-in and is not moved to the count-in's own time 0.
        expect(output.playCalls).toBe(0);
        expect(output.seekTimes).toEqual([]);
        expect(output.countInDurations).toHaveLength(1);
        expect(output.countInDurations[0]).toBeCloseTo(2000);
        expect(output.countInClicks.map(c => Math.round(c.time))).toEqual([0, 500, 1000, 1500]);
        expect(output.countInClicks.map(c => c.accent)).toEqual([true, false, false, false]);
        expect(output.countInClicks.every(c => c.volume === 0.8)).toBe(true);

        // The output starts the media once the count-in elapsed; the first position it reports is
        // the moment the main score owns the transport again (like checkForFinish on the synth path).
        output.reportTime(8000);
        expect(player.timePosition).toBe(8000);
        expect(output.seekTimes).toEqual([]);
        expect(player.state).toBe(PlayerState.Playing);

        // Regression: this update used to spin forever because the main clock never advanced while
        // the count-in was current. Now the main score continues from bar 5.
        output.reportTime(8100);
        expect(player.timePosition).toBe(8100);
        expect(player.tickPosition).toBeGreaterThanOrEqual(3840 * 4);
    });

    it('follows a seek deferred during the count-in once the media started', () => {
        const output = new RecordingBackingTrackOutput();
        const player = createPlayer(output);
        player.countInVolume = 1;
        player.play();

        // A seek during the count-in must neither move the media early nor get lost.
        player.timePosition = 8000;
        expect(output.seekTimes).toEqual([]);

        // The media started where it was paused (0); the player moves it to the deferred position
        // and ignores the stale position instead of flashing the cursor back to bar 1.
        output.reportTime(0);
        expect(output.seekTimes).toEqual([8000]);
        expect(player.timePosition).toBe(8000);

        output.reportTime(8000);
        expect(player.timePosition).toBe(8000);
        expect(output.seekTimes).toEqual([8000]);
    });

    it('restarts the count-in after a pause and never starts the media during it', () => {
        const output = new RecordingBackingTrackOutput();
        const player = createPlayer(output);
        player.countInVolume = 1;

        player.play();
        player.pause();
        expect(player.state).toBe(PlayerState.Paused);
        expect(output.pauseCalls).toBe(1);
        expect(output.playCalls).toBe(0);

        player.play();
        expect(output.countInDurations).toHaveLength(2);
        expect(output.playCalls).toBe(0);
    });

    it('starts the media directly when the output cannot play a count-in', () => {
        const output = new PlainBackingTrackOutput();
        const player = createPlayer(output);
        player.countInVolume = 1;

        expect(player.play()).toBe(true);
        expect(output.playCalls).toBe(1);

        output.reportTime(600);
        expect(player.state).toBe(PlayerState.Playing);
        expect(player.timePosition).toBe(600);
    });

    it('schedules metronome clicks ahead of the media and reports played events', () => {
        const output = new RecordingBackingTrackOutput();
        const player = createPlayer(output);
        player.metronomeVolume = 0.5;
        player.midiEventsPlayedFilter = [MidiEventType.AlphaTabMetronome];
        const played: MidiEventsPlayedEventArgs[] = [];
        player.midiEventsPlayed.on(e => played.push(e));

        player.play();
        expect(output.playCalls).toBe(1);

        // Clicks are scheduled up to the lookahead beyond the reported media position.
        output.reportTime(0);
        expect(output.metronomeClicks).toEqual([{ time: 0, accent: true, volume: 0.5 }]);
        output.reportTime(400);
        expect(output.metronomeClicks.map(c => Math.round(c.time))).toEqual([0, 500]);

        // Played events are reported once the media passed them, and never as count-in.
        expect(played).toHaveLength(1);
        expect(played[0].isCountIn).toBe(false);
        expect(played[0].events[0].type).toBe(MidiEventType.AlphaTabMetronome);
    });
});
