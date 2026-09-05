import { SamplePeakLimiter } from '@coderline/alphatab/synth/SamplePeakLimiter';

/**
 * Removes the limiter's initial delay and drains its tail exactly once.
 * Callers generate ahead by latencyFrames, rather than delaying the audible timeline.
 * An initial chunk shorter than lookahead can produce no samples; it is not EOF.
 * @internal
 */
export class SamplePeakLimiterStream {
    private readonly _limiter: SamplePeakLimiter;
    private _skipFrames: number;
    private _finished: boolean = false;

    public get finished(): boolean {
        return this._finished;
    }

    public constructor(sampleRate: number) {
        this._limiter = new SamplePeakLimiter(sampleRate);
        this._skipFrames = this._limiter.latencyFrames;
    }

    public reset(): void {
        this._limiter.reset();
        this._skipFrames = this._limiter.latencyFrames;
        this._finished = false;
    }

    public process(samples: Float32Array, final: boolean): Float32Array {
        if (this._finished) {
            throw new Error('Cannot process a finished limiter stream without resetting');
        }
        if (samples.length % 2 !== 0) {
            throw new Error('Expected interleaved stereo samples');
        }
        if (final) {
            const drained = new Float32Array(samples.length + this._limiter.latencyFrames * 2);
            drained.set(samples);
            samples = drained;
            this._finished = true;
        }
        this._limiter.processInterleaved(samples, 0, samples.length / 2);
        const skip = Math.min(this._skipFrames, samples.length / 2);
        this._skipFrames -= skip;
        return skip ? samples.subarray(skip * 2) : samples;
    }
}
