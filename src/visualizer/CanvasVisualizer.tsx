import React, { useRef, useEffect, useState } from 'react';
import { MidiSongData } from '../models/SongModels';
import { PlaybackEngine } from '../engine/audio/PlaybackEngine';

interface Props {
  song: MidiSongData | null;
  scrollSpeedPxPerMs?: number;
  isChromaKeyEnabled?: boolean;
  showGridLines?: boolean;
  showAllChannels?: boolean;
  showDebugHUD?: boolean;
}

// デフォルトのチャンネルカラー
export const DEFAULT_CHANNEL_COLORS = [
  '#FF4D4D', '#FF8533', '#FFC000', '#2ECC71',
  '#00D2D3', '#3498DB', '#9B59B6', '#E056FD',
  '#FF6B81', '#1DD1A1', '#F368E0', '#54A0FF',
  '#5F27CD', '#C8D6E5', '#FF9F43', '#10AC84'
];

interface VisualizerLane {
  channel: number;
  title: string;
  presetId: number;
  isAssigned: boolean;
  color: string;
  noteCount: number;
}

// レーン情報の算出 (slot.customColor を最優先で反映)
function getRenderLanes(song: MidiSongData | null, showAllChannels: boolean): VisualizerLane[] {
  if (!song) return [];
  const activeSlots = song.slots.filter(s => s.isEnabled && s.assignedPreset.id !== 0);

  if (!showAllChannels) {
    return activeSlots.map(slot => {
      const count = song.channelCaches[slot.selectedChannel]?.noteCount ?? 0;
      // customColor があれば優先、なければデフォルト色
      const color = slot.customColor || DEFAULT_CHANNEL_COLORS[slot.selectedChannel % 16];
      return {
        channel: slot.selectedChannel,
        title: slot.assignedPreset.name,
        presetId: slot.assignedPreset.id,
        isAssigned: true,
        color,
        noteCount: count
      };
    });
  } else {
    return song.usedChannels.map(ch => {
      const count = song.channelCaches[ch]?.noteCount ?? 0;
      const slot = activeSlots.find(s => s.selectedChannel === ch);
      if (slot) {
        const color = slot.customColor || DEFAULT_CHANNEL_COLORS[ch % 16];
        return {
          channel: ch,
          title: slot.assignedPreset.name,
          presetId: slot.assignedPreset.id,
          isAssigned: true,
          color,
          noteCount: count
        };
      } else {
        return {
          channel: ch,
          title: 'None',
          presetId: 0,
          isAssigned: false,
          color: 'rgba(115, 115, 122, 0.45)',
          noteCount: count
        };
      }
    });
  }
}

