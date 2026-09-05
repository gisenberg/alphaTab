import type { HydraImod } from '@coderline/alphatab/synth/soundfont/Hydra';

/** @internal */
export type SoundFontModulator = Readonly<Pick<HydraImod,
    'modSrcOper' | 'modDestOper' | 'modAmount' | 'modAmtSrcOper' | 'modTransOper'>>;

/**
 * Resolve one hierarchy level at load time, not while rendering samples.
 * A zero amount is a real override, including an explicit disabling of a default rule.
 * @internal
 */
export function overrideModulators(...layers: readonly (readonly SoundFontModulator[])[]): SoundFontModulator[] {
    const rules = new Map<string, SoundFontModulator>();
    for (const layer of layers) {
        for (const rule of layer) {
            const identity = `${rule.modSrcOper}:${rule.modDestOper}:${rule.modAmtSrcOper}`;
            rules.set(identity, { ...rule });
        }
    }
    return [...rules.values()];
}

/**
 * Instrument rules override their defaults; preset contributions remain independently additive.
 * Keeping the two levels separate also preserves differing transforms across levels.
 * This resolves rule precedence only, not supported sources, transforms or generator evaluation.
 * @internal
 */
export function resolveModulatorLayers(
    defaults: readonly SoundFontModulator[],
    instrumentGlobal: readonly SoundFontModulator[],
    instrumentLocal: readonly SoundFontModulator[],
    presetGlobal: readonly SoundFontModulator[],
    presetLocal: readonly SoundFontModulator[],
): { instrument: SoundFontModulator[]; preset: SoundFontModulator[] } {
    return {
        instrument: overrideModulators(defaults, instrumentGlobal, instrumentLocal),
        preset: overrideModulators(presetGlobal, presetLocal),
    };
}

/** Default SF2 negative, unipolar, concave note velocity to initial attenuation. @internal */
export const defaultVelocityAttenuation: SoundFontModulator = Object.freeze({
    modSrcOper: 0x0502, modDestOper: 48, modAmount: 960, modAmtSrcOper: 0, modTransOper: 0,
});

/**
 * Compile the standard velocity attenuation route, including explicit bank overrides.
 * Other routes are intentionally not evaluated here; this is not a general modulator engine.
 * @internal
 */
export function compileVelocityAttenuation(layers: ReturnType<typeof resolveModulatorLayers>): number {
    let amount = 0;
    for (const rules of [layers.instrument, layers.preset]) {
        for (const rule of rules) {
            if (rule.modSrcOper === 0x0502 && rule.modDestOper === 48 && rule.modAmtSrcOper === 0) {
                if (rule.modTransOper === 0) {
                    amount += rule.modAmount;
                } else if (rule.modTransOper === 2) {
                    amount += Math.abs(rule.modAmount);
                }
            }
        }
    }
    return amount;
}

// The concave controller curve is logarithmic in attenuation, not linear in amplitude.
// Precompute once: note-on needs one lookup, and the sample loop does no additional work.
const velocityAttenuationCurve = new Float64Array(128);
velocityAttenuationCurve[0] = 127 / 128;
for (let velocity = 1; velocity < 127; velocity++) {
    velocityAttenuationCurve[velocity] = Math.min(127 / 128, -Math.log10(velocity / 127) * 40 / 96);
}

/** Return decibels for an already compiled centibel amount and MIDI velocity. @internal */
export function velocityAttenuationDb(amount: number, velocity: number): number {
    return amount * 0.1 * velocityAttenuationCurve[Math.max(0, Math.min(127, velocity | 0))];
}

/** Compiled unipolar linear velocity route, in the destination generator's units. @internal */
export interface LinearVelocityModulation { offset: number; slope: number; }

