/**
 * A cumulative snapshot of audio-output health since the diagnostics were last reset.
 * Frame counts are per stereo frame, not interleaved sample values.
 * @target web
 * @public
 */
export interface SynthOutputDiagnostics {
    /** The output implementation producing audio. */
    readonly outputMode: 'audio-worklet' | 'script-processor' | 'unknown';

    /** The output sample rate in frames per second. */
    readonly sampleRate: number;

    /** The maximum number of stereo frames the output ring can hold. */
    readonly bufferCapacityFrames: number;

    /** The most recently observed number of queued stereo frames. */
    readonly bufferedFrames: number;

    /** The highest observed number of queued stereo frames. */
    readonly peakBufferedFrames: number;

    /** Frames requested by the audio device after playback became primed. */
    readonly outputFrames: number;

    /** Audio callbacks that could not be completely filled before the final buffer. */
    readonly underrunCount: number;

    /** Silent frames inserted because the output buffer ran dry. */
    readonly underrunFrames: number;

    /** Synthesized frames dropped because the output ring was full. */
    readonly droppedFrames: number;

    /** Output setup/runtime failures observed since the last reset. */
    readonly playbackFailureCount: number;

    /** The most recent output failure message, if any. */
    readonly lastPlaybackFailure: string | null;
}
