import { SamplePeakLimiter } from '@coderline/alphatab/synth/SamplePeakLimiter';

/**
 * Planar Web Audio adapter for the same stereo-linked limiter used by synthesis.
 * Uses fixed scratch storage even if a browser changes its render quantum size.
 * The caller supplies an already summed stereo bus and accounts for latencyFrames.
 * @target web
 * @internal
 */
export class StereoPeakOutputProcessor {
    private readonly _limiter: SamplePeakLimiter;
    private readonly _scratch: Float32Array = new Float32Array(256);

    public constructor(sampleRate: number) {
        this._limiter = new SamplePeakLimiter(sampleRate);
    }

    public get latencyFrames(): number {
        return this._limiter.latencyFrames;
    }

    public reset(): void {
        this._limiter.reset();
    }

    public process(input: Float32Array[], output: Float32Array[]): void {
        const left = output[0];
        const right = output[1];
        if (!left || !right) {
            return;
        }
        const inputLeft = input[0];
        // Web Audio normally upmixes the bus, but mono input must also be safe.
        const inputRight = input[1] ?? inputLeft;
        const frames = Math.min(left.length, right.length);
        for (let offset = 0; offset < frames; offset += 128) {
            const count = Math.min(128, frames - offset);
            for (let frame = 0; frame < count; frame++) {
                this._scratch[frame * 2] = inputLeft?.[offset + frame] ?? 0;
                this._scratch[frame * 2 + 1] = inputRight?.[offset + frame] ?? 0;
            }
            this._limiter.processInterleaved(this._scratch, 0, count);
            for (let frame = 0; frame < count; frame++) {
                left[offset + frame] = this._scratch[frame * 2];
                right[offset + frame] = this._scratch[frame * 2 + 1];
            }
        }
    }
}
