import { Environment } from '@coderline/alphatab/Environment';
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { LogLevel } from '@coderline/alphatab/LogLevel';
import type { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import { ModelUtils } from '@coderline/alphatab/model/ModelUtils';
import type { Score } from '@coderline/alphatab/model/Score';
import type {
    IAlphaSynthWorker,
    IAlphaSynthWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import type { Settings } from '@coderline/alphatab/Settings';
import type { SharedSampleBufferDescriptor } from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';
import { computeSoundFontCacheKey } from '@coderline/alphatab/platform/javascript/SoundFontCache';
import type { BackingTrackSyncPoint, IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
import type { ISynthOutput } from '@coderline/alphatab/synth/ISynthOutput';
import { MidiEventsPlayedEventArgs } from '@coderline/alphatab/synth/MidiEventsPlayedEventArgs';
import type { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
import { PlaybackRangeChangedEventArgs } from '@coderline/alphatab/synth/PlaybackRangeChangedEventArgs';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { PlayerStateChangedEventArgs } from '@coderline/alphatab/synth/PlayerStateChangedEventArgs';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { WorkerScoreCompilationCache } from '@coderline/alphatab/platform/worker/WorkerScoreCompilation';
import { TransportClock } from '@coderline/alphatab/synth/TransportClock';

/**
 * Options for an atomic SoundFont bank replacement.
 * @target web
 * @public
 */
export interface SoundFontBankLoadOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMilliseconds?: number;
}

/**
 * Raised when a newer bank request supersedes an older request.
 * @target web
 * @public
 */
export class SoundFontBankSupersededError extends Error {
    public constructor() {
        super('SoundFont bank request was superseded by a newer request');
        this.name = 'SoundFontBankSupersededError';
    }
}

interface PendingSoundFontBankOperation {
    readonly generation: number;
    readonly cacheKeys: string[];
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
    readonly signal?: AbortSignal;
    readonly abortHandler?: () => void;
}

/**
 * a WebWorker based alphaSynth which uses the given player as output.
 * @internal
 */
export class AlphaSynthWebWorkerApi implements IAlphaSynth {
    private _synth!: IAlphaSynthWorker;
    private _output: ISynthOutput;
    private _workerIsReadyForPlayback: boolean = false;
    private _workerIsReady: boolean = false;
    private _outputIsReady: boolean = false;
    private _state: PlayerState = PlayerState.Paused;
    private _masterVolume: number = 0;
    private _metronomeVolume: number = 0;
    private _countInVolume: number = 0;
    private _playbackSpeed: number = 0;
    private _isLooping: boolean = false;
    private _playbackRange: PlaybackRange | null = null;
    private _midiEventsPlayedFilter: MidiEventType[] = [];
    private _loadedMidiInfo?: PositionChangedEventArgs;
    private _currentPosition: PositionChangedEventArgs = new PositionChangedEventArgs(0, 0, 0, 0, false, 120, 120);
    private _nextOperationId = 1;
    private _soundFontGeneration = 0;
    private _pendingSoundFontOperations: Map<number, PendingSoundFontBankOperation> = new Map();
    private _knownSoundFontCacheKeys: Set<string> = new Set();
    private readonly _transportClock: TransportClock = new TransportClock();

    public get output(): ISynthOutput {
        return this._output;
    }

    public get isReady(): boolean {
        return this._workerIsReady && this._outputIsReady;
    }

    public get isReadyForPlayback(): boolean {
        return this._workerIsReadyForPlayback;
    }

    public get state(): PlayerState {
        return this._state;
    }

    public get logLevel(): LogLevel {
        return Logger.logLevel;
    }

    public get worker(): IAlphaSynthWorker {
        return this._synth;
    }

    public set logLevel(value: LogLevel) {
        Logger.logLevel = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setLogLevel',
            value: value
        });
    }

    public get masterVolume(): number {
        return this._masterVolume;
    }

    public set masterVolume(value: number) {
        value = Math.max(value, SynthConstants.MinVolume);
        this._masterVolume = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setMasterVolume',
            value: value
        });
    }

    public get metronomeVolume(): number {
        return this._metronomeVolume;
    }

    public set metronomeVolume(value: number) {
        value = Math.max(value, SynthConstants.MinVolume);
        this._metronomeVolume = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setMetronomeVolume',
            value: value
        });
    }
    public get countInVolume(): number {
        return this._countInVolume;
    }

    public set countInVolume(value: number) {
        value = Math.max(value, SynthConstants.MinVolume);
        this._countInVolume = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setCountInVolume',
            value: value
        });
    }

    public get midiEventsPlayedFilter(): MidiEventType[] {
        return this._midiEventsPlayedFilter;
    }

    public set midiEventsPlayedFilter(value: MidiEventType[]) {
        this._midiEventsPlayedFilter = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setMidiEventsPlayedFilter',
            value: Environment.prepareForPostMessage(value)
        });
    }

    public get playbackSpeed(): number {
        return this._playbackSpeed;
    }

    public set playbackSpeed(value: number) {
        value = ModelUtils.clamp(value, SynthConstants.MinPlaybackSpeed, SynthConstants.MaxPlaybackSpeed);
        this._playbackSpeed = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setPlaybackSpeed',
            value: value
        });
    }

    public get loadedMidiInfo(): PositionChangedEventArgs | undefined {
        return this._loadedMidiInfo;
    }

    public get currentPosition(): PositionChangedEventArgs {
        return this._currentPosition;
    }

    public get transportTimePosition(): number {
        return this._transportClock.position;
    }

    public get transportGeneration(): number {
        return this._transportClock.generation;
    }

    public get tickPosition(): number {
        return this._currentPosition.currentTick;
    }

    public set tickPosition(value: number) {
        if (value < 0) {
            value = 0;
        }
        this._currentPosition = new PositionChangedEventArgs(
            this._currentPosition.currentTime,
            this._currentPosition.endTime,
            value,
            this._currentPosition.endTick,
            true,
            this._currentPosition.originalTempo,
            this._currentPosition.modifiedTempo
        );
        this._transportClock.seek(this._currentPosition.currentTime);
        this._synth.postMessage({
            cmd: 'alphaSynth.setTickPosition',
            value: value
        });
    }

    public get timePosition(): number {
        return this._currentPosition.currentTime;
    }

    public set timePosition(value: number) {
        if (value < 0) {
            value = 0;
        }
        this._currentPosition = new PositionChangedEventArgs(
            value,
            this._currentPosition.endTime,
            this._currentPosition.currentTick,
            this._currentPosition.endTick,
            true,
            this._currentPosition.originalTempo,
            this._currentPosition.modifiedTempo
        );
        this._transportClock.seek(value);
        this._synth.postMessage({
            cmd: 'alphaSynth.setTimePosition',
            value: value
        });
    }

    public get isLooping(): boolean {
        return this._isLooping;
    }

    public set isLooping(value: boolean) {
        this._isLooping = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setIsLooping',
            value: value
        });
    }

    public get playbackRange(): PlaybackRange | null {
        return this._playbackRange;
    }

    public set playbackRange(value: PlaybackRange | null) {
        if (value) {
            if (value.startTick < 0) {
                value.startTick = 0;
            }
            if (value.endTick < 0) {
                value.endTick = 0;
            }
        }
        this._playbackRange = value;
        this._synth.postMessage({
            cmd: 'alphaSynth.setPlaybackRange',
            value: Environment.prepareForPostMessage(value)
        });
    }

    public constructor(player: ISynthOutput, settings: Settings, synthWorker: IAlphaSynthWorker) {
        this._workerIsReadyForPlayback = false;
        this._workerIsReady = false;
        this._outputIsReady = false;
        this._state = PlayerState.Paused;
        this._masterVolume = 0.0;
        this._metronomeVolume = 0.0;
        this._playbackSpeed = 0.0;
        this._isLooping = false;
        this._playbackRange = null;
        this._output = player;
        const directOutput = this._output as ISynthOutput & {
            setDirectWorkerPortHandler?: (handler: (port: MessagePort) => void) => void;
        };
        directOutput.setDirectWorkerPortHandler?.(port => {
            this._synth.postMessage({ cmd: 'alphaSynth.output.attachWorkletPort', port }, [port]);
        });
        this._output.ready.on(this._onOutputReady.bind(this));
        this._output.samplesPlayed.on(this.onOutputSamplesPlayed.bind(this));
        this._output.sampleRequest.on(this.onOutputSampleRequest.bind(this));
        this._output.playbackFailed?.on(error => {
            Logger.error('AlphaSynth', 'Audio output failed during playback', error);
            this.pause();
        });
        this._output.open(settings.player.bufferTimeInMilliseconds);
        const sharedSampleBuffer = (
            this._output as ISynthOutput & { readonly sharedSampleBuffer?: SharedSampleBufferDescriptor | null }
        ).sharedSampleBuffer;
        this._synth = synthWorker;
        this._synth.addEventListener('message', e => this.handleWorkerMessage(e));
        this._synth.postMessage({
            cmd: 'alphaSynth.initialize',
            sampleRate: this._output.sampleRate,
            logLevel: settings.core.logLevel,
            bufferTimeInMilliseconds: settings.player.bufferTimeInMilliseconds,
            sharedSampleBuffer: sharedSampleBuffer ?? undefined
        });
        this.masterVolume = 1;
        this.playbackSpeed = 1;
        this.metronomeVolume = 0;
    }

    public destroy(): void {
        this._rejectAllSoundFontOperations(new Error('AlphaSynth worker was destroyed'));
        this._synth.postMessage({
            cmd: 'alphaSynth.destroy'
        });
    }

    //
    // API communicating with the web worker
    public play(): boolean {
        this._output.activate();
        this._synth.postMessage({
            cmd: 'alphaSynth.play'
        });
        return true;
    }

    public pause(): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.pause'
        });
    }

    public playPause(): void {
        this._output.activate();
        this._synth.postMessage({
            cmd: 'alphaSynth.playPause'
        });
    }

    public stop(): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.stop'
        });
    }

    public playOneTimeMidiFile(midi: MidiFile): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.playOneTimeMidiFile',
            midi: JsonConverter.midiFileToJsObject(Environment.prepareForPostMessage(midi))
        });
    }

    public loadSoundFont(data: Uint8Array, append: boolean): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.loadSoundFontBytes',
            data: Environment.prepareForPostMessage(data),
            append: append
        });
    }

    /**
     * Parses all layers before atomically replacing the live SoundFont bank.
     * Requests are latest-wins and always settle through an explicit worker
     * response, timeout, abort, or destroy path.
     */
    public async loadSoundFontBankAsync(
        soundFonts: readonly Uint8Array[],
        options: SoundFontBankLoadOptions = {}
    ): Promise<void> {
        const generation = ++this._soundFontGeneration;
        this._rejectAllSoundFontOperations(new SoundFontBankSupersededError(), true);

        const cacheKeys = await Promise.all(soundFonts.map(computeSoundFontCacheKey));
        if (generation !== this._soundFontGeneration) {
            throw new SoundFontBankSupersededError();
        }
        if (options.signal?.aborted) {
            throw this._abortError();
        }

        const requestId = this._nextOperationId++;
        const timeoutMilliseconds = Math.max(1, options.timeoutMilliseconds ?? 60000);
        return new Promise<void>((resolve, reject) => {
            const abortHandler = options.signal
                ? () => {
                      this._synth.postMessage({ cmd: 'alphaSynth.cancelOperation', requestId });
                      this._settleSoundFontOperation(requestId, this._abortError());
                  }
                : undefined;
            const timeout = setTimeout(() => {
                this._synth.postMessage({ cmd: 'alphaSynth.cancelOperation', requestId });
                this._settleSoundFontOperation(
                    requestId,
                    new Error(`SoundFont bank request timed out after ${timeoutMilliseconds}ms`)
                );
            }, timeoutMilliseconds);

            this._pendingSoundFontOperations.set(requestId, {
                generation,
                cacheKeys,
                resolve,
                reject,
                timeout,
                signal: options.signal,
                abortHandler
            });
            options.signal?.addEventListener('abort', abortHandler!, { once: true });
            this._synth.postMessage({
                cmd: 'alphaSynth.replaceSoundFontBank',
                requestId,
                generation,
                soundFonts: soundFonts.map((data, index) => ({
                    cacheKey: cacheKeys[index],
                    data: this._knownSoundFontCacheKeys.has(cacheKeys[index])
                        ? undefined
                        : Environment.prepareForPostMessage(data)
                }))
            });
        });
    }

    public resetSoundFonts(): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.resetSoundFonts'
        });
    }

    public loadMidiFile(midi: MidiFile): void {
        const compilation = WorkerScoreCompilationCache.getForMidi(midi);
        this._synth.postMessage({
            cmd: 'alphaSynth.loadMidi',
            midi: compilation?.midiData ?? JsonConverter.midiFileToJsObject(Environment.prepareForPostMessage(midi))
        });
    }

    public applyTranspositionPitches(transpositionPitches: Map<number, number>): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.applyTranspositionPitches',
            transpositionPitches: Environment.prepareForPostMessage(transpositionPitches)
        });
    }

    public setChannelTranspositionPitch(channel: number, semitones: number): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.setChannelTranspositionPitch',
            channel: channel,
            semitones: semitones
        });
    }

    public setChannelMute(channel: number, mute: boolean): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.setChannelMute',
            channel: channel,
            mute: mute
        });
    }

    public resetChannelStates(): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.resetChannelStates'
        });
    }

    public setChannelSolo(channel: number, solo: boolean): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.setChannelSolo',
            channel: channel,
            solo: solo
        });
    }

    public setChannelVolume(channel: number, volume: number): void {
        volume = Math.max(volume, SynthConstants.MinVolume);
        this._synth.postMessage({
            cmd: 'alphaSynth.setChannelVolume',
            channel: channel,
            volume: volume
        });
    }

    public handleWorkerMessage(e: MessageEvent<IAlphaSynthWorkerMessage>): void {
        const data = e.data;
        switch (data.cmd) {
            case 'alphaSynth.ready':
                this._workerIsReady = true;
                this._checkReady();
                break;
            case 'alphaSynth.destroyed':
                this._synth.terminate();
                break;
            case 'alphaSynth.readyForPlayback':
                this._workerIsReadyForPlayback = true;
                this._checkReadyForPlayback();
                break;
            case 'alphaSynth.positionChanged':
                this._currentPosition = data.args;
                if (data.args.isSeek) {
                    this._transportClock.seek(data.args.currentTime);
                } else {
                    this._transportClock.observe(data.args.currentTime);
                }
                (this.positionChanged as EventEmitterOfT<PositionChangedEventArgs>).trigger(this._currentPosition);
                break;
            case 'alphaSynth.midiEventsPlayed':
                (this.midiEventsPlayed as EventEmitterOfT<MidiEventsPlayedEventArgs>).trigger(
                    new MidiEventsPlayedEventArgs(
                        data.events.map(JsonConverter.jsObjectToMidiEvent),
                        data.eventTimes,
                        data.currentTime,
                        data.isCountIn
                    )
                );
                break;
            case 'alphaSynth.playerStateChanged':
                this._state = data.state;
                if (data.state === PlayerState.Playing) {
                    this._transportClock.start(this._currentPosition.currentTime);
                } else {
                    this._transportClock.pause(this._currentPosition.currentTime);
                }
                (this.stateChanged as EventEmitterOfT<PlayerStateChangedEventArgs>).trigger(
                    new PlayerStateChangedEventArgs(data.state, data.stopped)
                );
                break;
            case 'alphaSynth.playbackRangeChanged':
                this._playbackRange = data.playbackRange;
                (this.playbackRangeChanged as EventEmitterOfT<PlaybackRangeChangedEventArgs>).trigger(
                    new PlaybackRangeChangedEventArgs(this._playbackRange)
                );
                break;
            case 'alphaSynth.finished':
                (this.finished as EventEmitter).trigger();
                break;
            case 'alphaSynth.soundFontLoaded':
                if (data.requestId !== undefined) {
                    for (const cacheKey of data.cacheKeys ?? []) {
                        this._knownSoundFontCacheKeys.add(cacheKey);
                    }
                    this._settleSoundFontOperation(data.requestId);
                }
                (this.soundFontLoaded as EventEmitter).trigger();
                break;
            case 'alphaSynth.soundFontLoadFailed':
                if (data.requestId !== undefined) {
                    const pending = this._pendingSoundFontOperations.get(data.requestId);
                    for (const cacheKey of pending?.cacheKeys ?? []) {
                        this._knownSoundFontCacheKeys.delete(cacheKey);
                    }
                    this._settleSoundFontOperation(data.requestId, data.error);
                }
                (this.soundFontLoadFailed as EventEmitterOfT<Error>).trigger(data.error);
                break;
            case 'alphaSynth.operationCancelled':
                this._settleSoundFontOperation(data.requestId, this._abortError());
                break;
            case 'alphaSynth.midiLoaded':
                this._checkReadyForPlayback();
                this._loadedMidiInfo = data.args;
                (this.midiLoaded as EventEmitterOfT<PositionChangedEventArgs>).trigger(this._loadedMidiInfo);
                break;
            case 'alphaSynth.midiLoadFailed':
                this._checkReadyForPlayback();
                (this.midiLoadFailed as EventEmitterOfT<Error>).trigger(data.error);
                break;
            case 'alphaSynth.output.addSamples':
                this._output.addSamples(data.samples, data.isFinal);
                break;
            case 'alphaSynth.output.play':
                this._output.play();
                break;
            case 'alphaSynth.output.pause':
                this._output.pause();
                break;
            case 'alphaSynth.output.destroy':
                this._output.destroy();
                break;
            case 'alphaSynth.output.resetSamples':
                this._output.resetSamples();
                break;
        }
    }

    private _checkReady(): void {
        if (this.isReady) {
            (this.ready as EventEmitter).trigger();
        }
    }

    private _settleSoundFontOperation(requestId: number, error?: Error): void {
        const pending = this._pendingSoundFontOperations.get(requestId);
        if (!pending) {
            return;
        }
        this._pendingSoundFontOperations.delete(requestId);
        clearTimeout(pending.timeout);
        if (pending.abortHandler) {
            pending.signal?.removeEventListener('abort', pending.abortHandler);
        }
        if (error) {
            pending.reject(error);
        } else {
            pending.resolve();
        }
    }

    private _rejectAllSoundFontOperations(error: Error, notifyWorker: boolean = false): void {
        for (const requestId of Array.from(this._pendingSoundFontOperations.keys())) {
            if (notifyWorker) {
                this._synth.postMessage({ cmd: 'alphaSynth.cancelOperation', requestId });
            }
            this._settleSoundFontOperation(requestId, error);
        }
    }

    private _abortError(): Error {
        const error = new Error('SoundFont bank request was aborted');
        error.name = 'AbortError';
        return error;
    }

    private _checkReadyForPlayback(): void {
        if (this.isReadyForPlayback) {
            (this.readyForPlayback as EventEmitter).trigger();
        }
    }

    readonly ready: IEventEmitter = new EventEmitter();
    readonly readyForPlayback: IEventEmitter = new EventEmitter();
    readonly finished: IEventEmitter = new EventEmitter();
    readonly soundFontLoaded: IEventEmitter = new EventEmitter();
    readonly soundFontLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    readonly midiLoaded: IEventEmitterOfT<PositionChangedEventArgs> = new EventEmitterOfT<PositionChangedEventArgs>();
    readonly midiLoadFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    readonly stateChanged: IEventEmitterOfT<PlayerStateChangedEventArgs> =
        new EventEmitterOfT<PlayerStateChangedEventArgs>();
    readonly positionChanged: IEventEmitterOfT<PositionChangedEventArgs> =
        new EventEmitterOfT<PositionChangedEventArgs>();
    readonly midiEventsPlayed: IEventEmitterOfT<MidiEventsPlayedEventArgs> =
        new EventEmitterOfT<MidiEventsPlayedEventArgs>();
    readonly playbackRangeChanged: IEventEmitterOfT<PlaybackRangeChangedEventArgs> =
        new EventEmitterOfT<PlaybackRangeChangedEventArgs>();

    //
    // output communication ( output -> worker )
    public onOutputSampleRequest(): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.output.sampleRequest'
        });
    }
    public onOutputSamplesPlayed(samples: number): void {
        this._synth.postMessage({
            cmd: 'alphaSynth.output.samplesPlayed',
            samples: samples
        });
    }

    private _onOutputReady(): void {
        this._outputIsReady = true;
        this._checkReady();
    }

    public loadBackingTrack(_score: Score): void {
        // ignore
    }

    public updateSyncPoints(_syncPoints: BackingTrackSyncPoint[]): void {
        // ignore
    }
}
