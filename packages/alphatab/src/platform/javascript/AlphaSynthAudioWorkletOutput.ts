import { Environment } from '@coderline/alphatab/Environment';
import { Logger } from '@coderline/alphatab/Logger';
import type { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynthWebAudioOutputBase } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
import {
    calculateWebAudioBufferCount,
    calculateWebAudioRequestBufferCount,
    SamplesPlayedReporter,
    WebAudioSamplesPlayedReportIntervalFrames,
    writeInterleavedStereoSamples
} from '@coderline/alphatab/platform/javascript/WebAudioSampleBuffer';
import type {
    IAlphaSynthWorkerMessage,
    IAlphaTabWorker
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { CircularSampleBuffer } from '@coderline/alphatab/synth/ds/CircularSampleBuffer';

/**
 * @target web
 * @internal
 */
type AudioWorkletProcessorMessagePort<T> = Omit<IAlphaTabWorker<T>, 'terminate'> & Pick<MessagePort, 'start'>;

/**
 * @target web
 * @internal
 */
interface AudioWorkletProcessor {
    readonly port: AudioWorkletProcessorMessagePort<IAlphaSynthWorkerMessage>;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

/**
 * @target web
 * @internal
 */
declare let AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor;
    new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

/**
 * @target web
 * @internal
 */
interface AudioWorkletNode<T> extends AudioNode {
    readonly port: AudioWorkletProcessorMessagePort<T>;
}

// Bug 646: Safari 14.1 is buggy regarding audio worklets
// globalThis cannot be used to access registerProcessor or samplerate
// we need to really use them as globals
/**
 * @target web
 * @internal
 */
declare let registerProcessor: any;
/**
 * @target web
 * @internal
 */
declare let sampleRate: number;

/**
 * This class implements a HTML5 Web Audio API based audio output device
 * for alphaSynth using the modern Audio Worklets.
 * @target web
 * @internal
 */
export class AlphaSynthWebWorklet {
    private static _isRegistered = false;
    public static init() {
        if (AlphaSynthWebWorklet._isRegistered) {
            return;
        }
        AlphaSynthWebWorklet._isRegistered = true;
        registerProcessor(
            'alphatab',
            class AlphaSynthWebWorkletProcessor extends AudioWorkletProcessor {
                public static readonly BufferSize: number = 4096;

                private _outputBuffer: Float32Array = new Float32Array(0);
                private _circularBuffer!: CircularSampleBuffer;
                private _bufferCount: number = 0;
                private _requestedBufferCount: number = 0;
                private _isStopped = false;
                private readonly _samplesPlayedReporter = new SamplesPlayedReporter(
                    WebAudioSamplesPlayedReportIntervalFrames
                );

                constructor(options: AudioWorkletNodeOptions) {
                    super(options);

                    Logger.debug('WebAudio', 'creating processor');

                    this._bufferCount = calculateWebAudioBufferCount(
                        options.processorOptions.bufferTimeInMilliseconds,
                        sampleRate,
                        AlphaSynthWebWorkletProcessor.BufferSize,
                        2
                    );
                    this._circularBuffer = new CircularSampleBuffer(
                        AlphaSynthWebWorkletProcessor.BufferSize * this._bufferCount
                    );

                    this.port.addEventListener('message', e => this._handleMessage(e));
                    this.port.start();
                }

                private _handleMessage(e: MessageEvent<IAlphaSynthWorkerMessage>) {
                    const data = e.data;
                    const cmd = data.cmd;
                    switch (cmd) {
                        case 'alphaSynth.output.addSamples':
                            const f: Float32Array = data.samples;
                            const writtenSamples = this._circularBuffer.write(f, 0, f.length);
                            this._requestedBufferCount = Math.max(0, this._requestedBufferCount - 1);
                            const droppedFrames = Math.floor(
                                (f.length - writtenSamples) / SynthConstants.AudioChannels
                            );
                            if (droppedFrames > 0) {
                                this._postSamplesPlayed(droppedFrames);
                            }
                            break;
                        case 'alphaSynth.output.resetSamples':
                            this._circularBuffer.clear();
                            this._requestedBufferCount = 0;
                            this._samplesPlayedReporter.reset();
                            this._requestBuffers();
                            break;
                        case 'alphaSynth.output.stop':
                            this._flushSamplesPlayed();
                            this._isStopped = true;
                            break;
                    }
                }

                public override process(
                    _inputs: Float32Array[][],
                    outputs: Float32Array[][],
                    _parameters: Record<string, Float32Array>
                ): boolean {
                    if (outputs.length !== 1 || outputs[0]?.length !== 2) {
                        return false;
                    }

                    const left: Float32Array = outputs[0][0];
                    const right: Float32Array = outputs[0][1];

                    if (!left || !right) {
                        return true;
                    }

                    const samples: number = left.length + right.length;
                    let buffer = this._outputBuffer;
                    if (buffer.length !== samples) {
                        buffer = new Float32Array(samples);
                        this._outputBuffer = buffer;
                    }
                    let interleavedSamplesToRead = Math.min(buffer.length, this._circularBuffer.count);
                    interleavedSamplesToRead -= interleavedSamplesToRead % SynthConstants.AudioChannels;
                    const samplesFromBuffer = this._circularBuffer.read(buffer, 0, interleavedSamplesToRead);
                    const playedFrames = writeInterleavedStereoSamples(buffer, samplesFromBuffer, left, right);
                    const samplesPlayed = this._samplesPlayedReporter.update(playedFrames, left.length);
                    if (samplesPlayed !== undefined) {
                        this._postSamplesPlayed(samplesPlayed);
                    }
                    this._requestBuffers();

                    return this._circularBuffer.count > 0 || !this._isStopped;
                }

                private _requestBuffers(): void {
                    // if we fall under the half of buffers
                    // we request one half
                    const halfBufferCount = calculateWebAudioRequestBufferCount(this._bufferCount);
                    const halfSamples: number = halfBufferCount * AlphaSynthWebWorkletProcessor.BufferSize;
                    // Issue #631: it can happen that requestBuffers is called multiple times
                    // before we already get samples via addSamples, therefore we need to
                    // remember how many buffers have been requested, and consider them as available.
                    const bufferedSamples =
                        this._circularBuffer.count +
                        this._requestedBufferCount * AlphaSynthWebWorkletProcessor.BufferSize;
                    if (bufferedSamples < halfSamples) {
                        this._requestedBufferCount += halfBufferCount;
                        for (let i: number = 0; i < halfBufferCount; i++) {
                            this.port.postMessage({
                                cmd: 'alphaSynth.output.sampleRequest'
                            });
                        }
                    }
                }

                private _flushSamplesPlayed(): void {
                    const samplesPlayed = this._samplesPlayedReporter.update(0, 0, true);
                    if (samplesPlayed !== undefined) {
                        this._postSamplesPlayed(samplesPlayed);
                    }
                }

                private _postSamplesPlayed(samples: number): void {
                    this.port.postMessage({
                        cmd: 'alphaSynth.output.samplesPlayed',
                        samples
                    });
                }
            }
        );
    }
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

    private _pendingEvents?: IAlphaSynthWorkerMessage[];

    public constructor(settings: Settings) {
        super();
        this._settings = settings;
        this._boundHandleMessage = e => this._handleMessage(e);
    }

    public override open(bufferTimeInMilliseconds: number) {
        super.open(bufferTimeInMilliseconds);
        this._bufferTimeInMilliseconds = bufferTimeInMilliseconds;
        this.onReady();
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
                    bufferTimeInMilliseconds: this._bufferTimeInMilliseconds
                }
            }) as AudioWorkletNode<IAlphaSynthWorkerMessage>;

            worklet.port.addEventListener('message', this._boundHandleMessage);
            worklet.port.start();
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
                this.onSamplesPlayed(data.samples);
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

    public addSamples(f: Float32Array): void {
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.addSamples',
            samples: Environment.prepareForPostMessage(f)
        });
    }

    public resetSamples(): void {
        this._postWorkerMessage({
            cmd: 'alphaSynth.output.resetSamples'
        });
    }
}
