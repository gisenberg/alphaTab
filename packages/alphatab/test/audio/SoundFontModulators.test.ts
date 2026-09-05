import { describe, expect, it } from 'vitest';
import { compileLinearVelocityModulation, linearVelocityValue, compileVelocityAttenuation, defaultVelocityAttenuation, overrideModulators, resolveModulatorLayers, velocityAttenuationDb, type SoundFontModulator } from '@coderline/alphatab/synth/soundfont/SoundFontModulators';
import { compileVelocityModulation, velocityModulationValue } from '@coderline/alphatab/synth/soundfont/SoundFontModulators';

const rule = (amount: number, source = 0x0502, destination = 48, amountSource = 0): SoundFontModulator => ({
    modSrcOper: source, modDestOper: destination, modAmount: amount, modAmtSrcOper: amountSource, modTransOper: 0,
});

describe('nonlinear bank velocity modulation', () => {
    const compile = (source: number) => compileVelocityModulation({ instrument: [rule(1, source, 8)], preset: [] }, 8)!;
    it('preserves finite, monotonic and complementary curves over every MIDI velocity', () => {
        const positiveConcave = compile(0x0402);
        const negativeConcave = compile(0x0502);
        const positiveConvex = compile(0x0802);
        const negativeConvex = compile(0x0902);
        let previousConcave = 0;
        let previousConvex = 0;
        for (let velocity = 0; velocity < 128; velocity++) {
            const concave = velocityModulationValue(positiveConcave, velocity);
            const convex = velocityModulationValue(positiveConvex, velocity);
            expect(Number.isFinite(concave) && Number.isFinite(convex)).toBe(true);
            expect(concave).toBeGreaterThanOrEqual(previousConcave);
            expect(convex).toBeGreaterThanOrEqual(previousConvex);
            expect(concave + velocityModulationValue(negativeConvex, velocity)).toBeCloseTo(1, 12);
            expect(convex + velocityModulationValue(negativeConcave, velocity)).toBeCloseTo(1, 12);
            previousConcave = concave;
            previousConvex = convex;
        }
        // Unlike a linear approximation, the midpoint is strongly curved.
        expect(velocityModulationValue(positiveConcave, 64)).toBeLessThan(0.2);
        expect(velocityModulationValue(positiveConvex, 64)).toBeGreaterThan(0.8);
        expect(previousConcave).toBeLessThan(1); // MIDI controller normalization is /128.
        expect(velocityModulationValue(negativeConvex, 0)).toBe(1);
    });
    it('honors zero overrides, additive preset routes and absolute transforms', () => {
        const route = compileVelocityModulation(resolveModulatorLayers([], [rule(1200, 0x0902, 8)],
            [rule(0, 0x0902, 8)], [], [{ ...rule(-600, 0x0902, 8), modTransOper: 2 }, rule(128, 2, 8)]), 8)!;
        expect(velocityModulationValue(route, 64)).toBeCloseTo(600 * velocityModulationValue(compile(0x0902), 64) + 64);
        expect(compileVelocityModulation({ instrument: [rule(0, 0x0902, 8)], preset: [] }, 8)).toBeUndefined();
    });
    it('does not misinterpret MIDI CC, bipolar, amount-source or unknown transform routes', () => {
        const instrument = [rule(1200, 0x0982, 8), rule(1200, 0x0b02, 8), rule(1200, 0x0902, 8, 2),
            { ...rule(1200, 0x0902, 8), modTransOper: 99 }];
        expect(compileVelocityModulation({ instrument, preset: [] }, 8)).toBeUndefined();
    });
});

describe('linear velocity envelope modulation', () => {
    it('uses the controller range for positive and negative routes', () => {
        const positive = compileLinearVelocityModulation({ instrument: [rule(1200, 2, 36)], preset: [] }, 36)!;
        const negative = compileLinearVelocityModulation({ instrument: [rule(-1200, 258, 36)], preset: [] }, 36)!;
        expect(linearVelocityValue(positive, 64)).toBe(600);
        expect(linearVelocityValue(negative, 64)).toBe(-600);
        expect(linearVelocityValue(positive, 127)).toBe(1190.625);
        expect(linearVelocityValue(negative, 127)).toBe(-9.375);
    });
    it('resolves zero replacement before adding preset contributions and transforms', () => {
        const layers = resolveModulatorLayers([], [rule(1200, 2, 38)], [rule(0, 2, 38)], [],
            [{ ...rule(-600, 258, 38), modTransOper: 2 }]);
        expect(linearVelocityValue(compileLinearVelocityModulation(layers, 38)!, 64)).toBe(300);
    });
    it('does not approximate unsupported curves, amount sources, transforms or destinations', () => {
        const instrument = [rule(10, 1026, 36), rule(10, 2, 36, 2), rule(10, 2, 38),
            { ...rule(10, 2, 36), modTransOper: 99 }];
        expect(compileLinearVelocityModulation({ instrument, preset: [] }, 36)).toBeUndefined();
    });
});

