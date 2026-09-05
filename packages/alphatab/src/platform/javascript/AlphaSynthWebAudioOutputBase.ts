import { AlphaTabError, AlphaTabErrorType } from '@coderline/alphatab/AlphaTabError';
import { Environment } from '@coderline/alphatab/Environment';
import {
    EventEmitter,
    EventEmitterOfT,
    type IEventEmitter,
    type IEventEmitterOfT
} from '@coderline/alphatab/EventEmitter';
import { Logger } from '@coderline/alphatab/Logger';
import type { ISynthOutput, ISynthOutputDevice } from '@coderline/alphatab/synth/ISynthOutput';
import type { SynthOutputDiagnostics } from '@coderline/alphatab/synth/SynthOutputDiagnostics';

/**
 * @target web
 * @internal
 */
declare const webkitAudioContext: any;

/**
 * @target web
 * @internal
 */
export class AlphaSynthWebAudioSynthOutputDevice implements ISynthOutputDevice {
    public device: MediaDeviceInfo;

    public constructor(device: MediaDeviceInfo) {
        this.device = device;
    }
    public get deviceId(): string {
        return this.device.deviceId;
    }
    public get label(): string {
        return this.device.label;
    }
    public isDefault: boolean = false;
}

/**
 * Some shared web audio stuff.
 * @target web
 * @internal
 */
export class WebAudioHelper {
    private static _knownDevices: ISynthOutputDevice[] = [];

    public static findKnownDevice(sinkId: string) {
        return WebAudioHelper._knownDevices.find(d => d.deviceId === sinkId);
    }

    /**
     * Creates an audio context.
     * @param minimumSampleRate When greater than zero and the platform default sample rate is
     * below it, the context is recreated with this sample rate. Letting the platform choose first
     * keeps native rates (e.g. 48 kHz) where they are already sufficient.
     */
    public static createAudioContext(minimumSampleRate: number = 0): AudioContext {
        const contextType = WebAudioHelper._audioContextType();
        const context = new contextType();
        if (minimumSampleRate > 0 && context.sampleRate < minimumSampleRate) {
            Logger.debug(
                'WebAudio',
                `Audio context sample rate ${context.sampleRate} is below the minimum of ${minimumSampleRate}, recreating`
            );
            try {
                void context.close();
            } catch (e) {
                Logger.debug('WebAudio', 'Could not close low sample rate audio context', e);
            }
            return new contextType({ sampleRate: minimumSampleRate });
        }
        return context;
    }

    private static _audioContextType(): typeof AudioContext {
        if ('AudioContext' in Environment.globalThis) {
            return Environment.globalThis.AudioContext as typeof AudioContext;
        }
        if ('webkitAudioContext' in Environment.globalThis) {
            return webkitAudioContext as typeof AudioContext;
        }
        throw new AlphaTabError(AlphaTabErrorType.General, 'AudioContext not found');
    }

    public static async checkSinkIdSupport() {
        // https://caniuse.com/mdn-api_audiocontext_sinkid
        const context = WebAudioHelper.createAudioContext();
        try {
            if (!('setSinkId' in context)) {
                Logger.warning('WebAudio', 'Browser does not support changing the output device');
                return false;
            }
            return true;
        } finally {
            try {
                await context.close();
            } catch (e) {
                Logger.debug('WebAudio', 'Could not close output-device capability context', e);
            }
        }
    }

    public static async enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        try {
            if (!(await WebAudioHelper.checkSinkIdSupport())) {
                return [];
            }

            // Request permissions
            let permissionStream: MediaStream | undefined;
            try {
                permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (e) {
                // sometimes we get an error but can still enumerate, e.g. if microphone access is denied,
                // we can still load the output devices in some cases.
                Logger.warning('WebAudio', 'Output device permission rejected', e);
            } finally {
                for (const track of permissionStream?.getTracks() ?? []) {
                    track.stop();
                }
            }

            // load devices
            const devices = await navigator.mediaDevices.enumerateDevices();

            // default device candidates
            let defaultDeviceGroupId = '';
            let defaultDeviceId = '';

            const realDevices = new Map<string, AlphaSynthWebAudioSynthOutputDevice>();
            for (const device of devices) {
                if (device.kind === 'audiooutput') {
                    realDevices.set(device.groupId, new AlphaSynthWebAudioSynthOutputDevice(device));

                    // chromium has the default device as deviceID: 'default'
                    // the standard defines empty-string as default
                    if (device.deviceId === 'default' || device.deviceId === '') {
                        defaultDeviceGroupId = device.groupId;
                        defaultDeviceId = device.deviceId;
                    }
                }
            }

            const final = Array.from(realDevices.values());

            // flag default device
            let defaultDevice = final.find(d => d.deviceId === defaultDeviceId);
            if (!defaultDevice) {
                defaultDevice = final.find(d => d.device.groupId === defaultDeviceGroupId);
            }
            if (!defaultDevice && final.length > 0) {
                defaultDevice = final[0];
            }

            if (defaultDevice) {
                defaultDevice.isDefault = true;
            }

            WebAudioHelper._knownDevices = final;

            return final;
        } catch (e) {
            Logger.error('WebAudio', 'Failed to enumerate output devices', e);
            return [];
        }
    }
}

