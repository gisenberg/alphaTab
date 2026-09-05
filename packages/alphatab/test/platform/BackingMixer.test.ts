import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@coderline/alphatab/Settings';
import { AudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';
import { BrowserUiFacade } from '@coderline/alphatab/platform/javascript/BrowserUiFacade';
const originalFactory = BrowserUiFacade.createAlphaSynthAudioWorklet;

function setup() {
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const master = { ...node(), gain: { setValueAtTime: vi.fn() } };
    const media = node();
    const mixer = {
        ...node(), addEventListener: vi.fn(),
        port: { postMessage: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), start: vi.fn() }
    };
    const context = {
        sampleRate: 48000, currentTime: 0, baseLatency: 0.01, outputLatency: 0.02,
        destination: {}, state: 'running', sinkId: '',
        setSinkId: vi.fn().mockResolvedValue(undefined),
        createGain: () => master,
        createBuffer: (_channels: number, frames: number) => ({ getChannelData: () => new Float32Array(frames) }),
        createMediaElementSource: vi.fn(() => media),
        close: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined)
    };
    vi.stubGlobal('AudioContext', vi.fn(function () { return context; }));
    vi.stubGlobal('AudioWorkletNode', vi.fn(function () { return mixer; }));
    vi.stubGlobal('window', { clearTimeout: vi.fn(), clearInterval: vi.fn() });
    const factory = vi.fn().mockResolvedValue(undefined);
    BrowserUiFacade.createAlphaSynthAudioWorklet = factory;
    const settings = new Settings();
    settings.player.enablePeakLimiter = true;
    const output = new AudioElementBackingTrackSynthOutput(settings);
    const element = {
        volume: 1, currentTime: 1, playbackRate: 0.5, ended: false, paused: false,
        pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
        removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn(), setSinkId: vi.fn()
    };
    output.audioElement = element as unknown as HTMLAudioElement;
    const initialize = () => (output as unknown as { _initializeMixer(): Promise<void> })._initializeMixer();
    return { output, initialize, element, context, master, media, mixer, factory };
}

