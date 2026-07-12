import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const frames = 128;
const iterations = 250_000;
const source = new Float32Array(frames * 2);
for (let i = 0; i < source.length; i++) {
    source[i] = Math.sin(i / 13);
}
const left = new Float32Array(frames);
const right = new Float32Array(frames);

function javascriptKernel(): void {
    for (let frame = 0, sourceIndex = 0; frame < frames; frame++, sourceIndex += 2) {
        left[frame] = source[sourceIndex];
        right[frame] = source[sourceIndex + 1];
    }
}

const wasmPath = path.resolve(import.meta.dirname, 'dsp-deinterleave.wasm');
if (!fs.existsSync(wasmPath)) {
    throw new Error(`Missing ${wasmPath}; generate it from dsp-deinterleave.wat before benchmarking`);
}
const instance = await WebAssembly.instantiate(fs.readFileSync(wasmPath));
const memory = instance.instance.exports.memory as WebAssembly.Memory;
const deinterleave = instance.instance.exports.deinterleave as (
    sourcePointer: number,
    leftPointer: number,
    rightPointer: number,
    frameCount: number
) => void;
const memoryFloats = new Float32Array(memory.buffer);
const sourcePointer = 0;
const leftPointer = source.byteLength;
const rightPointer = leftPointer + left.byteLength;

function wasmKernelWithBoundaryCopies(): void {
    memoryFloats.set(source, sourcePointer / 4);
    deinterleave(sourcePointer, leftPointer, rightPointer, frames);
    left.set(memoryFloats.subarray(leftPointer / 4, leftPointer / 4 + frames));
    right.set(memoryFloats.subarray(rightPointer / 4, rightPointer / 4 + frames));
}

function measure(kernel: () => void): number {
    for (let i = 0; i < 10_000; i++) kernel();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) kernel();
    return performance.now() - start;
}

const javascriptMilliseconds = measure(javascriptKernel);
const wasmMilliseconds = measure(wasmKernelWithBoundaryCopies);
const result = {
    frames,
    iterations,
    javascriptMilliseconds,
    wasmMilliseconds,
    wasmToJavascriptRatio: wasmMilliseconds / javascriptMilliseconds,
    selected: wasmMilliseconds < javascriptMilliseconds * 0.85 ? 'wasm' : 'javascript'
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
