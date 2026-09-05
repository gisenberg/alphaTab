import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Gp3To5Importer } from '../src/importer/Gp3To5Importer';
import { ByteBuffer } from '../src/io/ByteBuffer';
import { Settings } from '../src/Settings';

/** Read-only diagnostic of legacy GP MIDI intent, before unsupported fields are discarded. */
class EffectInspector extends Gp3To5Importer {
    public channels: { chorus: number; reverb: number; phase: number; tremolo: number }[][] = [];
    public override readPlaybackInfos(): void {
        super.readPlaybackInfos();
        this.channels = Reflect.get(this, '_midiChannelInfo');
    }
}

const file = process.argv[2];
if (!file) { throw new Error('Usage: tsx scripts/inspect-score-effects.ts <score.gp3|gp4|gp5>'); }
const importer = new EffectInspector();
const bytes = readFileSync(file);
importer.init(ByteBuffer.fromBuffer(bytes), new Settings());
const score = importer.readScore();
console.log(JSON.stringify({ file, sha256: createHash('sha256').update(bytes).digest('hex'),
    scope: 'Initial legacy MIDI channel values only; excludes mix-table automation and proprietary RSE effects.',
    tracks: score.tracks.map(track => ({
        name: track.name, playback: track.playbackInfo,
        sourcePrimary: importer.channels[track.playbackInfo.port][track.playbackInfo.primaryChannel],
        sourceSecondary: importer.channels[track.playbackInfo.port][track.playbackInfo.secondaryChannel]
    })) }, null, 2));
