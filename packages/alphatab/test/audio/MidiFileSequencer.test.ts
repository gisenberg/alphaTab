import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiEventType } from '@coderline/alphatab/midi/MidiEvent';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import type { Hydra } from '@coderline/alphatab/synth/soundfont/Hydra';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';
import { MidiFileSequencer } from '@coderline/alphatab/synth/MidiFileSequencer';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';

/**
 * Records dispatched events and how they are grouped into synthesis calls, which is what
 * decides whether note-ons are spread over time or all sound at the same instant.
 */
class RecordingSynthesizer implements IAudioSampleSynthesizer {
    /**
     * The sequencer's microbuffer loops read the sample rate once per iteration, so budgeting
     * those reads turns a non-terminating fill into a failing test instead of a hung suite.
     */
    private static readonly _maxMicroBufferIterations: number = 100_000;

    public masterVolume: number = 1;
    public metronomeVolume: number = 0;
    public readonly currentTempo: number = 120;
    public readonly timeSignatureNumerator: number = 4;
    public readonly timeSignatureDenominator: number = 4;
    public readonly activeVoiceCount: number = 0;

    /** Note-ons dispatched since the last {@link takeNoteOnCount} call. */
    private _noteOnCount: number = 0;

    private _microBufferIterations: number = 0;

    public get outSampleRate(): number {
        this._microBufferIterations++;
        if (this._microBufferIterations > RecordingSynthesizer._maxMicroBufferIterations) {
            throw new Error('Sequencer microbuffer loop did not terminate');
        }
        return 44100;
    }

    public takeNoteOnCount(): number {
        const noteOnCount = this._noteOnCount;
        this._noteOnCount = 0;
        return noteOnCount;
    }

    public dispatchEvent(synthEvent: SynthEvent): void {
        if (synthEvent.event?.type === MidiEventType.NoteOn) {
            this._noteOnCount++;
        }
    }

    public noteOffAll(_immediate: boolean): void {}
    public resetSoft(): void {}
    public resetPresets(): void {}
    public loadPresets(
        _hydra: Hydra,
        _instrumentPrograms: Set<number>,
        _percussionKeys: Set<number>,
        _append: boolean
    ): void {}
    public setupMetronomeChannel(_metronomeChannel: number, _metronomeVolume: number): void {}
    public synthesizeSilent(_sampleCount: number): void {}
    public synthesize(_buffer: Float32Array, _bufferPos: number, _sampleCount: number): SynthEvent[] {
        return [];
    }
    public applyTranspositionPitches(_transpositionPitches: Map<number, number>): void {}
    public setChannelTranspositionPitch(_channel: number, _semitones: number): void {}
    public channelSetMute(_channel: number, _mute: boolean): void {}
    public channelSetSolo(_channel: number, _solo: boolean): void {}
    public resetChannelStates(): void {}
    public channelSetMixVolume(_channel: number, _volume: number): void {}
    public hasSamplesForProgram(_program: number): boolean {
        return true;
    }
    public hasSamplesForPercussion(_key: number): boolean {
        return true;
    }
}

function createMidi(): MidiFile {
    // 8 bars of quarter notes at 120bpm -> 16 seconds, 32 note-ons.
    const bar = ':4 C4 D4 E4 F4';
    const score = ScoreLoader.loadAlphaTex(`\\tempo 120 . \\ts 4 4 ${new Array(8).fill(bar).join(' | ')}`);
    const midi = new MidiFile();
    new MidiFileGenerator(score, null, new AlphaSynthMidiFileHandler(midi)).generate();
    return midi;
}

