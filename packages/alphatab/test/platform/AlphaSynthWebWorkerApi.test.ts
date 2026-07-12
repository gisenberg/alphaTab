import { describe, expect, it, vi } from 'vitest';
import { EventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { Settings } from '@coderline/alphatab/Settings';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import { AlphaSynthWebWorkerApi } from '@coderline/alphatab/platform/worker/AlphaSynthWebWorkerApi';
import type { IAlphaSynthWorker } from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { TestOutput } from 'test/audio/TestOutput';

describe('AlphaSynthWebWorkerApi', () => {
    it('returns the last loaded MIDI metadata without recursing', () => {
        const api = Object.create(AlphaSynthWebWorkerApi.prototype) as AlphaSynthWebWorkerApi;
        const loaded = new PositionChangedEventArgs(0, 1000, 0, 960, false, 120, 120);
        Reflect.set(api, '_loadedMidiInfo', loaded);

        expect(api.loadedMidiInfo).toBe(loaded);
    });

    it('pauses the synth worker when the audio output fails', () => {
        const output = new TestOutput();
        const playbackFailed = new EventEmitterOfT<Error>();
        Reflect.set(output, 'playbackFailed', playbackFailed);
        const postMessage = vi.fn();
        const worker = {
            postMessage,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            terminate: vi.fn()
        } as unknown as IAlphaSynthWorker;
        new AlphaSynthWebWorkerApi(output, new Settings(), worker);
        postMessage.mockClear();

        playbackFailed.trigger(new Error('audio output failed'));

        expect(postMessage).toHaveBeenCalledWith({ cmd: 'alphaSynth.pause' });
    });
});
