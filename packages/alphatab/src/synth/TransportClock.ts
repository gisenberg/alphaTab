/**
 * A monotonic transport clock shared by playback implementations.
 *
 * The clock advances from a source observation instead of a UI timer. New
 * observations apply a small drift correction while discontinuities (seeks,
 * loops and device restarts) snap immediately to the authoritative source.
 * @public
 */
export class TransportClock {
    private readonly _now: () => number;
    private _anchorPosition: number = 0;
    private _anchorTime: number = 0;
    private _playbackRate: number = 1;
    private _isRunning: boolean = false;

    /** Maximum drift corrected gradually rather than treated as a discontinuity. */
    public softCorrectionLimit: number = 100;

    /** Fraction of a small source-observation error applied on each observation. */
    public softCorrectionFactor: number = 0.25;

    /**
     * @param now The time source in milliseconds. Defaults to `performance.now()` so all clocks
     * share one monotonic domain with the audio and animation timelines, falling back to
     * `Date.now()` where the high resolution timer is unavailable.
     */
    public constructor(now?: () => number) {
        this._now = now ?? TransportClock.defaultTimeSource();
        this._anchorTime = this._now();
    }

    /** The default monotonic time source of the current platform. */
    public static defaultTimeSource(): () => number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return () => performance.now();
        }
        return () => Date.now();
    }

    /** The current monotonic transport position in milliseconds. */
    public get position(): number {
        return this.positionAt(this._now());
    }

    public positionAt(now: number): number {
        if (!this._isRunning) {
            return this._anchorPosition;
        }
        return this._anchorPosition + Math.max(0, now - this._anchorTime) * this._playbackRate;
    }

    public start(position: number = this.position): void {
        this._anchorPosition = position;
        this._anchorTime = this._now();
        this._isRunning = true;
    }

    public pause(position: number = this.position): void {
        this._anchorPosition = position;
        this._anchorTime = this._now();
        this._isRunning = false;
    }

    public seek(position: number): void {
        this._anchorPosition = position;
        this._anchorTime = this._now();
    }

    public setPlaybackRate(playbackRate: number): void {
        const now = this._now();
        this._anchorPosition = this.positionAt(now);
        this._anchorTime = now;
        this._playbackRate = playbackRate;
    }

    /**
     * Observes an authoritative transport source such as an audio frame counter
     * or media element. Small errors are slewed; discontinuities snap.
     */
    public observe(position: number, observedAt: number = this._now()): void {
        const predicted = this.positionAt(observedAt);
        const drift = position - predicted;
        if (!this._isRunning || Math.abs(drift) > this.softCorrectionLimit) {
            this._anchorPosition = position;
            this._anchorTime = observedAt;
            return;
        }

        this._anchorPosition = predicted + drift * this.softCorrectionFactor;
        this._anchorTime = observedAt;
    }
}
