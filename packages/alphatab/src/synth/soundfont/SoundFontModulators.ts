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
