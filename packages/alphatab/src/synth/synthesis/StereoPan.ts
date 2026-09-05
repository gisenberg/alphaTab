/**
 * Constant-power sine/cosine pan, shared by note-on and controller updates.
 * Input is the combined sample/channel position: -0.5 left, 0 center, +0.5 right.
 * Called at control rate only, never from the sample loop.
 * @internal
 */
export function rightPanGain(pan: number): number {
    if (pan <= -0.5) {
        return 0;
    }
    if (pan >= 0.5) {
        return 1;
    }
    return Math.sin((pan + 0.5) * Math.PI / 2);
}
