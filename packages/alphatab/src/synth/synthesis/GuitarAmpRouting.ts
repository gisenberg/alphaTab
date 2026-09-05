import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { MidiEventType, type ProgramChangeEvent } from '@coderline/alphatab/midi/MidiEvent';

/** Resolve unambiguous track ownership without rewriting MIDI program changes. @internal */
export function findGuitarAmpChannels(midi: MidiFile): number[][] {
    const tracks = new Map<number, Set<number>>();
    const owners = new Map<number, Set<number>>();
    const guitarTracks = new Set<number>();
    for (const track of midi.tracks) {
        for (const event of track.events) {
            if (!('channel' in event) || typeof event.channel !== 'number' ||
                !Number.isInteger(event.channel) || event.channel < 0 || event.channel === 9) { continue; }
            let channels = tracks.get(event.track);
            if (!channels) { channels = new Set(); tracks.set(event.track, channels); }
            channels.add(event.channel);
            let channelOwners = owners.get(event.channel);
            if (!channelOwners) { channelOwners = new Set(); owners.set(event.channel, channelOwners); }
            channelOwners.add(event.track);
            if (event.type === MidiEventType.ProgramChange) {
                const program = (event as ProgramChangeEvent).program;
                if (program === 29 || program === 30) { guitarTracks.add(event.track); }
            }
        }
    }
    return [...tracks].filter(([track, channels]) => guitarTracks.has(track) &&
        [...channels].every(channel => owners.get(channel)!.size === 1)).map(([, channels]) => [...channels]);
}
