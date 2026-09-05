import { describe, expect, it } from 'vitest';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';

function sampleBank(): Uint8Array {
    // A minimal RIFF containing only the sample-data list, with four PCM16 samples.
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) {
            bytes[offset + i] = value.charCodeAt(i);
        }
    };
    text(0, 'RIFF'); view.setUint32(4, 36, true); text(8, 'sfbk');
    text(12, 'LIST'); view.setUint32(16, 24, true); text(20, 'sdta');
    text(24, 'smpl'); view.setUint32(28, 12, true);
    view.setInt16(32, 16384, true); view.setInt16(34, -16384, true);
    view.setInt16(36, 32767, true); view.setInt16(38, -32768, true);
    return bytes;
}

describe('SoundFont sample buffer ownership', () => {
    it('defaults to owned storage but allows explicit borrowing from offset byte buffers', () => {
        const padded = new Uint8Array(100);
        padded.set(sampleBank(), 11);
        const input = padded.subarray(11, 55);
        const owned = new Hydra();
        owned.load(ByteBuffer.fromBuffer(input));
        const borrowed = new Hydra();
        borrowed.load(ByteBuffer.fromBuffer(input), true);
        expect(owned.sampleData.buffer).not.toBe(input.buffer);
        expect(borrowed.sampleData.buffer).toBe(input.buffer);
        expect(borrowed.sampleData.byteOffset).toBe(input.byteOffset + 32);
        expect(borrowed.decodeSamples(0, 8, false)).toEqual(owned.decodeSamples(0, 8, false));
        input.fill(0);
        expect(owned.sampleData.some(value => value !== 0)).toBe(true);
        // Decoded PCM owns its storage even when the encoded source was borrowed.
        expect(borrowed.decodeSamples(0, 8, false)[2]).toBe(1);
    });

    it('decodes a subrange without copying encoded bytes and caches owned PCM', () => {
        const hydra = new Hydra();
        hydra.load(ByteBuffer.fromBuffer(sampleBank()));
        hydra.sampleData.slice = () => { throw new Error('Encoded sample copy'); };
        const decoded = hydra.decodeSamples(2, 8, false);
        expect(Array.from(decoded)).toEqual([-16384 / 32767, 1, Math.fround(-32768 / 32767)].map(Math.fround));
        hydra.sampleData.fill(0);
        expect(hydra.decodeSamples(2, 8, false)).toBe(decoded);
        expect(decoded[1]).toBe(1);
    });

    it('rejects truncated sample data rather than borrowing a shortened view', () => {
        for (const borrow of [false, true]) {
            const hydra = new Hydra();
            expect(() => hydra.load(ByteBuffer.fromBuffer(sampleBank().subarray(0, 42)), borrow)).toThrow('truncated');
        }
    });
});
