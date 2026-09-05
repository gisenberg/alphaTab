import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioElementBackingTrackSynthOutput } from '@coderline/alphatab/platform/javascript/AudioElementBackingTrackSynthOutput';

const device = (id: string) => ({ deviceId: id, label: id, isDefault: false });
function setup() {
    const output = new AudioElementBackingTrackSynthOutput();
    const mediaSetSinkId = vi.fn().mockResolvedValue(undefined);
    output.audioElement = { setSinkId: mediaSetSinkId } as unknown as HTMLAudioElement;
    const context = { sinkId: 'old', setSinkId: vi.fn().mockResolvedValue(undefined) };
    const ensure = vi
        .spyOn(output as unknown as { _ensureClickContext(): AudioContext }, '_ensureClickContext')
        .mockReturnValue(context as unknown as AudioContext);
    return { output, context, ensure, mediaSetSinkId };
}

describe('backing media and metronome device selection', () => {
    afterEach(() => vi.restoreAllMocks());

    it('rejects split routing when click-device selection is unsupported but permits the default', async () => {
        const { output, context, mediaSetSinkId } = setup();
        Reflect.deleteProperty(context, 'setSinkId');
        await expect(output.setOutputDevice(device('external'))).rejects.toThrow('cannot route');
        expect(mediaSetSinkId).not.toHaveBeenCalled();
        await output.setOutputDevice(null);
        expect(mediaSetSinkId).toHaveBeenCalledWith('');
    });

    it('reports both routing and rollback errors instead of claiming a consistent device', async () => {
        const { output, context, mediaSetSinkId } = setup();
        mediaSetSinkId.mockRejectedValueOnce(new Error('media failed'));
        context.setSinkId.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rollback failed'));
        await expect(output.setOutputDevice(device('new'))).rejects.toThrow('selection and click-device rollback failed');
    });

    it('initializes and routes the lazy click context before changing media output', async () => {
        const { output, context, ensure, mediaSetSinkId } = setup();
        let finish!: () => void;
        context.setSinkId.mockReturnValueOnce(
            new Promise<void>(resolve => {
                finish = resolve;
            })
        );
        const selected = output.setOutputDevice(device('new'));
        await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalledWith('new'));
        expect(ensure).toHaveBeenCalledOnce();
        expect(mediaSetSinkId).not.toHaveBeenCalled();
        finish();
        await selected;
        expect(mediaSetSinkId).toHaveBeenCalledWith('new');
    });

    it('restores the click device when media routing fails and allows a later selection', async () => {
        const { output, context, mediaSetSinkId } = setup();
        mediaSetSinkId.mockRejectedValueOnce(new Error('device unavailable'));
        await expect(output.setOutputDevice(device('bad'))).rejects.toThrow('device unavailable');
        expect(context.setSinkId.mock.calls.map(call => call[0])).toEqual(['bad', 'old']);
        await output.setOutputDevice(device('good'));
        expect(context.setSinkId).toHaveBeenLastCalledWith('good');
        expect(mediaSetSinkId).toHaveBeenLastCalledWith('good');
    });

    it('does not change media routing when click-device selection is rejected', async () => {
        const { output, context, mediaSetSinkId } = setup();
        context.setSinkId.mockRejectedValueOnce(new Error('permission denied'));
        await expect(output.setOutputDevice(device('new'))).rejects.toThrow('permission denied');
        expect(mediaSetSinkId).not.toHaveBeenCalled();
    });

    it('serializes concurrent selections so an earlier rollback cannot undo the later choice', async () => {
        const { output, context, mediaSetSinkId } = setup();
        let rejectFirst!: (error: Error) => void;
        mediaSetSinkId.mockReturnValueOnce(
            new Promise<void>((_resolve, reject) => {
                rejectFirst = reject;
            })
        );
        const first = output.setOutputDevice(device('first')).catch(error => error);
        const second = output.setOutputDevice(device('second'));
        await vi.waitFor(() => expect(mediaSetSinkId).toHaveBeenCalledWith('first'));
        expect(context.setSinkId).toHaveBeenCalledTimes(1);
        rejectFirst(new Error('first failed'));
        await first;
        await second;
        expect(context.setSinkId.mock.calls.map(call => call[0])).toEqual(['first', 'old', 'second']);
    });
});
