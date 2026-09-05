import { readFileSync } from 'node:fs';
import { ByteBuffer } from '../src/io/ByteBuffer';
import { Hydra } from '../src/synth/soundfont/Hydra';
import { TinySoundFont } from '../src/synth/synthesis/TinySoundFont';

const file = process.argv[2];
if (!file) { throw new Error('Usage: tsx scripts/inspect-stereo-soundfont.ts <bank.sf2>'); }
const hydra = new Hydra();
hydra.load(ByteBuffer.fromBuffer(readFileSync(file)), true);
const synth = new TinySoundFont(48000);
synth.loadPresets(hydra, new Set([0]), new Set(), false);
const preset = synth.presets!.findIndex(p => p.bank === 0 && p.presetNumber === 0);
if (preset < 0) { throw new Error('No bank-zero piano'); }
synth.channelSetPresetIndex(0, preset);
synth.channelNoteOn(0, 60, 0.5);
let peak = 0;
const samples = new Float32Array(128);
for (let i = 0; i < 750; i++) {
    synth.synthesize(samples, 0, 64);
    for (const sample of samples) {
        if (!Number.isFinite(sample)) { throw new Error('Non-finite output'); }
        peak = Math.max(peak, Math.abs(sample));
    }
}
const regions = synth.presets![preset].regions!;
const headerIndex = hydra.phdrs.findIndex(p => p.bank === 0 && p.preset === 0);
const instruments = new Set<number>();
const presetModulators = [];
for (let bag = hydra.phdrs[headerIndex].presetBagNdx; bag < hydra.phdrs[headerIndex + 1].presetBagNdx; bag++) {
    presetModulators.push(...hydra.pmods.slice(hydra.pbags[bag].modNdx, hydra.pbags[bag + 1].modNdx));
    for (const generator of hydra.pgens.slice(hydra.pbags[bag].genNdx, hydra.pbags[bag + 1].genNdx)) {
        if (generator.genOper === 41) { instruments.add(generator.genAmount.wordAmount); }
    }
}
const instrumentModulators = [...instruments].map(index => ({
    index, name: hydra.insts[index].instName,
    generatorZones: Array.from({ length: hydra.insts[index + 1].instBagNdx - hydra.insts[index].instBagNdx }, (_, offset) => {
        const bag = hydra.insts[index].instBagNdx + offset;
        return hydra.igens.slice(hydra.ibags[bag].instGenNdx, hydra.ibags[bag + 1].instGenNdx)
            .filter(g => [43, 44, 48, 51, 52, 53].includes(g.genOper))
            .map(g => ({ operator: g.genOper, amount: g.genAmount.shortAmount }));
    }),
    modulators: [...new Set(hydra.imods.slice(
        hydra.ibags[hydra.insts[index].instBagNdx].instModNdx,
        hydra.ibags[hydra.insts[index + 1].instBagNdx].instModNdx,
    ).map(modulator => JSON.stringify(modulator)))].map(value => JSON.parse(value)),
}));
console.log(JSON.stringify({ file, preset, name: synth.presets![preset].name, peak,
    presetModulators, instrumentModulators,
    matching: regions.filter(r => r.loKey <= 60 && r.hiKey >= 60 && r.loVel <= 63 && r.hiVel >= 63).map(r => ({
        attenuation: r.attenuation, pan: r.pan, sampleRate: r.sampleRate,
        samplePeak: r.samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0),
        ampEnv: r.ampEnv, filterFc: r.initialFilterFc,
    })),
    regions: regions.length, loaded: regions.filter(r => r.samples.length).length,
    linkedLeftRegions: regions.filter(r => r.pitchRegion).length }, null, 2));
if (peak === 0) { throw new Error('Piano is silent'); }
