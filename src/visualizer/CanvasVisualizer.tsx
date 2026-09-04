import React, { useRef, useEffect, useState } from 'react';
import { MidiSongData, ChannelCache } from '../models/SongModels';
import { PlaybackEngine } from '../engine/audio/PlaybackEngine';

interface Props {
  song: MidiSongData | null;
  scrollSpeedPxPerMs?: number;
  isChromaKeyEnabled?: boolean;
  showGridLines?: boolean;
  showAllChannels?: boolean;
  showDebugHUD?: boolean;
}

const LANE_COLORS = [
  'rgba(0, 217, 255, 0.85)',
  'rgba(51, 230, 77, 0.85)',
  'rgba(255, 217, 26, 0.85)',
  'rgba(255, 140, 0, 0.85)',
  'rgba(255, 51, 153, 0.85)',
  'rgba(179, 77, 242, 0.85)',
  'rgba(0, 242, 179, 0.85)',
  'rgba(89, 89, 255, 0.85)',
  'rgba(26, 204, 204, 0.85)',
  'rgba(51, 128, 255, 0.85)'
];
const UNASSIGNED_COLOR = 'rgba(115, 115, 122, 0.55)';

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

      // DPR (Device Pixel Ratio) 補正
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      // 背景クリア（通常: #121217 / クロマキー: #00FF00）
      ctx.fillStyle = isChromaKeyEnabled ? '#00FF00' : '#121217';
      ctx.fillRect(0, 0, width, height);

      if (!song) {
        ctx.restore();
        animId = requestAnimationFrame(render);
        return;
      }

      const engine = PlaybackEngine.getInstance();
      const currentMs = engine.getCurrentPlaybackMs();
      const judgeLineY = height * 0.8;
      const speed = scrollSpeedPxPerMs;

      // レーン決定
      const activeSlots = song.slots.filter(s => s.isEnabled && s.assignedPreset.id !== 0);
      const lanes = showAllChannels
        ? song.usedChannels.map((ch, idx) => {
            const slot = activeSlots.find(s => s.selectedChannel === ch);
            return {
              channel: ch,
              isAssigned: !!slot,
              color: slot ? LANE_COLORS[idx % LANE_COLORS.length] : UNASSIGNED_COLOR
            };
          })
        : activeSlots.map((s, idx) => ({
            channel: s.selectedChannel,
            isAssigned: true,
            color: LANE_COLORS[idx % LANE_COLORS.length]
          }));

      if (lanes.length === 0) {
        ctx.restore();
        animId = requestAnimationFrame(render);
        return;
      }

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
        ctx.fillStyle = 'rgba(0, 217, 255, 0.35)';
        ctx.fillRect(0, judgeLineY - 2, width, 6);
      }
      ctx.fillStyle = isChromaKeyEnabled ? '#000000' : 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(0, judgeLineY, width, 2.5);

      // 3. レーン境界線
      ctx.strokeStyle = isChromaKeyEnabled ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1.5;
      for (let i = 1; i < lanes.length; i++) {
        const x = i * laneWidth;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // 4. ノーツ描画 (SDF角丸矩形の再現)
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

        for (const note of visibleNotes) {
          const yBottom = judgeLineY - (note.startTimeMs - currentMs) * speed;
          const yTop = judgeLineY - (note.endTimeMs - currentMs) * speed;
          const noteHeight = Math.max(4, yBottom - yTop);

          const p = Math.min(Math.max(note.pitch, minP), maxP);
          const noteWidth = Math.max(6, (laneWidth / pitchRange) * 1.1);
          const innerX = ((p - minP) / pitchRange) * (laneWidth - noteWidth - 8) + 4;
          const x = laneX + innerX;

          const isHit = currentMs >= note.startTimeMs && currentMs <= note.endTimeMs;

          ctx.fillStyle = isHit ? '#FFFFFF' : lane.color;
          ctx.beginPath();
          ctx.roundRect(x, yTop, noteWidth, noteHeight, 2.5);
          ctx.fill();

          if (!isChromaKeyEnabled) {
            ctx.strokeStyle = isHit ? lane.color : 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = isHit ? 2 : 0.8;
            ctx.stroke();
          }
        }
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [song, scrollSpeedPxPerMs, isChromaKeyEnabled, showGridLines, showAllChannels]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {showDebugHUD && (
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            background: 'rgba(0, 0, 0, 0.85)',
            color: '#FFF',
            padding: '6px 10px',
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          {hudText}
        </div>
      )}
    </div>
  );
};