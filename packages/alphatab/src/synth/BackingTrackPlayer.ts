import type { EventEmitter, IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import type { MidiEvent } from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import type { Score } from '@coderline/alphatab/model/Score';
import { AlphaSynthBase } from '@coderline/alphatab/synth/AlphaSynth';
import { Queue } from '@coderline/alphatab/synth/ds/Queue';
import type { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import type { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';
import type { AlphaTabMetronomeEvent } from '@coderline/alphatab/midi/MidiEvent';
import type { TransportClock } from '@coderline/alphatab/synth/TransportClock';

/**
 * A synth output for playing backing tracks.
 * @public
 */
export interface IBackingTrackSynthOutput extends ISynthOutput {
    /** The monotonic clock used for media, cursor and auxiliary-audio scheduling. */
    readonly transportClock?: TransportClock;
    /**
     * An event fired when the playback time changes. The time is in absolute milliseconds.
     */
    readonly timeUpdate: IEventEmitterOfT<number>;
    /**
     * The total duration of the backing track in milliseconds.
     */
    readonly backingTrackDuration: number;
    /**
     * The playback rate at which the output should playback.
     */
    playbackRate: number;
    /**
     * The volume at which the output should play (0-1)
     */
    masterVolume: number;
    /**
     * Instructs the output to seek to the given time position.
     * @param time The absolute time in milliseconds.
     */
    seekTo(time: number): void;

    /**
     * Instructs the output to load the given backing track.
     * @param backingTrack The backing track to load.
     */
    loadBackingTrack(backingTrack: BackingTrack): void;

    /** Schedules a metronome click on the same transport as the backing track. */
    scheduleMetronomeClick?(backingTrackTime: number, accent: boolean, volume: number): void;

    /** Cancels metronome clicks which have not reached the output yet. */
    cancelScheduledMetronomeClicks?(): void;
}

/**
 * @internal
 */
class BackingTrackAudioSynthesizer implements IAudioSampleSynthesizer {
    private _midiEventQueue: Queue<SynthEvent> = new Queue<SynthEvent>();

    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public outSampleRate: number = 44100;
    public currentTempo: number = 120;
    public timeSignatureNumerator: number = 4;
    public timeSignatureDenominator: number = 4;
    public activeVoiceCount: number = 0;
    public output!: IBackingTrackSynthOutput;
    public mainTimeToBackingTrack: (time: number) => number = time => time;

    public noteOffAll(_immediate: boolean): void {
        // not supported, ignore
    }

    public resetSoft(): void {
        // not supported, ignore
    }

    public resetPresets(): void {
        // not supported, ignore
    }

    public loadPresets(
        _hydra: Hydra,
        _instrumentPrograms: Set<number>,
        _percussionKeys: Set<number>,
        _append: boolean
    ): void {
        // not supported, ignore
    }

    public setupMetronomeChannel(_metronomeChannel: number, _metronomeVolume: number): void {
        // not supported, ignore
    }

    public synthesizeSilent(_sampleCount: number): void {
        this.fakeSynthesize();
    }

    private _processMidiMessage(_e: MidiEvent): void {}

    public dispatchEvent(synthEvent: SynthEvent): void {
        this._midiEventQueue.enqueue(synthEvent);
    }

    public synthesize(_buffer: Float32Array, _bufferPos: number, _sampleCount: number): SynthEvent[] {
        return this.fakeSynthesize();
    }

    public fakeSynthesize(): SynthEvent[] {
        const processedEvents: SynthEvent[] = [];
        while (!this._midiEventQueue.isEmpty) {
            const m: SynthEvent = this._midiEventQueue.dequeue()!;
            if (m.isMetronome && this.metronomeVolume > 0) {
                const metronome = m.event as AlphaTabMetronomeEvent;
                this.output.scheduleMetronomeClick?.(
                    this.mainTimeToBackingTrack(m.time),
                    metronome.metronomeNumerator === 0,
                    this.metronomeVolume
                );
            } else if (m.event) {
                this._processMidiMessage(m.event);
            }
            processedEvents.push(m);
        }
        return processedEvents;
    }

    public applyTranspositionPitches(_transpositionPitches: Map<number, number>): void {
        // not supported, ignore
    }
    public setChannelTranspositionPitch(_channel: number, _semitones: number): void {
        // not supported, ignore
    }
    public channelSetMute(_channel: number, _mute: boolean): void {
        // not supported, ignore
    }
    public channelSetSolo(_channel: number, _solo: boolean): void {
        // not supported, ignore
    }
    public resetChannelStates(): void {
        // not supported, ignore
    }
    public channelSetMixVolume(_channel: number, _volume: number): void {
        // not supported, ignore
    }
    public hasSamplesForProgram(_program: number): boolean {
        return true;
    }
    public hasSamplesForPercussion(_key: number): boolean {
        return true;
    }
}

/**
 * @internal
 */
export class BackingTrackPlayer extends AlphaSynthBase {
    private static readonly _metronomeLookaheadMilliseconds: number = 150;
    private _backingTrackOutput: IBackingTrackSynthOutput;
    constructor(backingTrackOutput: IBackingTrackSynthOutput, bufferTimeInMilliseconds: number) {
        super(backingTrackOutput, new BackingTrackAudioSynthesizer(), bufferTimeInMilliseconds);
        const backingTrackSynthesizer = this.synthesizer as BackingTrackAudioSynthesizer;
        backingTrackSynthesizer.output = backingTrackOutput;
        backingTrackSynthesizer.mainTimeToBackingTrack = time =>
            this.sequencer.mainTimePositionToBackingTrack(time, backingTrackOutput.backingTrackDuration);
        this._backingTrackOutput = backingTrackOutput;

        backingTrackOutput.timeUpdate.on(timePosition => {
            const alphaTabTimePosition = this.sequencer.mainTimePositionFromBackingTrack(
                timePosition,
                backingTrackOutput.backingTrackDuration
            );

            const scheduleTo = Math.min(
                this.sequencer.currentEndTime,
                alphaTabTimePosition + BackingTrackPlayer._metronomeLookaheadMilliseconds
            );
            this.sequencer.fillMidiEventQueueToEndTime(scheduleTo);
            backingTrackSynthesizer.fakeSynthesize();

            this.updateTimePosition(alphaTabTimePosition, false);
            this.checkForFinish();
        });
    }

    protected override updateMasterVolume(value: number): void {
        super.updateMasterVolume(value);
        this._backingTrackOutput.masterVolume = value;
    }

    protected override updatePlaybackSpeed(value: number): void {
        super.updatePlaybackSpeed(value);
        this._backingTrackOutput.playbackRate = value;
    }

    protected override onSampleRequest(): void {
        // should never be called
    }

    public override loadMidiFile(midi: MidiFile): void {
        if (!this.isSoundFontLoaded) {
            this.isSoundFontLoaded = true;
            (this.soundFontLoaded as EventEmitter).trigger();
        }
        super.loadMidiFile(midi);
    }

    protected override updateTimePosition(timePosition: number, isSeek: boolean): void {
        super.updateTimePosition(timePosition, isSeek);
        if (isSeek) {
            this._backingTrackOutput.cancelScheduledMetronomeClicks?.();
            this._backingTrackOutput.seekTo(
                this.sequencer.mainTimePositionToBackingTrack(
                    timePosition,
                    this._backingTrackOutput.backingTrackDuration
                )
            );
        }
    }

    public override loadBackingTrack(score: Score): void {
        const backingTrackInfo = score.backingTrack;
        if (backingTrackInfo) {
            this._backingTrackOutput.loadBackingTrack(backingTrackInfo);
            this.timePosition = 0;
        }
    }

    public override updateSyncPoints(syncPoints: BackingTrackSyncPoint[]): void {
        this.sequencer.mainUpdateSyncPoints(syncPoints);
        this.tickPosition = this.tickPosition;
    }
}
