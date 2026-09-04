import { MidiSongData, BeatEvent } from '../../models/SongModels';
import { MidiDeviceManager } from '../midi/MidiDeviceManager';

interface ScheduledNote {
  pitch: number;
  velocity: number;
  channel: number;
  endpointId?: string;
  adjustedOnTimeMs: number;
  adjustedOffTimeMs: number;
}

interface ActiveNote {
  channel: number;
  endpointId: string;
  pitch: number;
  offTimeMs: number;
}

export class PlaybackEngine {
  private static instance: PlaybackEngine;

  private audioCtx: AudioContext | null = null;
  private bgmBuffer: AudioBuffer | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmGain: GainNode | null = null;

  private strongClickBuffer: AudioBuffer | null = null;
  private weakClickBuffer: AudioBuffer | null = null;

  // 再生タイムベース
  private isPlayingState = false;
  private playbackStartAudioTime = 0;
  private startOffsetPositionMs = 0;
  private pausedPositionMs = 0;
  public totalDurationMs = 0;

  public isMetronomeEnabled = true;
  public isBgmEnabled = true;

  // MIDIスケジューリング
  private activeSong: MidiSongData | null = null;
  private scheduledNotes: ScheduledNote[] = [];
  private nextNoteIdx = 0;
  private activeNotes: ActiveNote[] = [];
  private beatList: BeatEvent[] = [];
  private nextBeatIdx = 0;

  private timerWorkerId: number | null = null;
  private listeners: Set<(isPlaying: boolean, currentMs: number) => void> = new Set();

  private constructor() {}

  public static getInstance(): PlaybackEngine {
    if (!PlaybackEngine.instance) {
      PlaybackEngine.instance = new PlaybackEngine();
    }
    return PlaybackEngine.instance;
  }

  private initAudio(): AudioContext {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

      this.bgmGain = this.audioCtx.createGain();
      this.bgmGain.connect(this.audioCtx.destination);

      this.createClickBuffers(this.audioCtx);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  /**
   * Swift版と同様、15msの合成サイン波エンベロープバッファを生成
   */
  private createClickBuffers(ctx: AudioContext): void {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * 0.015);

    // 強拍: 1000Hz (amp: 0.7)
    const strong = ctx.createBuffer(1, length, sampleRate);
    const sData = strong.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = 1.0 - i / length;
      sData[i] = Math.sin(2.0 * Math.PI * 1000.0 * t) * env * 0.7;
    }
    this.strongClickBuffer = strong;

