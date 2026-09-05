// The SoundFont loading and Audio Synthesis is based on TinySoundFont, licensed under MIT,
// developed by Bernhard Schelling (https://github.com/schellingb/TinySoundFont)
// TypeScript port for alphaTab: (C) 2020 by Daniel Kuschny
// Licensed under: MPL-2.0
import {
    type AlphaTabMetronomeEvent,
    type ControlChangeEvent,
    type MidiEvent,
    MidiEventType,
    type NoteBendEvent,
    type NoteOffEvent,
    type NoteOnEvent,
    type PitchBendEvent,
    type ProgramChangeEvent,
    type TempoChangeEvent,
    type TimeSignatureEvent
} from '@coderline/alphatab/midi/MidiEvent';
import {
    type Hydra,
    type HydraIbag,
    type HydraIgen,
    type HydraInst,
    type HydraPbag,
    HydraPgen,
    type HydraPhdr,
    type HydraShdr
} from '@coderline/alphatab/synth/soundfont/Hydra';
import { Channel } from '@coderline/alphatab/synth/synthesis/Channel';
import { compileLinearVelocityModulation, compileVelocityModulation, velocityModulationValue, compileVelocityAttenuation, defaultVelocityAttenuation, resolveModulatorLayers, velocityAttenuationDb, type SoundFontModulator } from '@coderline/alphatab/synth/soundfont/SoundFontModulators';
import { MetronomeClick } from '@coderline/alphatab/synth/MetronomeClick';
import { Channels } from '@coderline/alphatab/synth/synthesis/Channels';
import { LoopMode } from '@coderline/alphatab/synth/synthesis/LoopMode';
import { OutputMode } from '@coderline/alphatab/synth/synthesis/OutputMode';
import { Preset } from '@coderline/alphatab/synth/synthesis/Preset';
import { Region } from '@coderline/alphatab/synth/synthesis/Region';
import { linkStereoSampleRegions, type StereoSampleRegion } from '@coderline/alphatab/synth/synthesis/StereoSampleRegions';
import type { SynthEvent } from '@coderline/alphatab/synth/synthesis/SynthEvent';
import { Voice } from '@coderline/alphatab/synth/synthesis/Voice';
import { TrackAudioBus } from '@coderline/alphatab/synth/synthesis/TrackAudioBus';
import { GuitarAmpProcessor } from '@coderline/alphatab/synth/synthesis/GuitarAmpProcessor';
import { findGuitarAmpChannels } from '@coderline/alphatab/synth/synthesis/GuitarAmpRouting';
import type { MidiFile } from '@coderline/alphatab/midi/MidiFile';
import { VoiceEnvelopeSegment } from '@coderline/alphatab/synth/synthesis/VoiceEnvelope';
import { SynthHelper } from '@coderline/alphatab/synth/SynthHelper';
import { TypeConversions } from '@coderline/alphatab/io/TypeConversions';
import { SynthConstants } from '@coderline/alphatab/synth/SynthConstants';
import { Queue } from '@coderline/alphatab/synth/ds/Queue';
import { ControllerType } from '@coderline/alphatab/midi/ControllerType';
import { Logger } from '@coderline/alphatab/Logger';
import type { IAudioSampleSynthesizer } from '@coderline/alphatab/synth/IAudioSampleSynthesizer';

/**
 * This is a tiny soundfont based synthesizer.
 * NOT YET IMPLEMENTED
 *   - Support for ChorusEffectsSend and ReverbEffectsSend generators
 *   - Better low-pass filter without lowering performance too much
 *   - Support for modulators
 * @internal
 */
export class TinySoundFont implements IAudioSampleSynthesizer {
    private _midiEventQueue: Queue<SynthEvent> = new Queue<SynthEvent>();
    private _mutedChannels: Map<number, boolean> = new Map<number, boolean>();
    private _soloChannels: Map<number, boolean> = new Map<number, boolean>();
    private _isAnySolo: boolean = false;
    private _trackAudioBuses: readonly TrackAudioBus[] = [];
    private _channelAudioBuses: Map<number, TrackAudioBus> = new Map();

    public prepareMidi(midi: MidiFile): void {
        if (!this._enableExperimentalGuitarAmp) { return; }
        // MIDI replacement is a stopped transport boundary, not a live effect switch.
        for (const voice of this._voices) { voice.kill(); }
        this.setTrackAudioBuses([]);
        const buses: TrackAudioBus[] = [];
        for (const channels of findGuitarAmpChannels(midi)) {
            const volume = this.channelGetMixVolume(channels[0]);
            if (channels.some(channel => this.channelGetMixVolume(channel) !== volume)) {
                Logger.warning('AlphaSynth', 'Skipping experimental guitar processing for unequal channel faders');
                continue;
            }
            buses.push(new TrackAudioBus(channels, new GuitarAmpProcessor(this.outSampleRate, 1, 0.2, 0.1),
                new Map([[29, 27], [30, 27]])));
        }
        this.setTrackAudioBuses(buses);
    }

    /** Configure worker-owned processors before playback. Channels of a track share its mix fader. */
    public setTrackAudioBuses(buses: readonly TrackAudioBus[]): void {
        if (this._voices.some(voice => voice.playingPreset !== -1)) {
            throw new Error('Stop active voices before changing track processing');
        }
        if (buses.length && this.outputMode !== OutputMode.StereoInterleaved) {
            throw new Error('Track processing requires interleaved stereo output');
        }
        const mapping = new Map<number, TrackAudioBus>();
        const processors = new Set();
        for (const bus of buses) {
            if (processors.has(bus.processor)) { throw new Error('Each track must own its processor state'); }
            processors.add(bus.processor);
            const mixVolume = this.channelGetMixVolume(bus.channels[0]);
            for (const channel of bus.channels) {
                if (mapping.has(channel) || channel === this._metronomeChannel) {
                    throw new Error('Track buses must not overlap or include the metronome channel');
                }
                if (this.channelGetMixVolume(channel) !== mixVolume) {
                    throw new Error('Channels sharing a track processor must share a mix fader');
                }
                mapping.set(channel, bus);
            }
        }
        for (const bus of this._trackAudioBuses) { bus.reset(); }
        for (const bus of buses) { bus.reset(); }
        this._trackAudioBuses = [...buses];
        this._channelAudioBuses = mapping;
    }

    // these are the transposition pitches applied generally on the song (via Settings or general transposition)
    private _transpositionPitches: Map<number, number> = new Map<number, number>();
    // these are the transposition pitches only applied on playback (adjusting the pitch only during playback)
    private _liveTranspositionPitches: Map<number, number> = new Map<number, number>();

    public currentTempo: number = 0;
    public timeSignatureNumerator: number = 0;
    public timeSignatureDenominator: number = 0;
    private _metronomeChannel: number = SynthConstants.DefaultChannelCount - 1;
    private _clickSamples: Float32Array | null = null;
    private _clickPosition: number = 0;
    private _clickSampleRate: number = 0;
    private _accentClick: Float32Array = new Float32Array(0);
    private _regularClick: Float32Array = new Float32Array(0);

    public constructor(sampleRate: number, private readonly _enableExperimentalGuitarAmp: boolean = false) {
        this.outSampleRate = sampleRate;
        this._prepareMetronomeSamples();
    }

    private _prepareMetronomeSamples(): void {
        this._clickSampleRate = this.outSampleRate;
        this._accentClick = MetronomeClick.createSamples(this.outSampleRate, true);
        this._regularClick = MetronomeClick.createSamples(this.outSampleRate, false);
    }

    public synthesize(buffer: Float32Array, bufferPos: number, sampleCount: number): SynthEvent[] {
        return this._fillWorkingBuffer(buffer, bufferPos, sampleCount);
    }

    public synthesizeSilent(sampleCount: number): void {
        this._fillWorkingBuffer(null, 0, sampleCount);
    }

