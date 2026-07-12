import { describe, expect, it } from 'vitest';
import { TransportClock } from '@coderline/alphatab/synth/TransportClock';

describe('TransportClock', () => {
    it('preserves position across rate changes and pause/resume', () => {
        let now = 1000;
        const clock = new TransportClock(() => now);

        clock.start(250);
        now += 100;
        expect(clock.position).toBe(350);

        clock.setPlaybackRate(2);
        now += 100;
        expect(clock.position).toBe(550);

        clock.pause();
        now += 1000;
        expect(clock.position).toBe(550);

        clock.start();
        now += 50;
        expect(clock.position).toBe(650);
    });

    it('slews small drift and snaps discontinuities', () => {
        let now = 0;
        const clock = new TransportClock(() => now);
        clock.start(0);

        now = 100;
        clock.observe(120);
        expect(clock.position).toBe(105);
        expect(clock.generation).toBe(0);

        clock.observe(1000);
        expect(clock.position).toBe(1000);
        expect(clock.generation).toBe(1);

        clock.seek(25);
        expect(clock.position).toBe(25);
        expect(clock.generation).toBe(2);
    });
});
