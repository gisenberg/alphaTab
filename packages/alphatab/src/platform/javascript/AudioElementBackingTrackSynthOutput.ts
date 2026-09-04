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
    // fake rate
    public readonly sampleRate: number = 44100;

    public audioElement!: HTMLAudioElement;
    private _updateInterval: number = 0;
    private _objectUrl: string | null = null;
    private _playGeneration: number = 0;
    private _clickContext: AudioContext | null = null;
    private _scheduledClicks: Set<OscillatorNode> = new Set<OscillatorNode>();
    private _countInTimer: number = 0;
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
        return this.audioElement.volume;
    }

    public set masterVolume(value: number) {
        this.audioElement.volume = value;
    }

    public seekTo(time: number): void {
        this.cancelScheduledMetronomeClicks();
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
        (this.ready as EventEmitter).trigger();
    }

    private _updatePosition() {
        const timePos = this.audioElement.currentTime * 1000;
        this._transportClock.observe(timePos);
        (this.timeUpdate as EventEmitterOfT<number>).trigger(timePos);
    }

    public play(): void {
        const playGeneration = ++this._playGeneration;
        this._clearCountInTimer();
        this._clearUpdateInterval();
        void this.audioElement.play().catch(reason => {
            if (playGeneration === this._playGeneration) {
                this._clearUpdateInterval();
                Logger.warning('WebAudio', `Backing track playback failed: reason=${reason}`);
            }
        });
        this._transportClock.start(this.audioElement.currentTime * 1000);
        this._updateInterval = window.setInterval(() => {
            this._updatePosition();
        }, 50);
    }

    public playAfterCountIn(durationMilliseconds: number): void {
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
        if (clickContext) {
            void clickContext.close();
        }
    }

    public pause(): void {
        this._playGeneration++;
        this._clearCountInTimer();
        this.audioElement.pause();
        this._transportClock.pause(this.audioElement.currentTime * 1000);
        this.cancelScheduledMetronomeClicks();
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
        this.cancelScheduledMetronomeClicks();
    }
    public activate(): void {
        const context = this._ensureClickContext();
        if (context.state === 'suspended') {
            void context.resume();
        }
    }

    public scheduleMetronomeClick(backingTrackTime: number, accent: boolean, volume: number): void {
        const delay = (backingTrackTime - this._transportClock.position) / 1000;
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
        const stopAt = startAt + (accent ? 0.045 : 0.032);
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(accent ? 1760 : 1175, startAt);
        const peak = Math.min(1, Math.max(0, volume * this.masterVolume)) * (accent ? 0.3 : 0.22);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.addEventListener('ended', () => {
            this._scheduledClicks.delete(oscillator);
            oscillator.disconnect();
            gain.disconnect();
        });
        this._scheduledClicks.add(oscillator);
        oscillator.start(startAt);
        oscillator.stop(stopAt);
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
        }
        return this._clickContext;
    }

    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly samplesPlayed: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly timeUpdate: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly sampleRequest: IEventEmitter = new EventEmitter();

    public async enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return WebAudioHelper.enumerateOutputDevices();
    }
    public async setOutputDevice(device: ISynthOutputDevice | null): Promise<void> {
        if (typeof this.audioElement.setSinkId !== 'function') {
            Logger.warning('WebAudio', 'Browser does not support changing the output device');
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
        if (!device) {
            await this.audioElement.setSinkId('');
        } else {
            await this.audioElement.setSinkId(device.deviceId);
        }

        const clickContext = this._clickContext as
            | (AudioContext & {
                  setSinkId?: (sinkId: string) => Promise<void>;
              })
            | null;
        if (clickContext?.setSinkId) {
            await clickContext.setSinkId(device?.deviceId ?? '');
        }
    }

    public async getOutputDevice(): Promise<ISynthOutputDevice | null> {
        if (!(await WebAudioHelper.checkSinkIdSupport())) {
            return null;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/sinkId
        const sinkId = this.audioElement.sinkId;

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
