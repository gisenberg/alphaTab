import type { EventEmitter, IEventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import {
    type AlphaTabMetronomeEvent,
    type MidiEvent,
    MidiEventType,
    type TempoChangeEvent,
    type TimeSignatureEvent
} from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import type { Score } from '@coderline/alphatab/model/Score';
import { AlphaSynthBase } from '@coderline/alphatab/synth/AlphaSynth';
import { Queue } from '@coderline/alphatab/synth/ds/Queue';
import type { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import type { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

/**
 * A synth output for playing backing tracks.
 * @public
 */
export interface IBackingTrackSynthOutput extends ISynthOutput {
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

    /**
     * Schedules a count-in click relative to the moment the count-in starts.
     * @param offsetMilliseconds The delay from the start of the count-in.
     * @param accent Whether the click is the accented first beat of a bar.
     * @param volume The count-in volume.
     */
    scheduleCountInClick?(offsetMilliseconds: number, accent: boolean, volume: number): void;

    /**
     * Starts the media once the count-in elapsed.
     * Outputs without this member cannot play a count-in; the player then starts the media immediately.
     * @param durationMilliseconds The count-in duration in real time.
     */
    playAfterCountIn?(durationMilliseconds: number): void;
}

/**
 * Queues sequenced events for the player instead of rendering audio. The player decides which
 * of them become scheduled clicks or played-event notifications; events sequenced outside of
 * {@link collectEvents} (silent seeks) only update the tempo state and are discarded.
 * @internal
 */
class BackingTrackAudioSynthesizer implements IAudioSampleSynthesizer {
    private _midiEventQueue: Queue<SynthEvent> = new Queue<SynthEvent>();
    private _collected: SynthEvent[] | null = null;

    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public outSampleRate: number = 44100;
    public currentTempo: number = 120;
    public timeSignatureNumerator: number = 4;
    public timeSignatureDenominator: number = 4;
    public activeVoiceCount: number = 0;

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
        this._drain();
    }

    /**
     * Runs a sequencing action and returns every event it dispatched, in order. The sequencer
     * drains the queue after each microbuffer, so the events are gathered while it runs.
     */
    public collectEvents(sequence: () => void): SynthEvent[] {
        const collected: SynthEvent[] = [];
        this._collected = collected;
        try {
            sequence();
            this._drain();
        } finally {
            this._collected = null;
        }
        return collected;
    }

    /**
     * Tracks the tempo and time signature like the real synthesizer does so a count-in started
     * in the middle of the song uses the current values instead of the defaults.
     */
    private _processMidiMessage(e: MidiEvent): void {
        switch (e.type) {
            case MidiEventType.TimeSignature:
                const timeSignature = e as TimeSignatureEvent;
                this.timeSignatureNumerator = timeSignature.numerator;
                this.timeSignatureDenominator = Math.pow(2, timeSignature.denominatorIndex);
                break;
            case MidiEventType.TempoChange:
                const tempoChange = e as TempoChangeEvent;
                this.currentTempo = tempoChange.beatsPerMinute;
                break;
        }
    }

    public dispatchEvent(synthEvent: SynthEvent): void {
        this._midiEventQueue.enqueue(synthEvent);
    }

    public synthesize(_buffer: Float32Array, _bufferPos: number, _sampleCount: number): SynthEvent[] {
        return this._drain();
    }

    private _drain(): SynthEvent[] {
        const processedEvents: SynthEvent[] = [];
        const collected = this._collected;
        while (!this._midiEventQueue.isEmpty) {
            const m: SynthEvent = this._midiEventQueue.dequeue()!;
            if (!m.isMetronome && m.event) {
                this._processMidiMessage(m.event);
            }
            processedEvents.push(m);
            if (collected) {
                collected.push(m);
            }
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
    private _backingTrackSynthesizer: BackingTrackAudioSynthesizer;
    private _countInUnsupportedWarned: boolean = false;

    constructor(backingTrackOutput: IBackingTrackSynthOutput, bufferTimeInMilliseconds: number) {
        super(backingTrackOutput, new BackingTrackAudioSynthesizer(), bufferTimeInMilliseconds);
        this._backingTrackSynthesizer = this.synthesizer as BackingTrackAudioSynthesizer;
        this._backingTrackOutput = backingTrackOutput;
        backingTrackOutput.timeUpdate.on(timePosition => this._onMediaTimeUpdate(timePosition));
    }

    private _onMediaTimeUpdate(timePosition: number): void {
        const alphaTabTimePosition = this.sequencer.mainTimePositionFromBackingTrack(
            timePosition,
            this._backingTrackOutput.backingTrackDuration
        );
        // Preserve external-media seeks while paused, without scheduling clicks
        // or emitting a second finish for queued timeupdate/seeked events.
        if (this.state !== PlayerState.Playing) {
            this.updateTimePosition(alphaTabTimePosition, false);
            return;
        }

        // The media only starts once the count-in elapsed, so its first time update is the moment
        // the main score takes the transport back. The sample-driven path performs the same
        // handoff in checkForFinish once the last count-in sample was played.
        if (this.state === PlayerState.Playing && this.sequencer.isPlayingCountIn) {
            if (!this._finishCountInFromMedia(alphaTabTimePosition)) {
                // The media was re-positioned, its next update reports the real position.
                return;
            }
        }

        const scheduleTo = Math.min(
            this.sequencer.currentEndTime,
            alphaTabTimePosition + BackingTrackPlayer._metronomeLookaheadMilliseconds
        );
        this._processSequencedEvents(
            this._backingTrackSynthesizer.collectEvents(() => this.sequencer.fillMidiEventQueueToEndTime(scheduleTo))
        );

        this.updateTimePosition(alphaTabTimePosition, false);
        this.checkForFinish();
    }

    /**
     * Schedules metronome clicks ahead of the media and queues played events, which is what the
     * real synthesizer does while rendering samples.
     */
    private _processSequencedEvents(events: SynthEvent[]): void {
        const output = this._backingTrackOutput;
        const metronomeVolume = this.metronomeVolume;
        for (const e of events) {
            if (e.isMetronome && metronomeVolume > 0) {
                const metronome = e.event as AlphaTabMetronomeEvent;
                output.scheduleMetronomeClick?.(
                    this.sequencer.mainTimePositionToBackingTrack(
                        e.time / this.sequencer.playbackSpeed,
                        output.backingTrackDuration
                    ),
                    metronome.metronomeNumerator === 0,
                    metronomeVolume
                );
            }
            if (this.midiEventsPlayedFilterSet.has(e.event.type)) {
                this.playedEventsQueue.enqueue(e);
            }
        }
    }

    protected override startCountIn(): void {
        const output = this._backingTrackOutput;
        if (!output.playAfterCountIn) {
            if (!this._countInUnsupportedWarned) {
                this._countInUnsupportedWarned = true;
                Logger.warning('AlphaSynth', 'The backing track output cannot play a count-in, starting playback directly');
            }
            this.output.play();
            return;
        }

        Logger.debug('AlphaSynth', 'Starting countin (backing track)');
        this.sequencer.startCountIn();
        this.updateTimePosition(0, true);

        // The media is not a synthesizer which could render the count-in sample by sample:
        // sequence the whole count-in now, schedule its clicks ahead on the output and let the
        // media start once the count-in elapsed.
        const durationMilliseconds = this.sequencer.currentEndTime;
        const countInEvents = this._backingTrackSynthesizer.collectEvents(() =>
            this.sequencer.fillMidiEventQueueToEndTime(durationMilliseconds)
        );
        const countInVolume = this.countInVolume;
        for (const e of countInEvents) {
            if (e.isMetronome) {
                const metronome = e.event as AlphaTabMetronomeEvent;
                output.scheduleCountInClick?.(
                    e.time / this.sequencer.playbackSpeed,
                    metronome.metronomeNumerator === 0,
                    countInVolume
                );
            }
        }
        output.playAfterCountIn(durationMilliseconds);
    }

    /**
     * @returns Whether the reported media position is the main position. `false` when the media
     * was re-positioned to follow a seek deferred during the count-in.
     */
    private _finishCountInFromMedia(mediaTimePosition: number): boolean {
        Logger.debug('AlphaSynth', 'Finished playback (count-in, backing track)');
        const seekPending = this.sequencer.hasPendingMainSeek;
        this.sequencer.resetCountIn();
        if (seekPending) {
            // The media started where it was paused. Follow the seek which was deferred while the
            // count-in owned the transport.
            this.timePosition = this.sequencer.currentTime;
        } else {
            // The media already plays at the main position: adopt it without seeking the media again.
            super.updateTimePosition(mediaTimePosition, true);
        }
        this.playInternal();
        this.output.resetSamples();
        return !seekPending;
    }

    public override playOneTimeMidiFile(_midi: MidiFile): void {
        // A backing track cannot render arbitrary MIDI; starting the media for the duration of
        // the file would only play an unrelated slice of the recording.
        Logger.debug('AlphaSynth', 'One-time MIDI playback is not supported with backing tracks');
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
        // Count-in and one-time positions are not positions in the media.
        if (isSeek && this.sequencer.isPlayingMain) {
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
