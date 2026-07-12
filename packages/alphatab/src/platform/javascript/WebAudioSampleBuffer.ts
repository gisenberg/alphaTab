import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/**
 * Calculates how many interleaved sample buffers are needed to cover the requested duration.
 * @internal
 */
export function calculateWebAudioBufferCount(
    bufferTimeInMilliseconds: number,
    sampleRate: number,
    bufferSize: number,
    minimumBufferCount: number = 1
): number {
    const minimum = Math.max(1, Math.floor(minimumBufferCount));
    if (
        !Number.isFinite(bufferTimeInMilliseconds) ||
        bufferTimeInMilliseconds <= 0 ||
        !Number.isFinite(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isFinite(bufferSize) ||
        bufferSize <= 0
    ) {
        return minimum;
    }

    const interleavedSampleCount = (bufferTimeInMilliseconds * sampleRate * SynthConstants.AudioChannels) / 1000;
    return Math.max(minimum, Math.ceil(interleavedSampleCount / bufferSize));
}

/**
 * Calculates the refill batch used by the web audio outputs.
 * @internal
 */
export function calculateWebAudioRequestBufferCount(
    bufferCount: number,
    minimumRequestBufferCount: number = 1
): number {
    return Math.max(Math.max(1, Math.floor(minimumRequestBufferCount)), Math.floor(bufferCount / 2));
}

/**
 * Limits cross-thread playback progress traffic to roughly one update every 23ms at 44.1kHz.
 * @internal
 */
export const WebAudioSamplesPlayedReportIntervalFrames: number = 1024;

/**
 * Copies interleaved stereo samples into Web Audio channel buffers and clears any underflow tail.
 * @returns The number of complete stereo frames copied.
 * @internal
 */
export function writeInterleavedStereoSamples(
    interleaved: Float32Array,
    interleavedSampleCount: number,
    left: Float32Array,
    right: Float32Array
): number {
    const availableFrames = Math.floor(
        Math.min(Math.max(0, interleavedSampleCount), interleaved.length) / SynthConstants.AudioChannels
    );
    const framesToWrite = Math.min(availableFrames, left.length, right.length);

    let sourceIndex = 0;
    for (let frame = 0; frame < framesToWrite; frame++) {
        left[frame] = interleaved[sourceIndex++];
        right[frame] = interleaved[sourceIndex++];
    }

    if (framesToWrite < left.length) {
        left.fill(0, framesToWrite);
    }
    if (framesToWrite < right.length) {
        right.fill(0, framesToWrite);
    }

    return framesToWrite;
}

/**
 * Batches samples-played notifications while still flushing underflow and stop boundaries promptly.
 * @internal
 */
export class SamplesPlayedReporter {
    private _pendingPlayedFrames: number = 0;
    private _silentFrames: number = 0;
    private readonly _reportIntervalFrames: number;

    public constructor(reportIntervalFrames: number) {
        this._reportIntervalFrames = Math.max(1, Math.floor(reportIntervalFrames));
    }

    public update(playedFrames: number, outputFrames: number, force: boolean = false): number | undefined {
        playedFrames = Math.max(0, Math.floor(playedFrames));
        outputFrames = Math.max(0, Math.floor(outputFrames));

        this._pendingPlayedFrames += playedFrames;
        const silentFrames = Math.max(0, outputFrames - playedFrames);
        if (silentFrames > 0) {
            this._silentFrames += silentFrames;
        } else {
            this._silentFrames = 0;
        }

        const underflowedWithAudio = playedFrames < outputFrames && this._pendingPlayedFrames > 0;
        if (
            !force &&
            this._pendingPlayedFrames < this._reportIntervalFrames &&
            !underflowedWithAudio &&
            this._silentFrames < this._reportIntervalFrames
        ) {
            return undefined;
        }

        const report = this._pendingPlayedFrames;
        this.reset();
        return report;
    }

    public reset(): void {
        this._pendingPlayedFrames = 0;
        this._silentFrames = 0;
    }
}
