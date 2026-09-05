import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';

/** Worker-owned processing of the summed strings of one track. @internal */
export interface ITrackAudioProcessor {
    /** Process interleaved stereo in place, including silence to advance effect tails. */
    process(buffer: Float32Array, frames: number): void;
    reset(): void;
}

/** Fixed-size scratch storage, allocated when configuring a track, never per audio block. @internal */
export class TrackAudioBus {
    public readonly channels: readonly number[];
    public readonly programSources: ReadonlyMap<number, number> | undefined;
    public readonly buffer: Float32Array = new Float32Array(SynthConstants.MicroBufferSize * 2);

    public constructor(
        channels: readonly number[],
        public readonly processor: ITrackAudioProcessor,
        programSources?: ReadonlyMap<number, number>
    ) {
        if (!channels.length || new Set(channels).size !== channels.length ||
            channels.some(channel => !Number.isInteger(channel) || channel < 0)) {
            throw new Error('Track audio bus requires distinct nonnegative channels');
        }
        this.channels = [...channels];
        if (programSources && [...programSources].some(([program, source]) =>
            !Number.isInteger(program) || program < 0 || program > 127 ||
            !Number.isInteger(source) || source < 0 || source > 127)) {
            throw new Error('Track program sources must be General MIDI program numbers');
        }
        this.programSources = programSources ? new Map(programSources) : undefined;
    }

    public reset(): void {
        this.buffer.fill(0);
        this.processor.reset();
    }
}
