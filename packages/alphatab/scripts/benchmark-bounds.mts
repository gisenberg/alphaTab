import fs from 'node:fs';
import v8 from 'node:v8';
import { ScoreLoader } from '@coderline/alphatab/importer/ScoreLoader';
import { Settings } from '@coderline/alphatab/Settings';
import { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
import { JsonConverter } from '@coderline/alphatab/model/JsonConverter';

const scorePath = process.argv[2];
if (!scorePath) {
    throw new Error('Usage: benchmark-bounds.mts <score-file>');
}

const settings = new Settings();
settings.core.engine = 'svg';
settings.core.enableLazyLoading = true;
settings.core.includeNoteBounds = true;
const score = ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(scorePath)), settings);
const renderer = new ScoreRenderer(settings);
renderer.width = 1200;
renderer.renderScore(score, [0]);

const bounds = renderer.boundsLookup;
if (!bounds) {
    throw new Error('Renderer did not produce a BoundsLookup');
}
const legacy = bounds.toJson();
const compact = bounds.toCompact();
const legacyBytes = v8.serialize(legacy).byteLength;
const compactBytes = v8.serialize(compact).byteLength;
const scorePayloadBytes = v8.serialize(JsonConverter.scoreToJsObject(score)).byteLength;
process.stdout.write(`${JSON.stringify({
    masterBars: score.masterBars.length,
    staffSystems: bounds.staffSystems.length,
    legacyBytes,
    compactBytes,
    reductionPercent: ((legacyBytes - compactBytes) / legacyBytes) * 100,
    scorePayloadBytes,
    repeatedRenderScorePayloadBytes: 0
}, null, 2)}\n`);
