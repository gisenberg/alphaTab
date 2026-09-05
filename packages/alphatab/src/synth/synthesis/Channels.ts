// The SoundFont loading and Audio Synthesis is based on TinySoundFont, licensed under MIT,
// developed by Bernhard Schelling (https://github.com/schellingb/TinySoundFont)
// TypeScript port for alphaTab: (C) 2020 by Daniel Kuschny
// Licensed under: MPL-2.0

import type { Channel } from '@coderline/alphatab/synth/synthesis/Channel';
import type { TinySoundFont } from '@coderline/alphatab/synth/synthesis/TinySoundFont';
import type { Voice } from '@coderline/alphatab/synth/synthesis/Voice';

/**
 * @internal
 */
export class Channels {
    public activeChannel: number = 0;
    public channelList: Channel[] = [];

    public setupVoice(tinySoundFont: TinySoundFont, voice: Voice): void {
        const c: Channel = this.channelList[this.activeChannel];
        const newpan: number = voice.region!.pan + c.panOffset;
        voice.playingChannel = this.activeChannel;
        voice.mixVolume = c.mixVolume;
        voice.noteGainDb += c.gainDb;

        voice.updatePitchRatio(c, tinySoundFont.outSampleRate);

        voice.updatePan(newpan);
    }
}
