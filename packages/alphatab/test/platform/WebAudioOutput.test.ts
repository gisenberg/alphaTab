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
    it.each(['suspended', 'interrupted'])('completes successful synth resume from %s', async state => {
        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        const context = { state, resume: vi.fn().mockResolvedValue(undefined) };
        (output as unknown as { context: AudioContext }).context = context as unknown as AudioContext;
        const completed = vi.fn();
        output.activate(completed);
        await Promise.resolve();
        expect(context.resume).toHaveBeenCalledOnce();
        expect(completed).toHaveBeenCalledOnce();
        expect(output.playbackDiagnostics.playbackFailureCount).toBe(0);
    });

    it.each(['retry', 'pause', 'destroy'])('ignores stale synth resume completion and failure after %s', async action => {
        for (const rejectResult of [false, true]) {
            const output = new AlphaSynthAudioWorkletOutput(new Settings());
            let resolve!: () => void;
            let reject!: (error: Error) => void;
            const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            const context = { state: 'suspended', resume: vi.fn().mockReturnValue(pending), close: vi.fn().mockResolvedValue(undefined) };
            (output as unknown as { context: AudioContext }).context = context as unknown as AudioContext;
            const failed = vi.fn();
            const completed = vi.fn();
            output.playbackFailed.on(failed);
            output.activate(completed);
            if (action === 'retry') {
                context.state = 'running';
                output.activate();
            } else if (action === 'pause') {
                output.pause();
            } else {
                output.destroy();
            }
            if (rejectResult) {
                reject(new Error('Old resume failure'));
            } else {
                resolve();
            }
            await Promise.resolve();
            expect(failed).not.toHaveBeenCalled();
            expect(completed).not.toHaveBeenCalled();
            expect(output.playbackDiagnostics.playbackFailureCount).toBe(0);
        }
    });

    it('cancels source setup when resume throws synchronously during play', async () => {
        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        BrowserUiFacade.createAlphaSynthAudioWorklet = vi.fn().mockReturnValue(new Promise<void>(() => {}));
        const source = { disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        const context = {
            state: 'suspended', sampleRate: 44100,
            resume: vi.fn(() => { throw new Error('Resume threw'); }),
            createBuffer: vi.fn().mockReturnValue({}), createBufferSource: vi.fn().mockReturnValue(source)
        };
        (output as unknown as { context: AudioContext }).context = context as unknown as AudioContext;
        const failed = vi.fn();
        output.playbackFailed.on(failed);
        expect(() => output.play()).not.toThrow();
        await Promise.resolve();
        expect(source.disconnect).toHaveBeenCalledOnce();
        expect(source.start).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Resume threw' }));
    });

    it('reports a rejected synth context resume instead of silently continuing playback', async () => {
        const output = new AlphaSynthAudioWorkletOutput(new Settings());
        const failure = new Error('Audio device could not resume');
        const context = { state: 'suspended', resume: vi.fn().mockRejectedValue(failure) };
        (output as unknown as { context: AudioContext }).context = context as unknown as AudioContext;
        const failed = vi.fn();
        const paused = vi.spyOn(output, 'pause');
        output.playbackFailed.on(failed);
        output.activate();
        await Promise.resolve();
        expect(paused).toHaveBeenCalledOnce();
        expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
        expect(output.playbackDiagnostics.playbackFailureCount).toBe(1);
        expect(output.playbackDiagnostics.lastPlaybackFailure).toBe(failure.message);
    });

    it.each([0.5, 0.75, 1, 1.5, 2])('schedules backing clicks in wall time at playback rate %s', rate => {
        const output = new AudioElementBackingTrackSynthOutput();
        output.audioElement = { currentTime: 1, playbackRate: 1, volume: 1 } as HTMLAudioElement;
        output.seekTo(1000);
        output.playbackRate = rate;
        const schedule = vi
            .spyOn(
                output as unknown as {
                    _scheduleClick(delay: number, accent: boolean, volume: number): void;
                },
                '_scheduleClick'
            )
            .mockImplementation(() => {});

        // A beat 500 ms ahead on the recording is 1 s away when practicing at half speed.
        output.scheduleMetronomeClick(1500, true, 0.4);
        expect(schedule).toHaveBeenLastCalledWith(0.5 / rate, true, 0.4);
        // Count-in offsets already use wall time and must not be scaled a second time.
        output.scheduleCountInClick(500, false, 0.4);
        expect(schedule).toHaveBeenLastCalledWith(0.5, false, 0.4);
        schedule.mockClear();
        output.scheduleMetronomeClick(1000 - 100 * rate, false, 0.4);
        expect(schedule).not.toHaveBeenCalled();
        output.scheduleMetronomeClick(1000 - 40 * rate, false, 0.4);
        expect(schedule).toHaveBeenCalledWith(0, false, 0.4);
    });

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

    it('sets a synth output device without creating a capability-probe context', async () => {
        const setSinkId = vi.fn().mockResolvedValue(undefined);
        const createAudioContext = vi.spyOn(WebAudioHelper, 'createAudioContext');
        const output = Object.create(AlphaSynthWebAudioOutputBase.prototype) as AlphaSynthWebAudioOutputBase;
        (output as unknown as { context: AudioContext }).context = { setSinkId } as unknown as AudioContext;

        await output.setOutputDevice({ deviceId: 'speaker-1', label: 'Speaker', isDefault: false });

        expect(setSinkId).toHaveBeenCalledWith('speaker-1');
        expect(createAudioContext).not.toHaveBeenCalled();
    });

    it('sets a backing-track output device on its media element without a capability probe', async () => {
        const setSinkId = vi.fn().mockResolvedValue(undefined);
        const createAudioContext = vi.spyOn(WebAudioHelper, 'createAudioContext');
        const output = new AudioElementBackingTrackSynthOutput();
        output.audioElement = { setSinkId } as unknown as HTMLAudioElement;
        const clickSetSinkId = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(output as unknown as { _ensureClickContext(): AudioContext }, '_ensureClickContext').mockReturnValue({
            setSinkId: clickSetSinkId,
            sinkId: ''
        } as unknown as AudioContext);

        await output.setOutputDevice({ deviceId: 'speaker-1', label: 'Speaker', isDefault: false });

        expect(setSinkId).toHaveBeenCalledWith('speaker-1');
        expect(clickSetSinkId).toHaveBeenCalledWith('speaker-1');
        expect(createAudioContext).not.toHaveBeenCalled();
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
        expect(output.playbackDiagnostics).toMatchObject({
            outputMode: 'unknown',
            playbackFailureCount: 1,
            lastPlaybackFailure: failure.message
        });

        output.resetPlaybackDiagnostics();
        expect(output.playbackDiagnostics).toMatchObject({
            playbackFailureCount: 0,
            lastPlaybackFailure: null
        });
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
