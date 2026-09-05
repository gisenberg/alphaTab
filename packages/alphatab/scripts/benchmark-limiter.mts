import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SamplePeakLimiter } from '../src/synth/SamplePeakLimiter';

// Measures DSP only, not device deadlines or worker scheduling.
// Reuses buffers so allocation and test-signal generation are outside the timed region.
const results = [];
for (const sampleRate of [48000, 96000]) {
    const frames = 128;
    const iterations = Math.ceil(sampleRate * 60 / frames);
    const limiter = new SamplePeakLimiter(sampleRate);
    const source = Float32Array.from({ length: frames * 2 }, (_, i) =>
        Math.sin(i / 7) * 1.4 + Math.sin(i / 19) * 0.4);
    const buffer = new Float32Array(source.length);
    const costs = new Float64Array(iterations);
    let peak = 0;
    let totalMs = 0;
    for (let i = 0; i < iterations; i++) {
        buffer.set(source);
        const start = performance.now();
        limiter.processInterleaved(buffer, 0, frames);
        costs[i] = performance.now() - start;
        totalMs += costs[i];
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
    }
    const firstChunkMs = costs[0];
    costs.sort();
    const budgetMs = frames / sampleRate * 1000;
    results.push({ sampleRate, frames, iterations, latencyFrames: limiter.latencyFrames,
        audioMs: iterations * budgetMs, totalMs, realtimeFactor: totalMs / (iterations * budgetMs),
        firstChunkMs, p99Ms: costs[Math.ceil(costs.length * 0.99) - 1], maxMs: costs[costs.length - 1],
        overBudgetChunks: costs.filter(cost => cost > budgetMs).length, peak });
}
process.stdout.write(`${JSON.stringify({ node: process.version, cpu: cpus()[0]?.model,
    scope: 'Offline limiter kernel only; excludes synthesis, IPC, worklet scheduling and devices', results }, null, 2)}\n`);