export const CanvasVisualizer: React.FC<Props> = ({
  song,
  scrollSpeedPxPerMs = 0.20,
  isChromaKeyEnabled = false,
  showGridLines = true,
  showAllChannels = false,
  showDebugHUD = false
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hudText, setHudText] = useState('');

  const lanes = getRenderLanes(song, showAllChannels);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();
    let frameCount = 0;
    let lastFpsUpdate = performance.now();

    const render = () => {
      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;
      frameCount++;

      if (now - lastFpsUpdate >= 500) {
        const fps = (frameCount * 1000) / (now - lastFpsUpdate);
        setHudText(`FPS: ${fps.toFixed(1)} | Delta: ${delta.toFixed(1)}ms`);
        frameCount = 0;
        lastFpsUpdate = now;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      // 背景クリア（通常: #0A0E1A / クロマキー: #00FF00）
      ctx.fillStyle = isChromaKeyEnabled ? '#00FF00' : '#0A0E1A';
      ctx.fillRect(0, 0, width, height);

      if (!song || lanes.length === 0) {
        ctx.restore();
        animId = requestAnimationFrame(render);
        return;
      }

      const engine = PlaybackEngine.getInstance();
      const currentMs = engine.getCurrentPlaybackMs();
      const judgeLineY = height * 0.8;
      const speed = scrollSpeedPxPerMs;
      const laneWidth = width / lanes.length;

      // 1. 小節/拍グリッド線
      if (showGridLines && song.beatEvents.length > 0) {
        const topMs = currentMs - (height - judgeLineY) / speed;
        const bottomMs = currentMs + judgeLineY / speed;

        for (const beat of song.beatEvents) {
          if (beat.timeMs < topMs) continue;
          if (beat.timeMs > bottomMs) break;

          const diffMs = beat.timeMs - currentMs;
          const y = Math.round(judgeLineY - diffMs * speed);

          ctx.lineWidth = beat.isAccent ? 2 : 1;
          ctx.strokeStyle = beat.isAccent
            ? (isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.4)')
            : (isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.15)');

          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      // 2. 判定ライン
      if (!isChromaKeyEnabled) {
        ctx.fillStyle = 'rgba(126, 202, 220, 0.35)';
        ctx.fillRect(0, judgeLineY - 2, width, 6);
      }
      ctx.fillStyle = isChromaKeyEnabled ? '#101F33' : 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(0, judgeLineY, width, 2.5);

      // 3. レーン境界線
      ctx.strokeStyle = isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.3)' : 'rgba(36, 59, 84, 0.7)';
      ctx.lineWidth = 1.5;
      for (let i = 1; i < lanes.length; i++) {
        const x = i * laneWidth;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // 4. ノーツ描画 (重なり防止 ＋ 明瞭な輪郭・立体感の付与)
      const topMs = currentMs - (height - judgeLineY) / speed - 50;
      const bottomMs = currentMs + judgeLineY / speed + 50;

      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        const cache = song.channelCaches[lane.channel];
        if (!cache || cache.noteCount === 0) continue;

        const visibleNotes = cache.visibleNotes(topMs, bottomMs);
        const laneX = i * laneWidth;
        const minP = cache.minPitch;
        const maxP = cache.maxPitch;
        const pitchRange = Math.max(1, maxP - minP);

        // 1音あたりのグリッド幅
        const stepX = (laneWidth - 16) / pitchRange;
        // 重なりを防ぐため、ピッチ幅よりわずかに小さい幅（最小6px、最大 stepX - 1px）にする
        const noteWidth = Math.max(6, Math.min(stepX - 1.5, 28));

        for (const note of visibleNotes) {
          const yBottom = judgeLineY - (note.startTimeMs - currentMs) * speed;
          const yTop = judgeLineY - (note.endTimeMs - currentMs) * speed;
          const noteHeight = Math.max(4, yBottom - yTop);

          const p = Math.min(Math.max(note.pitch, minP), maxP);
          const innerX = 8 + (p - minP) * stepX;
          const x = Math.round(laneX + innerX - noteWidth / 2);

          const isHit = currentMs >= note.startTimeMs && currentMs <= note.endTimeMs;

          // ① ノーツ本体の塗り（ヒット時は発光色）
          ctx.fillStyle = isHit ? '#E2EFFF' : lane.color;
          ctx.beginPath();
          ctx.roundRect(x, yTop, noteWidth, noteHeight, 2.5);
          ctx.fill();

          // ② 境界線（暗いフチ取り）を描画して、和音や連打の重なりを明瞭に分離
          ctx.strokeStyle = isChromaKeyEnabled
            ? 'rgba(0, 0, 0, 0.5)'
            : isHit
            ? '#FFFFFF'
            : 'rgba(10, 14, 26, 0.75)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [song, lanes, scrollSpeedPxPerMs, isChromaKeyEnabled, showGridLines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* 1. 各レーンの上部ヘッダーバー */}
      {lanes.length > 0 && (
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: 30,
            flexShrink: 0,
            borderBottom: '2px solid #243B54',
            background: isChromaKeyEnabled ? '#CBD7E6' : '#36485E'
          }}
        >
          {lanes.map((lane, index) => (
            <div
              key={`${lane.channel}_${index}`}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderLeft: index > 0 ? (isChromaKeyEnabled ? '1px solid rgba(0,0,0,0.2)' : '1px solid #243B54') : 'none',
                position: 'relative',
                overflow: 'hidden',
                padding: '0 6px'
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 'bold',
                  color: isChromaKeyEnabled
                    ? '#101F33'
                    : lane.isAssigned ? '#E2EFFF' : '#8FA4C4',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  maxWidth: '100%',
                  textAlign: 'center'
                }}
              >
                {lane.title}
              </div>

              {/* レーン下部のカスタムカラーライン */}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 3,
                  background: lane.color
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* 2. Canvas 描画エリア */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'block'
          }}
        />

        {showDebugHUD && (
          <div
            style={{
              position: 'absolute',
              bottom: 12,
              right: 12,
              background: 'rgba(0, 0, 0, 0.85)',
              color: '#E2EFFF',
              padding: '6px 10px',
              borderRadius: 6,
              fontFamily: 'monospace',
              fontSize: 11,
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            {hudText}
          </div>
        )}
      </div>
    </div>
  );
};