/**
 * @target web
 * @internal
 */
export abstract class AlphaSynthWebAudioOutputBase implements ISynthOutput {
    public outputLevel: ISynthOutput['outputLevel'] = null;
    protected static readonly BufferSize: number = 4096;
    protected static readonly PreferredSampleRate: number = 44100;

    protected context: AudioContext | null = null;
    protected buffer: AudioBuffer | null = null;
    protected source: AudioBufferSourceNode | null = null;

    private _resumeHandler?: () => void;
    private _sourceStarted: boolean = false;
    private _activationGeneration: number = 0;
    private _playbackFailureCount: number = 0;
    private _lastPlaybackFailure: string | null = null;
    private _bufferDiagnostics: SynthOutputDiagnostics = {
        outputMode: 'unknown',
        sampleRate: AlphaSynthWebAudioOutputBase.PreferredSampleRate,
        bufferCapacityFrames: 0,
        bufferedFrames: 0,
        peakBufferedFrames: 0,
        outputFrames: 0,
        underrunCount: 0,
        underrunFrames: 0,
        droppedFrames: 0,
        playbackFailureCount: 0,
        lastPlaybackFailure: null
    };

    public get sampleRate(): number {
        return this.context ? this.context.sampleRate : AlphaSynthWebAudioOutputBase.PreferredSampleRate;
    }

    public get outputLatencyMilliseconds(): number {
        if (!this.context) {
            return 0;
        }

        const baseLatency = Number.isFinite(this.context.baseLatency) ? this.context.baseLatency : 0;
        const outputLatency = Number.isFinite(this.context.outputLatency) ? this.context.outputLatency : 0;
        return Math.max(0, (baseLatency + outputLatency) * 1000);
    }

    /**
     * The minimum sample rate of the audio context, see {@link PlayerSettings.minimumSampleRate}.
     */
    public minimumSampleRate: number = 0;

    public activate(resumedCallback?: () => void): void {
        if (!this.context) {
            this.context = WebAudioHelper.createAudioContext(this.minimumSampleRate);
        }

        const context = this.context;
        const generation = ++this._activationGeneration;
        if (context.state === 'suspended' || (context.state as string) === 'interrupted') {
            Logger.debug('WebAudio', 'Audio Context is suspended, trying resume');
            let resumed: Promise<void>;
            try {
                resumed = context.resume();
            } catch (error) {
                // Report after play() has finished setting up its source, so pause can cancel that setup too.
                resumed = Promise.reject(error);
            }
            void resumed.then(
                () => {
                    if (context !== this.context || generation !== this._activationGeneration) {
                        return;
                    }
                    Logger.debug(
                        'WebAudio',
                        `Audio Context resume success: state=${this.context?.state}, sampleRate:${this.context?.sampleRate}`
                    );
                    if (resumedCallback) {
                        resumedCallback();
                    }
                },
                reason => {
                    if (context !== this.context || generation !== this._activationGeneration) {
                        return;
                    }
                    Logger.warning(
                        'WebAudio',
                        `Audio Context resume failed: state=${this.context?.state}, sampleRate:${this.context?.sampleRate}, reason=${reason}`
                    );
                    this.pause();
                    this.onPlaybackFailed(reason instanceof Error ? reason : new Error(String(reason)));
                }
            );
        }
    }

