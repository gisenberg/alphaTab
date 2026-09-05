import { describe, expect, it } from 'vitest';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { ByteBuffer } from '@coderline/alphatab/io/ByteBuffer';
import { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
import { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
import { MidiEventType, NoteOnEvent, NoteOffEvent } from '@coderline/alphatab/midi/MidiEvent';
import { PercussionMapper } from '@coderline/alphatab/model/PercussionMapper';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import { WorkerScoreCompilation } from '@coderline/alphatab/platform/worker/WorkerScoreCompilation';
import { Settings } from '@coderline/alphatab/Settings';

describe('percussion choke event preservation', () => {
    it('preserves articulation hints through cached and uncached worker MIDI serialization', () => {
        const midi = new MidiFile();
        const handler = new AlphaSynthMidiFileHandler(midi);
        handler.addNote(0, 0, 480, 57, 95, 9, false, true);
        handler.addNote(0, 960, 480, 57, 95, 9);
        handler.addNote(1, 0, 480, 40, 95, 0, true);
        const compilation = new WorkerScoreCompilation(1, ScoreLoader.loadAlphaTex('0.1'));
        compilation.attachMidi(midi);
        for (const payload of [JsonConverter.midiFileToJsObject(midi), compilation.midiData]) {
            // Regression: structuredClone alone passed, but the worker's JSON conversion dropped choke hints.
            const restored = JsonConverter.jsObjectToMidiFile(structuredClone(payload));
            const events = restored.tracks.flatMap(track => track.events);
            const starts = events.filter(event => event.type === MidiEventType.NoteOn) as NoteOnEvent[];
            const stops = events.filter(event => event.type === MidiEventType.NoteOff) as NoteOffEvent[];
            expect(starts.map(event => [event.noteKey, event.isPalmMute, !!event.isPercussionChoke]))
                .toEqual([[57, false, true], [40, true, false], [57, false, false]]);
            expect(stops.map(event => [event.tick, !!event.isPercussionChoke]))
                .toEqual([[480, true], [480, false], [1440, false]]);
        }
    });

    it.each([29, 94, 95, 96, 97, 98])('preserves choke %s for direct and track-indexed articulations', id => {
        for (const indexed of [false, true]) {
            const score = ScoreLoader.loadAlphaTex('0.1 0.1');
            const track = score.tracks[0];
            const staff = track.staves[0];
            staff.isPercussion = true;
            const beats = staff.bars[0].voices[0].beats;
            const articulation = PercussionMapper.getArticulationById(id)!;
            const normal = PercussionMapper.getArticulationById(articulation.outputMidiNumber)!;
            if (indexed) {
                track.percussionArticulations.push(articulation, normal);
            }
            beats[0].notes[0].percussionArticulation = indexed ? 0 : id;
            beats[1].notes[0].percussionArticulation = indexed ? 1 : normal.id;
            const midi = new MidiFile();
            new MidiFileGenerator(score, new Settings(), new AlphaSynthMidiFileHandler(midi)).generate();
            const events = midi.tracks.flatMap(track => track.events);
            const starts = events.filter(event => event.type === MidiEventType.NoteOn) as NoteOnEvent[];
            const stops = events.filter(event => event.type === MidiEventType.NoteOff) as NoteOffEvent[];
            // Regression: normal and choked cymbals previously collapsed to identical ordinary MIDI hits.
            expect(starts).toHaveLength(2);
            expect(stops).toHaveLength(2);
            expect(starts[0].isPercussionChoke).toBe(true);
            expect(stops[0].isPercussionChoke).toBe(true);
            expect(starts[1].isPercussionChoke).toBeUndefined();
            expect(stops[1].isPercussionChoke).toBeUndefined();
            expect(starts[0].noteKey).toBe(starts[1].noteKey);
            expect(stops[0].tick).toBe(starts[1].tick);
            expect(structuredClone(starts)[0].isPercussionChoke).toBe(true);
            expect(structuredClone(stops)[0].isPercussionChoke).toBe(true);
        }
    });

    it('keeps ordinary MIDI bytes and the palm-mute hint independent', () => {
        const bytes = (event: NoteOnEvent | NoteOffEvent) => {
            const buffer = ByteBuffer.empty();
            event.writeTo(buffer);
            return buffer.toArray();
        };
        const normal = new NoteOnEvent(0, 0, 9, 57, 95);
        const choke = new NoteOnEvent(0, 0, 9, 57, 95, false, true);
        expect(bytes(choke)).toEqual(bytes(normal));
        expect(bytes(new NoteOffEvent(0, 960, 9, 57, 95, true))).toEqual(bytes(new NoteOffEvent(0, 960, 9, 57, 95)));
        expect(choke.isPalmMute).toBe(false);
        expect(new NoteOnEvent(0, 0, 0, 40, 95, true).isPercussionChoke).toBeUndefined();
        const midi = new MidiFile();
        new AlphaSynthMidiFileHandler(midi).addNote(0, 120, 240, 57, 95, 9, false, true);
        const events = midi.tracks.flatMap(track => track.events) as (NoteOnEvent | NoteOffEvent)[];
        expect(events.map(event => event.tick)).toEqual([120, 360]);
        expect(events.every(event => event.isPercussionChoke)).toBe(true);
    });
});
