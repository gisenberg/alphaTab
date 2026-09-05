import { describe, expect, it } from 'vitest';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { Hydra, HydraIgen } from '@coderline/alphatab/synth/soundfont/Hydra';
import { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import { linkStereoSampleRegions, type StereoSampleRegion } from '@coderline/alphatab/synth/synthesis/StereoSampleRegions';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import type { Voice } from '@coderline/alphatab/synth/synthesis/Voice';
import { VoiceEnvelopeSegment } from '@coderline/alphatab/synth/synthesis/VoiceEnvelope';
import { NoteOnEvent, NoteOffEvent } from '@coderline/alphatab/midi/MidiEvent';

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

describe('bank-authored velocity filter routes', () => {
    it('activates a note-local filter envelope even when the static depth is zero', () => {
        // Regression: authored velocity-to-envelope-depth routes never reached the render path.
        const hydra = stereoHydra();
        hydra.ibags[1].instModNdx = 1;
        hydra.ibags[2].instModNdx = 1;
        hydra.imods = [{ modSrcOper: 0x0402, modDestOper: 11, modAmount: -4800,
            modAmtSrcOper: 0, modTransOper: 0 }];
        const synth = load(hydra);
        const [left, right] = synth.presets![0].regions!;
        synth.channelNoteOn(0, 60, 32 / 127);
        synth.channelNoteOn(0, 64, 96 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const leftVoices = voices.filter(v => v.region === left);
        expect(left.modEnvToFilterFc).toBe(0);
        expect(leftVoices[0].modEnvToFilterFc).toBeLessThan(0);
        expect(leftVoices[1].modEnvToFilterFc).toBeLessThan(leftVoices[0].modEnvToFilterFc);
        expect(voices.filter(v => v.region === right).every(v => v.modEnvToFilterFc === 0)).toBe(true);
        const initialCoefficient = leftVoices[0].lowPass.a0;
        expect(render(synth).some(sample => sample !== 0)).toBe(true);
        expect(leftVoices[0].lowPass.a0).not.toBe(initialCoefficient);
        const copy = new Region(left);
        expect(copy.velocityToFilterEnvelopeDepth).toEqual(left.velocityToFilterEnvelopeDepth);
        expect(copy.velocityToFilterEnvelopeDepth).not.toBe(left.velocityToFilterEnvelopeDepth);
        copy.clear(false);
        expect(copy.velocityToFilterEnvelopeDepth).toBeUndefined();
        expect(left.velocityToFilterEnvelopeDepth).toBeDefined();
    });

    it('adds velocity modulation to static envelope depth and resets it when reusing a voice', () => {
        const hydra = stereoHydra();
        hydra.igens[0] = generator(11, 1200);
        hydra.ibags[1].instModNdx = 1;
        hydra.ibags[2].instModNdx = 1;
        hydra.imods = [{ modSrcOper: 2, modDestOper: 11, modAmount: -2400,
            modAmtSrcOper: 0, modTransOper: 0 }];
        const synth = load(hydra);
        const left = synth.presets![0].regions![0];
        synth.channelNoteOn(0, 60, 64 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const first = voices.find(v => v.region === left)!;
        expect(first.modEnvToFilterFc).toBe(0); // Exact cancellation must disable the dynamic filter path.
        const initialPool = [...voices];
        synth.noteOffAll(true);
        synth.synthesize(new Float32Array(9600), 0, 4800);
        synth.channelNoteOn(0, 60, 32 / 127);
        const reused = voices.find(v => v.region === left && v.playingPreset !== -1)!;
        // The allocator may reuse either stereo half's former voice, not necessarily the left one.
        expect(initialPool).toContain(reused);
        expect(reused.modEnvToFilterFc).toBe(600);
        expect(left.modEnvToFilterFc).toBe(1200);
    });

    it('applies curved hi-hat cutoff per voice without changing the unmodulated stereo zone', () => {
        // Regression: GeneralUser negative convex velocity cutoff was silently ignored.
        const hydra = stereoHydra();
        hydra.ibags[1].instModNdx = 1;
        hydra.ibags[2].instModNdx = 1;
        hydra.imods = [{ modSrcOper: 0x0902, modDestOper: 8, modAmount: -4800,
            modAmtSrcOper: 0, modTransOper: 0 }];
        const synth = load(hydra);
        const [left, right] = synth.presets![0].regions!;
        const originalCutoff = left.initialFilterFc;
        synth.channelNoteOn(0, 60, 32 / 127);
        synth.channelNoteOn(0, 64, 96 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const cutoffs = voices.filter(v => v.region === left).map(v => v.initialFilterFc);
        expect(cutoffs[0]).toBeLessThan(cutoffs[1]);
        expect(cutoffs[1]).toBeLessThan(originalCutoff);
        // A convex rule is not the previously supported straight-line response.
        expect(cutoffs[0]).not.toBeCloseTo(originalCutoff - 3600);
        expect(voices.filter(v => v.region === right).every(v => v.initialFilterFc === right.initialFilterFc)).toBe(true);
        expect(left.initialFilterFc).toBe(originalCutoff);
        expect(render(synth).some(sample => sample !== 0)).toBe(true);
    });

    it('scales only static SF2 attenuation with the EMU compatibility law', () => {
        // Regression: literal centibels made layered-bank balances too extreme.
        const hydra = stereoHydra();
        hydra.igens[0] = generator(48, 180);
        hydra.igens[3] = generator(48, -70);
        hydra.pgens = [generator(48, 100), generator(41, 0)];
        hydra.pbags[1].genNdx = 2;
        const synth = load(hydra);
        const [left, right] = synth.presets![0].regions!;
        expect(left.attenuation).toBeCloseTo(11.2);
        expect(right.attenuation).toBeCloseTo(1.2);
        expect(left.velocityAttenuation).toBe(960);
        expect(right.velocityAttenuation).toBe(960);
        synth.channelNoteOn(0, 60, 64 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const leftVoice = voices.find(v => v.region === left)!;
        const rightVoice = voices.find(v => v.region === right)!;
        expect(rightVoice.noteGainDb - leftVoice.noteGainDb).toBeCloseTo(10);
    });

    it('loads zone-local cutoff rules and resolves each note without changing its shared region', () => {
        // Regression: GeneralUser kick/crash velocity cutoff rules were discarded at load time.
        const hydra = stereoHydra();
        hydra.ibags[1].instModNdx = 1;
        hydra.ibags[2].instModNdx = 1;
        hydra.imods = [{ modSrcOper: 258, modDestOper: 8, modAmount: -4800,
            modAmtSrcOper: 0, modTransOper: 0 }];
        const synth = load(hydra);
        const [left, right] = synth.presets![0].regions!;
        const originalCutoff = left.initialFilterFc;
        expect(left.velocityToFilter).toEqual({ offset: -4800, slope: 4800 });
        expect(right.velocityToFilter).toBeUndefined();
        synth.channelNoteOn(0, 60, 32 / 127);
        synth.channelNoteOn(0, 64, 96 / 127);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const leftVoices = voices.filter(v => v.region === left);
        expect(leftVoices.map(v => v.initialFilterFc)).toEqual([originalCutoff - 3600, originalCutoff - 1200]);
        expect(voices.filter(v => v.region === right).every(v => v.initialFilterFc === right.initialFilterFc)).toBe(true);
        expect(left.initialFilterFc).toBe(originalCutoff);
        const output = render(synth);
        expect(output.every(Number.isFinite)).toBe(true);
        expect(output.some(value => value !== 0)).toBe(true);
        const copy = new Region(left);
        expect(copy.velocityToFilter).toEqual(left.velocityToFilter);
        expect(copy.velocityToFilter).not.toBe(left.velocityToFilter);
        copy.clear(false);
        expect(copy.velocityToFilter).toBeUndefined();
        expect(left.velocityToFilter).toBeDefined();
    });
});

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

describe('note-local cymbal choke release', () => {
    it.each([false, true])('preserves normal hits and unrelated channels when choke starts first: %s', chokeFirst => {
        const synth = load();
        synth.channelSetPresetIndex(1, 0);
        for (const region of synth.presets![0].regions!) {
            region.ampEnv.release = 2;
        }
        synth.processMidiMessage(new NoteOnEvent(0, 0, 0, 60, 95, false, chokeFirst));
        synth.processMidiMessage(new NoteOnEvent(0, 0, 0, 60, 95, false, !chokeFirst));
        synth.processMidiMessage(new NoteOnEvent(1, 0, 1, 60, 95, false, true));
        render(synth);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        const active = voices.filter(voice => voice.playingPreset !== -1);
        const targeted = active.filter(voice => voice.playingChannel === 0 && voice.isPercussionChoke);
        const unaffected = active.filter(voice => !targeted.includes(voice));
        expect(targeted.length).toBeGreaterThan(0);
        expect(unaffected.length).toBeGreaterThan(0);
        synth.processMidiMessage(new NoteOffEvent(0, 960, 0, 60, 95, true));
        expect(targeted.every(voice => voice.ampEnv.segment === VoiceEnvelopeSegment.Release)).toBe(true);
        expect(unaffected.every(voice => voice.ampEnv.segment < VoiceEnvelopeSegment.Release)).toBe(true);
        const tail = new Float32Array(4800);
        synth.synthesize(tail, 0, 2400);
        expect(tail.every(Number.isFinite)).toBe(true);
        expect(targeted.every(voice => voice.playingPreset === -1)).toBe(true);
        expect(unaffected.every(voice => voice.playingPreset !== -1)).toBe(true);
        // No shared bank envelope may be shortened for later ordinary hits.
        expect(synth.presets![0].regions!.every(region => region.ampEnv.release === 2)).toBe(true);
    });

    it('does not let an ordinary note-off consume an older choked hit of the same key', () => {
        const synth = load();
        synth.channelNoteOn(0, 60, 0.7, false, true);
        synth.channelNoteOn(0, 60, 0.7);
        render(synth);
        const voices: Voice[] = Reflect.get(synth, '_voices');
        synth.processMidiMessage(new NoteOffEvent(0, 960, 0, 60, 95));
        expect(voices.filter(voice => voice.isPercussionChoke && voice.playingPreset !== -1)
            .every(voice => voice.ampEnv.segment < VoiceEnvelopeSegment.Release)).toBe(true);
        expect(voices.filter(voice => !voice.isPercussionChoke && voice.playingPreset !== -1)
            .every(voice => voice.ampEnv.segment === VoiceEnvelopeSegment.Release)).toBe(true);
    });

    it('preserves attack PCM and resets choke ownership when reusing pooled voices', () => {
        const normal = load(), choked = load();
        for (const synth of [normal, choked]) {
            for (const region of synth.presets![0].regions!) {
                region.ampEnv.release = 2;
            }
        }
        normal.channelNoteOn(0, 60, 0.7);
        choked.channelNoteOn(0, 60, 0.7, false, true);
        expect(render(choked)).toEqual(render(normal));
        // Fill the allocator's spare slots too, so the next hit must reuse a previously choked voice.
        choked.channelNoteOn(0, 62, 0.7, false, true);
        const voices: Voice[] = Reflect.get(choked, '_voices');
        const allocated = voices.filter(voice => voice.playingPreset !== -1);
        choked.channelNoteOff(0, 60, true);
        choked.channelNoteOff(0, 62, true);
        choked.synthesize(new Float32Array(4800), 0, 2400);
        choked.channelNoteOn(0, 60, 0.7);
        const reused = voices.filter(voice => voice.playingPreset !== -1);
        expect(reused.length).toBeGreaterThan(0);
        expect(reused.every(voice => allocated.includes(voice) && !voice.isPercussionChoke)).toBe(true);
        choked.channelNoteOff(0, 60, false);
        choked.synthesize(new Float32Array(4800), 0, 2400);
        expect(reused.every(voice => voice.playingPreset !== -1)).toBe(true);
    });
});

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
        expect(left.attenuation).toBeCloseTo(3.2); // (30 + 50) * EMU-compatible 0.04 dB.
        expect(left.transpose).toBe(-1);
        expect(left.tune).toBe(14); // Includes the left sample header's +17 cent correction.
        // An omitted local generator still inherits its global value.
        expect(right.attenuation).toBe(6); // (100 + 50) * 0.04 dB.
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
