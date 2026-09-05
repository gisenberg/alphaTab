import { describe, expect, it, vi } from 'vitest';
import { EventEmitterOfT } from '@coderline/alphatab/EventEmitter';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';
import { AlphaTabMetronomeEvent } from '@coderline/alphatab/midi/MidiEvent';
import { Settings } from '@coderline/alphatab/Settings';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';
import {
    AlphaSynthWebWorkerApi,
    SoundFontBankSupersededError
} from '@coderline/alphatab/platform/worker/AlphaSynthWebWorkerApi';
import type {
    IAlphaSynthWorker,
    IAlphaSynthWorkerMessage
} from '@coderline/alphatab/platform/worker/AlphaTabWorkerProtocol';
import { TestOutput } from 'test/audio/TestOutput';

class FakeSynthWorker implements IAlphaSynthWorker {
    public readonly postedMessages: IAlphaSynthWorkerMessage[] = [];
    private _listener?: (event: MessageEvent<IAlphaSynthWorkerMessage>) => void;

    public postMessage(message: IAlphaSynthWorkerMessage): void {
        this.postedMessages.push(message);
    }

    public addEventListener(_event: 'message', handler: (event: MessageEvent<IAlphaSynthWorkerMessage>) => void): void {
        this._listener = handler;
    }

    public removeEventListener(): void {}
    public terminate(): void {}

    public dispatch(message: IAlphaSynthWorkerMessage): void {
        this._listener?.({ data: message } as MessageEvent<IAlphaSynthWorkerMessage>);
    }
}

describe('AlphaSynthWebWorkerApi', () => {
    it('passes peak protection to the synthesis worker after settings serialization', () => {
        const settings = new Settings();
        settings.player.enablePeakLimiter = true;
        settings.player.enableExperimentalGuitarAmp = true;
        settings.player.releaseTailSeconds = 2;
        const restored = JsonConverter.jsObjectToSettings(JsonConverter.settingsToJsObject(settings));
        const worker = new FakeSynthWorker();
        new AlphaSynthWebWorkerApi(new TestOutput(), restored, worker);
        expect(worker.postedMessages).toContainEqual(expect.objectContaining({
            cmd: 'alphaSynth.initialize', enablePeakLimiter: true, enableExperimentalGuitarAmp: true,
            releaseTailSeconds: 2
        }));
    });

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

    it('preserves played-event playback times across the worker boundary', () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);
        const received = vi.fn();
        api.midiEventsPlayed.on(received);

        worker.dispatch({
            cmd: 'alphaSynth.midiEventsPlayed',
            events: [JsonConverter.midiEventToJsObject(new AlphaTabMetronomeEvent(0, 960, 1, 960, 500))],
            eventTimes: [1250],
            currentTime: 1200,
            isCountIn: true
        });

        expect(received).toHaveBeenCalledOnce();
        expect(received.mock.calls[0][0].events[0].tick).toBe(960);
        expect(received.mock.calls[0][0].eventTimes).toEqual([1250]);
        expect(received.mock.calls[0][0].currentTime).toBe(1200);
        expect(received.mock.calls[0][0].isCountIn).toBe(true);
    });

    it('correlates an atomic SoundFont bank response to its request', async () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);

        const operation = api.loadSoundFontBankAsync([new Uint8Array([1, 2, 3])]);
        await vi.waitFor(() => {
            expect(worker.postedMessages.some(message => message.cmd === 'alphaSynth.replaceSoundFontBank')).toBe(true);
        });
        const request = worker.postedMessages.find(message => message.cmd === 'alphaSynth.replaceSoundFontBank');
        if (!request || request.cmd !== 'alphaSynth.replaceSoundFontBank') {
            throw new Error('missing SoundFont bank request');
        }

        worker.dispatch({
            cmd: 'alphaSynth.soundFontLoaded',
            requestId: request.requestId,
            generation: request.generation,
            cacheKeys: request.soundFonts.map(soundFont => soundFont.cacheKey)
        });

        await expect(operation).resolves.toBeUndefined();
    });

    it('loads URL banks in the synth worker without UI-thread buffers', async () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);

        const operation = api.loadSoundFontBankFromUrls(['/soundfont/base.sf2', '/soundfont/overlay.sf2']);
        const request = worker.postedMessages.find(message => message.cmd === 'alphaSynth.replaceSoundFontBankFromUrls');
        if (!request || request.cmd !== 'alphaSynth.replaceSoundFontBankFromUrls') {
            throw new Error('missing URL SoundFont bank request');
        }
        expect(request.urls).toEqual(['/soundfont/base.sf2', '/soundfont/overlay.sf2']);

        worker.dispatch({
            cmd: 'alphaSynth.soundFontLoaded',
            requestId: request.requestId,
            generation: request.generation,
            cacheKeys: ['base-hash', 'overlay-hash']
        });

        await expect(operation).resolves.toBeUndefined();
    });

    it('supersedes an older bank request before it can become current', async () => {
        const worker = new FakeSynthWorker();
        const api = new AlphaSynthWebWorkerApi(new TestOutput(), new Settings(), worker);

        const older = api.loadSoundFontBankAsync([new Uint8Array([1])]);
        const newer = api.loadSoundFontBankAsync([new Uint8Array([2])]);

        await expect(older).rejects.toBeInstanceOf(SoundFontBankSupersededError);
        await vi.waitFor(() => {
            expect(
                worker.postedMessages.filter(message => message.cmd === 'alphaSynth.replaceSoundFontBank')
            ).toHaveLength(1);
        });
        const request = worker.postedMessages.find(message => message.cmd === 'alphaSynth.replaceSoundFontBank');
        if (!request || request.cmd !== 'alphaSynth.replaceSoundFontBank') {
            throw new Error('missing replacement request');
        }
        worker.dispatch({
            cmd: 'alphaSynth.soundFontLoaded',
            requestId: request.requestId,
            generation: request.generation,
            cacheKeys: request.soundFonts.map(soundFont => soundFont.cacheKey)
        });
        await expect(newer).resolves.toBeUndefined();
    });
});
