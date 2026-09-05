import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';

describe('backing click master gain', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('applies mute and volume changes to queued clicks without altering their relative level', () => {
        const gains: {
            gain: { setValueAtTime: ReturnType<typeof vi.fn> };
            connect: ReturnType<typeof vi.fn>;
            disconnect: ReturnType<typeof vi.fn>;
        }[] = [];
        const sources: {
            start: ReturnType<typeof vi.fn>;
            stop: ReturnType<typeof vi.fn>;
            connect: ReturnType<typeof vi.fn>;
            disconnect: ReturnType<typeof vi.fn>;
            addEventListener: ReturnType<typeof vi.fn>;
        }[] = [];
        const context = {
            sampleRate: 44100,
            currentTime: 2,
            destination: {},
            close: vi.fn().mockResolvedValue(undefined),
            createGain: () => {
                const gain = { gain: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
                gains.push(gain);
                return gain;
            },
            createBuffer: (_channels: number, frames: number) => ({ getChannelData: () => new Float32Array(frames) }),
            createBufferSource: () => {
                const source = {
                    start: vi.fn(),
                    stop: vi.fn(),
                    connect: vi.fn(),
                    disconnect: vi.fn(),
                    addEventListener: vi.fn()
                };
                sources.push(source);
                return source;
            }
        };
        vi.stubGlobal(
            'AudioContext',
            class {
                sampleRate = context.sampleRate;
                destination = context.destination;
                close = context.close;
                createGain = context.createGain;
                createBuffer = context.createBuffer;
                createBufferSource = context.createBufferSource;
                get currentTime() {
                    return context.currentTime;
                }
            }
        );
        const output = new AudioElementBackingTrackSynthOutput();
        output.audioElement = {
            volume: 0.6,
            currentTime: 0,
            pause: vi.fn(),
            removeAttribute: vi.fn(),
            load: vi.fn(),
            remove: vi.fn()
        } as unknown as HTMLAudioElement;
        output.scheduleCountInClick(1000, true, 0.4);
        output.scheduleCountInClick(1500, false, 0.3);
        expect(gains).toHaveLength(3); // One master bus, two independent beat levels.
        expect(gains[1].connect).toHaveBeenCalledWith(gains[0]);
        expect(gains[2].connect).toHaveBeenCalledWith(gains[0]);
        expect(gains[0].connect).toHaveBeenCalledWith(context.destination);
        expect(gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.6, 2);
        // Regression: scheduled clicks used to retain the old master level after mute.
        output.masterVolume = 0;
        expect(gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 2);
        context.currentTime = 2.5;
        output.masterVolume = 0.2;
        expect(gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.2, 2.5);
        expect(gains[1].gain.setValueAtTime).toHaveBeenCalledExactlyOnceWith(0.4, 3);
        expect(gains[2].gain.setValueAtTime).toHaveBeenCalledExactlyOnceWith(0.3, 3.5);
        expect(sources[0].start).toHaveBeenCalledExactlyOnceWith(3);
        expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(3.5);
        output.destroy();
        expect(gains[0].disconnect).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
        expect(sources[0].stop).toHaveBeenCalledOnce();
        expect(sources[1].stop).toHaveBeenCalledOnce();
    });
});
