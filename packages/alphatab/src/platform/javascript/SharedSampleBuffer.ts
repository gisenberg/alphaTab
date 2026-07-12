import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/**
 * Descriptor shared by the synth producer and AudioWorklet consumer.
 * @target web
 * @internal
 */
export interface SharedSampleBufferDescriptor {
    readonly buffer: SharedArrayBuffer;
}

/**
 * Result of one producer write.
 * @target web
 * @internal
 */
export interface SharedSampleBufferWriteResult {
    readonly writtenSamples: number;
    readonly droppedSamples: number;
}

/**
 * Lock-free single-producer/single-consumer Float32 ring shared by a synth
 * worker and an AudioWorklet. Payload samples never cross the renderer.
 * @target web
 * @internal
 */
export class SharedSampleBuffer {
    private static readonly _headerLength = 9;
    private static readonly _writeIndex = 0;
    private static readonly _readIndex = 1;
    private static readonly _count = 2;
    private static readonly _capacity = 3;
    private static readonly _generation = 4;
    private static readonly _writeSequence = 5;
    private static readonly _finalFlag = 6;
    private static readonly _droppedFrames = 7;
    private static readonly _diagnosticsGeneration = 8;

    private readonly _header: Int32Array;
    private readonly _samples: Float32Array;

    public static create(capacitySamples: number): SharedSampleBuffer {
        capacitySamples = Math.max(
            SynthConstants.AudioChannels,
            Math.floor(capacitySamples / SynthConstants.AudioChannels) * SynthConstants.AudioChannels
        );
        const byteLength =
            SharedSampleBuffer._headerLength * Int32Array.BYTES_PER_ELEMENT +
            capacitySamples * Float32Array.BYTES_PER_ELEMENT;
        const shared = new SharedSampleBuffer({ buffer: new SharedArrayBuffer(byteLength) });
        Atomics.store(shared._header, SharedSampleBuffer._capacity, capacitySamples);
        return shared;
    }

    public static fromDescriptor(descriptor: SharedSampleBufferDescriptor): SharedSampleBuffer {
        return new SharedSampleBuffer(descriptor);
    }

    private constructor(descriptor: SharedSampleBufferDescriptor) {
        this._header = new Int32Array(descriptor.buffer, 0, SharedSampleBuffer._headerLength);
        const capacityFromLength =
            (descriptor.buffer.byteLength - SharedSampleBuffer._headerLength * Int32Array.BYTES_PER_ELEMENT) /
            Float32Array.BYTES_PER_ELEMENT;
        this._samples = new Float32Array(
            descriptor.buffer,
            SharedSampleBuffer._headerLength * Int32Array.BYTES_PER_ELEMENT,
            capacityFromLength
        );
    }

    public get descriptor(): SharedSampleBufferDescriptor {
        return { buffer: this._header.buffer as SharedArrayBuffer };
    }

    public get capacitySamples(): number {
        return Atomics.load(this._header, SharedSampleBuffer._capacity);
    }

    public get countSamples(): number {
        return Atomics.load(this._header, SharedSampleBuffer._count);
    }

    public get generation(): number {
        return Atomics.load(this._header, SharedSampleBuffer._generation);
    }

    public get writeSequence(): number {
        return Atomics.load(this._header, SharedSampleBuffer._writeSequence);
    }

    public get isFinal(): boolean {
        return Atomics.load(this._header, SharedSampleBuffer._finalFlag) !== 0;
    }

    public write(source: Float32Array, isFinal: boolean = false): SharedSampleBufferWriteResult {
        const capacity = this.capacitySamples;
        const count = this.countSamples;
        let samplesToWrite = Math.min(source.length, capacity - count);
        samplesToWrite -= samplesToWrite % SynthConstants.AudioChannels;

        let writeIndex = Atomics.load(this._header, SharedSampleBuffer._writeIndex);
        const firstLength = Math.min(samplesToWrite, capacity - writeIndex);
        if (firstLength > 0) {
            this._samples.set(source.subarray(0, firstLength), writeIndex);
        }
        const secondLength = samplesToWrite - firstLength;
        if (secondLength > 0) {
            this._samples.set(source.subarray(firstLength, firstLength + secondLength), 0);
        }

        writeIndex = (writeIndex + samplesToWrite) % capacity;
        Atomics.store(this._header, SharedSampleBuffer._writeIndex, writeIndex);
        Atomics.add(this._header, SharedSampleBuffer._count, samplesToWrite);

        const droppedSamples = source.length - samplesToWrite;
        if (droppedSamples > 0) {
            Atomics.add(
                this._header,
                SharedSampleBuffer._droppedFrames,
                Math.floor(droppedSamples / SynthConstants.AudioChannels)
            );
        }
        if (isFinal) {
            Atomics.store(this._header, SharedSampleBuffer._finalFlag, 1);
        }
        Atomics.add(this._header, SharedSampleBuffer._writeSequence, 1);

        return { writtenSamples: samplesToWrite, droppedSamples };
    }

    public read(target: Float32Array, targetOffset: number, requestedSamples: number): number {
        const capacity = this.capacitySamples;
        let samplesToRead = Math.min(requestedSamples, this.countSamples, target.length - targetOffset);
        samplesToRead -= samplesToRead % SynthConstants.AudioChannels;

        let readIndex = Atomics.load(this._header, SharedSampleBuffer._readIndex);
        const firstLength = Math.min(samplesToRead, capacity - readIndex);
        if (firstLength > 0) {
            target.set(this._samples.subarray(readIndex, readIndex + firstLength), targetOffset);
        }
        const secondLength = samplesToRead - firstLength;
        if (secondLength > 0) {
            target.set(this._samples.subarray(0, secondLength), targetOffset + firstLength);
        }

        readIndex = (readIndex + samplesToRead) % capacity;
        Atomics.store(this._header, SharedSampleBuffer._readIndex, readIndex);
        Atomics.sub(this._header, SharedSampleBuffer._count, samplesToRead);
        return samplesToRead;
    }

    public resetSamples(): void {
        Atomics.store(this._header, SharedSampleBuffer._writeIndex, 0);
        Atomics.store(this._header, SharedSampleBuffer._readIndex, 0);
        Atomics.store(this._header, SharedSampleBuffer._count, 0);
        Atomics.store(this._header, SharedSampleBuffer._finalFlag, 0);
        Atomics.add(this._header, SharedSampleBuffer._generation, 1);
    }

    public takeDroppedFrames(): number {
        return Atomics.exchange(this._header, SharedSampleBuffer._droppedFrames, 0);
    }

    public resetDiagnostics(): void {
        Atomics.store(this._header, SharedSampleBuffer._droppedFrames, 0);
        Atomics.add(this._header, SharedSampleBuffer._diagnosticsGeneration, 1);
    }
}
