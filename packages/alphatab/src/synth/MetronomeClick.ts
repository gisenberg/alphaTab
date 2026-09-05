/**
 * Original, bank-independent wooden click shared by synthesis, exports and backing tracks.
 * Two damped resonances give a short percussive attack without the sustained sine beep.
 * @internal
 */
export class MetronomeClick {
    public static createSamples(sampleRate: number, accent: boolean): Float32Array {
        const length = Math.ceil(sampleRate * 0.09);
        const samples = new Float32Array(length);
        const frequency = 500;
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const attack = Math.min(1, t / 0.0008);
            const release = Math.min(1, (length - 1 - i) / (sampleRate * 0.004));
            const body = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / 0.012);
            const overtone = Math.sin(2 * Math.PI * frequency * 2.37 * t) * Math.exp(-t / 0.009);
            // A rounder, stronger downbeat and a brighter regular beat remain distinct in a mix.
            samples[i] = (accent ? 0.22 : 0.16) * attack * release * (body + (accent ? 0.25 : 0.8) * overtone);
        }
        return samples;
    }
}
