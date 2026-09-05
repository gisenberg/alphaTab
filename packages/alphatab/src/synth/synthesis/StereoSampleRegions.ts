import type { Region } from '@coderline/alphatab/synth/synthesis/Region';

/** Load-time metadata only. Stereo regions remain separate voices with independent non-pitch generators. @internal */
export interface StereoSampleRegion {
    region: Region;
    instrument: number;
    presetZone: number;
    sampleId: number;
    sampleLink: number;
    sampleType: number;
}

/** Associate reciprocal, identically triggered stereo pairs without duplicating either sample. @internal */
export function linkStereoSampleRegions(regions: StereoSampleRegion[]): number {
    const index = new Map<string, StereoSampleRegion[]>();
    const key = (entry: StereoSampleRegion, sample: number) => {
        const r = entry.region;
        return `${entry.presetZone}:${entry.instrument}:${sample}:${r.loKey}:${r.hiKey}:${r.loVel}:${r.hiVel}`;
    };
    for (const entry of regions) {
        const id = key(entry, entry.sampleId);
        const entries = index.get(id);
        if (entries) { entries.push(entry); }
        else { index.set(id, [entry]); }
    }
    const rejected: Region[] = [];
    for (const entry of regions) {
        const r = entry.region;
        if (!r.samples.length) { continue; }
        const partners = index.get(key(entry, entry.sampleLink));
        const partner = partners?.length === 1 ? partners[0] : undefined;
        if (!partner || partner.sampleLink !== entry.sampleId ||
            partner.sampleType !== (entry.sampleType === 4 ? 2 : 4) ||
            index.get(key(entry, entry.sampleId))!.length !== 1 ||
            !(r.sampleRate > 0) || !Number.isFinite(r.sampleRate) ||
            partner.region.sampleRate !== r.sampleRate || partner.region.samples.length !== r.samples.length ||
            partner.region.loopStart !== r.loopStart || partner.region.loopEnd !== r.loopEnd ||
            partner.region.loopMode !== r.loopMode) {
            rejected.push(r);
            continue;
        }
        // SF2 sample-header contract: both halves use the right sample's pitch generators.
        // Pan, filter and amplitude generators remain local to each region.
        if (entry.sampleType === 4) { r.pitchRegion = partner.region; }
    }
    for (const region of rejected) {
        region.samples = new Float32Array(0);
        region.pitchRegion = undefined;
    }
    return rejected.length;
}
