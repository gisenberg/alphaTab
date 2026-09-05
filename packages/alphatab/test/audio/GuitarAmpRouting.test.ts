import { describe, expect, it } from 'vitest';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { NoteOnEvent, ProgramChangeEvent } from '@coderline/alphatab/midi/MidiEvent';
import { findGuitarAmpChannels } from '@coderline/alphatab/synth/synthesis/GuitarAmpRouting';

describe('experimental guitar routing', () => {
    it('groups guitar channels by logical track and excludes clean-only, bass and drums', () => {
        const midi = new MidiFile();
        for (const [track, channel, program] of [[0, 0, 26], [0, 1, 30], [1, 2, 29], [2, 3, 34], [3, 9, 30], [4, 4, 27]]) {
            midi.addEvent(new ProgramChangeEvent(track, 0, channel, program));
        }
        expect(findGuitarAmpChannels(midi)).toEqual([[0, 1], [2]]);
    });

    it('does not combine distinct tracks that share a channel, including note-only ownership', () => {
        const midi = new MidiFile();
        midi.addEvent(new ProgramChangeEvent(0, 0, 0, 30));
        midi.addEvent(new ProgramChangeEvent(0, 0, 1, 30));
        midi.addEvent(new NoteOnEvent(1, 0, 1, 60, 100));
        expect(findGuitarAmpChannels(midi)).toEqual([]);
    });
});
