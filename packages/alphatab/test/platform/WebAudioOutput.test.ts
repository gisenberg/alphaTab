import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@coderline/alphatab/Settings';
import { AlphaSynthAudioWorkletOutput } from '@coderline/alphatab/platform/javascript/AlphaSynthAudioWorkletOutput';
import { AudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';
import {
    AlphaSynthWebAudioOutputBase,
    WebAudioHelper
} from '@coderline/alphatab/platform/javascript/AlphaSynthWebAudioOutputBase';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';

const originalWorkletFactory = BrowserUiFacade.createAlphaSynthAudioWorklet;

describe('WebAudioOutput', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        BrowserUiFacade.createAlphaSynthAudioWorklet = originalWorkletFactory;
    });

    it('closes the temporary context used to detect output-device support', async () => {
        const close = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(WebAudioHelper, 'createAudioContext').mockReturnValue({
            setSinkId: vi.fn(),
            close
        } as unknown as AudioContext);

        await expect(WebAudioHelper.checkSinkIdSupport()).resolves.toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('stops the temporary microphone stream used to unlock output-device labels', async () => {
        const stop = vi.fn();
        vi.stubGlobal('navigator', {
            mediaDevices: {
                getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
                enumerateDevices: vi.fn().mockResolvedValue([])
            }
        });
        vi.spyOn(WebAudioHelper, 'createAudioContext').mockReturnValue({
            setSinkId: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined)
        } as unknown as AudioContext);

        await expect(WebAudioHelper.enumerateOutputDevices()).resolves.toEqual([]);
        expect(stop).toHaveBeenCalledOnce();
    });

    it('does not resurrect a worklet after playback is paused during asynchronous setup', async () => {
        let finishWorkletSetup!: () => void;
        const setup = new Promise<void>(resolve => {
            finishWorkletSetup = resolve;
        });
        BrowserUiFacade.createAlphaSynthAudioWorklet = vi.fn().mockReturnValue(setup);

        const source = {
            buffer: null,
            loop: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(() => {
                throw new Error('an unstarted source cannot be stopped');
            })
        };
        const context = {
            state: 'running',
            sampleRate: 44100,
            destination: {},
            createBuffer: vi.fn().mockReturnValue({}),
            createBufferSource: vi.fn().mockReturnValue(source),
            close: vi.fn().mockResolvedValue(undefined)
        } as unknown as AudioContext;
        const workletConstructor = vi.fn();
        vi.stubGlobal('AudioWorkletNode', workletConstructor);

        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        (output as unknown as { context: AudioContext }).context = context;

        output.play();
        expect(() => output.pause()).not.toThrow();
        finishWorkletSetup();
        await setup;
        await Promise.resolve();

        expect(source.stop).not.toHaveBeenCalled();
        expect(workletConstructor).not.toHaveBeenCalled();
    });

    it('reports worklet setup failures instead of leaving playback stuck', async () => {
        const failure = new Error('worklet module did not load');
        BrowserUiFacade.createAlphaSynthAudioWorklet = vi.fn().mockRejectedValue(failure);

        const source = {
            buffer: null,
            loop: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn()
        };
        const context = {
            state: 'running',
            sampleRate: 44100,
            destination: {},
            createBuffer: vi.fn().mockReturnValue({}),
            createBufferSource: vi.fn().mockReturnValue(source)
        } as unknown as AudioContext;
        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        (output as unknown as { context: AudioContext }).context = context;
        const failed = vi.fn();
        output.playbackFailed.on(failed);

        output.play();
        await Promise.resolve();
        await Promise.resolve();

        expect(failed).toHaveBeenCalledWith(failure);
        expect(source.disconnect).toHaveBeenCalledOnce();
    });

    it('only stops a Web Audio source after it has started', () => {
        const stop = vi.fn();
        const source = {
            buffer: null,
            loop: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop
        };
        const context = {
            state: 'running',
            sampleRate: 44100,
            createBuffer: vi.fn().mockReturnValue({}),
            createBufferSource: vi.fn().mockReturnValue(source)
        } as unknown as AudioContext;
        const output = Object.create(AlphaSynthWebAudioOutputBase.prototype) as AlphaSynthWebAudioOutputBase;
        (output as unknown as { context: AudioContext }).context = context;

        output.play();
        output.pause();

        expect(stop).not.toHaveBeenCalled();
    });

    it('replaces backing-track timers and releases media resources on destroy', async () => {
        let nextInterval = 0;
        let rejectFirstPlay!: (reason: Error) => void;
        const firstPlay = new Promise<void>((_resolve, reject) => {
            rejectFirstPlay = reject;
        });
        const clearInterval = vi.fn();
        vi.stubGlobal('window', {
            setInterval: vi.fn(() => ++nextInterval),
            clearInterval
        });
        vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
        const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const audioElement = {
            currentTime: 0,
            duration: 0,
            playbackRate: 1,
            volume: 1,
            src: '',
            play: vi.fn().mockReturnValueOnce(firstPlay).mockResolvedValueOnce(undefined),
            pause: vi.fn(),
            removeAttribute: vi.fn(),
            load: vi.fn(),
            remove: vi.fn()
        } as unknown as HTMLAudioElement;
        const output = new AudioElementBackingTrackSynthOutput();
        output.audioElement = audioElement;

        output.loadBackingTrack({ rawAudioFile: new Uint8Array([1]) } as never);
        output.loadBackingTrack({ rawAudioFile: new Uint8Array([2]) } as never);
        output.play();
        output.play();
        rejectFirstPlay(new Error('stale play request'));
        await Promise.resolve();

        expect(clearInterval).toHaveBeenCalledWith(1);
        expect(clearInterval).not.toHaveBeenCalledWith(2);
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first');

        output.destroy();

        expect(clearInterval).toHaveBeenCalledWith(2);
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second');
        expect(audioElement.pause).toHaveBeenCalledOnce();
        expect(audioElement.remove).toHaveBeenCalledOnce();
    });
});
