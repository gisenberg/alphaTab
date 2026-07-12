import { Environment } from '@coderline/alphatab/Environment';
import { Logger } from '@coderline/alphatab/Logger';
import type { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynthWebAudioOutputBase } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import { calculateWebAudioBufferCount } from '@coderline/alphatab/platform/javascript/WebAudioSampleBuffer';
import {
    SharedSampleBuffer,
    type SharedSampleBufferDescriptor
} from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';
import type {
    IAlphaSynthWorkerMessage,
    IAlphaTabWorker
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/**
 * @target web
 * @internal
 */
type AudioWorkletProcessorMessagePort<T> = Omit<IAlphaTabWorker<T>, 'terminate'> & Pick<MessagePort, 'start'>;

/**
 * @target web
 * @internal
 */
interface AudioWorkletNode<T> extends AudioNode {
    readonly port: AudioWorkletProcessorMessagePort<T>;
}

/**
 * This class implements a HTML5 Web Audio API based audio output device
 * for alphaSynth. It can be controlled via a JS API.
 * @target web
 * @internal
 */
export class AlphaSynthAudioWorkletOutput extends AlphaSynthWebAudioOutputBase {
    private _worklet: AudioWorkletNode<IAlphaSynthWorkerMessage> | null = null;
    private _bufferTimeInMilliseconds: number = 0;
    private readonly _settings: Settings;
    private _boundHandleMessage: (e: MessageEvent<IAlphaSynthWorkerMessage>) => void;
    private _playGeneration: number = 0;
    private _sharedSampleBuffer: SharedSampleBuffer | null = null;
    private _lastResetGeneration: number = 0;
    private _directWorkerPortHandler?: (port: MessagePort) => void;

    private _pendingEvents?: IAlphaSynthWorkerMessage[];

    public constructor(settings: Settings) {
        super();
        this._settings = settings;
        this._boundHandleMessage = e => this._handleMessage(e);
    }

    public override open(bufferTimeInMilliseconds: number) {
        super.open(bufferTimeInMilliseconds);
        this._bufferTimeInMilliseconds = bufferTimeInMilliseconds;
        const bufferCount = calculateWebAudioBufferCount(
            bufferTimeInMilliseconds,
            this.sampleRate,
            AlphaSynthWebAudioOutputBase.BufferSize,
            2
        );
        this._sharedSampleBuffer = this._createSharedSampleBuffer(
            AlphaSynthWebAudioOutputBase.BufferSize * bufferCount
        );
        this._lastResetGeneration = this._sharedSampleBuffer?.generation ?? 0;
        this.configurePlaybackDiagnostics(
            'audio-worklet',
            (AlphaSynthWebAudioOutputBase.BufferSize * bufferCount) / SynthConstants.AudioChannels
        );
        this.onReady();
    }

    public get sharedSampleBuffer(): SharedSampleBufferDescriptor | null {
        return this._sharedSampleBuffer?.descriptor ?? null;
    }

    public setDirectWorkerPortHandler(handler: (port: MessagePort) => void): void {
        this._directWorkerPortHandler = handler;
    }

    private _createSharedSampleBuffer(capacitySamples: number): SharedSampleBuffer | null {
        const global = Environment.globalThis as typeof globalThis & { crossOriginIsolated?: boolean };
        if (typeof global.SharedArrayBuffer !== 'function' || global.crossOriginIsolated !== true) {
            return null;
        }
        try {
            return SharedSampleBuffer.create(capacitySamples);
        } catch (e) {
            Logger.warning('WebAudio', 'Shared audio transport unavailable; using message fallback', e);
            return null;
        }
    }

    public override play(): void {
        super.play();
        const ctx = this.context!;
        const playGeneration = ++this._playGeneration;

        // clear any pending events buffered from previous playback rounds
        // we just want the events which come in after the play call until the worklet is created
        if (this._pendingEvents) {
            this._pendingEvents = undefined;
        }

        // Create the worklet node which will replace the silence with generated audio.
        void this._createWorklet(ctx, playGeneration);
    }

    private async _createWorklet(ctx: AudioContext, playGeneration: number): Promise<void> {
        let worklet: AudioWorkletNode<IAlphaSynthWorkerMessage> | null = null;
        try {
            await BrowserUiFacade.createAlphaSynthAudioWorklet(ctx, this._settings);
            if (playGeneration !== this._playGeneration || this.context !== ctx || !this.source) {
                return;
            }

            worklet = new AudioWorkletNode(ctx, 'alphatab', {
                numberOfOutputs: 1,
                outputChannelCount: [2],
                processorOptions: {
                    bufferTimeInMilliseconds: this._bufferTimeInMilliseconds,
                    sharedSampleBuffer: this.sharedSampleBuffer ?? undefined
                }
            }) as AudioWorkletNode<IAlphaSynthWorkerMessage>;

            worklet.port.addEventListener('message', this._boundHandleMessage);
            worklet.port.start();
            if (this._directWorkerPortHandler) {
                const directChannel = new MessageChannel();
                worklet.port.postMessage({ cmd: 'alphaSynth.output.attachWorkerPort', port: directChannel.port1 }, [
                    directChannel.port1
                ]);
                this._directWorkerPortHandler(directChannel.port2);
            }
            this._worklet = worklet;
            this.source.connect(worklet);
            this.startSource();
            worklet.connect(ctx.destination);

            const pending = this._pendingEvents;
            if (pending) {
                for (const e of pending) {
                    worklet.port.postMessage(e);
                }
                this._pendingEvents = undefined;
            }
        } catch (reason) {
            worklet?.port.removeEventListener('message', this._boundHandleMessage);
            worklet?.disconnect();
            if (playGeneration === this._playGeneration) {
                this._worklet = null;
                this._pendingEvents = undefined;
                super.pause();
                const error = reason instanceof Error ? reason : new Error(String(reason));
                Logger.error('WebAudio', `Audio Worklet creation failed: reason=${error.message}`);
                this.onPlaybackFailed(error);
            }
        }
    }

    private _handleMessage(e: MessageEvent<IAlphaSynthWorkerMessage>) {
        const data = e.data;
        const cmd = data.cmd;
        switch (cmd) {
            case 'alphaSynth.output.samplesPlayed':
                if (data.diagnostics) {
                    this.setPlaybackBufferDiagnostics(data.diagnostics);
                }
                this.onSamplesPlayed(data.samples);
                break;
            case 'alphaSynth.output.diagnostics':
                this.setPlaybackBufferDiagnostics(data.diagnostics);
                break;
            case 'alphaSynth.output.sampleRequest':
                this.onSampleRequest();
                break;
        }
    }

    public override pause(): void {
        this._playGeneration++;
        const worklet = this._worklet;
        this._worklet = null;
        if (worklet) {
            worklet.port.postMessage({
                cmd: 'alphaSynth.output.stop'
            });
            worklet.port.removeEventListener('message', this._boundHandleMessage);
            worklet.disconnect();
        }
        this._pendingEvents = undefined;
        super.pause();
    }

    private _postWorkerMessage(message: IAlphaSynthWorkerMessage) {
        const worklet = this._worklet;
        if (worklet) {
            worklet.port.postMessage(message);
        } else {
            this._pendingEvents ??= [];
            this._pendingEvents.push(message);
        }
    }

    public addSamples(f: Float32Array, isFinal: boolean = false): void {
        if (this._sharedSampleBuffer) {
            this._sharedSampleBuffer.write(f, isFinal);
            return;
        }
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.addSamples',
            samples: Environment.prepareForPostMessage(f),
            isFinal
        });
    }

    public resetSamples(): void {
        const sharedSampleBuffer = this._sharedSampleBuffer;
        if (sharedSampleBuffer) {
            const generation = sharedSampleBuffer.generation;
            if (generation === this._lastResetGeneration) {
                sharedSampleBuffer.resetSamples();
            }
            this._lastResetGeneration = sharedSampleBuffer.generation;
        }
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.resetSamples'
        });
    }

    protected override onResetPlaybackDiagnostics(): void {
        super.onResetPlaybackDiagnostics();
        this._sharedSampleBuffer?.resetDiagnostics();
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.resetDiagnostics'
        });
    }
}
