import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { BackingTrack } from '@coderline/alphatab/model/BackingTrack';
import { WebAudioHelper } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import type { IBackingTrackSynthOutput } from '@coderline/alphatab/synth/BackingTrackPlayer';
import type { ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';
import { TransportClock } from '@coderline/alphatab/synth/TransportClock';
import { MetronomeClick } from '@coderline/alphatab/synth/MetronomeClick';
import type { Settings } from '@coderline/alphatab/Settings';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';

/**
 * A {@link IBackingTrackSynthOutput} which uses a HTMLAudioElement as playback mechanism.
 * Allows the access to the element for further custom usage.
 * @target web
 * @public
 */
export interface IAudioElementBackingTrackSynthOutput extends IBackingTrackSynthOutput {
    /**
     * The audio element used for playing the backing track.
     * @remarks
     * Direct interaction with the element might not result in correct alphaTab behavior.
     */
    readonly audioElement: HTMLAudioElement;
}

/**
 * @target web
 * @internal
 */
export class AudioElementBackingTrackSynthOutput implements IAudioElementBackingTrackSynthOutput {
    public outputLevel: IBackingTrackSynthOutput['outputLevel'] = null;
    // fake rate
    public readonly sampleRate: number = 44100;

    public audioElement!: HTMLAudioElement;
    private _updateInterval: number = 0;
    private _objectUrl: string | null = null;
    private _playGeneration: number = 0;
    private _activationGeneration: number = 0;
    private _clickContext: AudioContext | null = null;
    private _clickMasterGain: GainNode | null = null;
    private _scheduledClicks: Set<AudioBufferSourceNode> = new Set<AudioBufferSourceNode>();
    private _clickBuffers: Map<boolean, AudioBuffer> = new Map<boolean, AudioBuffer>();
    private _countInTimer: number = 0;
    private _outputDeviceChange: Promise<void> = Promise.resolve();
    private _destroyed: boolean = false;
    private _meterActive: boolean = false;
    private readonly _settings: Settings | null;
    private _mediaSource: MediaElementAudioSourceNode | null = null;
    private _mixer: AudioWorkletNode | null = null;
    private _mixerFaulted: boolean = false;
    private _masterVolume: number = 1;
    private _endObservedAt: number | null = null;

    public constructor(settings: Settings | null = null) {
        this._settings = settings;
    }

    private get _usesMixer(): boolean {
        return this._settings?.player.enablePeakLimiter ?? false;
    }

    public get outputLatencyMilliseconds(): number {
        const context = this._clickContext;
        return this._usesMixer && context
            ? ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000
                + Math.ceil(context.sampleRate * 0.003) / context.sampleRate * 1000
            : 0;
    }
    /** Anchors click scheduling to the media position between coarse time updates. */
    private readonly _transportClock: TransportClock = new TransportClock();

    public get backingTrackDuration(): number {
        const duration = this.audioElement.duration ?? 0;
        return Number.isFinite(duration) ? duration * 1000 : 0;
    }

    public get playbackRate(): number {
        return this.audioElement.playbackRate;
    }

    public set playbackRate(value: number) {
        this.audioElement.playbackRate = value;
        this._transportClock.setPlaybackRate(value);
    }

    public get masterVolume(): number {
        return this._usesMixer ? this._masterVolume : this.audioElement.volume;
    }

    public set masterVolume(value: number) {
        value = Number.isFinite(value) ? Math.max(0, Math.min(this._usesMixer ? 3 : 1, value)) : 1;
        this._masterVolume = value;
        this.audioElement.volume = this._usesMixer ? 1 : value;
        if (this._clickMasterGain && this._clickContext) {
            this._clickMasterGain.gain.setValueAtTime(value, this._clickContext.currentTime);
        }
    }

    public seekTo(time: number): void {
        this.outputLevel = null;
        this._endObservedAt = null;
        this.cancelScheduledMetronomeClicks();
        this._mixer?.port.postMessage({ cmd: 'alphaSynth.output.resetSamples' });
        this._transportClock.seek(time);
        this.audioElement.currentTime = time / 1000;
    }

    public loadBackingTrack(backingTrack: BackingTrack) {
        this._revokeObjectUrl();

        const blob = new Blob([backingTrack.rawAudioFile! as Uint8Array<ArrayBuffer>]);
        // https://html.spec.whatwg.org/multipage/media.html#loading-the-media-resource
        // Step 8. resets the playbackRate, we need to remember and restore it.
        const playbackRate = this.audioElement.playbackRate;
        this._objectUrl = URL.createObjectURL(blob);
        this.audioElement.src = this._objectUrl;
        this.audioElement.playbackRate = playbackRate;
    }

    public open(_bufferTimeInMilliseconds: number): void {
        this._destroyed = false;
        this._mixerFaulted = false;
        const audioElement = document.createElement('audio');
        audioElement.style.display = 'none';
        document.body.appendChild(audioElement);
        audioElement.addEventListener('seeked', () => {
            this._updatePosition();
        });
        audioElement.addEventListener('timeupdate', () => {
            this._updatePosition();
        });
        this.audioElement = audioElement;
        if (this._usesMixer) {
            void this._initializeMixer();
        } else {
            (this.ready as EventEmitter).trigger();
        }
    }

    private async _initializeMixer(): Promise<void> {
        let context: AudioContext | null = null;
        try {
            context = this._ensureClickContext();
            this._mediaSource = context.createMediaElementSource(this.audioElement);
            this.audioElement.volume = 1;
            this._mediaSource.connect(this._clickMasterGain!);
            await BrowserUiFacade.createAlphaSynthAudioWorklet(context, this._settings!);
            if (this._destroyed || context !== this._clickContext) {
                return;
            }
            this._mixer = new AudioWorkletNode(context, 'alphatab-mixer', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers'
            });
            this._mixer.addEventListener('processorerror', () => {
                if (!this._destroyed) {
                    this._mixerFaulted = true;
                    this.pause();
                    (this.playbackFailed as EventEmitterOfT<Error>).trigger(new Error('Backing output limiter failed'));
                }
            });
            this._mixer.port.addEventListener('message', event => {
                if (this._meterActive && !this._destroyed && !this._mixerFaulted && event.data.cmd === 'alphaSynth.output.level') {
                    this.outputLevel = event.data.level;
                }
            });
            this._mixer.port.start();
            this._clickMasterGain!.connect(this._mixer);
            this._mixer.connect(context.destination);
            (this.ready as EventEmitter).trigger();
        } catch (error) {
            if (!this._destroyed && (!context || context === this._clickContext)) {
                this._mixerFaulted = true;
                // Never fall back to an unprotected or double-routed boosted signal.
                (this.playbackFailed as EventEmitterOfT<Error>).trigger(
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    }

    private _updatePosition() {
        const timePos = this.audioElement.currentTime * 1000;
        this._transportClock.observe(timePos);
        let limiterDelay = this._mixer && this._clickContext && (this.audioElement.paused !== true || this.audioElement.ended)
            ? Math.ceil(this._clickContext.sampleRate * 0.003) / this._clickContext.sampleRate * 1000
            : 0;
        if (this.audioElement.ended && this._clickContext) {
            // Media time stops at EOF but the worklet must still drain its delay.
            // Permanently subtracting lookahead would prevent the player finishing.
            this._endObservedAt ??= this._clickContext.currentTime;
            limiterDelay = Math.max(0, limiterDelay - (this._clickContext.currentTime - this._endObservedAt) * 1000);
        } else {
            this._endObservedAt = null;
        }
        (this.timeUpdate as EventEmitterOfT<number>).trigger(Math.max(0, timePos - limiterDelay * this.playbackRate));
    }

    public play(): void {
        this._meterActive = true;
        if (this._usesMixer && (!this._mixer || this._mixerFaulted)) {
            (this.playbackFailed as EventEmitterOfT<Error>).trigger(new Error('Backing output limiter is not ready'));
            return;
        }
        const playGeneration = ++this._playGeneration;
        this._clearCountInTimer();
        this._clearUpdateInterval();
        void this.audioElement.play().catch(reason => {
            if (playGeneration === this._playGeneration) {
                this._clearUpdateInterval();
                Logger.warning('WebAudio', `Backing track playback failed: reason=${reason}`);
                (this.playbackFailed as EventEmitterOfT<Error>).trigger(
                    reason instanceof Error ? reason : new Error(String(reason))
                );
            }
        });
        this._transportClock.start(this.audioElement.currentTime * 1000);
        this._updateInterval = window.setInterval(() => {
            this._updatePosition();
        }, 50);
    }

    public playAfterCountIn(durationMilliseconds: number): void {
        this._meterActive = true;
        this._clearCountInTimer();
        this._countInTimer = window.setTimeout(
            () => {
                this._countInTimer = 0;
                this.play();
            },
            Math.max(0, durationMilliseconds)
        );
    }

    private _clearCountInTimer(): void {
        if (this._countInTimer !== 0) {
            window.clearTimeout(this._countInTimer);
            this._countInTimer = 0;
        }
    }
    public destroy(): void {
        this._destroyed = true;
        const audioElement = this.audioElement;
        if (audioElement) {
            this.pause();
            audioElement.removeAttribute('src');
            audioElement.load();
            audioElement.remove();
        }
        this._revokeObjectUrl();
        this.cancelScheduledMetronomeClicks();
        const clickContext = this._clickContext;
        this._clickContext = null;
        this._mediaSource?.disconnect();
        this._mediaSource = null;
        this._mixer?.disconnect();
        this._mixer?.port.close();
        this._mixer = null;
        this._clickMasterGain?.disconnect();
        this._clickMasterGain = null;
        this._clickBuffers.clear();
        if (clickContext) {
            void clickContext.close();
        }
    }

    public pause(): void {
        this._activationGeneration++;
        this._meterActive = false;
        this.outputLevel = null;
        this._endObservedAt = null;
        this._playGeneration++;
        this._clearCountInTimer();
        this.audioElement.pause();
        this._transportClock.pause(this.audioElement.currentTime * 1000);
        this.cancelScheduledMetronomeClicks();
        this._mixer?.port.postMessage({ cmd: 'alphaSynth.output.resetSamples' });
        this._clearUpdateInterval();
    }

    private _clearUpdateInterval(): void {
        if (this._updateInterval !== 0) {
            window.clearInterval(this._updateInterval);
            this._updateInterval = 0;
        }
    }

    private _revokeObjectUrl(): void {
        if (this._objectUrl) {
            URL.revokeObjectURL(this._objectUrl);
            this._objectUrl = null;
        }
    }

    public addSamples(_samples: Float32Array): void {
        // nobody will call this
    }
    public resetSamples(): void {
        this.outputLevel = null;
        this.cancelScheduledMetronomeClicks();
        this._mixer?.port.postMessage({ cmd: 'alphaSynth.output.resetSamples' });
    }
    public activate(): void {
        if (this._destroyed) {
            return;
        }
        const context = this._ensureClickContext();
        const generation = ++this._activationGeneration;
        if (context.state === 'suspended' || (context.state as string) === 'interrupted') {
            const failed = (error: unknown) => {
                // A late rejection must not stop a newer playback attempt or revive disposed output.
                if (this._destroyed || context !== this._clickContext || generation !== this._activationGeneration) {
                    return;
                }
                this.pause();
                (this.playbackFailed as EventEmitterOfT<Error>).trigger(
                    error instanceof Error ? error : new Error(String(error))
                );
            };
            try {
                void context.resume().catch(failed);
            } catch (error) {
                failed(error);
            }
        }
    }

    public scheduleMetronomeClick(backingTrackTime: number, accent: boolean, volume: number): void {
        // Media positions advance at playbackRate, while Web Audio schedules in
        // wall-clock seconds. Count-in offsets already use wall time separately.
        const delay = (backingTrackTime - this._transportClock.position) / (1000 * this.playbackRate);
        if (delay < -0.08) {
            return;
        }
        this._scheduleClick(Math.max(0, delay), accent, volume);
    }

    public scheduleCountInClick(offsetMilliseconds: number, accent: boolean, volume: number): void {
        this._scheduleClick(Math.max(0, offsetMilliseconds) / 1000, accent, volume);
    }

    private _scheduleClick(delaySeconds: number, accent: boolean, volume: number): void {
        const context = this._ensureClickContext();
        const startAt = context.currentTime + delaySeconds;
        const buffer = this._clickBuffers.get(accent)!;
        const oscillator = context.createBufferSource();
        oscillator.buffer = buffer;
        const gain = context.createGain();
        gain.gain.setValueAtTime(Math.max(0, volume), startAt);
        oscillator.connect(gain);
        gain.connect(this._clickMasterGain!);
        oscillator.addEventListener('ended', () => {
            this._scheduledClicks.delete(oscillator);
            oscillator.disconnect();
            gain.disconnect();
        });
        this._scheduledClicks.add(oscillator);
        oscillator.start(startAt);
    }

    public cancelScheduledMetronomeClicks(): void {
        for (const oscillator of this._scheduledClicks) {
            try {
                oscillator.stop();
            } catch {
                // The click might already have stopped between iteration and cancellation.
            }
        }
        this._scheduledClicks.clear();
    }

    private _ensureClickContext(): AudioContext {
        if (!this._clickContext) {
            this._clickContext = new AudioContext({ sampleRate: 44100 });
            this._clickMasterGain = this._clickContext.createGain();
            this._clickMasterGain.gain.setValueAtTime(this.masterVolume, this._clickContext.currentTime);
            if (!this._usesMixer) {
                this._clickMasterGain.connect(this._clickContext.destination);
            }
            // Prepare both accents before taking a scheduling timestamp, so the
            // first regular beat cannot be delayed by waveform generation.
            for (const accent of [false, true]) {
                const samples = MetronomeClick.createSamples(this._clickContext.sampleRate, accent);
                const buffer = this._clickContext.createBuffer(1, samples.length, this._clickContext.sampleRate);
                buffer.getChannelData(0).set(samples);
                this._clickBuffers.set(accent, buffer);
            }
        }
        return this._clickContext;
    }

    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly samplesPlayed: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly timeUpdate: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly sampleRequest: IEventEmitter = new EventEmitter();
    public readonly playbackFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();

    public async enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return WebAudioHelper.enumerateOutputDevices();
    }
    public setOutputDevice(device: ISynthOutputDevice | null): Promise<void> {
        const sinkId = device?.deviceId ?? '';
        // Serialize selection so a failed earlier request cannot undo a later choice.
        const change = this._outputDeviceChange.catch(() => {}).then(() => this._setOutputDevice(sinkId));
        this._outputDeviceChange = change;
        return change;
    }

    private async _setOutputDevice(sinkId: string): Promise<void> {
        if (this._destroyed) {
            throw new Error('Backing-track output was destroyed');
        }
        if (this._usesMixer) {
            const context = this._ensureClickContext() as AudioContext & {
                setSinkId?: (sinkId: string) => Promise<void>;
            };
            // Media and clicks now share one destination, so there is no second
            // media sink to change or roll back independently.
            if (typeof context.setSinkId !== 'function') {
                if (sinkId !== '' && sinkId !== 'default') {
                    throw new Error('Browser cannot route backing output to the selected device');
                }
                return;
            }
            await context.setSinkId(sinkId);
            if (this._destroyed) {
                throw new Error('Backing-track output was destroyed');
            }
            return;
        }
        if (typeof this.audioElement.setSinkId !== 'function') {
            Logger.warning('WebAudio', 'Browser does not support changing the output device');
            return;
        }
        // This is the real click context, not a temporary capability probe.
        // Create it now so selecting a device before the first click cannot split routing.
        const clickContext = this._ensureClickContext() as AudioContext & {
            setSinkId?: (sinkId: string) => Promise<void>;
            sinkId?: string;
        };
        if (!clickContext.setSinkId && sinkId !== '' && sinkId !== 'default') {
            throw new Error('Browser cannot route backing-track metronome to the selected device');
        }
        const previousSinkId = clickContext.sinkId ?? '';
        if (clickContext.setSinkId) {
            await clickContext.setSinkId(sinkId);
        }
        try {
            if (this._destroyed) {
                throw new Error('Backing-track output was destroyed');
            }
            await this.audioElement.setSinkId(sinkId);
        } catch (error) {
            if (!this._destroyed && clickContext.setSinkId) {
                try {
                    await clickContext.setSinkId(previousSinkId);
                } catch (rollbackError) {
                    throw new AggregateError(
                        [error, rollbackError],
                        'Output selection and click-device rollback failed'
                    );
                }
            }
            throw error;
        }
    }

    public async getOutputDevice(): Promise<ISynthOutputDevice | null> {
        if (!(await WebAudioHelper.checkSinkIdSupport())) {
            return null;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/sinkId
        const sinkId = this._usesMixer
            ? (this._clickContext as (AudioContext & { sinkId?: string }) | null)?.sinkId
            : this.audioElement.sinkId;

        if (typeof sinkId !== 'string' || sinkId === '' || sinkId === 'default') {
            return null;
        }

        // fast path -> cached devices list
        let device = WebAudioHelper.findKnownDevice(sinkId);
        if (device) {
            return device;
        }

        // slow path -> enumerate devices
        const allDevices = await this.enumerateOutputDevices();
        device = allDevices.find(d => d.deviceId === sinkId);
        if (device) {
            return device;
        }

        Logger.warning('WebAudio', 'Could not find output device in device list', sinkId, allDevices);
        return null;
    }
}
