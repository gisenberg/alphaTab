/** Bounded, allocation-free release draining shared by audio render paths. @internal */
export class SynthesisReleaseTail {
    private _frames = 0;
    private _quietFrames = 0;
    private readonly _maximumFrames: number;
    private readonly _fadeFrames: number;
    private readonly _quietLimit: number;
    public finished: boolean;

    public constructor(sampleRate: number, seconds: number) {
        if (!Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
            throw new Error('Invalid release-tail configuration');
        }
        this._maximumFrames = Math.round(sampleRate * seconds);
        this._fadeFrames = Math.min(this._maximumFrames, Math.ceil(sampleRate * 0.01));
        this._quietLimit = Math.ceil(sampleRate * 0.05);
        this.finished = this._maximumFrames === 0;
    }

    public reset(): void {
        this._frames = 0;
        this._quietFrames = 0;
        this.finished = this._maximumFrames === 0;
    }

    /** Returns the number of retained stereo frames, including a fade if the bound is reached. */
    public process(samples: Float32Array, offset: number, frames: number, voicesActive: boolean): number {
        let retained = 0;
        for (; retained < frames && !this.finished; retained++) {
            const remaining = this._maximumFrames - this._frames;
            const gain = remaining <= this._fadeFrames ? (remaining - 1) / Math.max(1, this._fadeFrames) : 1;
            const index = offset + retained * 2;
            samples[index] *= gain;
            samples[index + 1] *= gain;
            const quiet = Math.max(Math.abs(samples[index]), Math.abs(samples[index + 1])) < 0.00001;
            this._quietFrames = quiet && !voicesActive ? this._quietFrames + 1 : 0;
            this._frames++;
            this.finished = this._frames >= this._maximumFrames || this._quietFrames >= this._quietLimit;
        }
        return retained;
    }
}
