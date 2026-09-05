import { describe, expect, it } from 'vitest';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { Hydra, HydraIgen } from '@coderline/alphatab/synth/soundfont/Hydra';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { linkStereoSampleRegions, type StereoSampleRegion } from '@coderline/alphatab/synth/synthesis/StereoSampleRegions';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import type { Voice } from '@coderline/alphatab/synth/synthesis/Voice';

function generator(op: number, value: number): HydraIgen {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, value & 0xffff, true);
    return new HydraIgen(ByteBuffer.fromBuffer(bytes));
}

function stereoHydra(): Hydra {
    const hydra = new Hydra();
    hydra.phdrs = [0, 1].map(presetBagNdx => ({ presetName: 'Stereo test', preset: 0,
        bank: 0, presetBagNdx, library: 0, genre: 0, morphology: 0 }));
    hydra.pbags = [{ genNdx: 0, modNdx: 0 }, { genNdx: 1, modNdx: 0 }];
    hydra.pgens = [generator(41, 0)];
    hydra.insts = [{ instName: 'Pair', instBagNdx: 0 }, { instName: 'EOI', instBagNdx: 2 }];
    hydra.ibags = [0, 3, 6].map(instGenNdx => ({ instGenNdx, instModNdx: 0 }));
    hydra.igens = [generator(17, -500), generator(54, 1), generator(53, 0),
        generator(17, 500), generator(54, 1), generator(53, 1)];
    hydra.sHdrs = [0, 1].map(side => ({ sampleName: side ? 'Right' : 'Left',
        start: side * 128, end: (side + 1) * 128, startLoop: side * 128 + 8,
        endLoop: side * 128 + 120, sampleRate: 48000,
        // Different root metadata must not detune the left half from the right half.
        originalPitch: side ? 60 : 72, pitchCorrection: side ? 0 : 17,
        sampleLink: 1 - side, sampleType: side ? 2 : 4 }));
    hydra.sampleData = new Uint8Array(512);
    const pcm = new DataView(hydra.sampleData.buffer);
    for (let i = 0; i < 256; i++) { pcm.setInt16(i * 2, Math.round(Math.sin(i * Math.PI / 8) * 12000), true); }
    return hydra;
}

function load(hydra = stereoHydra()): TinySoundFont {
    const synth = new TinySoundFont(48000);
    synth.loadPresets(hydra, new Set([0]), new Set(), false);
    synth.channelSetPresetIndex(0, 0);
    return synth;
}

function render(synth: TinySoundFont): Float32Array {
    const samples = new Float32Array(128);
    synth.synthesize(samples, 0, 64);
    expect(samples.every(Number.isFinite)).toBe(true);
    return samples;
}

function assertSynchronized(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 2) { expect(samples[i]).toBe(samples[i + 1]); }
}

