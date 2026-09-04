import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioHelper } from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';

class FakeAudioContext {
    public static defaultSampleRate: number = 48000;
    public static instances: FakeAudioContext[] = [];

    public readonly sampleRate: number;
    public readonly options: AudioContextOptions | undefined;
    public closed: boolean = false;

    public constructor(options?: AudioContextOptions) {
        this.options = options;
        this.sampleRate = options?.sampleRate ?? FakeAudioContext.defaultSampleRate;
        FakeAudioContext.instances.push(this);
    }

    public close(): Promise<void> {
        this.closed = true;
        return Promise.resolve();
    }
}

describe('WebAudioHelper', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeAudioContext.instances = [];
        FakeAudioContext.defaultSampleRate = 48000;
    });

    it('keeps the platform default context when no minimum sample rate is configured', () => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        FakeAudioContext.defaultSampleRate = 24000;

        const context = WebAudioHelper.createAudioContext() as unknown as FakeAudioContext;

        expect(FakeAudioContext.instances).toEqual([context]);
        expect(context.options).toBeUndefined();
        expect(context.sampleRate).toBe(24000);
    });

    it('recreates the context with the minimum sample rate when the default is below it', () => {
        // Some macOS Bluetooth configurations default to 24 kHz, which distorts SoundFont synthesis.
        vi.stubGlobal('AudioContext', FakeAudioContext);
        FakeAudioContext.defaultSampleRate = 24000;

        const context = WebAudioHelper.createAudioContext(44100) as unknown as FakeAudioContext;

        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(FakeAudioContext.instances[0].closed).toBe(true);
        expect(context).toBe(FakeAudioContext.instances[1]);
        expect(context.options).toEqual({ sampleRate: 44100 });
        expect(context.sampleRate).toBe(44100);
    });

    it('keeps a native rate which already satisfies the minimum', () => {
        // Forcing 44.1 kHz on a 48 kHz device would resample needlessly (and break iOS synthesis).
        vi.stubGlobal('AudioContext', FakeAudioContext);
        FakeAudioContext.defaultSampleRate = 48000;

        const context = WebAudioHelper.createAudioContext(44100) as unknown as FakeAudioContext;

        expect(FakeAudioContext.instances).toEqual([context]);
        expect(context.closed).toBe(false);
        expect(context.options).toBeUndefined();
        expect(context.sampleRate).toBe(48000);
    });
});
