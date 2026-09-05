import { describe, expect, it } from 'vitest';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { HydraImod, HydraPmod } from '@coderline/alphatab/synth/soundfont/Hydra';

describe('SoundFont modulator amount encoding', () => {
    it.each([-32768, -160, -1, 0, 160, 32767])('preserves signed amount %i at both levels', amount => {
        const bytes = new Uint8Array(10);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 0x0502, true);
        view.setUint16(2, 48, true);
        view.setInt16(4, amount, true);
        view.setUint16(6, 0x008b, true);
        view.setUint16(8, 2, true);
        // Regression: preset modulators decoded negative amounts as large positive numbers.
        const preset = new HydraPmod(ByteBuffer.fromBuffer(bytes));
        const instrument = new HydraImod(ByteBuffer.fromBuffer(bytes));
        expect(preset.modAmount).toBe(amount);
        expect({ ...preset }).toEqual({ ...instrument });
        expect(preset.modSrcOper).toBe(0x0502);
        expect(preset.modAmtSrcOper).toBe(0x008b);
        expect(preset.modTransOper).toBe(2);
    });
});