    public channelGetMixVolume(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].mixVolume
            : 1.0;
    }

    public channelSetMixVolume(channel: number, volume: number): void {
        const bus = this._channelAudioBuses.get(channel);
        if (bus) {
            for (const member of bus.channels) { this._setChannelMixVolume(member, volume); }
        } else {
            this._setChannelMixVolume(channel, volume);
        }
    }

    private _setChannelMixVolume(channel: number, volume: number): void {
        const c: Channel = this._channelInit(channel);
        for (const v of this._voices) {
            if (v.playingChannel === channel && v.playingPreset !== -1) {
                v.mixVolume = volume;
            }
        }
        c.mixVolume = volume;
    }

    public channelSetMute(channel: number, mute: boolean): void {
        if (mute) {
            this._mutedChannels.set(channel, true);
        } else {
            this._mutedChannels.delete(channel);
        }
    }

    public channelSetSolo(channel: number, solo: boolean): void {
        if (solo) {
            this._soloChannels.set(channel, true);
        } else {
            this._soloChannels.delete(channel);
        }
        this._isAnySolo = this._soloChannels.size > 0;
    }

    public resetChannelStates(): void {
        this._mutedChannels = new Map<number, boolean>();
        this._soloChannels = new Map<number, boolean>();
        this._liveTranspositionPitches = new Map<number, number>();

        this.applyTranspositionPitches(new Map<number, number>());
        this._isAnySolo = false;
    }

    public setChannelTranspositionPitch(channel: number, semitones: number): void {
        let previousTransposition = 0;
        if (this._liveTranspositionPitches.has(channel)) {
            previousTransposition = this._liveTranspositionPitches.get(channel)!;
        }

        if (semitones === 0) {
            this._liveTranspositionPitches.delete(channel);
        } else {
            this._liveTranspositionPitches.set(channel, semitones);
        }

        for (const voice of this._voices) {
            if (voice.playingChannel === channel && voice.playingChannel !== 9 /*percussion*/) {
                let pitchDifference = 0;
                pitchDifference -= previousTransposition;
                pitchDifference += semitones;

                voice.playingKey += pitchDifference;

                if (this._channels) {
                    voice.updatePitchRatio(this._channels!.channelList[voice.playingChannel], this.outSampleRate);
                }
            }
        }
    }

    public applyTranspositionPitches(transpositionPitches: Map<number, number>): void {
        // dynamically adjust actively playing voices to the new pitch they have.
        // we are not updating the used preset and regions though.
        const previousTransposePitches = this._transpositionPitches;
        for (const voice of this._voices) {
            if (voice.playingChannel >= 0 && voice.playingChannel !== 9 /*percussion*/) {
                let pitchDifference = 0;

                if (previousTransposePitches.has(voice.playingChannel)) {
                    pitchDifference -= previousTransposePitches.get(voice.playingChannel)!;
                }

                if (transpositionPitches.has(voice.playingChannel)) {
                    pitchDifference += transpositionPitches.get(voice.playingChannel)!;
                }

                voice.playingKey += pitchDifference;

                if (this._channels) {
                    voice.updatePitchRatio(this._channels!.channelList[voice.playingChannel], this.outSampleRate);
                }
            }
        }

        this._transpositionPitches = transpositionPitches;
    }

    public dispatchEvent(synthEvent: SynthEvent): void {
        this._midiEventQueue.enqueue(synthEvent);
    }

    private _fillWorkingBuffer(buffer: Float32Array | null, bufferPos: number, sampleCount: number): SynthEvent[] {
        // Break the process loop into sections representing the smallest timeframe before the midi controls need to be updated
        // the bigger the timeframe the more efficent the process is, but playback quality will be reduced.
        const anySolo: boolean = this._isAnySolo;

        const processedEvents: SynthEvent[] = [];

        // process in micro-buffers
        // process events for first microbuffer
        while (!this._midiEventQueue.isEmpty) {
            const m: SynthEvent = this._midiEventQueue.dequeue()!;
            if (m.isMetronome && this.metronomeVolume > 0) {
                if (this._clickSampleRate !== this.outSampleRate) {
                    this._prepareMetronomeSamples();
                }
                this._clickSamples = (m.event as AlphaTabMetronomeEvent).metronomeNumerator === 0
                    ? this._accentClick : this._regularClick;
                this._clickPosition = 0;
            } else if (m.event) {
                this.processMidiMessage(m.event);
            }
            processedEvents.push(m);
        }

        if (buffer && this._trackAudioBuses.length) {
            this._renderTrackAudioBuses(buffer, bufferPos, sampleCount);
        }
        // voice processing loop (unprocessed channels keep the original fast path)
        for (const voice of this._voices) {
            if (voice.playingPreset !== -1) {
                const channel: number = voice.playingChannel;
                if (buffer && voice.audioBus) { continue; }
                // channel is muted if it is either explicitley muted, or another channel is set to solo but not this one.
                // exception. metronome is implicitly added in solo
                const isChannelMuted: boolean =
                    this._mutedChannels.has(channel) ||
                    (anySolo && channel !== this._metronomeChannel && !this._soloChannels.has(channel));

                if (!buffer) {
                    voice.kill();
                } else {
                    voice.render(this, buffer, bufferPos, sampleCount, isChannelMuted);
                }
            }
        }

        if (!buffer) {
            this._clickSamples = null;
            for (const bus of this._trackAudioBuses) { bus.reset(); }
        } else if (this._clickSamples) {
            const gain = this.metronomeVolume * this.masterVolume;
            for (let i = 0; i < sampleCount && this._clickPosition < this._clickSamples.length; i++) {
                const sample = this._clickSamples[this._clickPosition++] * gain;
                switch (this.outputMode) {
                    case OutputMode.StereoInterleaved:
                        buffer[bufferPos + i * 2] += sample;
                        buffer[bufferPos + i * 2 + 1] += sample;
                        break;
                    case OutputMode.StereoUnweaved:
                        buffer[bufferPos + i] += sample;
                        buffer[bufferPos + sampleCount + i] += sample;
                        break;
                    case OutputMode.Mono:
                        buffer[bufferPos + i] += sample;
                        break;
                }
            }
        }
        return processedEvents;
    }

    private _renderTrackAudioBuses(buffer: Float32Array, offset: number, frames: number): void {
        if (this.outputMode !== OutputMode.StereoInterleaved) {
            throw new Error('Track processing requires interleaved stereo output');
        }
        for (let start = 0; start < frames; start += SynthConstants.MicroBufferSize) {
            const count = Math.min(SynthConstants.MicroBufferSize, frames - start);
            for (const bus of this._trackAudioBuses) { bus.buffer.fill(0); }
            for (const voice of this._voices) {
                if (voice.playingPreset === -1) { continue; }
                const channel = voice.playingChannel;
                const bus = voice.audioBus;
                if (!bus) { continue; }
                const muted = this._mutedChannels.has(channel) || (this._isAnySolo && !this._soloChannels.has(channel));
                voice.render(this, bus.buffer, 0, count, muted, true);
            }
            for (const bus of this._trackAudioBuses) {
                bus.processor.process(bus.buffer, count);
                // Process tails even without active voices, but mute/solo gates the complete output.
                let audible = false;
                for (const channel of bus.channels) {
                    if (!this._mutedChannels.has(channel) && (!this._isAnySolo || this._soloChannels.has(channel))) {
                        audible = true;
                        break;
                    }
                }
                const gain = audible ? this.masterVolume * this.channelGetMixVolume(bus.channels[0]) : 0;
                for (let i = 0; i < count * 2; i++) { buffer[offset + start * 2 + i] += bus.buffer[i] * gain; }
            }
        }
    }

    public processMidiMessage(e: MidiEvent): void {
        //Logger.debug('Midi', `Processing Midi message ${MidiEventType[e.type]}/${e.tick}`);
        const command: MidiEventType = e.type;
        switch (command) {
            case MidiEventType.TimeSignature:
                const timeSignature = e as TimeSignatureEvent;
                this.timeSignatureNumerator = timeSignature.numerator;
                this.timeSignatureDenominator = Math.pow(2, timeSignature.denominatorIndex);
                break;
            case MidiEventType.NoteOn:
                const noteOn = e as NoteOnEvent;
                this.channelNoteOn(noteOn.channel, noteOn.noteKey, noteOn.noteVelocity / 127.0, noteOn.isPalmMute, noteOn.isPercussionChoke);
                break;
            case MidiEventType.NoteOff:
                const noteOff = e as NoteOffEvent;
                this.channelNoteOff(noteOff.channel, noteOff.noteKey, !!noteOff.isPercussionChoke);
                break;
            case MidiEventType.ControlChange:
                const controlChange = e as ControlChangeEvent;
                this.channelMidiControl(controlChange.channel, controlChange.controller, controlChange.value);
                break;
            case MidiEventType.ProgramChange:
                const programChange = e as ProgramChangeEvent;
                this.channelSetPresetNumber(programChange.channel, programChange.program, programChange.channel === 9);
                break;
            case MidiEventType.TempoChange:
                const tempoChange = e as TempoChangeEvent;
                this.currentTempo = tempoChange.beatsPerMinute;
                break;
            case MidiEventType.PitchBend:
                const pitchBend = e as PitchBendEvent;
                this.channelSetPitchWheel(pitchBend.channel, pitchBend.value);
                break;
            case MidiEventType.PerNotePitchBend:
                const noteBend = e as NoteBendEvent;
                let perNotePitchWheel = noteBend.value;
                // midi 2.0 -> midi 1.0
                perNotePitchWheel = (perNotePitchWheel * SynthConstants.MaxPitchWheel) / SynthConstants.MaxPitchWheel20;
                this.channelSetPerNotePitchWheel(noteBend.channel, noteBend.noteKey, perNotePitchWheel);
                break;
        }
    }

    public get metronomeVolume(): number {
        return this.channelGetMixVolume(this._metronomeChannel);
    }

    public set metronomeVolume(value: number) {
        this.setupMetronomeChannel(this._metronomeChannel, value);
    }

    public setupMetronomeChannel(channel:number, volume: number): void {
        this._metronomeChannel = channel;
        this.channelSetMixVolume(channel, volume);
        if (volume > 0) {
            this.channelSetVolume(channel, 1);
            this.channelSetPresetNumber(channel, 0, true);
        }
    }

    public get masterVolume(): number {
        return SynthHelper.decibelsToGain(this.globalGainDb);
    }

    public set masterVolume(value: number) {
        const gainDb = SynthHelper.gainToDecibels(value);
        const gainDBChange: number = gainDb - this.globalGainDb;
        if (gainDBChange === 0) {
            return;
        }

        for (const v of this._voices) {
            if (v.playingPreset !== -1) {
                v.noteGainDb += gainDBChange;
            }
        }

        this.globalGainDb = gainDb;
    }

    /**
     * Stop all playing notes immediatly and reset all channel parameters but keeps user
     * defined settings
     */
    public resetSoft(): void {
        this._clickSamples = null;
        for (const bus of this._trackAudioBuses) { bus.reset(); }
        for (const v of this._voices) {
            if (
                v.playingPreset !== -1 &&
                (v.ampEnv.segment < VoiceEnvelopeSegment.Release || v.ampEnv.parameters!.release !== 0)
            ) {
                v.endQuick(this.outSampleRate);
            }
        }

        if (this._channels) {
            for (const c of this._channels.channelList) {
                c.presetIndex = 0;
                c.bank = 0;
                c.pitchWheel = 8192;
                c.midiPan = 8192;
                c.perNotePitchWheel.clear();
                c.midiVolume = 16383;
                c.midiExpression = 16383;
                c.midiRpn = 0xffff;
                c.midiData = 0;
                c.panOffset = 0.0;
                c.gainDb = 0.0;
                c.pitchRange = 2.0;
                c.tuning = 0.0;
            }
        }
    }

    public presets: Preset[] | null = null;
    private _voices: Voice[] = [];
    private _channels: Channels | null = null;
    private _voicePlayIndex: number = 0;

    public get presetCount(): number {
        return this.presets?.length ?? 0;
    }

    /**
     * Gets the currently configured output mode.
     */
    public outputMode: OutputMode = OutputMode.StereoInterleaved;

    /**
     * Gets the currently configured sample rate.
     */
    public outSampleRate: number = 0;

    /**
     * Gets the currently configured global gain in DB.
     */
    public globalGainDb: number = 0;

    /**
     * Stop all playing notes immediatly and reset all channel parameters
     */
    public reset(): void {
        this._clickSamples = null;
        for (const bus of this._trackAudioBuses) { bus.reset(); }
        for (const v of this._voices) {
            if (
                v.playingPreset !== -1 &&
                (v.ampEnv.segment < VoiceEnvelopeSegment.Release || v.ampEnv.parameters!.release !== 0)
            ) {
                v.endQuick(this.outSampleRate);
            }
        }
        this._channels = null;
    }

    /**
     * Setup the parameters for the voice render methods
     * @param outputMode if mono or stereo and how stereo channel data is ordered
     * @param sampleRate the number of samples per second (output frequency)
     * @param globalGainDb volume gain in decibels (>0 means higher, <0 means lower)
     */
    public setOutput(outputMode: OutputMode, sampleRate: number, globalGainDb: number): void {
        if (this._trackAudioBuses.length && outputMode !== OutputMode.StereoInterleaved) {
            throw new Error('Track processing requires interleaved stereo output');
        }
        this.outputMode = outputMode;
        this.outSampleRate = sampleRate >= 1 ? sampleRate : 44100.0;
        this.globalGainDb = globalGainDb;
    }

    /**
     * Start playing a note
     * @param presetIndex preset index >= 0 and < {@link presetCount}
     * @param key note value between 0 and 127 (60 being middle C)
     * @param vel velocity as a float between 0.0 (equal to note off) and 1.0 (full)
     */
    public noteOn(presetIndex: number, key: number, vel: number, isPalmMute: boolean = false, isPercussionChoke: boolean = false): void {
        if (!this.presets) {
            return;
        }

        const midiVelocity: number = (vel * 127) | 0;
        if (presetIndex < 0 || presetIndex >= this.presets.length) {
            return;
        }

        if (vel <= 0.0) {
            this.noteOff(presetIndex, key);
            return;
        }

        // Play all matching regions.
        const preset = this.presets[presetIndex];
        let sourcePreset = preset;
        let audioBus = this._channelAudioBuses.get(this._channels?.activeChannel ?? 0);
        if (audioBus?.programSources) {
            const sourceProgram = preset.bank === 0 ? audioBus.programSources.get(preset.presetNumber) : undefined;
            const sourceIndex = sourceProgram === undefined ? -1 : this._getPresetIndex(0, sourceProgram);
            const source = this.presets[sourceIndex];
            // An unavailable source must retain the original sound, never silence the note.
            if (source?.regions?.some(region => region.samples && region.samples.length > 0 &&
                key >= region.loKey && key <= region.hiKey && midiVelocity >= region.loVel && midiVelocity <= region.hiVel)) {
                sourcePreset = source;
            } else {
                audioBus = undefined;
            }
        }
        const palmMute = isPalmMute && preset.bank < 128 && preset.presetNumber >= 24 && preset.presetNumber <= 39;
        const voicePlayIndex: number = this._voicePlayIndex++;
        for (const region of sourcePreset.regions!) {
            if (
                // Unused/unsupported SoundFont regions have no decoded PCM.
                // Starting them feeds undefined samples into the voice and poisons the mix with NaN.
                region.samples.length === 0 ||
                key < region.loKey ||
                key > region.hiKey ||
                midiVelocity < region.loVel ||
                midiVelocity > region.hiVel
            ) {
                continue;
            }
            let voice: Voice | null = null;
            if (region.group !== 0) {
                for (const v of this._voices) {
                    // Choke earlier notes, not stereo/layered regions of this hit
                    // or a separate MIDI channel using the same drum preset.
                    if (v.playingPreset === presetIndex && v.region!.group === region.group &&
                        v.playIndex !== voicePlayIndex && v.playingChannel === (this._channels?.activeChannel ?? 0)) {
                        v.endQuick(this.outSampleRate);
                    } else if (v.playingPreset === -1 && !voice) {
                        voice = v;
                    }
                }
            } else {
                for (const v of this._voices) {
                    if (v.playingPreset === -1) {
                        voice = v;
                    }
                }
            }

            if (!voice) {
                for (let i: number = 0; i < 4; i++) {
                    const newVoice: Voice = new Voice();
                    newVoice.playingPreset = -1;
                    this._voices.push(newVoice);
                }
                voice = this._voices[this._voices.length - 4];
            }

            voice.region = region;
            voice.playingPreset = presetIndex;
            voice.audioBus = audioBus;
            voice.playingKey = key;
            voice.isPercussionChoke = isPercussionChoke;
            voice.playIndex = voicePlayIndex;
            voice.noteGainDb = this.globalGainDb - Math.max(0, Math.min(144,
                region.attenuation + velocityAttenuationDb(region.velocityAttenuation, midiVelocity)));

            if (this._channels) {
                this._channels.setupVoice(this, voice);
            } else {
                voice.calcPitchRatio(0, this.outSampleRate);
                // The SFZ spec is silent about the pan curve, but a 3dB pan law seems common. This sqrt() curve matches what Dimension LE does; Alchemy Free seems closer to sin(adjustedPan * pi/2).
                voice.updatePan(region.pan);
            }

            // Offset/end.
            voice.sourceSamplePosition = region.offset;

            // Loop.
            const doLoop: boolean = region.loopMode !== LoopMode.None && region.loopStart < region.loopEnd;
            voice.loopStart = doLoop ? region.loopStart : 0;
            voice.loopEnd = doLoop ? region.loopEnd : 0;

            // Setup envelopes.
            voice.ampEnv.setup(region.ampEnv, key, midiVelocity, true, this.outSampleRate, palmMute);
            voice.modEnv.setup(region.modEnv, key, midiVelocity, false, this.outSampleRate);
            if (region.pitchRegion) {
                voice.pitchModEnv.setup(region.pitchRegion.modEnv, key, midiVelocity, false, this.outSampleRate);
                voice.pitchModLfo.setup(region.pitchRegion.delayModLFO, region.pitchRegion.freqModLFO, this.outSampleRate);
            }

            // Setup lowpass filter.
            voice.lowPass.setResonance(region.initialFilterQ);
            voice.lowPass.z1 = 0;
            voice.lowPass.z2 = 0;
            voice.initialFilterFc = region.initialFilterFc;
            voice.modEnvToFilterFc = region.modEnvToFilterFc;
            if (region.velocityToFilterEnvelopeDepth) {
                voice.modEnvToFilterFc += velocityModulationValue(region.velocityToFilterEnvelopeDepth, midiVelocity);
            }
            if (region.velocityToFilter) {
                // Bank-authored cutoff changes belong to this note, not the shared region.
                voice.initialFilterFc += velocityModulationValue(region.velocityToFilter, midiVelocity);
            }
            if (palmMute) {
                // Damping belongs to this voice, never its shared SoundFont region
                // or MIDI channel. Open notes in the same chord retain their tone.
                const cutoffHz = Math.min(4000, Math.max(1800, 440 * Math.pow(2, (key - 69) / 12) * 18));
                voice.initialFilterFc = Math.min(voice.initialFilterFc, 1200 * Math.log2(cutoffHz / 8.176));
            }
            voice.lowPass.setCutoff(voice.initialFilterFc, this.outSampleRate);

            // Setup LFO filters.
            voice.modLfo.setup(region.delayModLFO, region.freqModLFO, this.outSampleRate);
            const pitchRegion = region.pitchRegion ?? region;
            voice.vibLfo.setup(pitchRegion.delayVibLFO, pitchRegion.freqVibLFO, this.outSampleRate);
        }
    }

    /**
     * Start playing a note
     * @param bank instrument bank number (alternative to preset_index)
     * @param presetNumber preset number (alternative to preset_index)
     * @param key note value between 0 and 127 (60 being middle C)
     * @param vel velocity as a float between 0.0 (equal to note off) and 1.0 (full)
     * @returns returns false if preset does not exist, otherwise true
     */
    public bankNoteOn(bank: number, presetNumber: number, key: number, vel: number): boolean {
        const presetIndex: number = this._getPresetIndex(bank, presetNumber);
        if (presetIndex === -1) {
            return false;
        }
        this.noteOn(presetIndex, key, vel);
        return true;
    }

    /**
     * Stop playing a note
     */
    public noteOff(presetIndex: number, key: number): void {
        let matchFirst: Voice | null = null;
        let matchLast: Voice | null = null;
        const matches: Voice[] = [];
        for (const v of this._voices) {
            if (
                v.playingPreset !== presetIndex ||
                v.playingKey !== key ||
                v.ampEnv.segment >= VoiceEnvelopeSegment.Release
            ) {
                continue;
            }

            if (!matchFirst || v.playIndex < matchFirst.playIndex) {
                matchFirst = v;
                matchLast = v;
                matches.push(v);
            } else if (v.playIndex === matchFirst.playIndex) {
                matchLast = v;
                matches.push(v);
            }
        }

        if (!matchFirst) {
            return;
        }
        for (const v of matches) {
            if (
                v !== matchFirst &&
                v !== matchLast &&
                (v.playIndex !== matchFirst.playIndex ||
                    v.playingPreset !== presetIndex ||
                    v.playingKey !== key ||
                    v.ampEnv.segment >= VoiceEnvelopeSegment.Release)
            ) {
                continue;
            }
            v.end(this.outSampleRate);
        }
    }

    /**
     * Stop playing a note
     * @returns returns false if preset does not exist, otherwise true
     */
    public bankNoteOff(bank: number, presetNumber: number, key: number): boolean {
        const presetIndex: number = this._getPresetIndex(bank, presetNumber);
        if (presetIndex === -1) {
            return false;
        }

        this.noteOff(presetIndex, key);
        return true;
    }

    /**
     * Stop playing all notes (end with sustain and release)
     */
    public noteOffAll(immediate: boolean): void {
        if (immediate) {
            this._clickSamples = null;
        }
        for (const voice of this._voices) {
            if (voice.playingPreset !== -1) {
                if (immediate) {
                    voice.endQuick(this.outSampleRate);
                } else if (voice.ampEnv.segment < VoiceEnvelopeSegment.Release) {
                    voice.end(this.outSampleRate);
                }
            }
        }
    }

    public get activeVoiceCount(): number {
        let count: number = 0;
        for (const v of this._voices) {
            if (v.playingPreset !== -1) {
                count++;
            }
        }
        return count;
    }

    private _channelInit(channel: number): Channel {
        if (this._channels && channel < this._channels.channelList.length) {
            return this._channels.channelList[channel];
        }

        if (!this._channels) {
            this._channels = new Channels();
        }

        for (let i: number = this._channels.channelList.length; i <= channel; i++) {
            const c: Channel = new Channel();
            c.presetIndex = 0;
            c.bank = 0;
            c.pitchWheel = 8192;
            c.midiPan = 8192;
            c.midiVolume = 16383;
            c.midiExpression = 16383;
            c.midiRpn = 0xffff;
            c.midiData = 0;
            c.panOffset = 0.0;
            c.gainDb = 0.0;
            c.pitchRange = 2.0;
            c.tuning = 0.0;
            c.mixVolume = 1;
            this._channels.channelList.push(c);
        }

        return this._channels.channelList[channel];
    }

    /**
     * Returns the preset index from a bank and preset number, or -1 if it does not exist in the loaded SoundFont
     */
    private _getPresetIndex(bank: number, presetNumber: number): number {
        if (!this.presets) {
            return -1;
        }

        // search reverse (last import wins)
        for (let i: number = this.presets.length - 1; i >= 0; i--) {
            const preset: Preset = this.presets[i];
            if (preset.presetNumber === presetNumber && preset.bank === bank) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Returns the name of a preset index >= 0 and < GetPresetName()
     * @param presetIndex
     */
    public getPresetName(presetIndex: number): string | null {
        if (!this.presets) {
            return null;
        }
        return presetIndex < 0 || presetIndex >= this.presets.length ? null : this.presets[presetIndex].name;
    }

    /**
     * Returns the name of a preset by bank and preset number
     */
    public bankGetPresetName(bank: number, presetNumber: number): string | null {
        return this.getPresetName(this._getPresetIndex(bank, presetNumber));
    }

    /**
     * Start playing a note on a channel
     * @param channel channel number
     * @param key note value between 0 and 127 (60 being middle C)
     * @param vel velocity as a float between 0.0 (equal to note off) and 1.0 (full)
     */
    public channelNoteOn(channel: number, key: number, vel: number, isPalmMute: boolean = false, isPercussionChoke: boolean = false): void {
        if (!this._channels || channel > this._channels.channelList.length) {
            return;
        }

        if (this._transpositionPitches.has(channel)) {
            key += this._transpositionPitches.get(channel)!;
        }

        if (this._liveTranspositionPitches.has(channel)) {
            key += this._liveTranspositionPitches.get(channel)!;
        }

        this._channels.activeChannel = channel;
        this.noteOn(this._channels.channelList[channel].presetIndex, key, vel, isPalmMute, isPercussionChoke);
    }

    /**
     * Stop playing notes on a channel
     * @param channel channel number
     * @param key note value between 0 and 127 (60 being middle C)
     */
    public channelNoteOff(channel: number, key: number, isPercussionChoke?: boolean): void {
        if (this._transpositionPitches.has(channel)) {
            key += this._transpositionPitches.get(channel)!;
        }
        if (this._liveTranspositionPitches.has(channel)) {
            key += this._liveTranspositionPitches.get(channel)!;
        }

        const matches: Voice[] = [];
        let matchFirst: Voice | null = null;
        let matchLast: Voice | null = null;
        for (const v of this._voices) {
            // Find the first and last entry in the voices list with matching channel, key and look up the smallest play index
            if (
                v.playingPreset === -1 ||
                v.playingChannel !== channel ||
                v.playingKey !== key ||
                (isPercussionChoke !== undefined && v.isPercussionChoke !== isPercussionChoke) ||
                v.ampEnv.segment >= VoiceEnvelopeSegment.Release
            ) {
                continue;
            }

            if (!matchFirst || v.playIndex < matchFirst.playIndex) {
                matchFirst = v;
                matchLast = v;
                matches.push(v);
            } else if (v.playIndex === matchFirst.playIndex) {
                matchLast = v;
                matches.push(v);
            }
        }

        const c: Channel = this._channelInit(channel);
        c.perNotePitchWheel.delete(key);

        if (!matchFirst) {
            return;
        }

        for (const v of matches) {
            // Stop all voices with matching channel, key and the smallest play index which was enumerated above
            if (
                v !== matchFirst &&
                v !== matchLast &&
                (v.playIndex !== matchFirst.playIndex ||
                    v.playingPreset === -1 ||
                    v.playingChannel !== channel ||
                    v.playingKey !== key ||
                    v.ampEnv.segment >= VoiceEnvelopeSegment.Release)
            ) {
                continue;
            }

            if (v.isPercussionChoke) {
                // Preserve the original attack and gate; choke only this note's layers at note-off.
                v.endQuick(this.outSampleRate);
            } else {
                v.end(this.outSampleRate);
            }
        }
    }

    /**
     * Stop playing all notes on a channel with sustain and release.
     * @param channel channel number
     */
    public channelNoteOffAll(channel: number): void {
        const c: Channel = this._channelInit(channel);
        c.perNotePitchWheel.clear();

        for (const v of this._voices) {
            if (
                v.playingPreset !== -1 &&
                v.playingChannel === channel &&
                v.ampEnv.segment < VoiceEnvelopeSegment.Release
            ) {
                v.end(this.outSampleRate);
            }
        }
    }

    /**
     * Stop playing all notes on a channel immediately
     * @param channel channel number
     */
    public channelSoundsOffAll(channel: number): void {
        const c: Channel = this._channelInit(channel);
        c.perNotePitchWheel.clear();

        for (const v of this._voices) {
            if (
                v.playingPreset !== -1 &&
                v.playingChannel === channel &&
                (v.ampEnv.segment < VoiceEnvelopeSegment.Release || v.ampEnv.parameters!.release === 0)
            ) {
                v.endQuick(this.outSampleRate);
            }
        }
    }

    /**
     *
     * @param channel channel number
     * @param presetIndex preset index <= 0 and > {@link presetCount}
     */
    public channelSetPresetIndex(channel: number, presetIndex: number): void {
        this._channelInit(channel).presetIndex = TypeConversions.int32ToUint16(presetIndex);
    }

    /**
     * @param channel channel number
     * @param presetNumber preset number (alternative to preset_index)
     * @param midiDrums false for normal channels, otherwise apply MIDI drum channel rules
     * @returns return false if preset does not exist, otherwise true
     */
    public channelSetPresetNumber(channel: number, presetNumber: number, midiDrums: boolean = false): boolean {
        const c: Channel = this._channelInit(channel);
        let presetIndex: number = 0;
        if (midiDrums) {
            presetIndex = this._getPresetIndex(128 | (c.bank & 0x7fff), presetNumber);
            if (presetIndex === -1) {
                presetIndex = this._getPresetIndex(128, presetNumber);
            }
            if (presetIndex === -1) {
                presetIndex = this._getPresetIndex(128, 0);
            }
            if (presetIndex === -1) {
                presetIndex = this._getPresetIndex(c.bank & 0x7ff, presetNumber);
            }
        } else {
            presetIndex = this._getPresetIndex(c.bank & 0x7ff, presetNumber);
        }
        c.presetIndex = presetIndex;
        return presetIndex !== -1;
    }

    /**
     * @param channel channel number
     * @param bank instrument bank number (alternative to preset_index)
     */
    public channelSetBank(channel: number, bank: number): void {
        this._channelInit(channel).bank = TypeConversions.int32ToUint16(bank);
    }

    /**
     * @param channel channel number
     * @param bank instrument bank number (alternative to preset_index)
     * @param presetNumber preset number (alternative to preset_index)
     * @returns return false if preset does not exist, otherwise true
     */
    public channelSetBankPreset(channel: number, bank: number, presetNumber: number): boolean {
        const c: Channel = this._channelInit(channel);
        const presetIndex: number = this._getPresetIndex(bank, presetNumber);
        if (presetIndex === -1) {
            return false;
        }

        c.presetIndex = TypeConversions.int32ToUint16(presetIndex);
        c.bank = TypeConversions.int32ToUint16(bank);
        return true;
    }

    /**
     * @param channel channel number
     * @param pan stereo panning value from 0.0 (left) to 1.0 (right) (default 0.5 center)
     */
    public channelSetPan(channel: number, pan: number): void {
        if (!Number.isFinite(pan)) {
            throw new RangeError('Pan must be finite');
        }
        pan = Math.max(0, Math.min(1, pan));
        for (const v of this._voices) {
            if (v.playingChannel === channel && v.playingPreset !== -1) {
                const newPan: number = v.region!.pan + pan - 0.5;
                v.updatePan(newPan);
            }
        }
        this._channelInit(channel).panOffset = pan - 0.5;
    }

    /**
     * @param channel channel number
     * @param volume linear volume scale factor (default 1.0 full)
     */
    public channelSetVolume(channel: number, volume: number): void {
        const c: Channel = this._channelInit(channel);
        const gainDb: number = SynthHelper.gainToDecibels(volume);
        const gainDBChange: number = gainDb - c.gainDb;
        if (gainDBChange === 0) {
            return;
        }

        for (const v of this._voices) {
            if (v.playingChannel === channel && v.playingPreset !== -1) {
                v.noteGainDb += gainDBChange;
            }
        }

        c.gainDb = gainDb;
    }

    /**
     * @param channel channel number
     * @param pitchWheel pitch wheel position 0 to 16383 (default 8192 unpitched)
     */
    public channelSetPitchWheel(channel: number, pitchWheel: number): void {
        const c: Channel = this._channelInit(channel);
        if (c.pitchWheel === pitchWheel) {
            return;
        }

        c.pitchWheel = TypeConversions.int32ToUint16(pitchWheel);
        this._channelApplyPitch(channel, c);
    }

    /**
     * @param channel channel number
     * @param key note value between 0 and 127
     * @param pitchWheel pitch wheel position 0 to 16383 (default 8192 unpitched)
     */
    public channelSetPerNotePitchWheel(channel: number, key: number, pitchWheel: number): void {
        if (this._transpositionPitches.has(channel)) {
            key += this._transpositionPitches.get(channel)!;
        }
        if (this._liveTranspositionPitches.has(channel)) {
            key += this._liveTranspositionPitches.get(channel)!;
        }

        const c: Channel = this._channelInit(channel);
        if (c.perNotePitchWheel.has(key) && c.perNotePitchWheel.get(key) === pitchWheel) {
            return;
        }

        c.perNotePitchWheel.set(key, pitchWheel);
        this._channelApplyPitch(channel, c, key);
    }

    private _channelApplyPitch(channel: number, c: Channel, key: number = -1): void {
        for (const v of this._voices) {
            if (v.playingChannel === channel && v.playingPreset !== -1 && (key === -1 || v.playingKey === key)) {
                v.updatePitchRatio(c, this.outSampleRate);
            }
        }
    }

    /**
     * @param channel channel number
     * @param pitchRange range of the pitch wheel in semitones (default 2.0, total +/- 2 semitones)
     */
    public channelSetPitchRange(channel: number, pitchRange: number): void {
        const c: Channel = this._channelInit(channel);
        if (c.pitchRange === pitchRange) {
            return;
        }

        c.pitchRange = pitchRange;
        if (c.pitchWheel !== 8192) {
            this._channelApplyPitch(channel, c);
        }
    }

    /**
     * @param channel channel number
     * @param tuning tuning of all playing voices in semitones (default 0.0, standard (A440) tuning)
     */
    public channelSetTuning(channel: number, tuning: number): void {
        const c: Channel = this._channelInit(channel);
        if (c.tuning === tuning) {
            return;
        }

        c.tuning = tuning;
        this._channelApplyPitch(channel, c);
    }

    /**
     * Apply a MIDI control change to the channel (not all controllers are supported!)
     */
    public channelMidiControl(channel: number, controller: ControllerType, controlValue: number): void {
        const c: Channel = this._channelInit(channel);
        switch (controller) {
            case ControllerType.DataEntryFine:
                c.midiData = TypeConversions.int32ToUint16((c.midiData & 0x3f80) | controlValue);

                if (c.midiRpn === 0) {
                    this.channelSetPitchRange(channel, (c.midiData >> 7) + 0.01 * (c.midiData & 0x7f));
                } else if (c.midiRpn === 1) {
                    this.channelSetTuning(channel, (c.tuning | 0) + (c.midiData - 8192.0) / 8192.0); // fine tune
                } else if (c.midiRpn === 2) {
                    this.channelSetTuning(channel, controlValue - 64.0 + (c.tuning - (c.tuning | 0))); // coarse tune
                }
                return;

            case ControllerType.VolumeCoarse:
                c.midiVolume = TypeConversions.int32ToUint16((c.midiVolume & 0x7f) | (controlValue << 7));
                // Raising to the power of 3 seems to result in a decent sounding volume curve for MIDI
                this.channelSetVolume(channel, Math.pow((c.midiVolume / 16383.0) * (c.midiExpression / 16383.0), 3.0));
                return;
            case ControllerType.VolumeFine:
                c.midiVolume = TypeConversions.int32ToUint16((c.midiVolume & 0x3f80) | controlValue);
                // Raising to the power of 3 seems to result in a decent sounding volume curve for MIDI
                this.channelSetVolume(channel, Math.pow((c.midiVolume / 16383.0) * (c.midiExpression / 16383.0), 3.0));
                return;
            case ControllerType.ExpressionControllerCoarse:
                c.midiExpression = TypeConversions.int32ToUint16((c.midiExpression & 0x7f) | (controlValue << 7));
                // Raising to the power of 3 seems to result in a decent sounding volume curve for MIDI
                this.channelSetVolume(channel, Math.pow((c.midiVolume / 16383.0) * (c.midiExpression / 16383.0), 3.0));
                return;
            case ControllerType.ExpressionControllerFine:
                c.midiExpression = TypeConversions.int32ToUint16((c.midiExpression & 0x3f80) | controlValue);
                // Raising to the power of 3 seems to result in a decent sounding volume curve for MIDI
                this.channelSetVolume(channel, Math.pow((c.midiVolume / 16383.0) * (c.midiExpression / 16383.0), 3.0));
                return;
            case ControllerType.PanCoarse:
                c.midiPan = TypeConversions.int32ToUint16((c.midiPan & 0x7f) | (controlValue << 7));
                this.channelSetPan(channel, c.midiPan / 16384.0);
                return;
            case ControllerType.PanFine:
                c.midiPan = TypeConversions.int32ToUint16((c.midiPan & 0x3f80) | controlValue);
                this.channelSetPan(channel, c.midiPan / 16384.0);
                return;
            case ControllerType.DataEntryCoarse:
                c.midiData = TypeConversions.int32ToUint16((c.midiData & 0x7f) | (controlValue << 7));
                if (c.midiRpn === 0) {
                    this.channelSetPitchRange(channel, (c.midiData >> 7) + 0.01 * (c.midiData & 0x7f));
                } else if (c.midiRpn === 1) {
                    this.channelSetTuning(channel, (c.tuning | 0) + (c.midiData - 8192.0) / 8192.0); // fine tune
                } else if (c.midiRpn === 2 && controller === ControllerType.DataEntryCoarse) {
                    this.channelSetTuning(channel, controlValue - 64.0 + (c.tuning - (c.tuning | 0))); // coarse tune
                }
                return;
            case ControllerType.BankSelectCoarse:
                c.bank = TypeConversions.int32ToUint16(0x8000 | controlValue);
                return;
            // bank select MSB alone acts like LSB
            case ControllerType.BankSelectFine:
                c.bank = TypeConversions.int32ToUint16(
                    ((c.bank & 0x8000) !== 0 ? (c.bank & 0x7f) << 7 : 0) | controlValue
                );
                return;
            case ControllerType.RegisteredParameterCourse:
                c.midiRpn = TypeConversions.int32ToUint16(
                    ((c.midiRpn === 0xffff ? 0 : c.midiRpn) & 0x7f) | (controlValue << 7)
                );
                // TODO
                return;
            case ControllerType.RegisteredParameterFine:
                c.midiRpn = TypeConversions.int32ToUint16(
                    ((c.midiRpn === 0xffff ? 0 : c.midiRpn) & 0x3f80) | controlValue
                );
                // TODO
                return;
            case ControllerType.NonRegisteredParameterFine:
                c.midiRpn = 0xffff;
                // TODO
                return;
            case ControllerType.NonRegisteredParameterCourse:
                c.midiRpn = 0xffff;
                // TODO
                return;
            case ControllerType.AllSoundOff:
                this.channelSoundsOffAll(channel);
                return;
            case ControllerType.AllNotesOff:
                this.channelNoteOffAll(channel);
                return;
            case ControllerType.ResetControllers:
                c.midiVolume = 16383;
                c.midiExpression = 16383;
                c.midiPan = 8192;
                c.bank = 0;
                this.channelSetVolume(channel, 1);
                this.channelSetPan(channel, 0.5);
                this.channelSetPitchRange(channel, 2);
                // TODO
                return;
        }
    }

    /**
     * Gets the current preset index of the given channel.
     * @param channel The channel index
     * @returns The current preset index of the given channel.
     */
    public channelGetPresetIndex(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].presetIndex
            : 0;
    }

    /**
     * Gets the current bank of the given channel.
     * @param channel The channel index
     * @returns The current bank of the given channel.
     */
    public channelGetPresetBank(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].bank & 0x7fff
            : 0;
    }

    /**
     * Gets the current pan of the given channel.
     * @param channel The channel index
     * @returns The current pan of the given channel.
     */
    public channelGetPan(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].panOffset + 0.5
            : 0.5;
    }

    /**
     * Gets the current volume of the given channel.
     * @param channel The channel index
     * @returns The current volune of the given channel.
     */
    public channelGetVolume(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? SynthHelper.decibelsToGain(this._channels.channelList[channel].gainDb)
            : 1.0;
    }

    /**
     * Gets the current pitch wheel of the given channel.
     * @param channel The channel index
     * @returns The current pitch wheel of the given channel.
     */
    public channelGetPitchWheel(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].pitchWheel
            : 8192;
    }

    /**
     * Gets the current pitch range of the given channel.
     * @param channel The channel index
     * @returns The current pitch range of the given channel.
     */
    public channelGetPitchRange(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].pitchRange
            : 2.0;
    }

    /**
     * Gets the current tuning of the given channel.
     * @param channel The channel index
     * @returns The current tuning of the given channel.
     */
    public channelGetTuning(channel: number): number {
        return this._channels && channel < this._channels.channelList.length
            ? this._channels.channelList[channel].tuning
            : 0.0;
    }

    public resetPresets(): void {
        this.presets = [];
    }

    public loadPresets(
        hydra: Hydra,
        instrumentPrograms: Set<number>,
        percussionKeys: Set<number>,
        append: boolean
    ): void {
        if (this._enableExperimentalGuitarAmp && this._trackAudioBuses.length) {
            // Do not mutate the sequencer's actual instrument inventory.
            instrumentPrograms = new Set(instrumentPrograms);
            instrumentPrograms.add(27);
        }
        const newPresets: Preset[] = [];
        for (let phdrIndex: number = 0; phdrIndex < hydra.phdrs.length - 1; phdrIndex++) {
            const phdr: HydraPhdr = hydra.phdrs[phdrIndex];
            let regionIndex: number = 0;

            const preset: Preset = new Preset();
            const stereoRegions: StereoSampleRegion[] = [];
            newPresets.push(preset);
            preset.name = phdr.presetName;
            preset.bank = phdr.bank;
            preset.presetNumber = phdr.preset;
            let regionNum: number = 0;

            for (
                let pbagIndex: number = phdr.presetBagNdx;
                pbagIndex < hydra.phdrs[phdrIndex + 1].presetBagNdx;
                pbagIndex++
            ) {
                const pbag: HydraPbag = hydra.pbags[pbagIndex];
                let plokey: number = 0;
                let phikey: number = 127;
                let plovel: number = 0;
                let phivel: number = 127;

                for (let pgenIndex: number = pbag.genNdx; pgenIndex < hydra.pbags[pbagIndex + 1].genNdx; pgenIndex++) {
                    const pgen: HydraPgen = hydra.pgens[pgenIndex];

                    if (pgen.genOper === HydraPgen.GenKeyRange) {
                        plokey = pgen.genAmount.lowByteAmount;
                        phikey = pgen.genAmount.highByteAmount;
                        continue;
                    }

                    if (pgen.genOper === HydraPgen.GenVelRange) {
                        plovel = pgen.genAmount.lowByteAmount;
                        phivel = pgen.genAmount.highByteAmount;
                        continue;
                    }

                    if (pgen.genOper !== HydraPgen.GenInstrument) {
                        continue;
                    }

                    if (pgen.genAmount.wordAmount >= hydra.insts.length) {
                        continue;
                    }

                    const pinst: HydraInst = hydra.insts[pgen.genAmount.wordAmount];
                    for (
                        let ibagIndex: number = pinst.instBagNdx;
                        ibagIndex < hydra.insts[pgen.genAmount.wordAmount + 1].instBagNdx;
                        ibagIndex++
                    ) {
                        const ibag: HydraIbag = hydra.ibags[ibagIndex];

                        let ilokey: number = 0;
                        let ihikey: number = 127;
                        let ilovel: number = 0;
                        let ihivel: number = 127;

                        for (
                            let igenIndex: number = ibag.instGenNdx;
                            igenIndex < hydra.ibags[ibagIndex + 1].instGenNdx;
                            igenIndex++
                        ) {
                            const igen: HydraIgen = hydra.igens[igenIndex];
                            if (igen.genOper === HydraPgen.GenKeyRange) {
                                ilokey = igen.genAmount.lowByteAmount;
                                ihikey = igen.genAmount.highByteAmount;
                                continue;
                            }

                            if (igen.genOper === HydraPgen.GenVelRange) {
                                ilovel = igen.genAmount.lowByteAmount;
                                ihivel = igen.genAmount.highByteAmount;
                                continue;
                            }

                            if (
                                igen.genOper === 53 &&
                                ihikey >= plokey &&
                                ilokey <= phikey &&
                                ihivel >= plovel &&
                                ilovel <= phivel
                            ) {
                                regionNum++;
                            }
                        }
                    }
                }
            }

            preset.regions = new Array<Region>(regionNum);

            let globalRegion: Region = new Region();
            globalRegion.clear(true);
            let presetGlobalModulators: readonly SoundFontModulator[] = [];

            // Zones.
            for (
                let pbagIndex: number = phdr.presetBagNdx;
                pbagIndex < hydra.phdrs[phdrIndex + 1].presetBagNdx;
                pbagIndex++
            ) {
                const pbag: HydraPbag = hydra.pbags[pbagIndex];
                const presetLocalModulators = hydra.pmods.slice(pbag.modNdx, hydra.pbags[pbagIndex + 1].modNdx);

                const presetRegion: Region = new Region(globalRegion);
                let hadGenInstrument: boolean = false;

                // Generators.
                for (let pgenIndex: number = pbag.genNdx; pgenIndex < hydra.pbags[pbagIndex + 1].genNdx; pgenIndex++) {
                    const pgen: HydraPgen = hydra.pgens[pgenIndex];

                    // Instrument.
                    if (pgen.genOper === HydraPgen.GenInstrument) {
                        const whichInst: number = pgen.genAmount.wordAmount;
                        if (whichInst >= hydra.insts.length) {
                            continue;
                        }

                        let instRegion: Region = new Region();
                        instRegion.clear(false);
                        let instrumentGlobalModulators: readonly SoundFontModulator[] = [];

                        // Generators
                        const inst: HydraInst = hydra.insts[whichInst];
                        for (
                            let ibagIndex: number = inst.instBagNdx;
                            ibagIndex < hydra.insts[whichInst + 1].instBagNdx;
                            ibagIndex++
                        ) {
                            const ibag: HydraIbag = hydra.ibags[ibagIndex];
                            const instrumentLocalModulators = hydra.imods.slice(ibag.instModNdx, hydra.ibags[ibagIndex + 1].instModNdx);
                            const zoneRegion: Region = new Region(instRegion);
                            let hadSampleId: boolean = false;

                            for (
                                let igenIndex: number = ibag.instGenNdx;
                                igenIndex < hydra.ibags[ibagIndex + 1].instGenNdx;
                                igenIndex++
                            ) {
                                const igen: HydraIgen = hydra.igens[igenIndex];

                                if (igen.genOper === HydraPgen.GenSampleId) {
                                    const modulatorLayers = resolveModulatorLayers(
                                        [defaultVelocityAttenuation], instrumentGlobalModulators,
                                        instrumentLocalModulators, presetGlobalModulators, presetLocalModulators);
                                    zoneRegion.velocityAttenuation = compileVelocityAttenuation(modulatorLayers);
                                    zoneRegion.ampEnv.velocityToDecay = compileLinearVelocityModulation(modulatorLayers, 36);
                                    zoneRegion.ampEnv.velocityToRelease = compileLinearVelocityModulation(modulatorLayers, 38);
                                    zoneRegion.velocityToFilter = compileVelocityModulation(modulatorLayers, 8);
                                    zoneRegion.velocityToFilterEnvelopeDepth = compileVelocityModulation(modulatorLayers, 11);
                                    // preset region key and vel ranges are a filter for the zone regions
                                    if (
                                        zoneRegion.hiKey < presetRegion.loKey ||
                                        zoneRegion.loKey > presetRegion.hiKey
                                    ) {
                                        continue;
                                    }

                                    if (
                                        zoneRegion.hiVel < presetRegion.loVel ||
                                        zoneRegion.loVel > presetRegion.hiVel
                                    ) {
                                        continue;
                                    }

                                    if (presetRegion.loKey > zoneRegion.loKey) {
                                        zoneRegion.loKey = presetRegion.loKey;
                                    }

                                    if (presetRegion.hiKey < zoneRegion.hiKey) {
                                        zoneRegion.hiKey = presetRegion.hiKey;
                                    }

                                    if (presetRegion.loVel > zoneRegion.loVel) {
                                        zoneRegion.loVel = presetRegion.loVel;
                                    }

                                    if (presetRegion.hiVel < zoneRegion.hiVel) {
                                        zoneRegion.hiVel = presetRegion.hiVel;
                                    }

                                    // sum regions
                                    zoneRegion.offset += presetRegion.offset;
                                    zoneRegion.end += presetRegion.end;
                                    zoneRegion.loopStart += presetRegion.loopStart;
                                    zoneRegion.loopEnd += presetRegion.loopEnd;
                                    zoneRegion.transpose += presetRegion.transpose;
                                    zoneRegion.tune += presetRegion.tune;
                                    zoneRegion.pitchKeyTrack += presetRegion.pitchKeyTrack;
                                    zoneRegion.attenuation += presetRegion.attenuation;
                                    zoneRegion.pan += presetRegion.pan;
                                    zoneRegion.ampEnv.delay += presetRegion.ampEnv.delay;
                                    zoneRegion.ampEnv.attack += presetRegion.ampEnv.attack;
                                    zoneRegion.ampEnv.hold += presetRegion.ampEnv.hold;
                                    zoneRegion.ampEnv.decay += presetRegion.ampEnv.decay;
                                    zoneRegion.ampEnv.sustain += presetRegion.ampEnv.sustain;
                                    zoneRegion.ampEnv.release += presetRegion.ampEnv.release;
                                    zoneRegion.ampEnv.keynumToHold += presetRegion.ampEnv.keynumToHold;
                                    zoneRegion.ampEnv.keynumToDecay += presetRegion.ampEnv.keynumToDecay;
                                    zoneRegion.modEnv.delay += presetRegion.modEnv.delay;
                                    zoneRegion.modEnv.attack += presetRegion.modEnv.attack;
                                    zoneRegion.modEnv.hold += presetRegion.modEnv.hold;
                                    zoneRegion.modEnv.decay += presetRegion.modEnv.decay;
                                    zoneRegion.modEnv.sustain += presetRegion.modEnv.sustain;
                                    zoneRegion.modEnv.release += presetRegion.modEnv.release;
                                    zoneRegion.modEnv.keynumToHold += presetRegion.modEnv.keynumToHold;
                                    zoneRegion.modEnv.keynumToDecay += presetRegion.modEnv.keynumToDecay;
                                    zoneRegion.initialFilterQ += presetRegion.initialFilterQ;
                                    zoneRegion.initialFilterFc += presetRegion.initialFilterFc;
                                    zoneRegion.modEnvToPitch += presetRegion.modEnvToPitch;
                                    zoneRegion.modEnvToFilterFc += presetRegion.modEnvToFilterFc;
                                    zoneRegion.delayModLFO += presetRegion.delayModLFO;
                                    zoneRegion.freqModLFO += presetRegion.freqModLFO;
                                    zoneRegion.modLfoToPitch += presetRegion.modLfoToPitch;
                                    zoneRegion.modLfoToFilterFc += presetRegion.modLfoToFilterFc;
                                    zoneRegion.modLfoToVolume += presetRegion.modLfoToVolume;
                                    zoneRegion.delayVibLFO += presetRegion.delayVibLFO;
                                    zoneRegion.freqVibLFO += presetRegion.freqVibLFO;
                                    zoneRegion.vibLfoToPitch += presetRegion.vibLfoToPitch;

                                    // EG times need to be converted from timecents to seconds.
                                    zoneRegion.ampEnv.envToSecs(true);
                                    zoneRegion.modEnv.envToSecs(false);

                                    // LFO times need to be converted from timecents to seconds.
                                    zoneRegion.delayModLFO =
                                        zoneRegion.delayModLFO < -11950.0
                                            ? 0.0
                                            : SynthHelper.timecents2Secs(zoneRegion.delayModLFO);
                                    zoneRegion.delayVibLFO =
                                        zoneRegion.delayVibLFO < -11950.0
                                            ? 0.0
                                            : SynthHelper.timecents2Secs(zoneRegion.delayVibLFO);

                                    // Pin values to their ranges.
                                    if (zoneRegion.pan < -0.5) {
                                        zoneRegion.pan = -0.5;
                                    } else if (zoneRegion.pan > 0.5) {
                                        zoneRegion.pan = 0.5;
                                    }

                                    zoneRegion.initialFilterQ = Math.max(0, Math.min(960, zoneRegion.initialFilterQ));

                                    const shdr: HydraShdr = hydra.sHdrs[igen.genAmount.wordAmount];
                                    const sampleType = shdr.sampleType & ~0x10;
                                    zoneRegion.offset += shdr.start;
                                    zoneRegion.end += shdr.end;
                                    zoneRegion.loopStart += shdr.startLoop;
                                    zoneRegion.loopEnd += shdr.endLoop;
                                    if (shdr.endLoop > 0) {
                                        zoneRegion.loopEnd -= 1;
                                    }

                                    if (zoneRegion.pitchKeyCenter === -1) {
                                        zoneRegion.pitchKeyCenter = shdr.originalPitch;
                                    }

                                    zoneRegion.tune += shdr.pitchCorrection;
                                    zoneRegion.sampleRate = shdr.sampleRate;

                                    const isPercussion = phdr.bank === SynthConstants.PercussionBank;

                                    const shouldLoadSamples =
                                        (isPercussion &&
                                            TinySoundFont._setContainsRange(
                                                percussionKeys,
                                                zoneRegion.loKey,
                                                zoneRegion.hiKey
                                            )) ||
                                        (!isPercussion && instrumentPrograms.has(phdr.preset));

                                    if (!shouldLoadSamples) {
                                        Logger.debug(
                                            'AlphaSynth',
                                            `Skipping load of unused sample ${shdr.sampleName} for preset ${phdr.presetName} (bank ${preset.bank} program ${preset.presetNumber})`
                                        );
                                        zoneRegion.samples = new Float32Array(0);
                                    } else if (sampleType === 1 || sampleType === 2 || sampleType === 4) {
                                        Logger.debug(
                                            'AlphaSynth',
                                            `Loading of used sample ${shdr.sampleName} for preset ${phdr.presetName} (bank ${preset.bank} program ${preset.presetNumber})`
                                        );

                                        // Embedded mono or one side of a stereo pair. Each side owns its zone/pan.
                                        const decompressVorbis = (shdr.sampleType & 0x10) !== 0;
                                        if (decompressVorbis) {
                                            // for SF3 the shdr contains the byte offsets within the overall buffer holding the OGG container
                                            zoneRegion.samples = hydra.decodeSamples(shdr.start, shdr.end, true);
                                            // loop points are already relative within the individual samples.
                                        } else {
                                            zoneRegion.samples = hydra.decodeSamples(
                                                // The DWORD dwStart contains the index, in sample data points, from the beginning of the sample data
                                                // field to the first data point of this sample
                                                zoneRegion.offset * 2,
                                                // The DWORD dwEnd contains the index, in sample data points, from the beginning of the sample data
                                                // field to the first of the set of 46 zero valued data points following this sample.
                                                zoneRegion.end * 2,
                                                false
                                            );

                                            // The DWORD dwStartloop contains the index, in sample data points, from the beginning of the sample data field to the first
                                            // data point in the loop of this sample

                                            // The DWORD dwEndloop contains the index, in sample data points, from the beginning of the sample data field to the first
                                            // data point following the loop of this sample. Note that this is the data point “equivalent to” the first loop data point, and that
                                            // to produce portable artifact free loops, the eight proximal data points surrounding both the Startloop and Endloop points
                                            // should be identical.

                                            // reset offsets relative to sub-buffer
                                            if (zoneRegion.loopStart > 0) {
                                                zoneRegion.loopStart -= zoneRegion.offset;
                                            }
                                            if (zoneRegion.loopEnd > 0) {
                                                zoneRegion.loopEnd -= zoneRegion.offset;
                                            }
                                        }

                                        // play whole sample
                                        zoneRegion.offset = 0;
                                        zoneRegion.end = zoneRegion.samples.length - 1;
                                    } else {
                                        // unsupported
                                        //  0x08: // Linked Sample
                                        //  0x8001: // RomMonoSample
                                        //  0x8002: // RomRightSample
                                        //  0x8004: // RomLeftSample
                                        //  0x8008: // RomLinkedSample
                                        Logger.warning(
                                            'AlphaSynth',
                                            `Skipping load of unsupported sample ${shdr.sampleName} for preset ${phdr.presetName}, sample type ${shdr.sampleType} is not supported (bank ${preset.bank} program ${preset.presetNumber})`
                                        );
                                        zoneRegion.samples = new Float32Array(0);
                                    }

                                    preset.regions[regionIndex] = new Region(zoneRegion);
                                    if (sampleType === 2 || sampleType === 4) {
                                        stereoRegions.push({ region: preset.regions[regionIndex],
                                            instrument: pgen.genAmount.wordAmount, presetZone: pbagIndex,
                                            sampleId: igen.genAmount.wordAmount, sampleLink: shdr.sampleLink,
                                            sampleType });
                                    }
                                    regionIndex++;

                                    hadSampleId = true;
                                } else {
                                    zoneRegion.operator(igen.genOper, igen.genAmount);
                                }
                            }

                            // Handle instrument's global zone.
                            if (ibag === hydra.ibags[inst.instBagNdx] && !hadSampleId) {
                                instRegion = new Region(zoneRegion);
                                instrumentGlobalModulators = instrumentLocalModulators;
                            }

                            // Other modulator destinations still require a general note-on/controller engine.
                        }

                        hadGenInstrument = true;
                    } else {
                        presetRegion.operator(pgen.genOper, pgen.genAmount);
                    }
                }

                // Handle preset's global zone.
                if (pbag === hydra.pbags[phdr.presetBagNdx] && !hadGenInstrument) {
                    globalRegion = presetRegion;
                    presetGlobalModulators = presetLocalModulators;
                }
            }
            const rejectedStereoRegions = linkStereoSampleRegions(stereoRegions);
            if (rejectedStereoRegions) {
                Logger.warning('AlphaSynth', `Skipped ${rejectedStereoRegions} unmatched or incompatible stereo regions in ${preset.name}`);
            }
        }

        if (!append || !this.presets) {
            this.presets = newPresets;
        } else {
            for (const preset of newPresets) {
                this.presets.push(preset);
            }
        }
    }

    private static _setContainsRange(x: Set<number>, lo: number, hi: number) {
        for (let i = lo; i <= hi; i++) {
            if (x.has(i)) {
                return true;
            }
        }
        return false;
    }

    public hasSamplesForProgram(program: number): boolean {
        const presets = this.presets;
        if (!presets) {
            return false;
        }

        for (const preset of presets) {
            if (preset.presetNumber === program) {
                for (const region of preset.regions!) {
                    if (region.samples.length > 0) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    public hasSamplesForPercussion(key: number): boolean {
        const presets = this.presets;
        if (!presets) {
            return false;
        }

        for (const preset of presets) {
            if (preset.bank === SynthConstants.PercussionBank) {
                for (const region of preset.regions!) {
                    if (region.loKey >= key && region.hiKey <= key && region.samples.length > 0) {
                        return true;
                    }
                }
            }
        }

        return false;
    }
}
