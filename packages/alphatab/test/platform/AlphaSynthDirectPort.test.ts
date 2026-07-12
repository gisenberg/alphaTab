import { describe, expect, it, vi } from 'vitest';
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
});