describe('protected backing mix output', () => {
    it.each(['suspended', 'interrupted'])('resumes a %s backing context', async state => {
        const { output, initialize, context } = setup();
        await initialize();
        context.state = state;
        output.activate();
        expect(context.resume).toHaveBeenCalledOnce();
        output.destroy();
    });

    it.each(['reject', 'throw'])('pauses and reports resume failure through the playback error path (%s)', async mode => {
        const { output, initialize, context, element } = setup();
        await initialize();
        const failure = new Error('Output device unavailable');
        context.state = 'suspended';
        if (mode === 'reject') {
            context.resume.mockRejectedValueOnce(failure);
        } else {
            context.resume.mockImplementationOnce(() => { throw failure; });
        }
        const failed = vi.fn();
        output.playbackFailed.on(failed);
        output.activate();
        await Promise.resolve();
        expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
        expect(element.pause).toHaveBeenCalledOnce();
        expect(output.outputLevel).toBeNull();
        output.destroy();
    });

    it.each(['retry', 'pause', 'destroy'])('ignores a stale resume rejection after %s', async action => {
        const { output, initialize, context, element } = setup();
        await initialize();
        context.state = 'suspended';
        let reject!: (error: Error) => void;
        context.resume.mockReturnValueOnce(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
        const failed = vi.fn();
        output.playbackFailed.on(failed);
        output.activate();
        if (action === 'retry') {
            context.state = 'running';
            output.activate();
        } else if (action === 'pause') {
            output.pause();
        } else {
            output.destroy();
        }
        const pauseCount = element.pause.mock.calls.length;
        reject(new Error('Old resume failed'));
        await Promise.resolve();
        expect(failed).not.toHaveBeenCalled();
        expect(element.pause).toHaveBeenCalledTimes(pauseCount);
        if (action !== 'destroy') {
            output.destroy();
        }
    });

    it('ignores late output levels after pause', async () => {
        const { output, initialize, mixer } = setup();
        await initialize();
        const handler = mixer.port.addEventListener.mock.calls.find(call => call[0] === 'message')![1];
        const event = { data: { cmd: 'alphaSynth.output.level', level: { peak: 0.5, rms: 0.25 } } };
        // Count-in is audible even while the media element itself is paused.
        vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn(), clearInterval: vi.fn() });
        output.playAfterCountIn(1000);
        handler(event);
        expect(output.outputLevel).toEqual(event.data.level);
        output.pause();
        handler(event);
        expect(output.outputLevel).toBeNull();
        output.destroy();
    });

    afterEach(() => {
        vi.restoreAllMocks(); vi.unstubAllGlobals();
        BrowserUiFacade.createAlphaSynthAudioWorklet = originalFactory;
    });

    it('routes media and the click master through one limiter and never attenuates media twice', async () => {
        const { output, initialize, element, context, master, media, mixer } = setup();
        const ready = vi.fn();
        output.ready.on(ready);
        output.masterVolume = 0.5;
        await initialize();
        expect(ready).toHaveBeenCalledOnce();
        expect(media.connect).toHaveBeenCalledExactlyOnceWith(master);
        expect(master.connect).toHaveBeenCalledExactlyOnceWith(mixer);
        expect(mixer.connect).toHaveBeenCalledExactlyOnceWith(context.destination);
        expect(element.volume).toBe(1);
        expect(master.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 0);
        output.masterVolume = 2;
        expect(element.volume).toBe(1);
        expect(output.masterVolume).toBe(2);
        expect(master.gain.setValueAtTime).toHaveBeenLastCalledWith(2, 0);
        output.masterVolume = 0;
        expect(master.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
        expect(output.outputLatencyMilliseconds).toBeCloseTo(33);
        output.destroy();
        expect(media.disconnect).toHaveBeenCalledOnce();
        expect(mixer.disconnect).toHaveBeenCalledOnce();
        expect(mixer.port.close).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
    });

    it('fails closed when worklet initialization fails, without reporting ready or playing unprotected media', async () => {
        const { output, initialize, factory, master, element } = setup();
        factory.mockRejectedValueOnce(new Error('worklet unavailable'));
        const failed = vi.fn();
        const ready = vi.fn();
        output.playbackFailed.on(failed);
        output.ready.on(ready);
        await initialize();
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'worklet unavailable' }));
        expect(ready).not.toHaveBeenCalled();
        expect(master.connect).not.toHaveBeenCalled();
        output.play();
        expect(element.play).not.toHaveBeenCalled();
        output.destroy();
    });

    it('does not resurrect output when destroyed while the module is loading', async () => {
        const { output, initialize, factory, master, context } = setup();
        let finish!: () => void;
        factory.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
        const ready = vi.fn();
        output.ready.on(ready);
        const initializing = initialize();
        output.destroy();
        finish();
        await initializing;
        expect(ready).not.toHaveBeenCalled();
        expect(master.connect).not.toHaveBeenCalled();
        expect(context.close).toHaveBeenCalledOnce();
    });

    it('does not restart media through a processor that has failed', async () => {
        const { output, initialize, mixer, element } = setup();
        await initialize();
        const failed = vi.fn();
        output.playbackFailed.on(failed);
        const handler = mixer.addEventListener.mock.calls.find(call => call[0] === 'processorerror')![1];
        handler();
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Backing output limiter failed' }));
        output.play();
        expect(element.play).not.toHaveBeenCalled();
        output.destroy();
    });

    it('changes the shared context sink, leaving no independent media routing to drift', async () => {
        const { output, initialize, context, element } = setup();
        await initialize();
        await output.setOutputDevice({ deviceId: 'interface', label: 'Interface', isDefault: false });
        expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith('interface');
        expect(element.setSinkId).not.toHaveBeenCalled();
        output.destroy();
    });

    it('clears lookahead on pause/seek and reports the delayed musical position at slowed playback', async () => {
        const { output, initialize, mixer } = setup();
        await initialize();
        const position = vi.fn();
        output.timeUpdate.on(position);
        (output as unknown as { _updatePosition(): void })._updatePosition();
        expect(position).toHaveBeenLastCalledWith(998.5);
        output.seekTo(4000);
        output.pause();
        expect(mixer.port.postMessage).toHaveBeenCalledTimes(2);
        expect(mixer.port.postMessage).toHaveBeenLastCalledWith({ cmd: 'alphaSynth.output.resetSamples' });
        output.destroy();
    });

    it('reaches the exact endpoint after draining lookahead rather than getting stuck just before EOF', async () => {
        const { output, initialize, element, context } = setup();
        await initialize();
        const position = vi.fn();
        output.timeUpdate.on(position);
        element.ended = true;
        element.paused = true;
        const update = () => (output as unknown as { _updatePosition(): void })._updatePosition();
        update();
        expect(position).toHaveBeenLastCalledWith(998.5);
        context.currentTime += 0.01;
        update();
        expect(position).toHaveBeenLastCalledWith(1000);
        element.ended = false;
        output.seekTo(4000);
        update();
        expect(position).toHaveBeenLastCalledWith(4000);
        output.destroy();
    });
});