/** Resolve at bank load; unsupported controllers and curves must not become linear approximations. @internal */
export function compileLinearVelocityModulation(
    layers: ReturnType<typeof resolveModulatorLayers>, destination: number
): LinearVelocityModulation | undefined {
    let offset = 0;
    let slope = 0;
    for (const rules of [layers.instrument, layers.preset]) {
        for (const rule of rules) {
            if (rule.modDestOper !== destination || rule.modAmtSrcOper !== 0 ||
                (rule.modSrcOper !== 2 && rule.modSrcOper !== 258) ||
                (rule.modTransOper !== 0 && rule.modTransOper !== 2)) { continue; }
            // Both supported sources are nonnegative, so ABS applies to the amount.
            const amount = rule.modTransOper === 2 ? Math.abs(rule.modAmount) : rule.modAmount;
            if (rule.modSrcOper === 258) { offset += amount; slope -= amount; }
            else { slope += amount; }
        }
    }
    return offset === 0 && slope === 0 ? undefined : { offset, slope };
}

/** MIDI's linear controller range is 128, not 127; evaluated once per note. @internal */
export function linearVelocityValue(route: LinearVelocityModulation, velocity: number): number {
    return route.offset + route.slope * Math.max(0, Math.min(127, velocity | 0)) / 128;
}

/** Bank-authored unipolar velocity curves, compiled to scalar amounts per region. @internal */
export interface VelocityModulation extends LinearVelocityModulation {
    concavePositive?: number;
    concaveNegative?: number;
    convexPositive?: number;
    convexNegative?: number;
}

// SF2 controller curves use the 96 dB logarithmic law with explicit endpoints.
// Compatibility reference: FluidSynth 2.4.6 fluid_mod.c and fluid_conv.c
// (unipolar /128 mapping and interpolated SF2 curve endpoints).
// Interpolate the 128-point curve at the controller's /128 position once here,
// so note-on needs only shared lookups, not logs or a per-region 128-value table.
const concavePositive = new Float64Array(128);
const concaveNegative = new Float64Array(128);
const convexPositive = new Float64Array(128);
const convexNegative = new Float64Array(128);
function concavePoint(index: number): number {
    return index === 127 ? 1 : -Math.log10((127 - index) / 127) * 40 / 96;
}
function concaveAt(position: number): number {
    const lower = Math.floor(position);
    if (lower === 127) { return 1; }
    const fraction = position - lower;
    return concavePoint(lower) * (1 - fraction) + concavePoint(lower + 1) * fraction;
}
for (let velocity = 0; velocity < 128; velocity++) {
    const position = velocity * 127 / 128;
    concavePositive[velocity] = concaveAt(position);
    concaveNegative[velocity] = concaveAt(127 - position);
    convexPositive[velocity] = 1 - concaveNegative[velocity];
    convexNegative[velocity] = 1 - concavePositive[velocity];
}

/** Preserve rule precedence and reject unsupported controllers rather than approximating them. @internal */
export function compileVelocityModulation(
    layers: ReturnType<typeof resolveModulatorLayers>, destination: number
): VelocityModulation | undefined {
    const route: VelocityModulation = compileLinearVelocityModulation(layers, destination) ?? { offset: 0, slope: 0 };
    for (const rules of [layers.instrument, layers.preset]) {
        for (const rule of rules) {
            if (rule.modDestOper !== destination || rule.modAmtSrcOper !== 0 ||
                (rule.modTransOper !== 0 && rule.modTransOper !== 2)) { continue; }
            let field: 'concavePositive' | 'concaveNegative' | 'convexPositive' | 'convexNegative';
            switch (rule.modSrcOper) {
                case 0x0402: field = 'concavePositive'; break;
                case 0x0502: field = 'concaveNegative'; break;
                case 0x0802: field = 'convexPositive'; break;
                case 0x0902: field = 'convexNegative'; break;
                default: continue;
            }
            const amount = rule.modTransOper === 2 ? Math.abs(rule.modAmount) : rule.modAmount;
            route[field] = (route[field] ?? 0) + amount;
        }
    }
    return Object.values(route).some(amount => amount !== 0) ? route : undefined;
}

/** Evaluate a compiled route once per note; never used in the sample loop. @internal */
export function velocityModulationValue(route: VelocityModulation, velocity: number): number {
    const index = Math.max(0, Math.min(127, velocity | 0));
    return route.offset + route.slope * index / 128 +
        (route.concavePositive ?? 0) * concavePositive[index] +
        (route.concaveNegative ?? 0) * concaveNegative[index] +
        (route.convexPositive ?? 0) * convexPositive[index] +
        (route.convexNegative ?? 0) * convexNegative[index];
}
