import {
    MidiEventType,
    type NoteOnEvent,
    type ProgramChangeEvent,
    type TempoChangeEvent,
    type TimeSignatureEvent
} from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import type { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';
import { Logger } from '@coderline/alphatab/Logger';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { MidiUtils } from '@coderline/alphatab/midi/MidiUtils';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import { BackingTrackSyncPoint } from '@coderline/alphatab/synth/IAlphaSynth';

/**
 * @internal
 */
export class MidiFileSequencerTempoChange {
    public bpm: number;
    public ticks: number;
    public time: number;

    public constructor(bpm: number, ticks: number, time: number) {
        this.bpm = bpm;
        this.ticks = ticks;
        this.time = time;
    }
}

/**
 * @internal
 */
class MidiSequencerState {
    public tempoChanges: MidiFileSequencerTempoChange[] = [];
    public tempoChangeIndex: number = 0;
    public syncPoints: BackingTrackSyncPoint[] = [];
    public firstProgramEventPerChannel: Map<number, SynthEvent> = new Map();
    public firstTimeSignatureNumerator: number = 0;
    public firstTimeSignatureDenominator: number = 0;
    public synthData: SynthEvent[] = [];
    public division: number = MidiUtils.QuarterTime;
    public eventIndex: number = 0;
    public currentTime: number = 0;
    public syncPointIndex: number = 0;
    public playbackRange: PlaybackRange | null = null;
    public playbackRangeStartTime: number = 0;
    public playbackRangeEndTime: number = 0;
    public endTick: number = 0;
    public endTime: number = 0;
    public currentTempo: number = 0;
    public syncPointTempo: number = 0;
    public metronomeChannel: number = SynthConstants.DefaultChannelCount - 1;
}

/**
 * This sequencer dispatches midi events to the synthesizer based on the current
 * synthesize position. The sequencer does not consider the playback speed.
 * @internal
 */
export class MidiFileSequencer {
    private _synthesizer: IAudioSampleSynthesizer;
    private _currentState: MidiSequencerState;
    private _mainState: MidiSequencerState;
    private _oneTimeState: MidiSequencerState | null = null;
    private _countInState: MidiSequencerState | null = null;
    /** Absolute (speed=1) seek target requested while another state owned the synthesizer. */
    private _pendingMainSeekTime: number | null = null;

    public get metronomeChannel() {
        return this._mainState.metronomeChannel;
    }

    public get isPlayingMain(): boolean {
        return this._currentState === this._mainState;
    }

    public get isPlayingOneTimeMidi(): boolean {
        return this._currentState === this._oneTimeState;
    }

    public get isPlayingCountIn(): boolean {
        return this._currentState === this._countInState;
    }

    public constructor(synthesizer: IAudioSampleSynthesizer) {
        this._synthesizer = synthesizer;
        this._mainState = new MidiSequencerState();
        this._currentState = this._mainState;
    }

    public get mainPlaybackRange(): PlaybackRange | null {
        return this._mainState.playbackRange;
    }

    public set mainPlaybackRange(value: PlaybackRange | null) {
        this._mainState.playbackRange = value;
        if (value) {
            this._mainState.playbackRangeStartTime = this._tickPositionToTimePositionWithSpeed(
                this._mainState,
                value.startTick,
                1
            );
            this._mainState.playbackRangeEndTime = this._tickPositionToTimePositionWithSpeed(
                this._mainState,
                value.endTick,
                1
            );
        }
    }

    public isLooping: boolean = false;

    public get currentTime() {
        return this._currentState.currentTime / this.playbackSpeed;
    }

    /**
     * Gets the duration of the song in ticks.
     */
    public get currentEndTick() {
        return this._currentState.endTick;
    }

    public get currentEndTime(): number {
        return this._currentState.endTime / this.playbackSpeed;
    }

    public get currentTempo(): number {
        return this._currentState.currentTempo;
    }

    public get modifiedTempo(): number {
        return this._currentState.syncPointTempo * this.playbackSpeed;
    }

    public get syncPointTempo(): number {
        return this._currentState.syncPointTempo;
    }

    public get currentSyncPoints(): BackingTrackSyncPoint[] {
        return this._currentState.syncPoints;
    }

    /**
     * Gets or sets the playback speed.
     */
    public playbackSpeed: number = 1;

    public mainSeek(timePosition: number): void {
        // map to speed=1
        this._mainSeekAbsolute(timePosition * this.playbackSpeed);
    }

    private _mainSeekAbsolute(timePosition: number): void {
        // ensure playback range
        if (this.mainPlaybackRange) {
            if (timePosition < this._mainState.playbackRangeStartTime) {
                timePosition = this._mainState.playbackRangeStartTime;
            } else if (timePosition > this._mainState.playbackRangeEndTime) {
                timePosition = this._mainState.playbackRangeEndTime;
            }
        }

        // The count-in and one-time MIDI files own the synthesizer while they play, so the main
        // state cannot be silently processed here: its events would be dispatched into that
        // render. Advancing only its time would be worse - the main state would resume with a
        // stale event index and the next microbuffer would dispatch every skipped event at once,
        // producing one simultaneous burst of note-ons. Defer the seek until the main state is
        // current again.
        if (!this.isPlayingMain) {
            this._pendingMainSeekTime = timePosition;
            return;
        }
        this._pendingMainSeekTime = null;

        if (timePosition > this._mainState.currentTime) {
            this._mainSilentProcess(timePosition - this._mainState.currentTime);
        } else if (timePosition < this._mainState.currentTime) {
            // we have to restart the midi to make sure we get the right state: instruments, volume, pan, etc
            MidiFileSequencer._resetStateToStart(this._mainState);
            const metronomeVolume: number = this._synthesizer.metronomeVolume;
            this._synthesizer.noteOffAll(true);
            this._synthesizer.resetSoft();
            this._synthesizer.setupMetronomeChannel(this.metronomeChannel, metronomeVolume);
            this._mainSilentProcess(timePosition);
        }
    }

    /**
     * Rewinds a state to the very beginning of its timeline. Time and event index must always be
     * reset together: a non-zero time with a stale event index makes the next microbuffer dispatch
     * every skipped event simultaneously.
     */
    private static _resetStateToStart(state: MidiSequencerState): void {
        state.currentTime = 0;
        state.eventIndex = 0;
        state.syncPointIndex = 0;
        state.tempoChangeIndex = 0;
        state.currentTempo = state.tempoChanges.length > 0 ? state.tempoChanges[0].bpm : state.currentTempo;
        state.syncPointTempo = state.syncPoints.length > 0 ? state.syncPoints[0].syncBpm : state.currentTempo;
    }

    private _applyPendingMainSeek(): void {
        const pendingMainSeekTime = this._pendingMainSeekTime;
        if (pendingMainSeekTime === null) {
            return;
        }
        this._pendingMainSeekTime = null;
        this._mainSeekAbsolute(pendingMainSeekTime);
    }

    private _mainSilentProcess(milliseconds: number): void {
        if (milliseconds <= 0) {
            return;
        }

        const start: number = Date.now();
        const finalTime: number = this._mainState.currentTime + milliseconds;

        while (this._mainState.currentTime < finalTime) {
            if (this._fillMidiEventQueueLimited(finalTime - this._mainState.currentTime)) {
                this._synthesizer.synthesizeSilent(SynthConstants.MicroBufferSize);
            }
        }

        this._mainState.currentTime = finalTime;

        const duration: number = Date.now() - start;
        Logger.debug('Sequencer', `Silent seek finished in ${duration}ms (main)`);
    }

    public loadOneTimeMidi(midiFile: MidiFile): void {
        this._oneTimeState = this.createStateFromFile(midiFile);
        this._currentState = this._oneTimeState;
    }

    public get hasPendingMainSeek(): boolean {
        return this._pendingMainSeekTime !== null;
    }

    public instrumentPrograms: Set<number> = new Set<number>();
    public percussionKeys: Set<number> = new Set<number>();

    public loadMidi(midiFile: MidiFile): void {
        this.instrumentPrograms.clear();
        this.percussionKeys.clear();
        this._pendingMainSeekTime = null;
        this._mainState = this.createStateFromFile(midiFile);
        this._currentState = this._mainState;
    }

    public createStateFromFile(midiFile: MidiFile): MidiSequencerState {
        const state = new MidiSequencerState();

        this.percussionKeys.add(SynthConstants.MetronomeKey); // Metronome

        state.tempoChanges = [];

        state.division = midiFile.division;
        state.eventIndex = 0;
        state.currentTime = 0;

        // build synth events.
        state.synthData = [];

        // Converts midi to milliseconds for easy sequencing
        let bpm: number = 120;
        let absTick: number = 0;
        let absTime: number = 0.0;

        let metronomeCount: number = 0;
        let metronomeLengthInTicks: number = 0;
        let metronomeLengthInMillis: number = 0;
        let metronomeTick: number = midiFile.tickShift; // shift metronome to content
        let metronomeTime: number = 0.0;

        let maxChannel = 0;

        let previousTick: number = 0;
        for (const mEvent of midiFile.events) {
            const synthData: SynthEvent = new SynthEvent(state.synthData.length, mEvent);
            state.synthData.push(synthData);

            const deltaTick: number = mEvent.tick - previousTick;
            absTick += deltaTick;
            absTime += deltaTick * (60000.0 / (bpm * midiFile.division));
            synthData.time = absTime;
            previousTick = mEvent.tick;

            if (metronomeLengthInTicks > 0) {
                while (metronomeTick < absTick) {
                    const metronome: SynthEvent = SynthEvent.newMetronomeEvent(
                        state.synthData.length,
                        metronomeTick,
                        Math.floor(metronomeTick / metronomeLengthInTicks) % metronomeCount,
                        metronomeLengthInTicks,
                        metronomeLengthInMillis
                    );
                    state.synthData.push(metronome);
                    metronome.time = metronomeTime;
                    metronomeTick += metronomeLengthInTicks;
                    metronomeTime += metronomeLengthInMillis;
                }
            }

            if (mEvent.type === MidiEventType.TempoChange) {
                const meta: TempoChangeEvent = mEvent as TempoChangeEvent;
                bpm = MidiFileSequencer._sanitizeBpm(meta.beatsPerMinute);
                state.tempoChanges.push(new MidiFileSequencerTempoChange(bpm, absTick, absTime));
                metronomeLengthInMillis = metronomeLengthInTicks * (60000.0 / (bpm * midiFile.division));
            } else if (mEvent.type === MidiEventType.TimeSignature) {
                const meta: TimeSignatureEvent = mEvent as TimeSignatureEvent;
                const timeSignatureDenominator: number = Math.pow(2, meta.denominatorIndex);
                metronomeCount = meta.numerator;
                metronomeLengthInTicks = (state.division * (4.0 / timeSignatureDenominator)) | 0;
                metronomeLengthInMillis = metronomeLengthInTicks * (60000.0 / (bpm * midiFile.division));
                if (state.firstTimeSignatureDenominator === 0) {
                    state.firstTimeSignatureNumerator = meta.numerator;
                    state.firstTimeSignatureDenominator = timeSignatureDenominator;
                }
            } else if (mEvent.type === MidiEventType.ProgramChange) {
                const programChange = mEvent as ProgramChangeEvent;
                const channel: number = programChange.channel;
                if (!state.firstProgramEventPerChannel.has(channel)) {
                    state.firstProgramEventPerChannel.set(channel, synthData);
                }
                if (channel > maxChannel) {
                    maxChannel = channel;
                }
                const isPercussion = channel === SynthConstants.PercussionChannel;
                if (!isPercussion) {
                    this.instrumentPrograms.add(programChange.program);
                }
            } else if (mEvent.type === MidiEventType.NoteOn) {
                const noteOn = mEvent as NoteOnEvent;
                const isPercussion = noteOn.channel === SynthConstants.PercussionChannel;
                if (isPercussion) {
                    this.percussionKeys.add(noteOn.noteKey);
                }
                if (noteOn.channel > maxChannel) {
                    maxChannel = noteOn.channel;
                }
            }
        }

        state.currentTempo = state.tempoChanges.length > 0 ? state.tempoChanges[0].bpm : bpm;
        state.syncPointTempo = state.currentTempo;

        state.synthData.sort((a, b) => {
            if (a.time > b.time) {
                return 1;
            }
            if (a.time < b.time) {
                return -1;
            }
            return a.eventIndex - b.eventIndex;
        });
        state.endTime = absTime;
        state.endTick = absTick;
        state.metronomeChannel = maxChannel + 1;

        return state;
    }

    public fillMidiEventQueue(): boolean {
        if (this.isPlayingMain) {
            // The main state must never be sequenced while a deferred seek is outstanding.
            this._applyPendingMainSeek();
        }
        return this._fillMidiEventQueueLimited(-1);
    }

    /**
     * Sequences the state which currently owns the synthesizer up to the given time and
     * dispatches every event before it.
     * @param endTime The speed-adjusted playback time (same domain as {@link currentTime}).
     * @returns Whether any events were dispatched.
     */
    public fillMidiEventQueueToEndTime(endTime: number): boolean {
        if (this.isPlayingMain) {
            // The main state must never be sequenced while a deferred seek is outstanding.
            this._applyPendingMainSeek();
        }

        // `_fillMidiEventQueueLimited` only advances the state which is actually current. Looping
        // until the *main* clock reaches the target never terminates while the count-in or a
        // one-time MIDI file owns the synthesizer, which made a backing-track player spin forever
        // on its first media time update as soon as a count-in was enabled.
        const state = this._currentState;
        const absoluteEndTime = endTime * this.playbackSpeed;
        let anyEventsDispatched: boolean = false;
        while (state.currentTime < absoluteEndTime) {
            if (this._fillMidiEventQueueLimited(absoluteEndTime - state.currentTime)) {
                this._synthesizer.synthesizeSilent(SynthConstants.MicroBufferSize);
                anyEventsDispatched = true;
            }
        }

        state.currentTime = absoluteEndTime;
        while (state.eventIndex < state.synthData.length && state.synthData[state.eventIndex].time < state.currentTime) {
            const synthEvent = state.synthData[state.eventIndex];
            this._synthesizer.dispatchEvent(synthEvent);
            state.eventIndex++;
            anyEventsDispatched = true;
        }

        return anyEventsDispatched;
    }

    private _fillMidiEventQueueLimited(maxMilliseconds: number): boolean {
        let millisecondsPerBuffer: number =
            (SynthConstants.MicroBufferSize / this._synthesizer.outSampleRate) * 1000 * this.playbackSpeed;
        let endTime: number = this._internalEndTime;
        if (maxMilliseconds > 0) {
            // ensure that first microbuffer does not already exceed max time
            if (maxMilliseconds < millisecondsPerBuffer) {
                millisecondsPerBuffer = maxMilliseconds;
            }
            endTime = Math.min(this._internalEndTime, this._currentState.currentTime + maxMilliseconds);
        }

        let anyEventsDispatched: boolean = false;
        this._currentState.currentTime += millisecondsPerBuffer;
        while (
            this._currentState.eventIndex < this._currentState.synthData.length &&
            this._currentState.synthData[this._currentState.eventIndex].time < this._currentState.currentTime &&
            this._currentState.currentTime < endTime
        ) {
            this._synthesizer.dispatchEvent(this._currentState.synthData[this._currentState.eventIndex]);
            this._currentState.eventIndex++;
            anyEventsDispatched = true;
        }

        return anyEventsDispatched;
    }

    public mainTickPositionToTimePosition(tickPosition: number): number {
        return this._tickPositionToTimePositionWithSpeed(this._mainState, tickPosition, this.playbackSpeed);
    }

    public mainUpdateSyncPoints(syncPoints: BackingTrackSyncPoint[]) {
        const state = this._mainState;
        syncPoints.sort((a, b) => a.synthTick - b.synthTick); // just in case
        state.syncPoints = [];

        if (syncPoints.length >= 0) {
            let bpm: number = 120;
            let absTick: number = 0;
            let absTime: number = 0.0;

            let tempoChangeIndex = 0;

            for (let i = 0; i < syncPoints.length; i++) {
                const p = syncPoints[i];
                let deltaTick = 0;

                // TODO: merge interpolation into MidiFileGenerator where we already play through
                // the time axis.

                // remember state from previous sync point (or start). to handle linear interpolation
                let previousModifiedTempo: number;
                let previousMillisecondOffset: number;
                let previousTick: number;

                if (i === 0) {
                    previousModifiedTempo = bpm;
                    previousMillisecondOffset = 0;
                    previousTick = 0;
                } else {
                    const previousSyncPoint = syncPoints[i - 1];
                    previousModifiedTempo = MidiFileSequencer._sanitizeBpm(previousSyncPoint.syncBpm);
                    previousMillisecondOffset = previousSyncPoint.syncTime;
                    previousTick = previousSyncPoint.synthTick;
                }

                // process time until sync point
                // here it gets a bit tricky. if we have tempo changes on the synthesizer time axis (inbetween two sync points)
                // we have to calculate a interpolated sync point on the alphaTab time axis.
                // otherwise the linear interpolation later in the lookup will fail.
                // goal is to have always a linear increase between two points, no matter if the time axis is sliced by tempo changes or sync points
                while (
                    tempoChangeIndex < state.tempoChanges.length &&
                    state.tempoChanges[tempoChangeIndex].ticks <= p.synthTick
                ) {
                    deltaTick = state.tempoChanges[tempoChangeIndex].ticks - absTick;
                    if (deltaTick > 0) {
                        absTick += deltaTick;
                        absTime += deltaTick * (60000.0 / (bpm * state.division));

                        const millisPerTick = (p.syncTime - previousMillisecondOffset) / (p.synthTick - previousTick);
                        const interpolatedMillisecondOffset =
                            (absTick - previousTick) * millisPerTick + previousMillisecondOffset;

                        const syncPoint = new BackingTrackSyncPoint();
                        syncPoint.synthTick = absTick;
                        syncPoint.synthBpm = bpm;
                        syncPoint.synthTime = absTime;
                        syncPoint.syncTime = interpolatedMillisecondOffset;
                        syncPoint.syncBpm = previousModifiedTempo;
                    }

                    bpm = MidiFileSequencer._sanitizeBpm(state.tempoChanges[tempoChangeIndex].bpm);
                    tempoChangeIndex++;
                }

                deltaTick = p.synthTick - absTick;
                absTick += deltaTick;
                absTime += deltaTick * (60000.0 / (bpm * state.division));
                state.syncPoints.push(p);
            }
        }

        state.syncPointIndex = 0;
        state.syncPointTempo = state.syncPoints.length > 0 ? state.syncPoints[0].syncBpm : state.currentTempo;
    }

    public currentTimePositionToTickPosition(timePosition: number): number {
        const state = this._currentState;
        if (state.tempoChanges.length === 0) {
            return 0;
        }

        timePosition *= this.playbackSpeed;

        this._updateCurrentTempo(state, timePosition);
        const lastTempoChange = state.tempoChanges[state.tempoChangeIndex];
        const timeDiff = timePosition - lastTempoChange.time;
        const ticks =
            (timeDiff / (60000.0 / (MidiFileSequencer._sanitizeBpm(lastTempoChange.bpm) * state.division))) | 0;
        // we add 1 for possible rounding errors.(floating point issuses)
        return lastTempoChange.ticks + ticks + 1;
    }

    private static _sanitizeBpm(bpm: number) {
        return Math.max(bpm, 1); // prevent <0 bpms. Doesn't make sense and can cause endless loops
    }

    public currentUpdateCurrentTempo(timePosition: number) {
        this._updateCurrentTempo(this._mainState, timePosition * this.playbackSpeed);
    }

    private _updateCurrentTempo(state: MidiSequencerState, timePosition: number) {
        let tempoChangeIndex = state.tempoChangeIndex;
        if (timePosition < state.tempoChanges[tempoChangeIndex].time) {
            tempoChangeIndex = 0;
        }

        while (
            tempoChangeIndex + 1 < state.tempoChanges.length &&
            state.tempoChanges[tempoChangeIndex + 1].time <= timePosition
        ) {
            tempoChangeIndex++;
        }

        if (tempoChangeIndex !== state.tempoChangeIndex) {
            state.tempoChangeIndex = tempoChangeIndex;
            state.currentTempo = state.tempoChanges[state.tempoChangeIndex].bpm;

            if (state.syncPoints.length === 0) {
                state.syncPointTempo = state.currentTempo;
            }
        }
    }

    public currentUpdateSyncPoints(timePosition: number) {
        this._updateSyncPoints(this._mainState, timePosition);
    }

    private _updateSyncPoints(state: MidiSequencerState, timePosition: number) {
        const syncPoints = state.syncPoints;
        if (syncPoints.length > 0) {
            let syncPointIndex = Math.min(state.syncPointIndex, syncPoints.length - 1);
            if (timePosition < syncPoints[syncPointIndex].syncTime) {
                syncPointIndex = 0;
            }
            while (syncPointIndex + 1 < syncPoints.length && syncPoints[syncPointIndex + 1].syncTime <= timePosition) {
                syncPointIndex++;
            }
            if (syncPointIndex !== state.syncPointIndex) {
                state.syncPointIndex = syncPointIndex;
                state.syncPointTempo = syncPoints[syncPointIndex].syncBpm;
            }
        } else {
            state.syncPointTempo = state.currentTempo;
        }
    }

    public mainTimePositionFromBackingTrack(timePosition: number, backingTrackLength: number): number {
        const mainState = this._mainState;
        const syncPoints = mainState.syncPoints;

        // Imported sync points can end a few milliseconds beyond the decoded
        // media duration. The actual media endpoint must still reach the final tick.
        if (Number.isFinite(backingTrackLength) && backingTrackLength > 0 && timePosition >= backingTrackLength) {
            return mainState.endTime / this.playbackSpeed;
        }

        if (timePosition < 0 || syncPoints.length === 0) {
            return timePosition;
        }

        this._updateSyncPoints(this._mainState, timePosition);

        const syncPointIndex = Math.min(mainState.syncPointIndex, syncPoints.length - 1);

        const currentSyncPoint = syncPoints[syncPointIndex];
        const timeDiff = timePosition - currentSyncPoint.syncTime;

        let alphaTabTimeDiff: number;

        if (syncPointIndex + 1 < syncPoints.length) {
            const nextSyncPoint = syncPoints[syncPointIndex + 1];
            const relativeTimeDiff = timeDiff / (nextSyncPoint.syncTime - currentSyncPoint.syncTime);

            alphaTabTimeDiff = (nextSyncPoint.synthTime - currentSyncPoint.synthTime) * relativeTimeDiff;
        } else {
            const relativeTimeDiff = timeDiff / (backingTrackLength - currentSyncPoint.syncTime);
            alphaTabTimeDiff = (mainState.endTime - currentSyncPoint.synthTime) * relativeTimeDiff;
        }

        return (currentSyncPoint.synthTime + alphaTabTimeDiff) / this.playbackSpeed;
    }

    public mainTimePositionToBackingTrack(timePosition: number, backingTrackLength: number): number {
        const mainState = this._mainState;
        const syncPoints = mainState.syncPoints;
        if (Number.isFinite(backingTrackLength) && backingTrackLength > 0 && mainState.endTime > 0 &&
            timePosition * this.playbackSpeed >= mainState.endTime) {
            return backingTrackLength;
        }
        if (timePosition < 0 || syncPoints.length === 0) {
            return timePosition;
        }

        timePosition *= this.playbackSpeed;

        let syncPointIndex = Math.min(mainState.syncPointIndex, syncPoints.length - 1);
        if (timePosition < syncPoints[syncPointIndex].synthTime) {
            syncPointIndex = 0;
        }
        while (syncPointIndex + 1 < syncPoints.length && syncPoints[syncPointIndex + 1].synthTime <= timePosition) {
            syncPointIndex++;
        }

        // NOTE: this logic heavily relies on the interpolation done in mainUpdateSyncPoints
        // we ensure that we have a linear increase between two points
        const currentSyncPoint = syncPoints[syncPointIndex];
        const alphaTabTimeDiff = timePosition - currentSyncPoint.synthTime;

        let backingTrackPos: number;
        if (syncPointIndex + 1 < syncPoints.length) {
            const nextSyncPoint = syncPoints[syncPointIndex + 1];
            const relativeAlphaTabTimeDiff = alphaTabTimeDiff / (nextSyncPoint.synthTime - currentSyncPoint.synthTime);
            const backingTrackDiff = nextSyncPoint.syncTime - currentSyncPoint.syncTime;
            backingTrackPos = currentSyncPoint.syncTime + backingTrackDiff * relativeAlphaTabTimeDiff;
        } else {
            const relativeAlphaTabTimeDiff = alphaTabTimeDiff / (mainState.endTime - currentSyncPoint.synthTime);
            const frameDiff = backingTrackLength - currentSyncPoint.syncTime;
            backingTrackPos = currentSyncPoint.syncTime + frameDiff * relativeAlphaTabTimeDiff;
        }

        return backingTrackPos;
    }

    private _tickPositionToTimePositionWithSpeed(
        state: MidiSequencerState,
        tickPosition: number,
        playbackSpeed: number
    ): number {
        let timePosition: number = 0.0;
        let bpm: number = 120.0;
        let lastChange: number = 0;

        // find start and bpm of last tempo change before time
        for (const c of state.tempoChanges) {
            if (tickPosition < c.ticks) {
                break;
            }

            timePosition = c.time;
            bpm = c.bpm;
            lastChange = c.ticks;
        }

        // add the missing millis
        tickPosition -= lastChange;
        timePosition += tickPosition * (60000.0 / (bpm * state.division));

        return timePosition / playbackSpeed;
    }

    private get _internalEndTime(): number {
        if (this.isPlayingMain) {
            return !this.mainPlaybackRange ? this._currentState.endTime : this._currentState.playbackRangeEndTime;
        }
        return this._currentState.endTime;
    }

    public get isFinished(): boolean {
        return this._currentState.currentTime >= this._internalEndTime;
    }

    public stop(): void {
        // Stop always returns ownership to the main score. Rewinding only the active auxiliary
        // state leaves count-in or one-time MIDI current, so the following main seek is deferred
        // and the visible cursor remains parked at the old score position.
        this._countInState = null;
        this._oneTimeState = null;
        this._currentState = this._mainState;
        this._pendingMainSeekTime = null;

        // Rewind to the true start of the timeline. The caller seeks to the playback range start
        // afterwards, which replays the intervening program changes, volumes and tempo events
        // through the silent-process path. Parking `currentTime` at the range start here (it used
        // to be assigned the range start *tick* as if it were milliseconds) would leave the state
        // with a stale event index of zero.
        MidiFileSequencer._resetStateToStart(this._mainState);
    }

    public resetOneTimeMidi() {
        this._oneTimeState = null;
        this._currentState = this._mainState;
        this._applyPendingMainSeek();
    }

    public resetCountIn() {
        this._countInState = null;
        this._currentState = this._mainState;
        this._applyPendingMainSeek();
    }

    public startCountIn() {
        this.generateCountInMidi();
        this._currentState = this._countInState!;

        MidiFileSequencer._resetStateToStart(this._countInState!);
        this._synthesizer.noteOffAll(true);
    }

    generateCountInMidi() {
        const state = new MidiSequencerState();
        state.division = this._mainState.division;

        let bpm: number = 120;
        let timeSignatureNumerator = 4;
        let timeSignatureDenominator = 4;
        if (this._mainState.eventIndex === 0) {
            bpm = this._mainState.tempoChanges[0].bpm;
            timeSignatureNumerator = this._mainState.firstTimeSignatureNumerator;
            timeSignatureDenominator = this._mainState.firstTimeSignatureDenominator;
        } else {
            bpm = this._synthesizer.currentTempo;
            timeSignatureNumerator = this._synthesizer.timeSignatureNumerator;
            timeSignatureDenominator = this._synthesizer.timeSignatureDenominator;
        }

        state.tempoChanges.push(new MidiFileSequencerTempoChange(bpm, 0, 0));

        const metronomeLengthInTicks: number = (state.division * (4.0 / timeSignatureDenominator)) | 0;
        const metronomeLengthInMillis: number = metronomeLengthInTicks * (60000.0 / (bpm * this._mainState.division));
        let metronomeTick: number = 0;
        let metronomeTime: number = 0.0;

        for (let i = 0; i < timeSignatureNumerator; i++) {
            const metronome: SynthEvent = SynthEvent.newMetronomeEvent(
                state.synthData.length,
                metronomeTick,
                i,
                metronomeLengthInTicks,
                metronomeLengthInMillis
            );
            state.synthData.push(metronome);
            metronome.time = metronomeTime;
            metronomeTick += metronomeLengthInTicks;
            metronomeTime += metronomeLengthInMillis;
        }

        state.synthData.sort((a, b) => {
            if (a.time > b.time) {
                return 1;
            }
            if (a.time < b.time) {
                return -1;
            }
            return a.eventIndex - b.eventIndex;
        });
        state.endTime = metronomeTime;
        state.endTick = metronomeTick;
        state.currentTempo = bpm;
        state.syncPointTempo = bpm;
        this._countInState = state;
    }
}
