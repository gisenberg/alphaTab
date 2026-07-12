/** Low-level MIDI generation and alphaSynth surface without browser rendering UI. */
import '@coderline/alphatab/alphaTab.polyfills';

export {
    PlayerMode,
    PlayerOutputMode,
    PlayerSettings,
    SlidePlaybackSettings,
    VibratoPlaybackSettings
} from '@coderline/alphatab/PlayerSettings';
export { Settings } from '@coderline/alphatab/Settings';
export { AlphaSynthMidiFileHandler } from '@coderline/alphatab/midi/AlphaSynthMidiFileHandler';
export { MidiFile } from '@coderline/alphatab/midi/MidiFile';
export { MidiFileGenerator } from '@coderline/alphatab/midi/MidiFileGenerator';
export { AlphaSynth } from '@coderline/alphatab/synth/AlphaSynth';
export { AlphaSynthWrapper } from '@coderline/alphatab/synth/AlphaSynthWrapper';
export type { IAlphaSynth } from '@coderline/alphatab/synth/IAlphaSynth';
export { PlaybackRange } from '@coderline/alphatab/synth/PlaybackRange';
export { TransportClock } from '@coderline/alphatab/synth/TransportClock';
export * as midi from '@coderline/alphatab/midi/_barrel';
export * as synth from '@coderline/alphatab/synth/_barrel';
