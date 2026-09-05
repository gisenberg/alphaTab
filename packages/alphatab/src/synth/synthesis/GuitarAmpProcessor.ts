import type { ITrackAudioProcessor } from '@coderline/alphatab/synth/synthesis/TrackAudioBus';

/**
 * First-order antiderivative antialiasing of a cubic soft clipper.
 * See Werner and Azelborn, DAFx 2023, Antialiasing Piecewise Polynomial Waveshapers.
 * Original implementation; no vendor DSP or samples. Reduces aliasing, not alias-free.
 * @internal
 */
export class AntialiasedSoftClipper {
    private _previous: number = 0;

    public reset(): void {
        this._previous = 0;
    }

    private static _primitive(x: number): number {
        const a = Math.abs(x);
        return a >= 1 ? a - 0.375 : 0.75 * x * x - 0.125 * x * x * x * x;
    }

    public process(x: number): number {
        if (!Number.isFinite(x)) {
            this.reset();
            return 0;
        }
        const p = this._previous;
        this._previous = x;
        if (Math.abs(x) <= 1 && Math.abs(p) <= 1) {
            // Factored divided difference avoids cancellation for nearly equal inputs.
            return (x + p) * (0.75 - 0.125 * (x * x + p * p));
        }
        if (x >= 1 && p >= 1) {
            return 1;
        }
        if (x <= -1 && p <= -1) {
            return -1;
        }
        return (AntialiasedSoftClipper._primitive(x) - AntialiasedSoftClipper._primitive(p)) / (x - p);
    }
}

/**
 * Experimental original drive and cabinet-voicing stage for clean guitar samples.
 * Two ADAA stages at 2x rate; fixed storage and no allocations in process().
 * Not a circuit model, recorded cabinet IR, or reproduction of Guitar Pro's RSE.
 * @internal
 */
export class GuitarAmpProcessor implements ITrackAudioProcessor {
    private readonly _previousInput = new Float64Array(2);
    private readonly _highPassInput = new Float64Array(2);
    private readonly _highPassOutput = new Float64Array(2);
    private readonly _cabinet = new Float64Array(8);
    private readonly _clippers = [
        new AntialiasedSoftClipper(),
        new AntialiasedSoftClipper(),
        new AntialiasedSoftClipper(),
        new AntialiasedSoftClipper()
    ];
    private readonly _highPassCoefficient: number;
    private readonly _lowPassCoefficient: number;

    public constructor(
        sampleRate: number,
        private readonly _drive: number = 24,
        private readonly _outputGain: number = 0.2,
        private readonly _inputGain: number = 1
    ) {
        if (
            !Number.isFinite(sampleRate) ||
            sampleRate < 8000 ||
            sampleRate > 192000 ||
            !Number.isFinite(_drive) ||
            _drive < 1 ||
            _drive > 64 ||
            !Number.isFinite(_outputGain) ||
            _outputGain < 0 ||
            _outputGain > 1 ||
            !Number.isFinite(_inputGain) || _inputGain < 0 || _inputGain > 1
        ) {
            throw new Error('Invalid guitar amp configuration');
        }
        this._highPassCoefficient = Math.exp((-2 * Math.PI * 90) / (sampleRate * 2));
        this._lowPassCoefficient = 1 - Math.exp((-2 * Math.PI * Math.min(7000, sampleRate * 0.2)) / (sampleRate * 2));
    }

    public reset(): void {
        this._previousInput.fill(0);
        this._highPassInput.fill(0);
        this._highPassOutput.fill(0);
        this._cabinet.fill(0);
        for (const clipper of this._clippers) {
            clipper.reset();
        }
    }

    public process(buffer: Float32Array, frames: number): void {
        if (!Number.isInteger(frames) || frames < 0 || frames * 2 > buffer.length) {
            throw new Error('Invalid stereo frame count');
        }
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < 2; channel++) {
                const index = frame * 2 + channel;
                const input = Number.isFinite(buffer[index]) ? Math.max(-100, Math.min(100, buffer[index])) * this._inputGain : 0;
                const previous = this._previousInput[channel];
                let output = 0;
                for (let phase = 1; phase <= 2; phase++) {
                    const interpolated = previous + (input - previous) * phase * 0.5;
                    const highPassed =
                        this._highPassCoefficient *
                        (this._highPassOutput[channel] + interpolated - this._highPassInput[channel]);
                    this._highPassInput[channel] = interpolated;
                    this._highPassOutput[channel] = highPassed;
                    output = this._clippers[channel * 2].process(highPassed * this._drive);
                    output = this._clippers[channel * 2 + 1].process(output * 4);
                    // Smooth cabinet-like roll-off also filters before returning to the base rate.
                    for (let pole = 0; pole < 4; pole++) {
                        const state = channel * 4 + pole;
                        this._cabinet[state] += this._lowPassCoefficient * (output - this._cabinet[state]);
                        output = this._cabinet[state];
                    }
                }
                this._previousInput[channel] = input;
                buffer[index] = output * this._outputGain;
            }
        }
    }
}
