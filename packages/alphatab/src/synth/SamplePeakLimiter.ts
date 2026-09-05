/**
 * Stereo-linked lookahead sample-peak limiter with bounded storage and O(1) work per frame.
 * The caller must account for latencyFrames and drain that many silent input frames at EOF.
 * This is sample-peak protection, not an oversampled true-peak limiter.
 * @internal
 */
export class SamplePeakLimiter {
    public readonly latencyFrames: number;
    private readonly _ceiling: number;
    private readonly _release: number;
    private readonly _audio: Float32Array;
    private readonly _gains: Float64Array;
    private readonly _peakValues: Float64Array;
    private readonly _peakIndices: Float64Array;
    private _head: number = 0;
    private _tail: number = 0;
    private _frame: number = 0;
    private _detectorGain: number = 1;
    private _gainSum: number;

    public constructor(sampleRate: number, lookaheadMilliseconds: number = 3, ceiling: number = 0.95) {
        if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
            !Number.isFinite(lookaheadMilliseconds) || lookaheadMilliseconds < 0 || lookaheadMilliseconds > 20 ||
            !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) {
            throw new Error('Invalid sample-peak limiter configuration');
        }
        this.latencyFrames = Math.ceil(sampleRate * lookaheadMilliseconds / 1000);
        this._ceiling = ceiling;
        this._release = 1 - Math.exp(-1 / (sampleRate * 0.08));
        const size = this.latencyFrames + 1;
        this._audio = new Float32Array(size * 2);
        this._gains = new Float64Array(size);
        this._gains.fill(1);
        this._gainSum = size;
        this._peakValues = new Float64Array(size + 1);
        this._peakIndices = new Float64Array(size + 1);
    }

    public reset(): void {
        this._audio.fill(0);
        this._gains.fill(1);
        this._head = 0;
        this._tail = 0;
        this._frame = 0;
        this._detectorGain = 1;
        this._gainSum = this._gains.length;
    }

    public processInterleaved(buffer: Float32Array, offset: number, frames: number): void {
        const size = this._gains.length;
        const queueSize = this._peakValues.length;
        for (let i = 0; i < frames; i++) {
            const position = offset + i * 2;
            const left = Number.isFinite(buffer[position]) ? buffer[position] : 0;
            const right = Number.isFinite(buffer[position + 1]) ? buffer[position + 1] : 0;
            const peak = Math.max(Math.abs(left), Math.abs(right));
            const slot = this._frame % size;
            this._audio[slot * 2] = left;
            this._audio[slot * 2 + 1] = right;

            // Monotonic queue of the past lookahead window's peaks.
            while (this._head !== this._tail && this._peakIndices[this._head] < this._frame - this.latencyFrames) {
                this._head = (this._head + 1) % queueSize;
            }
            while (this._head !== this._tail) {
                const previous = (this._tail + queueSize - 1) % queueSize;
                if (this._peakValues[previous] > peak) {
                    break;
                }
                this._tail = previous;
            }
            this._peakValues[this._tail] = peak;
            this._peakIndices[this._tail] = this._frame;
            this._tail = (this._tail + 1) % queueSize;
            const windowPeak = this._peakValues[this._head];
            const required = windowPeak > this._ceiling ? this._ceiling / windowPeak : 1;
            this._detectorGain = Math.min(required, this._detectorGain + this._release * (1 - this._detectorGain));

            // Every detector window in this moving average contains the delayed output frame.
            // Consequently each gain, and their average, is safe for that frame's peak.
            // Averaging spreads the attack across lookaheadFrames rather than jumping the gain.
            this._gainSum += this._detectorGain - this._gains[slot];
            this._gains[slot] = this._detectorGain;
            const gain = Math.max(0, Math.min(1, this._gainSum / size));
            const delayed = ((slot + 1) % size) * 2;
            buffer[position] = this._audio[delayed] * gain;
            buffer[position + 1] = this._audio[delayed + 1] * gain;
            this._frame++;
        }
    }
}
