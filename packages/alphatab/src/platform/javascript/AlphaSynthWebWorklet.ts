import { Logger } from '@coderline/alphatab/Logger';
import { OutputLevelMeter } from '@coderline/alphatab/synth/OutputLevelMeter';
import { StereoPeakOutputProcessor } from '@coderline/alphatab/platform/javascript/StereoPeakOutputProcessor';
import {
    calculateWebAudioBufferCount,
    calculateWebAudioRequestBufferCount,
    SamplesPlayedReporter,
    SynthOutputDiagnosticsTracker,
    WebAudioSamplesPlayedReportIntervalFrames,
    writeInterleavedStereoSamples
} from '@coderline/alphatab/platform/javascript/WebAudioSampleBuffer';
import {
    SharedSampleBuffer,
    type SharedSampleBufferDescriptor
} from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';
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

// Bug 646: Safari 14.1 is buggy regarding audio worklets. These APIs must be
// accessed as globals rather than through globalThis.
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
 * The real-time AudioWorklet implementation. It intentionally lives apart
 * from the main-thread output so bundlers do not pull the browser UI and full
 * alphaTab API into the worklet payload.
 * @target web
 * @internal
 */
export class AlphaSynthWebWorklet {
    private static _isRegistered = false;

    public static init(): void {
        if (AlphaSynthWebWorklet._isRegistered) {
            return;
        }
        AlphaSynthWebWorklet._isRegistered = true;
        registerProcessor(
            'alphatab-mixer',
            class AlphaTabMixerProcessor extends AudioWorkletProcessor {
                private readonly _meter = new OutputLevelMeter(sampleRate);
                private readonly _processor = new StereoPeakOutputProcessor(sampleRate);
                private readonly _empty: Float32Array[] = [];

                public constructor() {
                    super();
                    this.port.addEventListener('message', event => {
                        if (event.data.cmd === 'alphaSynth.output.resetSamples') {
                            this._processor.reset();
                            this._meter.reset();
                        }
                    });
                    this.port.start();
                }

                public override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
                    // Keep processing disconnected input to drain the lookahead tail.
                    // No per-quantum messages, allocations or renderer callbacks.
                    this._processor.process(inputs[0] ?? this._empty, outputs[0] ?? this._empty);
                    if (outputs[0]?.[0] && outputs[0]?.[1]) {
                        const level = this._meter.push(outputs[0][0], outputs[0][1]);
                        if (level) {
                            this.port.postMessage({ cmd: 'alphaSynth.output.level', level });
                        }
                    }
                    return true;
                }
            }
        );
        registerProcessor(
            'alphatab',
            class AlphaSynthWebWorkletProcessor extends AudioWorkletProcessor {
                private readonly _meter = new OutputLevelMeter(sampleRate);
                public static readonly BufferSize: number = 4096;

                private _outputBuffer: Float32Array = new Float32Array(0);
                private _circularBuffer: CircularSampleBuffer;
                private _sharedSampleBuffer: SharedSampleBuffer | null;
                private _bufferCount: number;
                private _requestedBufferCount: number = 0;
                private _isStopped = false;
                private _hasReceivedSamples = false;
                private _finalBufferReceived = false;
                private _diagnosticOutputFrames = 0;
                private _sharedGeneration = 0;
                private _sharedWriteSequence = 0;
                private _diagnostics: SynthOutputDiagnosticsTracker;
                private readonly _samplesPlayedReporter = new SamplesPlayedReporter(
                    WebAudioSamplesPlayedReportIntervalFrames
                );
                private _directWorkerPort: MessagePort | null = null;

                public constructor(options: AudioWorkletNodeOptions) {
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
                    const sharedDescriptor = options.processorOptions.sharedSampleBuffer as
                        | SharedSampleBufferDescriptor
                        | undefined;
                    this._sharedSampleBuffer = sharedDescriptor
                        ? SharedSampleBuffer.fromDescriptor(sharedDescriptor)
                        : null;
                    this._sharedGeneration = this._sharedSampleBuffer?.generation ?? 0;
                    this._sharedWriteSequence = this._sharedSampleBuffer?.writeSequence ?? 0;
                    this._diagnostics = new SynthOutputDiagnosticsTracker(
                        'audio-worklet',
                        sampleRate,
                        (AlphaSynthWebWorkletProcessor.BufferSize * this._bufferCount) / SynthConstants.AudioChannels
                    );

                    this.port.addEventListener('message', event => this._handleMessage(event));
                    this.port.start();
                }

                private _handleMessage(event: MessageEvent<IAlphaSynthWorkerMessage>): void {
                    const data = event.data;
                    switch (data.cmd) {
                        case 'alphaSynth.output.attachWorkerPort':
                            this._directWorkerPort?.close();
                            this._directWorkerPort = data.port;
                            this._directWorkerPort.addEventListener('message', directEvent =>
                                this._handleMessage(directEvent)
                            );
                            this._directWorkerPort.start();
                            break;
                        case 'alphaSynth.output.addSamples': {
                            if (this._sharedSampleBuffer) {
                                break;
                            }
                            const samples = data.samples;
                            const writtenSamples = this._circularBuffer.write(samples, 0, samples.length);
                            this._requestedBufferCount = Math.max(0, this._requestedBufferCount - 1);
                            this._hasReceivedSamples ||= samples.length > 0;
                            this._finalBufferReceived ||= data.isFinal === true;
                            const droppedFrames = Math.floor(
                                (samples.length - writtenSamples) / SynthConstants.AudioChannels
                            );
                            this._diagnostics.recordDroppedFrames(droppedFrames);
                            this._recordBufferDepth();
                            if (droppedFrames > 0) {
                                this._postSamplesPlayed(droppedFrames);
                            }
                            break;
                        }
                        case 'alphaSynth.output.resetSamples':
                            this._meter.reset();
                            if (!this._sharedSampleBuffer) {
                                this._circularBuffer.clear();
                            }
                            // Requests already sent across the worklet boundary are still in flight.
                            // Keep accounting for them so rapid consecutive resets cannot request
                            // duplicate refill batches and overflow the freshly cleared buffer.
                            this._samplesPlayedReporter.reset();
                            this._hasReceivedSamples = false;
                            this._finalBufferReceived = false;
                            this._syncSharedState();
                            this._recordBufferDepth();
                            this._requestBuffers();
                            break;
                        case 'alphaSynth.output.resetDiagnostics':
                            this._sharedSampleBuffer?.resetDiagnostics();
                            this._diagnostics.reset(this._bufferedSampleCount / SynthConstants.AudioChannels);
                            this._diagnosticOutputFrames = 0;
                            this._postDiagnostics();
                            break;
                        case 'alphaSynth.output.stop':
                            this._meter.reset();
                            this._flushSamplesPlayed();
                            this._isStopped = true;
                            this._directWorkerPort?.close();
                            this._directWorkerPort = null;
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

                    const left = outputs[0][0];
                    const right = outputs[0][1];
                    if (!left || !right) {
                        return true;
                    }

                    const sampleCount = left.length + right.length;
                    let buffer = this._outputBuffer;
                    if (buffer.length !== sampleCount) {
                        buffer = new Float32Array(sampleCount);
                        this._outputBuffer = buffer;
                    }

                    this._syncSharedState();
                    let interleavedSamplesToRead = Math.min(buffer.length, this._bufferedSampleCount);
                    interleavedSamplesToRead -= interleavedSamplesToRead % SynthConstants.AudioChannels;
                    const samplesFromBuffer = this._sharedSampleBuffer
                        ? this._sharedSampleBuffer.read(buffer, 0, interleavedSamplesToRead)
                        : this._circularBuffer.read(buffer, 0, interleavedSamplesToRead);
                    const playedFrames = writeInterleavedStereoSamples(buffer, samplesFromBuffer, left, right);
                    const level = this._meter.push(left, right);
                    if (level) {
                        // Send only the small level snapshot directly to the main-side output.
                        this.port.postMessage({ cmd: 'alphaSynth.output.level', level });
                    }

                    if (this._hasReceivedSamples) {
                        const finalTail = this._finalBufferReceived && playedFrames < left.length;
                        this._diagnostics.recordOutput(
                            playedFrames,
                            finalTail ? playedFrames : left.length,
                            !finalTail
                        );
                    }
                    this._recordBufferDepth();
                    this._diagnosticOutputFrames += left.length;

                    const samplesPlayed = this._samplesPlayedReporter.update(playedFrames, left.length);
                    if (samplesPlayed !== undefined) {
                        this._postSamplesPlayed(samplesPlayed);
                    }
                    this._requestBuffers();

                    return this._bufferedSampleCount > 0 || !this._isStopped;
                }

                private get _bufferedSampleCount(): number {
                    return this._sharedSampleBuffer?.countSamples ?? this._circularBuffer.count;
                }

                private _syncSharedState(): void {
                    const shared = this._sharedSampleBuffer;
                    if (!shared) {
                        return;
                    }

                    const generation = shared.generation;
                    if (generation !== this._sharedGeneration) {
                        this._meter.reset();
                        this._sharedGeneration = generation;
                        this._samplesPlayedReporter.reset();
                        this._hasReceivedSamples = false;
                        this._finalBufferReceived = false;
                    }

                    const writeSequence = shared.writeSequence;
                    let committedWrites = writeSequence - this._sharedWriteSequence;
                    if (committedWrites < 0) {
                        committedWrites += 0x100000000;
                    }
                    if (committedWrites > 0) {
                        this._sharedWriteSequence = writeSequence;
                        this._requestedBufferCount = Math.max(0, this._requestedBufferCount - committedWrites);
                        this._hasReceivedSamples = true;
                    }
                    this._finalBufferReceived ||= shared.isFinal;

                    const droppedFrames = shared.takeDroppedFrames();
                    if (droppedFrames > 0) {
                        this._diagnostics.recordDroppedFrames(droppedFrames);
                        this._postSamplesPlayed(droppedFrames);
                    }
                }

                private _requestBuffers(): void {
                    if (this._isStopped) {
                        return;
                    }
                    const halfBufferCount = calculateWebAudioRequestBufferCount(this._bufferCount);
                    const halfSamples = halfBufferCount * AlphaSynthWebWorkletProcessor.BufferSize;
                    const bufferedSamples =
                        this._bufferedSampleCount +
                        this._requestedBufferCount * AlphaSynthWebWorkletProcessor.BufferSize;
                    if (bufferedSamples < halfSamples) {
                        this._requestedBufferCount += halfBufferCount;
                        for (let i = 0; i < halfBufferCount; i++) {
                            this._postToSynth({ cmd: 'alphaSynth.output.sampleRequest' });
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
                    const diagnostics = this._takeDiagnosticsForReport();
                    this._postToSynth({
                        cmd: 'alphaSynth.output.samplesPlayed',
                        samples,
                        diagnostics
                    });
                    if (diagnostics && this._directWorkerPort) {
                        this.port.postMessage({ cmd: 'alphaSynth.output.diagnostics', diagnostics });
                    }
                }

                private _postToSynth(message: IAlphaSynthWorkerMessage): void {
                    (this._directWorkerPort ?? this.port).postMessage(message);
                }

                private _recordBufferDepth(): void {
                    this._diagnostics.recordBufferDepth(this._bufferedSampleCount / SynthConstants.AudioChannels);
                }

                private _takeDiagnosticsForReport() {
                    const intervalFrames = Math.max(1, Math.floor(sampleRate / 4));
                    if (this._diagnosticOutputFrames < intervalFrames) {
                        return undefined;
                    }
                    this._diagnosticOutputFrames = 0;
                    return this._diagnostics.snapshot;
                }

                private _postDiagnostics(): void {
                    this.port.postMessage({
                        cmd: 'alphaSynth.output.diagnostics',
                        diagnostics: this._diagnostics.snapshot
                    });
                }
            }
        );
    }
}
