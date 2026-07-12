import { Environment } from '@coderline/alphatab/Environment';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';

/**
 * Versioned worker-ready representation shared by renderer and synth clients.
 * @target web
 * @internal
 */
export interface WorkerScoreCompilation {
    readonly id: number;
    readonly score: Score;
    readonly midi?: MidiFile;
    readonly scoreData: Map<string, unknown>;
    readonly midiData?: unknown;
}

/**
 * Compiles the object graph once per score revision, rather than independently
 * walking it for the renderer worker and again for the synth worker.
 * @target web
 * @internal
 */
export class WorkerScoreCompilationCache {
    private static _nextId: number = 1;
    private static readonly _byScore: WeakMap<Score, WorkerScoreCompilation> = new WeakMap();
    private static readonly _byMidi: WeakMap<MidiFile, WorkerScoreCompilation> = new WeakMap();

    public static compile(score: Score, midi?: MidiFile): WorkerScoreCompilation {
        const compilation: WorkerScoreCompilation = {
            id: WorkerScoreCompilationCache._nextId++,
            score,
            midi,
            scoreData: JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(score))!,
            midiData: midi ? JsonConverter.midiFileToJsObject(Environment.prepareForPostMessage(midi)) : undefined
        };
        WorkerScoreCompilationCache._byScore.set(score, compilation);
        if (midi) {
            WorkerScoreCompilationCache._byMidi.set(midi, compilation);
        }
        return compilation;
    }

    public static getOrCompileScore(score: Score, force: boolean = false): WorkerScoreCompilation {
        if (!force) {
            const existing = WorkerScoreCompilationCache._byScore.get(score);
            if (existing) {
                return existing;
            }
        }
        return WorkerScoreCompilationCache.compile(score);
    }

    public static getForMidi(midi: MidiFile): WorkerScoreCompilation | undefined {
        return WorkerScoreCompilationCache._byMidi.get(midi);
    }
}
