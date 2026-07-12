import { describe, expect, it } from 'vitest';
import { Logger } from '@coderline/alphatab/Logger';
import { VisualTestHelper, type VisualTestOptions } from 'test/visualTests/VisualTestHelper';
import { enableTestColoring } from 'test/visualTests/features/ColoringTestHelper';

const WarmupPairs = 3;
const MeasuredPairs = 10;
const MedianOverheadBudgetMilliseconds = 120;

async function measureRender(prepare: (options: VisualTestOptions) => void): Promise<number> {
    let startedAt = 0;
    await VisualTestHelper.runVisualTest('general/colors.gp', undefined, options => {
        prepare(options);
        startedAt = performance.now();
    });
    return performance.now() - startedAt;
}

async function measureColored(): Promise<number> {
    return measureRender(options => enableTestColoring(options.score));
}

async function measureDefault(): Promise<number> {
    return measureRender(options => {
        options.runs[0].referenceFileName = 'test-data/visual-tests/general/colors-disabled.png';
    });
}

function median(values: number[]): number {
    const sorted = [...values].sort((a: number, b: number) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

describe('ColorPerformance', () => {
    it('keeps styled rendering overhead within budget', { timeout: 30000 }, async () => {
        // This file runs in its own single-worker Vitest process via test:performance.
        // Warm both paths and alternate order so scheduler/cache noise cannot land
        // exclusively on the colored side of every pair.
        for (let i = 0; i < WarmupPairs; i++) {
            await measureColored();
            await measureDefault();
        }

        const overheads: number[] = [];
        for (let i = 0; i < MeasuredPairs; i++) {
            const coloredFirst = i % 2 === 0;
            const first = coloredFirst ? await measureColored() : await measureDefault();
            const second = coloredFirst ? await measureDefault() : await measureColored();
            const colored = coloredFirst ? first : second;
            const baseline = coloredFirst ? second : first;
            overheads.push(colored - baseline);

            Logger.info('Test-color-performance', 'Pair', i, { colored, baseline, overhead: colored - baseline });
        }

        const medianOverhead = median(overheads);
        Logger.info('Test-color-performance', 'Median overhead', medianOverhead);
        expect(medianOverhead).toBeLessThan(MedianOverheadBudgetMilliseconds);
    });
});
