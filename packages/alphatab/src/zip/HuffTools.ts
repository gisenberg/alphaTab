// This Inflate algorithm is based on the Inflate class of the Haxe Standard Library (MIT)
import { FormatError } from '@coderline/alphatab/FormatError';
/*
 * Copyright (C)2005-2019 Haxe Foundation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
import { Huffman } from '@coderline/alphatab/zip/Huffman';

// This Inflater is based on the Zip Reader of the Haxe Standard Library (MIT)

/**
 * @internal
 */
export class HuffTools {
    public static make(lengths: number[], pos: number, nlengths: number, maxbits: number): Huffman {
        if (maxbits > 32) {
            throw new FormatError('Invalid huffman');
        }
        const counts: Int32Array = new Int32Array(maxbits);
        let actualMaxBits: number = 0;
        for (let i: number = 0; i < nlengths; i++) {
            const bitLength: number = lengths[i + pos];
            if (bitLength < 0 || bitLength >= maxbits) {
                throw new FormatError('Invalid huffman');
            }
            if (bitLength > 0) {
                counts[bitLength]++;
                actualMaxBits = Math.max(actualMaxBits, bitLength);
            }
        }

        if (actualMaxBits === 0) {
            throw new FormatError('Invalid huffman');
        }

        const nextCode: Int32Array = new Int32Array(maxbits);
        let code: number = 0;
        for (let bitLength: number = 1; bitLength < maxbits; bitLength++) {
            code = (code + counts[bitLength - 1]) << 1;
            nextCode[bitLength] = code;
        }

        const table: Int32Array = new Int32Array(1 << actualMaxBits);
        table.fill(-1);
        for (let symbol: number = 0; symbol < nlengths; symbol++) {
            const bitLength: number = lengths[symbol + pos];
            if (bitLength === 0) {
                continue;
            }

            const symbolCode: number = nextCode[bitLength]++;
            if (symbolCode >= 1 << bitLength) {
                throw new FormatError('Invalid huffman');
            }
            const reversedCode: number = HuffTools._reverseBits(symbolCode, bitLength);
            const encoded: number = (bitLength << 16) | symbol;
            const step: number = 1 << bitLength;
            for (let index: number = reversedCode; index < table.length; index += step) {
                table[index] = encoded;
            }
        }

        return new Huffman(actualMaxBits, table);
    }

    private static _reverseBits(value: number, bitLength: number): number {
        let reversed: number = 0;
        for (let i: number = 0; i < bitLength; i++) {
            reversed = (reversed << 1) | (value & 1);
            value >>= 1;
        }
        return reversed;
    }
}
