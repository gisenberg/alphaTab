import { Environment } from '@coderline/alphatab/Environment';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import type { Score } from '@coderline/alphatab/model/Score';

/**
 * Versioned worker-ready representation shared by renderer and synth clients.
 * The score graph is serialized lazily on first access and only once per revision.
 * @target web
 * @internal
 */
export class WorkerScoreCompilation {
    public readonly id: number;
    public readonly score: Score;
    /** The {@link Score.revision} this compilation was created for. */
    public readonly scoreRevision: number;
    private _scoreData?: Map<string, unknown>;
    private _midi?: MidiFile;
    private _midiData?: unknown;

    public constructor(id: number, score: Score) {
        this.id = id;
        this.score = score;
        this.scoreRevision = score.revision;
    }

    /** The serialized score graph, computed on first access. */
    public get scoreData(): Map<string, unknown> {
        if (!this._scoreData) {
            this._scoreData = JsonConverter.scoreToJsObject(Environment.prepareForPostMessage(this.score))!;
        }
        return this._scoreData;
    }

    /** Whether the score graph was already serialized for this revision. */
    public get hasScoreData(): boolean {
        return this._scoreData !== undefined;
    }

    public get midi(): MidiFile | undefined {
        return this._midi;
    }

    public get midiData(): unknown {
        return this._midiData;
    }

    public attachMidi(midi: MidiFile): void {
        this._midi = midi;
        this._midiData = JsonConverter.midiFileToJsObject(Environment.prepareForPostMessage(midi));
    }
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

    /**
     * Returns the compilation of the score, creating it if the score is not known yet, and
     * attaches the MIDI payload. A known score keeps its identity and serialized graph:
     * regenerating MIDI (player ready, track changes, reloads) does not change the score.
     */
    public static compile(score: Score, midi?: MidiFile): WorkerScoreCompilation {
        let compilation = WorkerScoreCompilationCache._current(score);
        if (!compilation) {
            compilation = WorkerScoreCompilationCache._createRevision(score);
        }
        if (midi) {
            compilation.attachMidi(midi);
            WorkerScoreCompilationCache._byMidi.set(midi, compilation);
        }
        return compilation;
    }

    /**
     * Returns the compilation of the score. `force` starts a new revision, which is required
     * after the score object was changed in place.
     */
    public static getOrCompileScore(score: Score, force: boolean = false): WorkerScoreCompilation {
        if (!force) {
            const existing = WorkerScoreCompilationCache._current(score);
            if (existing) {
                return existing;
            }
        }
        return WorkerScoreCompilationCache._createRevision(score);
    }

    /** The cached compilation, unless the score was finished again since it was created. */
    private static _current(score: Score): WorkerScoreCompilation | undefined {
        const existing = WorkerScoreCompilationCache._byScore.get(score);
        return existing && existing.scoreRevision === score.revision ? existing : undefined;
    }

    public static getForMidi(midi: MidiFile): WorkerScoreCompilation | undefined {
        return WorkerScoreCompilationCache._byMidi.get(midi);
    }

    private static _createRevision(score: Score): WorkerScoreCompilation {
        const compilation = new WorkerScoreCompilation(WorkerScoreCompilationCache._nextId++, score);
        WorkerScoreCompilationCache._byScore.set(score, compilation);
        return compilation;
    }
}
