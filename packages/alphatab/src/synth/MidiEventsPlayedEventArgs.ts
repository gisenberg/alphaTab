import type { MidiEvent } from '@coderline/alphatab/midi/MidiEvent';

/**
 * Represents the info when the synthesizer played certain midi events.
 * @public
 */
export class MidiEventsPlayedEventArgs {
    /**
     * Gets the events which were played.
     */
    public readonly events: MidiEvent[];

    /**
     * Gets the exact speed-adjusted playback-transport time, in milliseconds,
     * assigned to each event in {@link events}. A notification can arrive
     * before this time when audio is buffered. The array uses the same ordering
     * and length as {@link events}.
     */
    public readonly eventTimes: number[];

    /**
     * Gets the synthesizer transport time when this notification was created.
     * This uses the same time domain as {@link eventTimes}, including during a
     * temporary count-in transport.
     */
    public readonly currentTime: number;

    /**
     * Gets whether the events belong to the temporary count-in transport.
     */
    public readonly isCountIn: boolean;

    /**
     * Initializes a new instance of the {@link MidiEventsPlayedEventArgs} class.
     * @param events The events which were played.
     * @param eventTimes The playback-transport time for each event.
     * @param currentTime The matching synthesizer transport time at notification.
     * @param isCountIn Whether the active transport is the count-in.
     */
    public constructor(events: MidiEvent[], eventTimes?: number[], currentTime: number = 0, isCountIn: boolean = false) {
        this.events = events;
        this.eventTimes = eventTimes?.length === events.length ? eventTimes : events.map(() => 0);
        this.currentTime = currentTime;
        this.isCountIn = isCountIn;
    }
}