describe('SoundFont velocity dynamics', () => {
    it('uses squared amplitude velocity for the default curve, not the former linear gain', () => {
        // The SF2 96 dB concave route corresponds to a power-of-two velocity response.
        for (const velocity of [16, 32, 64, 96, 127]) {
            const gain = 10 ** (-velocityAttenuationDb(960, velocity) / 20);
            expect(gain).toBeCloseTo((velocity / 127) ** 2, 12);
        }
    });
    it('keeps the whole MIDI domain finite and monotonic with no attenuation at maximum velocity', () => {
        let previous = Infinity;
        for (let velocity = 0; velocity < 128; velocity++) {
            const attenuation = velocityAttenuationDb(960, velocity);
            expect(Number.isFinite(attenuation)).toBe(true);
            expect(attenuation).toBeLessThanOrEqual(previous);
            previous = attenuation;
        }
        expect(previous).toBe(0);
    });
    it('compiles defaults, instrument replacement, zero disable and additive preset amounts once', () => {
        const compile = (instrument: SoundFontModulator[], preset: SoundFontModulator[] = []) =>
            compileVelocityAttenuation(resolveModulatorLayers([defaultVelocityAttenuation], [], instrument, [], preset));
        expect(compile([])).toBe(960);
        expect(compile([rule(800)])).toBe(800);
        expect(compile([rule(0)])).toBe(0);
        expect(compile([rule(800)], [rule(-200)])).toBe(600);
        expect(compile([rule(800)], [{ ...rule(-200), modTransOper: 2 }])).toBe(1000);
        expect(velocityAttenuationDb(compile([rule(0)]), 16)).toBe(0);
    });
    it('does not treat unrelated or unsupported routes as standard velocity attenuation', () => {
        const unrelated = [rule(120, 3), rule(120, 0x0502, 8), rule(120, 0x0502, 48, 2),
            { ...rule(120), modTransOper: 99 }];
        expect(compileVelocityAttenuation({ instrument: unrelated, preset: [] })).toBe(0);
    });
});

describe('SoundFont modulator hierarchy', () => {
    it('uses the final matching rule within and across global/local layers', () => {
        expect(overrideModulators([rule(960)], [rule(800), rule(600)], [rule(400)]))
            .toEqual([rule(400)]);
    });
    it('preserves zero-amount overrides instead of reviving disabled defaults', () => {
        expect(overrideModulators([rule(960)], [rule(0)])).toEqual([rule(0)]);
    });
    it('distinguishes source, destination and amount-source identities', () => {
        const rules = [rule(1), rule(2, 2), rule(3, 0x0502, 8), rule(4, 0x0502, 48, 2)];
        expect(overrideModulators(rules)).toEqual(rules);
    });
    it('retains negative preset contributions separately from instrument overrides', () => {
        expect(resolveModulatorLayers([rule(960)], [rule(800)], [rule(0)], [rule(100)], [rule(-200)]))
            .toEqual({ instrument: [rule(0)], preset: [rule(-200)] });
    });
    it('lets a later transform replace the same identity within a level without merging levels', () => {
        const absolute = { ...rule(120), modTransOper: 2 };
        expect(resolveModulatorLayers([], [rule(60)], [absolute], [], [rule(-30)]))
            .toEqual({ instrument: [absolute], preset: [rule(-30)] });
    });
    it('inherits omitted rules and returns independent records without mutating source banks', () => {
        const global = Object.freeze(rule(960));
        const result = overrideModulators([global], []);
        expect(result).toEqual([global]);
        expect(result[0]).not.toBe(global);
        expect(overrideModulators()).toEqual([]);
    });
});
