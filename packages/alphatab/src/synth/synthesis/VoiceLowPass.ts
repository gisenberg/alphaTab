// The SoundFont loading and Audio Synthesis is based on TinySoundFont, licensed under MIT,
// developed by Bernhard Schelling (https://github.com/schellingb/TinySoundFont)
// TypeScript port for alphaTab: (C) 2020 by Daniel Kuschny
// Licensed under: MPL-2.0
import { SynthHelper } from '@coderline/alphatab/synth/SynthHelper';

/**
 * @internal
 */
export class VoiceLowPass {
    public qInv: number = 0;
    public a0: number = 0;
    public a1: number = 0;
    public b1: number = 0;
    public b2: number = 0;
    public z1: number = 0;
    public z2: number = 0;
    public active: boolean = false;
    public resonance: number = 0;
    private _gain: number = 1;

    public constructor(other?: VoiceLowPass) {
        if (other) {
            this.qInv = other.qInv;
            this.a0 = other.a0;
            this.a1 = other.a1;
            this.b1 = other.b1;
            this.b2 = other.b2;
            this.z1 = other.z1;
            this.z2 = other.z2;
            this.active = other.active;
            this.resonance = other.resonance;
            this._gain = other._gain;
        }
    }

    public setResonance(centibels: number): void {
        this.resonance = Math.max(0, Math.min(960, centibels));
        // Butterworth at zero resonance; SoundFont resonance is measured in tenths of dB.
        this.qInv = Math.SQRT2 * Math.pow(10, -this.resonance / 200);
        // Reduce the DC gain by half the requested resonance, folded into feed-forward coefficients.
        this._gain = Math.pow(10, -this.resonance / 400);
    }

    public setCutoff(cents: number, sampleRate: number): void {
        this.active = this.resonance > 0 || cents <= 13500;
        if (this.active) {
            const boundedCents = Math.max(1500, Math.min(13500, cents));
            this.setup(SynthHelper.cents2Hertz(boundedCents) / sampleRate);
        }
    }

    public setup(fc: number): void {
        // Lowpass filter from http://www.earlevel.com/main/2012/11/26/biquad-c-source-code/
        // A modulated cutoff may exceed Nyquist, especially at low output sample rates.
        const k: number = Math.tan(Math.PI * Math.max(0.00001, Math.min(0.49, fc)));
        const kk: number = k * k;
        const norm: number = 1 / (1 + k * this.qInv + kk);
        this.a0 = kk * norm * this._gain;
        this.a1 = 2 * this.a0;
        this.b1 = 2 * (kk - 1) * norm;
        this.b2 = (1 - k * this.qInv + kk) * norm;
    }

    public process(input: number): number {
        const output: number = input * this.a0 + this.z1;
        this.z1 = input * this.a1 + this.z2 - this.b1 * output;
        this.z2 = input * this.a0 - this.b2 * output;
        return output;
    }
}
