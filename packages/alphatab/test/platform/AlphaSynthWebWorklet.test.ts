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
    it('registers the post-mix limiter as a separate input-processing worklet', () => {
        const processors = new Map<string, new () => {
            port: FakeMessagePort;
            process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
        }>();
        vi.stubGlobal('sampleRate', 48000);
        vi.stubGlobal('AudioWorkletProcessor', class { public readonly port = new FakeMessagePort(); });
        vi.stubGlobal('registerProcessor', (name: string, processor: new () => {
            port: FakeMessagePort;
            process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
        }) => processors.set(name, processor));
        AlphaSynthWebWorklet.init();
        expect(processors.has('alphatab')).toBe(true);
        const Mixer = processors.get('alphatab-mixer')!;
        const mixer = new Mixer();
        const input = [[new Float32Array(512).fill(0.1), new Float32Array(512).fill(0.2)]];
        const output = [[new Float32Array(512), new Float32Array(512)]];
        expect(mixer.process(input, output)).toBe(true);
        expect(output[0][0][511]).toBe(input[0][0][511]);
        expect(output[0][1][511]).toBe(input[0][1][511]);
        expect(mixer.process([], output)).toBe(true);
    });

    it('reports post-limiter PCM levels rather than overloaded input levels', () => {
        type Processor = { port: FakeMessagePort; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
        const processors = new Map<string, new () => Processor>();
        vi.stubGlobal('sampleRate', 48000);
        vi.stubGlobal('AudioWorkletProcessor', class { public readonly port = new FakeMessagePort(); });
        vi.stubGlobal('registerProcessor', (name: string, processor: new () => Processor) => processors.set(name, processor));
        AlphaSynthWebWorklet.init();
        const Mixer = processors.get('alphatab-mixer')!;
        const mixer = new Mixer();
        const input = [[new Float32Array(128).fill(3), new Float32Array(128).fill(-2)]];
        const output = [[new Float32Array(128), new Float32Array(128)]];
        let peak = 0;
        let power = 0;
        let frames = 0;
        let reports = 0;
        for (let quantum = 0; quantum < 80; quantum++) {
            mixer.process(input, output);
            for (let i = 0; i < 128; i++) {
                const left = output[0][0][i];
                const right = output[0][1][i];
                peak = Math.max(peak, Math.abs(left), Math.abs(right));
                power += left * left + right * right;
                frames++;
            }
            const message = mixer.port.postedMessages.pop();
            if (message?.cmd === 'alphaSynth.output.level') {
                expect(message.level.peak).toBe(peak);
                expect(message.level.rms).toBe(Math.sqrt(power / (frames * 2)));
                // The overloaded source must not be mistaken for the protected output.
                expect(message.level.peak).toBeLessThan(1);
                expect(message.level.peak).toBeGreaterThan(0);
                peak = 0; power = 0; frames = 0; reports++;
            }
        }
        expect(reports).toBe(2);
    });

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

        // Regression: measuring queued samples would omit output silence after starvation.
        const initialPower = left[0] ** 2 + right[0] ** 2 + left[1] ** 2 + right[1] ** 2;
        const initialPeak = Math.max(...left, ...right);
        const silentOutput = [[new Float32Array(128), new Float32Array(128)]];
        for (let quantum = 0; quantum < 38; quantum++) {
            processor.process([], silentOutput, {});
        }
        const levels = port.postedMessages.filter(message => message.cmd === 'alphaSynth.output.level');
        expect(levels).toHaveLength(1);
        expect(levels[0].level.peak).toBe(initialPeak);
        expect(levels[0].level.rms).toBeCloseTo(Math.sqrt(initialPower / ((2 + 38 * 128) * 2)), 12);
    });
});
