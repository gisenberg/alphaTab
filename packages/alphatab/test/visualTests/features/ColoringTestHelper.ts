import { BarStyle, BarSubElement } from '@coderline/alphatab/model/Bar';
import { BeatStyle, BeatSubElement } from '@coderline/alphatab/model/Beat';
import { Color } from '@coderline/alphatab/model/Color';
import { NoteStyle, NoteSubElement } from '@coderline/alphatab/model/Note';
import { type Score, ScoreStyle, ScoreSubElement } from '@coderline/alphatab/model/Score';
import { TrackStyle, TrackSubElement } from '@coderline/alphatab/model/Track';
import { VoiceStyle, VoiceSubElement } from '@coderline/alphatab/model/Voice';
import { TestPlatform } from 'test/TestPlatform';

export function enableTestColoring(score: Score): void {
    const shuffledHues = [
        0.38, 0.88, 0.04, 0, 0.08, 0.36, 0.48, 0.94, 0.64, 0.72, 0.76, 0.34, 0.44, 0.02, 0.56, 0.1, 0.7,
        0.66, 0.96, 0.68, 0.16, 0.5, 0.46, 0.3, 0.4, 0.26, 0.92, 0.2, 0.24, 0.42, 0.58, 0.74, 0.8, 0.84, 0.22,
        0.32, 0.28, 0.12, 0.9, 0.18, 0.14, 0.54, 0.6, 0.62, 0.86, 0.52, 0.78, 0.82, 0.06, 0.98
    ];
    let hueIndex = 0;
    let saturation = 1;
    let lightness = 0.5;

    function hueToRgb(p: number, q: number, t: number): number {
        if (t < 0) {
            t += 1;
        }
        if (t > 1) {
            t -= 1;
        }
        if (t < 1 / 6) {
            return p + (q - p) * 6 * t;
        }
        if (t < 1 / 2) {
            return q;
        }
        if (t < 2 / 3) {
            return p + (q - p) * (2 / 3 - t) * 6;
        }
        return p;
    }

    function nextColor(): Color {
        hueIndex++;
        if (hueIndex >= shuffledHues.length) {
            hueIndex = 0;
            saturation -= 0.05;

            if (saturation <= 0) {
                saturation = 1;
                lightness -= 0.05;

                if (lightness < 0) {
                    lightness = 0.5;
                }
            }
        }

        const h = shuffledHues[hueIndex];
        const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
        const p = 2 * lightness - q;
        const r = hueToRgb(p, q, h + 1 / 3);
        const g = hueToRgb(p, q, h);
        const b = hueToRgb(p, q, h - 1 / 3);

        return new Color((r * 255) | 0, (g * 255) | 0, (b * 255) | 0);
    }

    score.style = new ScoreStyle();
    for (const key of TestPlatform.enumValues<ScoreSubElement>(ScoreSubElement)) {
        score.style.colors.set(key, nextColor());
    }

    for (const track of score.tracks) {
        track.style = new TrackStyle();
        for (const key of TestPlatform.enumValues<TrackSubElement>(TrackSubElement)) {
            track.style.colors.set(key, nextColor());
        }

        for (const staff of track.staves) {
            for (const bar of staff.bars) {
                bar.style = new BarStyle();
                for (const key of TestPlatform.enumValues<BarSubElement>(BarSubElement)) {
                    if (typeof key === 'number') {
                        bar.style.colors.set(key, nextColor());
                    }
                }

                for (const voice of bar.voices) {
                    voice.style = new VoiceStyle();
                    for (const key of TestPlatform.enumValues<VoiceSubElement>(VoiceSubElement)) {
                        if (typeof key === 'number') {
                            voice.style.colors.set(key, nextColor());
                        }
                    }

                    for (const beat of voice.beats) {
                        beat.style = new BeatStyle();
                        for (const key of TestPlatform.enumValues<BeatSubElement>(BeatSubElement)) {
                            if (typeof key === 'number') {
                                beat.style.colors.set(key, nextColor());
                            }
                        }

                        for (const note of beat.notes) {
                            note.style = new NoteStyle();
                            for (const key of TestPlatform.enumValues<NoteSubElement>(NoteSubElement)) {
                                if (typeof key === 'number') {
                                    note.style.colors.set(key, nextColor());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