    private _patchIosSampleRate(): void {
        const ua: string = navigator.userAgent;
        if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1) {
            const context: AudioContext = WebAudioHelper.createAudioContext();
            const buffer: AudioBuffer = context.createBuffer(1, 1, AlphaSynthWebAudioOutputBase.PreferredSampleRate);
            const dummy: AudioBufferSourceNode = context.createBufferSource();
            dummy.buffer = buffer;
            dummy.connect(context.destination);
            dummy.start(0);
            dummy.disconnect(0);
            // tslint:disable-next-line: no-floating-promises
            context.close();
        }
    }

    public open(_bufferTimeInMilliseconds: number): void {
        this._patchIosSampleRate();
        this.context = WebAudioHelper.createAudioContext(this.minimumSampleRate);
        const ctx: any = this.context;
        if (ctx.state === 'suspended') {
            this._registerResumeHandler();
        }
    }

    private _registerResumeHandler() {
        this._unregisterResumeHandler();
        this._resumeHandler = (() => {
            this.activate(() => {
                this._unregisterResumeHandler();
            });
        }).bind(this);
        document.body.addEventListener('touchend', this._resumeHandler, false);
        document.body.addEventListener('click', this._resumeHandler, false);
    }

    private _unregisterResumeHandler() {
        const resumeHandler = this._resumeHandler;
        if (resumeHandler) {
            document.body.removeEventListener('touchend', resumeHandler, false);
            document.body.removeEventListener('click', resumeHandler, false);
            this._resumeHandler = undefined;
        }
    }

    public play(): void {
        const ctx = this.context!;
        this.activate();
        // create an empty buffer source (silence)
        this.buffer = ctx.createBuffer(2, AlphaSynthWebAudioOutputBase.BufferSize, ctx.sampleRate);
        this.source = ctx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.loop = true;
        this._sourceStarted = false;
    }

    protected startSource(): void {
        if (this.source && !this._sourceStarted) {
            this.source.start(0);
            this._sourceStarted = true;
        }
    }

    public pause(): void {
        this._activationGeneration++;
        this.outputLevel = null;
        if (this.source) {
            if (this._sourceStarted) {
                this.source.stop(0);
            }
            this.source.disconnect();
        }
        this.source = null;
        this._sourceStarted = false;
    }

    public destroy(): void {
        this.pause();
        this.context?.close();
        this.context = null;
        this._unregisterResumeHandler();
    }

    public abstract addSamples(f: Float32Array): void;
    public abstract resetSamples(): void;

    public readonly ready: IEventEmitter = new EventEmitter();
    public readonly samplesPlayed: IEventEmitterOfT<number> = new EventEmitterOfT<number>();
    public readonly sampleRequest: IEventEmitter = new EventEmitter();
    public readonly playbackFailed: IEventEmitterOfT<Error> = new EventEmitterOfT<Error>();
    public readonly playbackDiagnosticsChanged: IEventEmitterOfT<SynthOutputDiagnostics> =
        new EventEmitterOfT<SynthOutputDiagnostics>(() => this.playbackDiagnostics);

    public get playbackDiagnostics(): SynthOutputDiagnostics {
        return {
            ...this._bufferDiagnostics,
            playbackFailureCount: this._playbackFailureCount,
            lastPlaybackFailure: this._lastPlaybackFailure
        };
    }

    protected onSamplesPlayed(numberOfSamples: number) {
        (this.samplesPlayed as EventEmitterOfT<number>).trigger(numberOfSamples);
    }

    protected onSampleRequest() {
        (this.sampleRequest as EventEmitter).trigger();
    }

    protected onReady() {
        (this.ready as EventEmitter).trigger();
    }

    protected onPlaybackFailed(error: Error) {
        this._playbackFailureCount++;
        this._lastPlaybackFailure = error.message;
        this._emitPlaybackDiagnostics();
        (this.playbackFailed as EventEmitterOfT<Error>).trigger(error);
    }

    protected setPlaybackBufferDiagnostics(diagnostics: SynthOutputDiagnostics): void {
        this._bufferDiagnostics = diagnostics;
        this._emitPlaybackDiagnostics();
    }

    protected configurePlaybackDiagnostics(
        outputMode: SynthOutputDiagnostics['outputMode'],
        bufferCapacityFrames: number
    ): void {
        this._bufferDiagnostics = {
            outputMode,
            sampleRate: this.sampleRate,
            bufferCapacityFrames: Math.max(0, Math.floor(bufferCapacityFrames)),
            bufferedFrames: 0,
            peakBufferedFrames: 0,
            outputFrames: 0,
            underrunCount: 0,
            underrunFrames: 0,
            droppedFrames: 0,
            playbackFailureCount: 0,
            lastPlaybackFailure: null
        };
    }

    public resetPlaybackDiagnostics(): void {
        this._playbackFailureCount = 0;
        this._lastPlaybackFailure = null;
        this.onResetPlaybackDiagnostics();
    }

    protected onResetPlaybackDiagnostics(): void {
        this._bufferDiagnostics = {
            ...this._bufferDiagnostics,
            peakBufferedFrames: this._bufferDiagnostics.bufferedFrames,
            outputFrames: 0,
            underrunCount: 0,
            underrunFrames: 0,
            droppedFrames: 0
        };
        this._emitPlaybackDiagnostics();
    }

    private _emitPlaybackDiagnostics(): void {
        (this.playbackDiagnosticsChanged as EventEmitterOfT<SynthOutputDiagnostics>).trigger(
            this.playbackDiagnostics
        );
    }

    public enumerateOutputDevices(): Promise<ISynthOutputDevice[]> {
        return WebAudioHelper.enumerateOutputDevices();
    }

    public async setOutputDevice(device: ISynthOutputDevice | null): Promise<void> {
        const context = this.context;
        if (!context || !('setSinkId' in context)) {
            Logger.warning('WebAudio', 'Browser does not support changing the output device');
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
        if (!device) {
            await (context as any).setSinkId('');
        } else {
            await (context as any).setSinkId(device.deviceId);
        }
    }

    public async getOutputDevice(): Promise<ISynthOutputDevice | null> {
        if (!(await WebAudioHelper.checkSinkIdSupport())) {
            return null;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/sinkId
        const sinkId = (this.context as any).sinkId;

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