describe('MidiFileSequencerTests', () => {
    it('defers a main seek requested while the count-in owns the synthesizer', () => {
        // Regression: seeking during the count-in (a score click, a loop range or a tempo change)
        // used to move the main state's time forward while leaving its event index behind. When
        // the count-in finished, the first microbuffer then dispatched every skipped event at
        // once, so the whole skipped section sounded as one explosively loud batch of note-ons.
        const synthesizer = new RecordingSynthesizer();
        const sequencer = new MidiFileSequencer(synthesizer);
        sequencer.loadMidi(createMidi());

        sequencer.startCountIn();
        expect(sequencer.isPlayingCountIn).toBe(true);

        // Seek to bar 5 (8 seconds in, 16 note-ons skipped) while the count-in is playing.
        sequencer.mainSeek(8000);
        expect(sequencer.hasPendingMainSeek).toBe(true);
        expect(synthesizer.takeNoteOnCount()).toBe(0);

        // Returning to the main state applies the deferred seek silently.
        sequencer.resetCountIn();
        expect(sequencer.hasPendingMainSeek).toBe(false);
        expect(synthesizer.takeNoteOnCount()).toBe(16);

        // The first audible microbuffer must not replay the skipped section.
        sequencer.fillMidiEventQueue();
        expect(synthesizer.takeNoteOnCount()).toBeLessThanOrEqual(1);
    });

    it('fills the queue to an end time while the count-in owns the synthesizer', () => {
        // Regression: the microbuffer loop tested the *main* state's clock even though
        // _fillMidiEventQueueLimited only ever advances the current state. While the count-in
        // (or a one-time MIDI file) was current the main clock never moved, so the loop never
        // terminated. A backing track's first time update therefore spun its caller forever and
        // no file with embedded audio could be played at all.
        const synthesizer = new RecordingSynthesizer();
        const sequencer = new MidiFileSequencer(synthesizer);
        sequencer.loadMidi(createMidi());

        sequencer.startCountIn();
        expect(sequencer.isPlayingCountIn).toBe(true);

        // This is the scheduling window BackingTrackPlayer requests on every media time update.
        sequencer.fillMidiEventQueueToEndTime(150);

        expect(sequencer.currentTime).toBe(150);
    });

    it('advances the main state and applies a deferred seek when filling to an end time', () => {
        const synthesizer = new RecordingSynthesizer();
        const sequencer = new MidiFileSequencer(synthesizer);
        sequencer.loadMidi(createMidi());

        // A seek requested during the count-in stays deferred until the main state is current.
        sequencer.startCountIn();
        sequencer.mainSeek(8000);
        sequencer.resetCountIn();
        expect(sequencer.hasPendingMainSeek).toBe(false);
        expect(synthesizer.takeNoteOnCount()).toBe(16);

        sequencer.fillMidiEventQueueToEndTime(8150);

        expect(sequencer.isPlayingMain).toBe(true);
        expect(sequencer.currentTime).toBe(8150);
        // Bar 5 starts exactly at the seek target, so the window plays it and nothing earlier.
        expect(synthesizer.takeNoteOnCount()).toBe(1);
    });

    it('keeps time and event index consistent when stopping inside a playback range', () => {
        // Regression: stop() assigned the playback range's start *tick* to the millisecond-based
        // currentTime while resetting the event index to zero, so a following no-op seek left the
        // sequencer able to dispatch the whole pre-range section in a single microbuffer.
        const synthesizer = new RecordingSynthesizer();
        const sequencer = new MidiFileSequencer(synthesizer);
        sequencer.loadMidi(createMidi());
        sequencer.mainPlaybackRange = { startTick: 3840 * 4, endTick: 3840 * 6 };

        sequencer.stop();
        expect(sequencer.currentTime).toBe(0);

        // Seeking to the range start replays the skipped events silently...
        sequencer.mainSeek(8000);
        expect(synthesizer.takeNoteOnCount()).toBe(16);

        // ...so audible playback starts clean.
        sequencer.fillMidiEventQueue();
        expect(synthesizer.takeNoteOnCount()).toBeLessThanOrEqual(1);
    });

    it('returns to the main score when stopped during count-in', () => {
        const synthesizer = new RecordingSynthesizer();
        const sequencer = new MidiFileSequencer(synthesizer);
        sequencer.loadMidi(createMidi());
        sequencer.startCountIn();
        sequencer.mainSeek(8000);

        expect(sequencer.isPlayingCountIn).toBe(true);
        expect(sequencer.hasPendingMainSeek).toBe(true);

        // Regression: stop() rewound the count-in state but left it current. A following seek to
        // the beginning was therefore deferred, leaving the visible cursor at the old measure.
        sequencer.stop();

        expect(sequencer.isPlayingMain).toBe(true);
        expect(sequencer.isPlayingCountIn).toBe(false);
        expect(sequencer.hasPendingMainSeek).toBe(false);
        expect(sequencer.currentTime).toBe(0);

        sequencer.mainSeek(0);
        sequencer.fillMidiEventQueue();
        expect(synthesizer.takeNoteOnCount()).toBeLessThanOrEqual(1);
    });
});