describe('embedded SoundFont stereo samples', () => {
    it.each([0, 1, -1])('adds preset key scaling before envelope unit conversion (instrument multiplier %i)', multiplier => {
        const hydra = stereoHydra();
        const scaling = [[31, 100], [32, -100], [39, -200], [40, 200]];
        hydra.pgens.unshift(...scaling.map(([op, value]) => generator(op, value)));
        hydra.pbags[1].genNdx += scaling.length;
        hydra.igens.unshift(...scaling.map(([op, value]) => generator(op, value * multiplier)));
        hydra.ibags[1].instGenNdx += scaling.length;
        hydra.ibags[2].instGenNdx += scaling.length;
        const [left, right] = load(hydra).presets![0].regions!;
        // Regression: preset key scaling was discarded, sometimes converting timecents too early.
        for (const [region, factor] of [[left, multiplier + 1], [right, 1]] as const) {
            expect(region.modEnv.keynumToHold).toBe(100 * factor);
            expect(region.modEnv.keynumToDecay).toBe(factor === 0 ? 0 : -100 * factor);
            expect(region.ampEnv.keynumToHold).toBe(factor === 0 ? 0 : -200 * factor);
            expect(region.ampEnv.keynumToDecay).toBe(200 * factor);
            // Nonzero scaling retains timecents for note-on; cancellation restores fixed seconds.
            for (const envelope of [region.ampEnv, region.modEnv]) {
                expect(envelope.hold).toBe(factor === 0 ? 0 : -12000);
                expect(envelope.decay).toBe(factor === 0 ? 0 : -12000);
            }
        }
    });

    it('loads global/local velocity overrides independently on stereo halves and adds preset modulation', () => {
        const hydra = stereoHydra();
        const mod = (modAmount: number) => ({ modSrcOper: 0x0502, modDestOper: 48,
            modAmount, modAmtSrcOper: 0, modTransOper: 0 });
        hydra.phdrs[1].presetBagNdx = 2;
        hydra.pbags = [{ genNdx: 0, modNdx: 0 }, { genNdx: 0, modNdx: 1 }, { genNdx: 1, modNdx: 2 }];
        hydra.pmods = [mod(100), mod(-200)];
        hydra.insts[1].instBagNdx = 3;
        hydra.ibags = [{ instGenNdx: 0, instModNdx: 0 }, { instGenNdx: 0, instModNdx: 1 },
            { instGenNdx: 3, instModNdx: 2 }, { instGenNdx: 6, instModNdx: 2 }];
        hydra.imods = [mod(800), mod(0)];
        const synth = load(hydra);
        expect(synth.presets![0].regions!.map(r => r.velocityAttenuation)).toEqual([-200, 600]);
        synth.channelNoteOn(0, 60, 64 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const active = voices.filter(v => v.region !== null && v.region !== undefined);
        // A zero local instrument override must not revive the default or inherit right-side gain.
        expect(active[0].noteGainDb).toBeGreaterThan(active[1].noteGainDb);
        expect(render(synth).some(x => x !== 0)).toBe(true);
    });

    it.each([[-100, 0], [0, 0], [120, 120], [960, 960], [2000, 960]])('retains and bounds resonance %i in centibels rather than cutoff cents', (resonance, expected) => {
        const hydra = stereoHydra();
        hydra.pgens.unshift(generator(9, resonance));
        hydra.pbags[1].genNdx++;
        const synth = load(hydra);
        expect(synth.presets![0].regions!.map(r => r.initialFilterQ))
            .toEqual([expected, expected]);
        synth.channelNoteOn(0, 60, 0.8);
        assertSynchronized(render(synth));
    });

    it('overrides global gain and tuning within each level, then adds preset to instrument once', () => {
        const hydra = stereoHydra();
        hydra.phdrs[1].presetBagNdx = 2;
        hydra.pbags = [0, 3, 7].map(genNdx => ({ genNdx, modNdx: 0 }));
        hydra.pgens = [generator(48, 200), generator(51, 12), generator(52, 30),
            generator(48, 50), generator(51, -2), generator(52, -5), generator(41, 0)];
        hydra.insts[1].instBagNdx = 3;
        hydra.ibags = [0, 3, 9, 12].map(instGenNdx => ({ instGenNdx, instModNdx: 0 }));
        hydra.igens = [generator(48, 100), generator(51, 7), generator(52, 20),
            generator(48, 30), generator(51, 1), generator(52, 2),
            generator(17, -500), generator(54, 1), generator(53, 0),
            generator(17, 500), generator(54, 1), generator(53, 1)];
        const [left, right] = load(hydra).presets![0].regions!;
        // Regression: += applied both global and local attenuation, making layered banks too quiet.
        expect(left.attenuation).toBe(8);
        expect(left.transpose).toBe(-1);
        expect(left.tune).toBe(14); // Includes the left sample header's +17 cent correction.
        // An omitted local generator still inherits its global value.
        expect(right.attenuation).toBe(15);
        expect(right.transpose).toBe(5);
        expect(right.tune).toBe(15);
    });

    it('loads both zones exactly once and uses right-hand pitch metadata', () => {
        const synth = load();
        const regions = synth.presets![0].regions!;
        expect(regions).toHaveLength(2);
        expect(regions.every(r => r.samples.length === 128)).toBe(true);
        expect(regions[0].pitchRegion).toBe(regions[1]);
        synth.channelNoteOn(0, 60, 0.8);
        expect(synth.activeVoiceCount).toBe(2);
        const audio = render(synth);
        expect(audio.some(x => x !== 0)).toBe(true);
        assertSynchronized(audio);
    });

    it('keeps pitch envelopes, LFOs, bends and releases synchronized without copying local amplitude', () => {
        const synth = load();
        const [left, right] = synth.presets![0].regions!;
        right.modEnvToPitch = 350;
        right.modEnv.attack = 0.1;
        right.modEnv.decay = 0.1;
        right.modEnv.sustain = 0.3;
        right.modEnv.release = 0.2;
        right.modLfoToPitch = 100;
        right.vibLfoToPitch = 75;
        right.freqModLFO = right.freqVibLFO = 100;
        // Deliberately different left pitch generators must be ignored, not its amplitude envelope.
        left.modEnvToPitch = -1200;
        left.modEnv.attack = 0.5;
        left.freqModLFO = left.freqVibLFO = 2000;
        left.modLfoToPitch = 400;
        left.vibLfoToPitch = 1000;
        left.ampEnv.release = right.ampEnv.release = 0.2;
        synth.channelNoteOn(0, 60, 0.8);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const rightVoice = voices.find(v => v.region === right)!;
        let minimumModulation = 0;
        let minimumVibrato = 0;
        for (let i = 0; i < 100; i++) {
            if (i === 30) { synth.channelSetPitchWheel(0, 10000); }
            if (i === 60) { synth.channelNoteOff(0, 60); }
            assertSynchronized(render(synth));
            minimumModulation = Math.min(minimumModulation, rightVoice.modLfo.level);
            minimumVibrato = Math.min(minimumVibrato, rightVoice.vibLfo.level);
        }
        // A negative LFO delta means the descending half-cycle, not a disabled oscillator.
        expect(minimumModulation).toBeLessThan(0);
        expect(minimumVibrato).toBeLessThan(0);
        expect(left.modEnv.attack).toBe(0.5);
        synth.noteOffAll(true);
        for (let i = 0; i < 100 && synth.activeVoiceCount; i++) { assertSynchronized(render(synth)); }
        expect(synth.activeVoiceCount).toBe(0);
    });

    it('preserves each half\'s sample and amplitude rather than duplicating or downmixing the pair', () => {
        const synth = load();
        const [left, right] = synth.presets![0].regions!;
        left.samples = Float32Array.from(left.samples, x => -x);
        left.attenuation = 6;
        synth.channelNoteOn(0, 60, 0.8);
        const audio = render(synth);
        for (let i = 0; i < audio.length; i += 2) {
            expect(audio[i]).toBeCloseTo(-audio[i + 1] * Math.pow(10, -6 / 20), 6);
        }
        expect(right.attenuation).toBe(0);
    });

    it.each(['missing', 'duplicate', 'rate', 'loop', 'reciprocity', 'range'])('rejects %s pairs without invalid audio', reason => {
        const left = new Region();
        left.samples = new Float32Array(64);
        left.sampleRate = 48000;
        const right = new Region(left);
        const entries: StereoSampleRegion[] = [
            { region: left, instrument: 0, presetZone: 0, sampleId: 0, sampleLink: 1, sampleType: 4 },
            { region: right, instrument: 0, presetZone: 0, sampleId: 1, sampleLink: 0, sampleType: 2 }
        ];
        if (reason === 'missing') { entries.pop(); }
        if (reason === 'duplicate') { entries.push({ ...entries[0], region: new Region(left) }); }
        if (reason === 'rate') { right.sampleRate = 44100; }
        if (reason === 'loop') { right.loopEnd = 8; }
        if (reason === 'reciprocity') { entries[1].sampleLink = 7; }
        if (reason === 'range') { right.hiKey = 1; }
        expect(linkStereoSampleRegions(entries)).toBeGreaterThan(0);
        expect(entries.every(e => e.region.samples.length === 0)).toBe(true);
    });

    it('does not attempt to decode ROM samples as embedded PCM', () => {
        const hydra = stereoHydra();
        for (const sample of hydra.sHdrs) { sample.sampleType |= 0x8000; }
        const synth = load(hydra);
        synth.channelNoteOn(0, 60, 0.8);
        expect(synth.activeVoiceCount).toBe(0);
        expect(render(synth).every(x => x === 0)).toBe(true);
    });
});
