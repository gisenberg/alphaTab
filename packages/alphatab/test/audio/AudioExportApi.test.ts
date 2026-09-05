import { describe, expect, it, vi } from 'vitest';
import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { Settings } from '@coderline/alphatab/Settings';
import { AudioExportOptions } from '@coderline/alphatab/synth/IAudioExporter';

describe('audio export API boundary', () => {
    it('preserves DSP options while translating track controls to MIDI channels', async () => {
        // Direct exporter tests missed options silently dropped by the public API.
        const score = ScoreLoader.loadAlphaTex('\\tempo 120 . :4 C4');
        score.tracks[0].playbackInfo.primaryChannel = 4;
        score.tracks[0].playbackInfo.secondaryChannel = 5;
        const initialize = vi.fn(async () => {});
        const exporter = { initialize };
        const api = {
            score,
            settings: new Settings(),
            uiFacade: { createWorkerAudioExporter: () => exporter }
        } as unknown as AlphaTabApiBase<Settings>;
        const options = new AudioExportOptions();
        options.enablePeakLimiter = true;
        options.enableExperimentalGuitarAmp = true;
        options.releaseTailSeconds = 2;
        options.trackVolume.set(0, 1.5);
        options.trackTranspositionPitches.set(0, -2);
        await AlphaTabApiBase.prototype.exportAudio.call(api, options);
        expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
            enablePeakLimiter: true,
            enableExperimentalGuitarAmp: true,
            releaseTailSeconds: 2,
            trackVolume: new Map([[4, 1.5], [5, 1.5]]),
            trackTranspositionPitches: new Map([[4, -2], [5, -2]])
        }), expect.anything(), expect.anything(), expect.anything());
        expect(options.trackVolume).toEqual(new Map([[0, 1.5]]));
        expect(options.trackTranspositionPitches).toEqual(new Map([[0, -2]]));
    });
});
