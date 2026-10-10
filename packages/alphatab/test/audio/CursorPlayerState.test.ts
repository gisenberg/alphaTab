import { describe, expect, it, vi } from 'vitest';
import { AlphaTabApiBase } from '@coderline/alphatab/AlphaTabApiBase';
import { PlayerState } from '@coderline/alphatab/synth/PlayerState';
import { PositionChangedEventArgs } from '@coderline/alphatab/synth/PositionChangedEventArgs';

describe('beat cursor player state', () => {
    it('applies a deferred position update in the state it was reported in', () => {
        // Pausing seeks to the current beat; resuming with a count-in before the deferred
        // cursor update ran used to animate the cursor through the count-in.
        const deferred: (() => void)[] = [];
        const player = { state: PlayerState.Paused };
        const cursorUpdateTick = vi.fn();
        // Private members are assigned by name; the stub stands in for a fully built API.
        const api = Object.assign(Object.create(null), {
            uiFacade: { beginInvoke: (action: () => void) => deferred.push(action), triggerEvent: () => {} },
            container: {}
        }) as Record<string, unknown>;
        api['_isDestroyed'] = false;
        api['_player'] = player;
        api['_cursorUpdateTick'] = cursorUpdateTick;
        const position = new PositionChangedEventArgs(1000, 10000, 960, 9600, true, 120, 90);

        (AlphaTabApiBase.prototype as unknown as { _onPlayerPositionChanged(e: PositionChangedEventArgs): void })
            ._onPlayerPositionChanged.call(api, position);
        player.state = PlayerState.Playing;
        for (const action of deferred) {
            action();
        }

        expect(cursorUpdateTick).toHaveBeenCalledWith(960, false, 0.75, false, true, PlayerState.Paused);
    });
});