    // 弱拍: 800Hz (amp: 0.35)
    const weak = ctx.createBuffer(1, length, sampleRate);
    const wData = weak.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = 1.0 - i / length;
      wData[i] = Math.sin(2.0 * Math.PI * 800.0 * t) * env * 0.35;
    }
    this.weakClickBuffer = weak;
  }

  public async setBgmAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    const ctx = this.initAudio();
    this.bgmBuffer = await ctx.decodeAudioData(arrayBuffer);
  }

  public clearBgmAudio(): void {
    this.bgmBuffer = null;
    this.stopBgm();
  }

  public prepareSong(song: MidiSongData | null): void {
    this.stop();
    this.activeSong = song;
    this.totalDurationMs = song?.durationMs ?? 0;
    this.pausedPositionMs = 0;
    this.startOffsetPositionMs = 0;
  }

  public getCurrentPlaybackMs(): number {
    if (!this.isPlayingState || !this.audioCtx) {
      return this.pausedPositionMs;
    }
    const elapsedSec = this.audioCtx.currentTime - this.playbackStartAudioTime;
    return Math.min(this.totalDurationMs, this.startOffsetPositionMs + elapsedSec * 1000.0);
  }

  public togglePlayPause(): void {
    if (this.isPlayingState) {
      this.pause();
    } else {
      this.play();
    }
  }

  public play(): void {
    if (this.isPlayingState || !this.activeSong) return;
    const ctx = this.initAudio();

    if (this.pausedPositionMs >= this.totalDurationMs) {
      this.pausedPositionMs = 0;
    }
    this.startOffsetPositionMs = this.pausedPositionMs;
    this.playbackStartAudioTime = ctx.currentTime;
    this.isPlayingState = true;

    this.rebuildSchedule(this.startOffsetPositionMs);
    this.playBgm(this.startOffsetPositionMs);

    // 3ms 高精度スケジューリングループ（Web Worker風のsetInterval）
    this.timerWorkerId = window.setInterval(() => {
      this.processTick();
    }, 3);

    this.notifyState();
  }

  public pause(): void {
    if (!this.isPlayingState) return;
    this.pausedPositionMs = this.getCurrentPlaybackMs();
    this.isPlayingState = false;

    if (this.timerWorkerId !== null) {
      clearInterval(this.timerWorkerId);
      this.timerWorkerId = null;
    }
    this.stopBgm();
    this.sendAllActiveNotesOff();
    this.notifyState();
  }

  public stop(): void {
    this.pause();
    this.pausedPositionMs = 0;
    this.startOffsetPositionMs = 0;
    this.notifyState();
  }

  public seek(toMs: number): void {
    const clamped = Math.max(0, Math.min(toMs, this.totalDurationMs));
    const wasPlaying = this.isPlayingState;
    if (wasPlaying) this.pause();
    this.pausedPositionMs = clamped;
    this.startOffsetPositionMs = clamped;
    if (wasPlaying) this.play();
    this.notifyState();
  }

  public updateSlotConfiguration(song: MidiSongData): void {
    this.activeSong = song;
    if (this.isPlayingState) {
      const curMs = this.getCurrentPlaybackMs();
      this.rebuildSchedule(curMs);
    }
  }

  private rebuildSchedule(fromMs: number): void {
    if (!this.activeSong) return;
    const midiMgr = MidiDeviceManager.getInstance();
    const endpoints = midiMgr.getEndpoints();
    const items: ScheduledNote[] = [];

    for (const slot of this.activeSong.slots) {
      if (!slot.isEnabled || slot.assignedPreset.id === 0) continue;
      const cache = this.activeSong.channelCaches[slot.selectedChannel];
      if (!cache || cache.noteCount === 0) continue;

      const matchedEp = endpoints.find(
        ep =>
          ep.identifiedPreset?.id === slot.assignedPreset.id ||
          ep.name.toLowerCase().includes(slot.assignedPreset.mcuName.toLowerCase())
      );

      const offset = slot.latencyOffsetMs;
      const sendChannel = slot.assignedPreset.midiChannel;

      for (const note of cache.notes) {
        const onMs = note.startTimeMs + offset;
        const offMs = note.endTimeMs + offset;
        if (offMs > fromMs) {
          items.push({
            pitch: note.pitch,
            velocity: note.velocity,
            channel: sendChannel,
            endpointId: matchedEp?.id,
            adjustedOnTimeMs: onMs,
            adjustedOffTimeMs: offMs
          });
        }
      }
    }

    items.sort((a, b) => a.adjustedOnTimeMs - b.adjustedOnTimeMs);
    this.scheduledNotes = items;
    this.nextNoteIdx = items.findIndex(n => n.adjustedOnTimeMs >= fromMs);
    if (this.nextNoteIdx === -1) this.nextNoteIdx = items.length;

    this.beatList = this.activeSong.beatEvents;
    this.nextBeatIdx = this.beatList.findIndex(b => b.timeMs >= fromMs);
    if (this.nextBeatIdx === -1) this.nextBeatIdx = this.beatList.length;
  }

  private processTick(): void {
    const curMs = this.getCurrentPlaybackMs();
    const midiMgr = MidiDeviceManager.getInstance();
    const epMap = new Map(midiMgr.getEndpoints().map(ep => [ep.id, ep]));

    // 1. Note On 送信
    while (this.nextNoteIdx < this.scheduledNotes.length && this.scheduledNotes[this.nextNoteIdx].adjustedOnTimeMs <= curMs) {
      const item = this.scheduledNotes[this.nextNoteIdx++];
      if (item.endpointId && epMap.has(item.endpointId)) {
        const ep = epMap.get(item.endpointId)!;
        const status = 0x90 | (item.channel & 0x0f);
        midiMgr.sendBytes(ep, [status, item.pitch & 0x7f, item.velocity & 0x7f]);
        this.activeNotes.push({
          channel: item.channel,
          endpointId: item.endpointId,
          pitch: item.pitch,
          offTimeMs: item.adjustedOffTimeMs
        });
      }
    }

    // 2. Note Off 送信
    let i = 0;
    while (i < this.activeNotes.length) {
      if (this.activeNotes[i].offTimeMs <= curMs) {
        const record = this.activeNotes[i];
        if (epMap.has(record.endpointId)) {
          const ep = epMap.get(record.endpointId)!;
          const status = 0x80 | (record.channel & 0x0f);
          midiMgr.sendBytes(ep, [status, record.pitch & 0x7f, 0]);
        }
        this.activeNotes.splice(i, 1);
      } else {
        i++;
      }
    }

    // 3. メトロノーム クリック再生
    if (this.nextBeatIdx < this.beatList.length && this.beatList[this.nextBeatIdx].timeMs <= curMs) {
      const beat = this.beatList[this.nextBeatIdx++];
      if (this.isMetronomeEnabled) {
        this.playClick(beat.isAccent);
      }
    }

    // 曲末尾終了
    if (curMs >= this.totalDurationMs && this.totalDurationMs > 0) {
      this.stop();
    }
  }

  private playClick(isAccent: boolean): void {
    if (!this.audioCtx) return;
    const buf = isAccent ? this.strongClickBuffer : this.weakClickBuffer;
    if (!buf) return;

    const source = this.audioCtx.createBufferSource();
    source.buffer = buf;
    source.connect(this.audioCtx.destination);
    source.start();
  }

  private playBgm(fromMs: number): void {
    if (!this.audioCtx || !this.bgmBuffer || !this.isBgmEnabled) return;
    this.stopBgm();

    const startSec = fromMs / 1000.0;
    if (startSec >= this.bgmBuffer.duration) return;

    this.bgmSource = this.audioCtx.createBufferSource();
    this.bgmSource.buffer = this.bgmBuffer;
    this.bgmSource.connect(this.bgmGain!);
    this.bgmSource.start(0, startSec);
  }

  private stopBgm(): void {
    if (this.bgmSource) {
      try { this.bgmSource.stop(); } catch { /* no-op */ }
      this.bgmSource.disconnect();
      this.bgmSource = null;
    }
  }

  private sendAllActiveNotesOff(): void {
    const midiMgr = MidiDeviceManager.getInstance();
    const epMap = new Map(midiMgr.getEndpoints().map(ep => [ep.id, ep]));
    for (const record of this.activeNotes) {
      const ep = epMap.get(record.endpointId);
      if (ep) {
        midiMgr.sendBytes(ep, [0x80 | (record.channel & 0x0f), record.pitch & 0x7f, 0]);
      }
    }
    this.activeNotes = [];
  }

  public subscribe(cb: (isPlaying: boolean, currentMs: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyState(): void {
    const cur = this.getCurrentPlaybackMs();
    this.listeners.forEach(cb => cb(this.isPlayingState, cur));
  }
}