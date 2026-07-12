import { describe, expect, it } from 'vitest';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { Score } from '@coderline/alphatab/model/Score';
import { Track } from '@coderline/alphatab/model/Track';
import { WorkerScoreCompilationCache } from '@coderline/alphatab/platform/worker/WorkerScoreCompilation';
import { AlphaTabWorkerScoreRenderer } from '@coderline/alphatab/platform/worker/AlphaTabWorkerScoreRenderer';
import type {
    IAlphaTabRenderingWorker,
    IAlphaTabWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { Settings } from '@coderline/alphatab/Settings';
import type { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';

function createScore(): Score {
    const score = new Score();
    score.addTrack(new Track());
    return score;
}

describe('WorkerScoreCompilation', () => {
    it('shares one versioned score and midi payload across both worker clients', () => {
        const score = createScore();
        const midi = new MidiFile();

        const compilation = WorkerScoreCompilationCache.compile(score, midi);

        expect(WorkerScoreCompilationCache.getOrCompileScore(score)).toBe(compilation);
        expect(WorkerScoreCompilationCache.getForMidi(midi)).toBe(compilation);
        expect(compilation.scoreData).toBeInstanceOf(Map);
        expect(compilation.midiData).toBeDefined();

        const nextRevision = WorkerScoreCompilationCache.getOrCompileScore(score, true);
        expect(nextRevision.id).toBeGreaterThan(compilation.id);
    });

    it('sends a score graph only once for repeated renders of one compilation', () => {
        const messages: IAlphaTabWorkerMessage[] = [];
        const worker = {
            postMessage: (message: IAlphaTabWorkerMessage) => messages.push(message),
            addEventListener: () => {},
            removeEventListener: () => {},
            terminate: () => {}
        } as IAlphaTabRenderingWorker;
        const api = {
            settings: new Settings(),
            score: null
        } as unknown as AlphaTabApiBase<unknown>;
        const renderer = new AlphaTabWorkerScoreRenderer(api, worker);
        const score = createScore();

        renderer.renderScore(score, [0]);
        renderer.renderScore(score, [0]);

        const renders = messages.filter(message => message.cmd === 'alphaTab.renderScore');
        expect(renders).toHaveLength(2);
        expect(renders[0].score).toBeInstanceOf(Map);
        expect(renders[1].score).toBeUndefined();
        expect(renders[1].compilationId).toBe(renders[0].compilationId);
    });
});
