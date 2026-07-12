import { describe, expect, it } from 'vitest';
import {
    calculateWebAudioBufferCount,
    calculateWebAudioRequestBufferCount,
    SamplesPlayedReporter,
    WebAudioSamplesPlayedReportIntervalFrames,
    writeInterleavedStereoSamples
} from '@coderline/alphatab/platform/javascript/WebAudioSampleBuffer';

describe('WebAudioSampleBuffer', () => {
    it('sizes buffers in interleaved stereo samples and never creates a zero-capacity ring', () => {
        expect(calculateWebAudioBufferCount(500, 44100, 4096)).toBe(11);
        expect(calculateWebAudioBufferCount(1, 44100, 4096)).toBe(1);
        expect(calculateWebAudioBufferCount(1, 44100, 4096, 2)).toBe(2);
        expect(calculateWebAudioBufferCount(0, 44100, 4096)).toBe(1);
        expect(calculateWebAudioRequestBufferCount(1)).toBe(1);
        expect(calculateWebAudioRequestBufferCount(2, 2)).toBe(2);
        expect(calculateWebAudioRequestBufferCount(11)).toBe(5);
    });

    it('copies complete stereo frames and clears the unused output tail', () => {
        const left = new Float32Array([9, 9, 9, 9]);
        const right = new Float32Array([9, 9, 9, 9]);

        const frames = writeInterleavedStereoSamples(new Float32Array([1, 2, 3, 4]), 4, left, right);

        expect(frames).toBe(2);
        expect(Array.from(left)).toEqual([1, 3, 0, 0]);
        expect(Array.from(right)).toEqual([2, 4, 0, 0]);
    });

    it('batches worklet progress without losing played frames', () => {
        const reporter = new SamplesPlayedReporter(WebAudioSamplesPlayedReportIntervalFrames);
        const reports: number[] = [];

        // A Web Audio worklet renders 128 frames per quantum: 345 callbacks cover just over one second.
        for (let i = 0; i < 345; i++) {
            const report = reporter.update(128, 128);
            if (report !== undefined) {
                reports.push(report);
            }
        }
        reports.push(reporter.update(0, 0, true)!);

        expect(reports).toHaveLength(44);
        expect(reports.reduce((total, report) => total + report, 0)).toBe(345 * 128);
    });

    it('still reports prolonged silence so playback completion can be checked', () => {
        const reporter = new SamplesPlayedReporter(WebAudioSamplesPlayedReportIntervalFrames);

        for (let i = 0; i < 7; i++) {
            expect(reporter.update(0, 128)).toBeUndefined();
        }
        expect(reporter.update(0, 128)).toBe(0);
    });
});
