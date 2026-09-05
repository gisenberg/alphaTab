/**
 * Original, bank-independent wooden click shared by synthesis, exports and backing tracks.
 * Damped resonances plus a deterministic band-limited strike model the attack and tail.
 * No recorded samples are used. Callers cache the result rather than synthesize each beat.
 * @internal
 */
export class MetronomeClick {
    public static createSamples(sampleRate: number, accent: boolean): Float32Array {
        if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
            throw new Error('Invalid metronome sample rate');
        }
        // Fixed continuous-time partials avoid sample-rate-dependent random noise
        // and aliasing. Higher-rate devices hear the same strike, not a new seed.
        const frequencies = new Float64Array(32);
        const phases = new Float64Array(32);
        let random = 0x4f1bbcdc;
        const nextRandom = () => {
            random ^= random << 13;
            random ^= random >>> 17;
            random ^= random << 5;
            return (random >>> 0) / 4294967296;
        };
        for (let p = 0; p < frequencies.length; p++) {
            frequencies[p] = 350 + (p + nextRandom()) * 190;
            phases[p] = nextRandom() * 2 * Math.PI;
        }
        const length = Math.ceil(sampleRate * 0.15);
        const samples = new Float32Array(length);
        let energy = 0;
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            let strike = 0;
            for (let p = 0; p < frequencies.length; p++) {
                if (frequencies[p] < sampleRate * 0.45) {
                    strike += Math.sin(2 * Math.PI * frequencies[p] * t + phases[p]);
                }
            }
            const attack = Math.min(1, t / 0.00025);
            const release = Math.min(1, (length - 1 - i) / (sampleRate * 0.01));
            const body = (accent ? 1.15 : 1) * Math.sin(2 * Math.PI * 500 * t) * Math.exp(-t / 0.016);
            const overtone = (accent ? 0.75 : 1.08) * Math.sin(2 * Math.PI * 1185 * t) * Math.exp(-t / 0.008);
            const tail = 0.19 * (Math.sin(2 * Math.PI * 490 * t + 0.5) + 0.5 * Math.sin(2 * Math.PI * 1230 * t)) * Math.exp(-t / 0.045);
            const noise = (accent ? 0.82 : 0.65) * strike / 4 * Math.exp(-t / 0.005);
            samples[i] = attack * release * (body + overtone + tail + noise);
            energy += samples[i] * samples[i];
        }
        // Preserve regular-beat energy independently of sample rate. The stronger
        // downbeat follows the measured accent contrast of a lossless GP export;
        // it changes neither regular-beat loudness nor the original strike model.
        const gain = Math.sqrt((accent ? 0.000215 : 0.0001) * sampleRate / energy);
        for (let i = 0; i < length; i++) {
            samples[i] *= gain;
        }
        return samples;
    }
}
