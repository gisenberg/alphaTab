import { CircularSampleBuffer } from '@coderline/alphatab/synth/ds/CircularSampleBuffer';
import { AlphaSynthWebAudioOutputBase } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import {
    calculateWebAudioBufferCount,
    calculateWebAudioRequestBufferCount,
    SynthOutputDiagnosticsTracker,
    writeInterleavedStereoSamples
} from '@coderline/alphatab/platform/javascript/WebAudioSampleBuffer';

/**
 * This class implements a HTML5 Web Audio API based audio output device
 * for alphaSynth using the legacy ScriptProcessor node.
 * @target web
 * @internal
 */
export class AlphaSynthScriptProcessorOutput extends AlphaSynthWebAudioOutputBase {
    private _audioNode: ScriptProcessorNode | null = null;
    private _circularBuffer!: CircularSampleBuffer;
    private _bufferCount: number = 0;
    private _requestedBufferCount: number = 0;
    private _diagnostics!: SynthOutputDiagnosticsTracker;
    private _diagnosticOutputFrames: number = 0;
    private _hasReceivedSamples: boolean = false;
    private _finalBufferReceived: boolean = false;

    public override open(bufferTimeInMilliseconds: number) {
        super.open(bufferTimeInMilliseconds);
        this._bufferCount = calculateWebAudioBufferCount(
            bufferTimeInMilliseconds,
            this.sampleRate,
            AlphaSynthWebAudioOutputBase.BufferSize,
            2
        );
        this._circularBuffer = new CircularSampleBuffer(AlphaSynthWebAudioOutputBase.BufferSize * this._bufferCount);
        const capacityFrames =
            (AlphaSynthWebAudioOutputBase.BufferSize * this._bufferCount) / SynthConstants.AudioChannels;
        this._diagnostics = new SynthOutputDiagnosticsTracker('script-processor', this.sampleRate, capacityFrames);
        this.configurePlaybackDiagnostics('script-processor', capacityFrames);
        this.onReady();
    }

    public override play(): void {
        super.play();
        const ctx = this.context!;
        // create a script processor node which will replace the silence with the generated audio
        this._audioNode = ctx.createScriptProcessor(4096, 0, 2);
        this._audioNode.onaudioprocess = this._generateSound.bind(this);
        this._circularBuffer.clear();
        this._requestedBufferCount = 0;
        this._hasReceivedSamples = false;
        this._finalBufferReceived = false;
        this._diagnostics.recordBufferDepth(0);
        this._requestBuffers();
        this.source!.connect(this._audioNode, 0, 0);
        this.startSource();
        this._audioNode.connect(ctx.destination, 0, 0);
    }

    public override pause(): void {
        this._diagnostics.recordBufferDepth(0);
        this._publishDiagnostics(true);
        super.pause();
        if (this._audioNode) {
            this._audioNode.disconnect(0);
        }
        this._audioNode = null;
    }

    public addSamples(f: Float32Array, isFinal: boolean = false): void {
        const writtenSamples = this._circularBuffer.write(f, 0, f.length);
        this._requestedBufferCount = Math.max(0, this._requestedBufferCount - 1);
        const droppedFrames = Math.floor((f.length - writtenSamples) / SynthConstants.AudioChannels);
        this._hasReceivedSamples ||= f.length > 0;
        this._finalBufferReceived ||= isFinal;
        this._diagnostics.recordDroppedFrames(droppedFrames);
        this._diagnostics.recordBufferDepth(this._circularBuffer.count / SynthConstants.AudioChannels);
        if (droppedFrames > 0) {
            this.onSamplesPlayed(droppedFrames);
        }
    }

    public resetSamples(): void {
        this._circularBuffer.clear();
        this._requestedBufferCount = 0;
        this._hasReceivedSamples = false;
        this._finalBufferReceived = false;
        this._diagnostics.recordBufferDepth(0);
        this._requestBuffers();
    }

    private _requestBuffers(): void {
        // if we fall under the half of buffers
        // we request one half
        // ScriptProcessor callbacks consume 4096 stereo frames, or two alphaSynth buffers.
        const halfBufferCount = calculateWebAudioRequestBufferCount(this._bufferCount, 2);
        const halfSamples: number = halfBufferCount * AlphaSynthWebAudioOutputBase.BufferSize;
        // Issue #631: it can happen that requestBuffers is called multiple times
        // before we already get samples via addSamples, therefore we need to
        // remember how many buffers have been requested, and consider them as available.
        const bufferedSamples =
            this._circularBuffer.count + this._requestedBufferCount * AlphaSynthWebAudioOutputBase.BufferSize;
        if (bufferedSamples < halfSamples) {
            this._requestedBufferCount += halfBufferCount;
            for (let i: number = 0; i < halfBufferCount; i++) {
                this.onSampleRequest();
            }
        }
    }

    private _outputBuffer: Float32Array = new Float32Array(0);
    private _generateSound(e: AudioProcessingEvent): void {
        const left: Float32Array = e.outputBuffer.getChannelData(0);
        const right: Float32Array = e.outputBuffer.getChannelData(1);
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

        if (this._hasReceivedSamples) {
            const finalTail = this._finalBufferReceived && playedFrames < left.length;
            this._diagnostics.recordOutput(
                playedFrames,
                finalTail ? playedFrames : left.length,
                !finalTail
            );
        }
        this._diagnostics.recordBufferDepth(this._circularBuffer.count / SynthConstants.AudioChannels);
        this._diagnosticOutputFrames += left.length;
        this._publishDiagnostics();

        this.onSamplesPlayed(playedFrames);
        this._requestBuffers();
    }

    protected override onResetPlaybackDiagnostics(): void {
        this._diagnostics.reset(this._circularBuffer.count / SynthConstants.AudioChannels);
        this._diagnosticOutputFrames = 0;
        this.setPlaybackBufferDiagnostics(this._diagnostics.snapshot);
    }

    private _publishDiagnostics(force: boolean = false): void {
        const intervalFrames = Math.max(1, Math.floor(this.sampleRate / 4));
        if (!force && this._diagnosticOutputFrames < intervalFrames) {
            return;
        }
        this._diagnosticOutputFrames = 0;
        this.setPlaybackBufferDiagnostics(this._diagnostics.snapshot);
    }
}
