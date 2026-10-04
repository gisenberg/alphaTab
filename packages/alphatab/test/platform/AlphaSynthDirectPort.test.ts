import { describe, expect, it, vi } from 'vitest';
import { SharedSampleBuffer } from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';
import { AlphaSynthWorkerSynthOutput } from '@coderline/alphatab/platform/worker/AlphaSynthWorkerSynthOutput';
import type {
    IAlphaSynthWorkerMessage,
    IAlphaTabWorkerGlobalScope
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';

describe('AlphaSynth direct worklet port', () => {
    it('keeps sample requests and payloads off the renderer-facing worker channel', async () => {
        const mainPost = vi.fn();
        let mainHandler: ((event: MessageEvent<IAlphaSynthWorkerMessage>) => void) | undefined;
        const main = {
            postMessage: mainPost,
            addEventListener: (_event: 'message', handler: (event: MessageEvent<IAlphaSynthWorkerMessage>) => void) => {
                mainHandler = handler;
            },
            removeEventListener: () => {}
        } as IAlphaTabWorkerGlobalScope<IAlphaSynthWorkerMessage>;
        const output = new AlphaSynthWorkerSynthOutput(main);
        output.open(0);
        output.play();
        mainPost.mockClear();
        expect(mainHandler).toBeDefined();

        const channel = new MessageChannel();
        output.attachDirectPort(channel.port1);
        const request = new Promise<void>(resolve => output.sampleRequest.on(resolve));
        channel.port2.postMessage({ cmd: 'alphaSynth.output.sampleRequest' } satisfies IAlphaSynthWorkerMessage);
        await request;

        const payload = new Promise<IAlphaSynthWorkerMessage>(resolve => {
            channel.port2.addEventListener('message', event => resolve(event.data));
            channel.port2.start();
        });
        output.addSamples(new Float32Array([0.25, -0.25]));

        expect(await payload).toMatchObject({ cmd: 'alphaSynth.output.addSamples' });
        expect(mainPost).not.toHaveBeenCalled();
        channel.port2.close();
        output.destroy();
    });
    it('isolates resumed shared audio from a disconnected processor still draining its old ring', () => {
        const messages: IAlphaSynthWorkerMessage[] = [];
        const main = { postMessage: (message: IAlphaSynthWorkerMessage) => messages.push(message), removeEventListener: vi.fn(), addEventListener: vi.fn() } as IAlphaTabWorkerGlobalScope<IAlphaSynthWorkerMessage>;
        const initial = SharedSampleBuffer.create(4096);
        const output = new AlphaSynthWorkerSynthOutput(main, initial.descriptor);
        const start = () => {
            output.play();
            const message = messages[messages.length - 1]!;
            if (message.cmd !== 'alphaSynth.output.play' || !message.sharedSampleBuffer) {
                throw new Error('Missing playback transport');
            }
            return SharedSampleBuffer.fromDescriptor(message.sharedSampleBuffer);
        };
        const previous = start();
        output.addSamples(new Float32Array([0.1, 0.2]));
        output.pause();
        const current = start();
        output.addSamples(new Float32Array([0.3, 0.4]));
        const drained = new Float32Array(2);
        previous.read(drained, 0, drained.length);
        expect(current.countSamples).toBe(2);
        current.read(drained, 0, drained.length);
        expect(Array.from(drained)).toEqual(Array.from(new Float32Array([0.3, 0.4])));
        output.destroy();
    });

    it('rejects stale refill, progress and port attachment after a rapid pause/play', () => {
        const messages: IAlphaSynthWorkerMessage[] = [];
        let handler!: (event: MessageEvent<IAlphaSynthWorkerMessage>) => void;
        const main = {
            postMessage: (message: IAlphaSynthWorkerMessage) => messages.push(message),
            addEventListener: (_name: string, listener: typeof handler) => { handler = listener; },
            removeEventListener: vi.fn()
        } as IAlphaTabWorkerGlobalScope<IAlphaSynthWorkerMessage>;
        const output = new AlphaSynthWorkerSynthOutput(main);
        output.open(0);
        const requests = vi.fn();
        const progress = vi.fn();
        output.sampleRequest.on(requests);
        output.samplesPlayed.on(progress);
        output.play();
        const oldPlay = messages[messages.length - 1]!;
        if (oldPlay.cmd !== 'alphaSynth.output.play') { throw new Error('Missing play'); }
        output.pause();
        output.play();
        const play = messages[messages.length - 1]!;
        if (play.cmd !== 'alphaSynth.output.play') { throw new Error('Missing play'); }
        const dispatch = (data: IAlphaSynthWorkerMessage) => handler({ data } as MessageEvent<IAlphaSynthWorkerMessage>);
        dispatch({ cmd: 'alphaSynth.output.sampleRequest', playbackGeneration: oldPlay.playbackGeneration });
        dispatch({ cmd: 'alphaSynth.output.samplesPlayed', samples: 4096, playbackGeneration: oldPlay.playbackGeneration });
        const stale = { close: vi.fn(), addEventListener: vi.fn() } as unknown as MessagePort;
        output.attachDirectPort(stale, oldPlay.playbackGeneration);
        expect(stale.close).toHaveBeenCalledOnce();
        expect(stale.addEventListener).not.toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
        dispatch({ cmd: 'alphaSynth.output.sampleRequest', playbackGeneration: play.playbackGeneration });
        dispatch({ cmd: 'alphaSynth.output.samplesPlayed', samples: 128, playbackGeneration: play.playbackGeneration });
        expect(requests).toHaveBeenCalledOnce();
        expect(progress).toHaveBeenCalledExactlyOnceWith(128);
        output.destroy();
    });

    it('sends resets to the lifecycle channel after the paused direct port is retired', () => {
        const mainPost = vi.fn();
        const main = { postMessage: mainPost, removeEventListener: vi.fn(), addEventListener: vi.fn() } as IAlphaTabWorkerGlobalScope<IAlphaSynthWorkerMessage>;
        const output = new AlphaSynthWorkerSynthOutput(main);
        const port = { postMessage: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), start: vi.fn() } as unknown as MessagePort;
        output.play();
        output.attachDirectPort(port);
        output.pause();
        mainPost.mockClear();
        output.resetSamples();
        expect(mainPost).toHaveBeenCalledExactlyOnceWith({ cmd: 'alphaSynth.output.resetSamples' });
        expect(port.postMessage).not.toHaveBeenCalled();
        output.destroy();
    });

});
