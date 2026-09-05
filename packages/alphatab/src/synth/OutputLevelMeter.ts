/** Post-output sample peak and unweighted stereo RMS, in linear amplitude. @public @target web */
export interface SynthOutputLevel {
    readonly peak: number;
    readonly rms: number;
}

/** Fixed-storage level measurement, reporting no more than ten times per audio second. @internal @target web */
export class OutputLevelMeter {
    private readonly _intervalFrames: number;
    private _frames: number = 0;
    private _peak: number = 0;
    private _power: number = 0;

    public constructor(sampleRate: number) {
        if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
            throw new RangeError('Invalid meter sample rate');
        }
        this._intervalFrames = Math.ceil(sampleRate / 10);
    }

    public reset(): void {
        this._frames = 0;
        this._peak = 0;
        this._power = 0;
    }

    public push(left: Float32Array, right: Float32Array): SynthOutputLevel | null {
        const frames = Math.min(left.length, right.length);
        for (let frame = 0; frame < frames; frame++) {
            const l = left[frame];
            const r = right[frame];
            this._peak = Math.max(this._peak, Math.abs(l), Math.abs(r));
            this._power += l * l + r * r;
        }
        this._frames += frames;
        if (this._frames < this._intervalFrames) {
            return null;
        }
        const level = { peak: this._peak, rms: Math.sqrt(this._power / (this._frames * 2)) };
        this.reset();
        return level;
    }
}
