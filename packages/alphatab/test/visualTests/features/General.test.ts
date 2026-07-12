import { describe, it } from 'vitest';
import { StaveProfile } from '@coderline/alphatab/StaveProfile';
import { Settings } from '@coderline/alphatab/Settings';
import { VisualTestHelper } from 'test/visualTests/VisualTestHelper';
import { enableTestColoring } from 'test/visualTests/features/ColoringTestHelper';

describe('GeneralTests', () => {
    it('song-details', async () => {
        await VisualTestHelper.runVisualTest('general/song-details.gp');
    });

    it('repeats', async () => {
        const settings: Settings = new Settings();
        settings.display.staveProfile = StaveProfile.Score;
        await VisualTestHelper.runVisualTest('general/repeats.gp', settings);
    });

    it('alternate-endings', async () => {
        const settings: Settings = new Settings();
        settings.display.staveProfile = StaveProfile.Score;
        await VisualTestHelper.runVisualTest('general/alternate-endings.gp', settings);
    });

    it('tuning', async () => {
        await VisualTestHelper.runVisualTest('general/tuning.gp');
    });

    it('colors', async () => {
        await VisualTestHelper.runVisualTest('general/colors.gp', undefined, o => {
            enableTestColoring(o.score);
        });
    });

    it('font-fallback', async () => {
        await VisualTestHelper.runVisualTestTex(
            `\\title "Normal ♮♯ 🎸"
            .
            \\track "Track 🎸"
            \\lyrics "Test Lyrics 🤘"
            (1.2 1.1).4 x.2.8 0.1 1.1 | 1.2 3.2 0.1 1.1`,
            'test-data/visual-tests/general/font-fallback.png'
        );
    });
});
