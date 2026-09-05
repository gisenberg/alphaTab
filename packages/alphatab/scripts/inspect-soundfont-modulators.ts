import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ByteBuffer } from '../src/io/ByteBuffer';
import { Hydra, type HydraIgen } from '../src/synth/soundfont/Hydra';
import { GenOperators } from '../src/synth/synthesis/Region';
import { resolveModulatorLayers, type SoundFontModulator } from '../src/synth/soundfont/SoundFontModulators';

const file = process.argv[2];
if (!file) { throw new Error('Usage: tsx scripts/inspect-soundfont-modulators.ts <sf2> [bank:program,...]'); }
const selected = new Set((process.argv[3] ?? '0:0,0:26,0:29,0:30,0:34,0:81,128:0').split(','));
const bytes = readFileSync(file);
const hydra = new Hydra();
hydra.load(ByteBuffer.fromBuffer(bytes), true);

function range(global: readonly HydraIgen[], local: readonly HydraIgen[], op: number): [number, number] {
    let value: [number, number] = [0, 127];
    for (const generator of [...global, ...local]) {
        if (generator.genOper === op) { value = [generator.genAmount.lowByteAmount, generator.genAmount.highByteAmount]; }
    }
    return value;
}
const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
function source(operator: number): string {
    if (operator === 0) { return 'constant'; }
    const index = operator & 127;
    const names: Record<number, string> = { 2: 'velocity', 3: 'key', 10: 'poly-pressure', 13: 'channel-pressure', 14: 'pitch-wheel', 16: 'pitch-sensitivity' };
    return `${operator & 128 ? `CC${index}` : names[index] ?? `unknown-${index}`};${operator & 256 ? 'negative' : 'positive'};${operator & 512 ? 'bipolar' : 'unipolar'};curve-${operator >> 10}`;
}
const presets = [];
for (let p = 0; p < hydra.phdrs.length - 1; p++) {
    const header = hydra.phdrs[p];
    if (!selected.has(`${header.bank}:${header.preset}`)) { continue; }
    let presetGlobal: readonly SoundFontModulator[] = [];
    let presetGlobalGenerators: readonly HydraIgen[] = [];
    let zones = 0;
    const rules = new Map<string, { layer: string; rule: SoundFontModulator; zones: number }>();
    for (let pb = header.presetBagNdx; pb < hydra.phdrs[p + 1].presetBagNdx; pb++) {
        const pg = hydra.pgens.slice(hydra.pbags[pb].genNdx, hydra.pbags[pb + 1].genNdx);
        const pm = hydra.pmods.slice(hydra.pbags[pb].modNdx, hydra.pbags[pb + 1].modNdx);
        const instrument = pg[pg.length - 1];
        if (instrument?.genOper !== GenOperators.Instrument) {
            if (pb === header.presetBagNdx) { presetGlobal = pm; presetGlobalGenerators = pg; }
            continue;
        }
        const index = instrument.genAmount.wordAmount;
        if (!hydra.insts[index + 1]) { throw new Error('Invalid instrument index'); }
        let instrumentGlobal: readonly SoundFontModulator[] = [];
        let instrumentGlobalGenerators: readonly HydraIgen[] = [];
        for (let ib = hydra.insts[index].instBagNdx; ib < hydra.insts[index + 1].instBagNdx; ib++) {
            const ig = hydra.igens.slice(hydra.ibags[ib].instGenNdx, hydra.ibags[ib + 1].instGenNdx);
            const im = hydra.imods.slice(hydra.ibags[ib].instModNdx, hydra.ibags[ib + 1].instModNdx);
            if (ig[ig.length - 1]?.genOper !== GenOperators.SampleID) {
                if (ib === hydra.insts[index].instBagNdx) { instrumentGlobal = im; instrumentGlobalGenerators = ig; }
                continue;
            }
            if (![GenOperators.KeyRange, GenOperators.VelRange].every(op => overlaps(
                range(presetGlobalGenerators, pg, op), range(instrumentGlobalGenerators, ig, op)))) { continue; }
            zones++;
            const layers = resolveModulatorLayers([], instrumentGlobal, im, presetGlobal, pm);
            for (const [layer, values] of Object.entries(layers)) {
                for (const rule of values) {
                    const identity = `${layer}:${JSON.stringify(rule)}`;
                    const entry = rules.get(identity) ?? { layer, rule, zones: 0 };
                    entry.zones++;
                    rules.set(identity, entry);
                }
            }
        }
    }
    presets.push({ bank: header.bank, program: header.preset, name: header.presetName, zones,
        rules: [...rules.values()].map(entry => ({ ...entry, source: source(entry.rule.modSrcOper),
            amountSource: source(entry.rule.modAmtSrcOper), destination: GenOperators[entry.rule.modDestOper] ?? entry.rule.modDestOper })) });
}
console.log(JSON.stringify({ file, sha256: createHash('sha256').update(bytes).digest('hex'),
    scope: 'Explicit bank rules only, including zero overrides. Implicit defaults are not inserted. All overlapping key/velocity zones, not only played notes. Rule precedence only; no audio evaluation.',
    presets }, null, 2));
