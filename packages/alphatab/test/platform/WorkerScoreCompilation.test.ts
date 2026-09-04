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

    it('keeps the identity and serialized graph of a known score when only the midi changes', () => {
        // Regression: every midi regeneration (player ready, track changes, reloads) re-serialized
        // the whole score and minted a new id, so the next render posted the full graph again.
        const score = createScore();
        const first = WorkerScoreCompilationCache.compile(score, new MidiFile());
        expect(first.hasScoreData).toBe(false);
        const scoreData = first.scoreData;
        expect(first.hasScoreData).toBe(true);

        const midi = new MidiFile();
        const second = WorkerScoreCompilationCache.compile(score, midi);
        expect(second).toBe(first);
        expect(second.id).toBe(first.id);
        expect(second.scoreData).toBe(scoreData);
        expect(second.midi).toBe(midi);
        expect(second.midiData).toBeDefined();
        expect(WorkerScoreCompilationCache.getForMidi(midi)).toBe(first);
    });

    it('starts a new revision after the score was finished again', () => {
        // In-place edits end with score.finish(); a render after it must not reuse the stale graph.
        const score = createScore();
        const first = WorkerScoreCompilationCache.compile(score, new MidiFile());
        score.finish(new Settings());

        const second = WorkerScoreCompilationCache.getOrCompileScore(score);
        expect(second).not.toBe(first);
        expect(second.id).toBeGreaterThan(first.id);
        expect(WorkerScoreCompilationCache.compile(score)).toBe(second);
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
        // A midi regeneration in between (e.g. the player became ready) keeps the resident graph valid.
        WorkerScoreCompilationCache.compile(score, new MidiFile());
        renderer.renderScore(score, [0]);
        // An in-place edit invalidates it.
        score.finish(new Settings());
        renderer.renderScore(score, [0]);

        const renders = messages.filter(message => message.cmd === 'alphaTab.renderScore');
        expect(renders).toHaveLength(4);
        expect(renders[0].score).toBeInstanceOf(Map);
        expect(renders[1].score).toBeUndefined();
        expect(renders[1].compilationId).toBe(renders[0].compilationId);
        expect(renders[2].score).toBeUndefined();
        expect(renders[2].compilationId).toBe(renders[0].compilationId);
        expect(renders[3].score).toBeInstanceOf(Map);
        expect(renders[3].compilationId).toBeGreaterThan(renders[0].compilationId);
    });
});
