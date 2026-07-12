import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlphaSynthWebWorklet } from '@coderline/alphatab/platform/javascript/AlphaSynthWebWorklet';
import { SharedSampleBuffer } from '@coderline/alphatab/platform/javascript/SharedSampleBuffer';
import type { IAlphaSynthWorkerMessage } from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';

class FakeMessagePort {
    public readonly postedMessages: IAlphaSynthWorkerMessage[] = [];
    private _listener: ((event: MessageEvent<IAlphaSynthWorkerMessage>) => void) | undefined;

    public addEventListener(_type: string, listener: (event: MessageEvent<IAlphaSynthWorkerMessage>) => void): void {
        this._listener = listener;
    }

    public start(): void {}

    public postMessage(message: IAlphaSynthWorkerMessage): void {
        this.postedMessages.push(message);
    }

    public dispatch(message: IAlphaSynthWorkerMessage): void {
        this._listener?.({ data: message } as MessageEvent<IAlphaSynthWorkerMessage>);
    }
}

describe('AlphaSynthWebWorklet', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        (AlphaSynthWebWorklet as unknown as Record<string, unknown>)['_isRegistered'] = false;
    });

    it('does not duplicate in-flight refill requests across rapid resets', () => {
        const port = new FakeMessagePort();
        let Processor!: new (options: AudioWorkletNodeOptions) => { port: FakeMessagePort };

        class FakeAudioWorkletProcessor {
            public readonly port = port;
        }

        vi.stubGlobal('sampleRate', 48000);
        vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
        vi.stubGlobal(
            'registerProcessor',
            (_name: string, processor: new (options: AudioWorkletNodeOptions) => { port: FakeMessagePort }) => {
                Processor = processor;
            }
        );

        AlphaSynthWebWorklet.init();
        new Processor({ processorOptions: { bufferTimeInMilliseconds: 500 } });

        port.dispatch({ cmd: 'alphaSynth.output.resetSamples' });
        const firstRefillCount = port.postedMessages.filter(
            message => message.cmd === 'alphaSynth.output.sampleRequest'
        ).length;

        // Regression: resetting the request counter here used to enqueue a second
        // six-buffer refill while the first six requests were still in flight.
        port.dispatch({ cmd: 'alphaSynth.output.resetSamples' });
        const secondRefillCount = port.postedMessages.filter(
            message => message.cmd === 'alphaSynth.output.sampleRequest'
        ).length;

        expect(firstRefillCount).toBe(6);
        expect(secondRefillCount).toBe(firstRefillCount);
    });

    it('reads worker-produced samples directly from shared memory', () => {
        const port = new FakeMessagePort();
        let Processor!: new (
            options: AudioWorkletNodeOptions
        ) => {
            port: FakeMessagePort;
            process(
                inputs: Float32Array[][],
                outputs: Float32Array[][],
                parameters: Record<string, Float32Array>
            ): boolean;
        };

        class FakeAudioWorkletProcessor {
            public readonly port = port;
        }

        vi.stubGlobal('sampleRate', 48000);
        vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
        vi.stubGlobal(
            'registerProcessor',
            (
                _name: string,
                processor: new (
                    options: AudioWorkletNodeOptions
                ) => {
                    port: FakeMessagePort;
                    process(
                        inputs: Float32Array[][],
                        outputs: Float32Array[][],
                        parameters: Record<string, Float32Array>
                    ): boolean;
                }
            ) => {
                Processor = processor;
            }
        );

        const shared = SharedSampleBuffer.create(4096);
        AlphaSynthWebWorklet.init();
        const processor = new Processor({
            processorOptions: {
                bufferTimeInMilliseconds: 500,
                sharedSampleBuffer: shared.descriptor
            }
        });

        shared.write(new Float32Array([0.1, 0.2, 0.3, 0.4]));
        const left = new Float32Array(2);
        const right = new Float32Array(2);
        processor.process([], [[left, right]], {});

        expect(left[0]).toBeCloseTo(0.1);
        expect(left[1]).toBeCloseTo(0.3);
        expect(right[0]).toBeCloseTo(0.2);
        expect(right[1]).toBeCloseTo(0.4);
        expect(shared.countSamples).toBe(0);
        expect(port.postedMessages.some(message => message.cmd === 'alphaSynth.output.addSamples')).toBe(false);
    });
});
