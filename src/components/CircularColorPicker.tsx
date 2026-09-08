import React, { useState, useRef, useEffect } from 'react';

interface CircularColorPickerProps {
  color: string;
  onChange: (newColor: string) => void;
  onClose: () => void;
}

// クイック選択用の鮮やかな代表色
const QUICK_COLORS = [
  '#FF4D4D', '#FF8533', '#FFC000', '#2ECC71',
  '#00D2D3', '#3498DB', '#9B59B6', '#E056FD',
  '#FFFFFF', '#8FA4C4'
];

export function CircularColorPicker({ color, onChange, onClose }: CircularColorPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);

  // 色相 (0〜360度) と 明度 (0〜100%) の簡易管理
  const [lightness, setLightness] = useState(50);

  // 外側クリックで自動で閉じる
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [onClose]);

  // 円形パレット上のクリック／ドラッグで色相を算出
  const handleWheelInteraction = (clientX: number, clientY: number) => {
    if (!wheelRef.current) return;
    const rect = wheelRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const dx = clientX - centerX;
    const dy = clientY - centerY;

    // 角度 (0〜360度) を算出
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle < 0) angle += 360;

    // HSL から HEX に変換して通知
    const newHex = hslToHex(angle, 100, lightness);
    onChange(newHex);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    handleWheelInteraction(e.clientX, e.clientY);

    const onMouseMove = (moveEvent: MouseEvent) => {
      handleWheelInteraction(moveEvent.clientX, moveEvent.clientY);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 190,
        background: '#141D34',
        border: '1px solid #243B54',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.65)',
        padding: 12,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 'bold', color: '#8FA4C4' }}>ノーツカラー設定</span>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: '#8FA4C4', cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          ✕
        </button>
      </div>

      {/* ドーナツ型 円形カラーパレット (Color Wheel) */}
      <div
        ref={wheelRef}
        onMouseDown={handleMouseDown}
        style={{
          width: 130,
          height: 130,
          borderRadius: '50%',
          background: 'conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
          position: 'relative',
          cursor: 'crosshair',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
        }}
      >
        {/* 中央の現在選択色プレビュー円 */}
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: '50%',
            background: color,
            border: '3px solid #141D34',
            boxShadow: 'inset 0 0 4px rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        />
      </div>

      {/* 明度調整スライダー */}
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: '#8FA4C4' }}>明度:</span>
        <input
          type="range"
          min={20}
          max={85}
          value={lightness}
          onChange={e => {
            const val = Number(e.target.value);
            setLightness(val);
            // 現在の色を明度に合わせて再計算
            const rgb = hexToRgb(color);
            if (rgb) {
              const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
              onChange(hslToHex(hsl.h, hsl.s, val));
            }
          }}
          style={{ flex: 1, accentColor: '#A4D3FF' }}
        />
      </div>

      {/* クイック代表色パレット */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5, width: '100%' }}>
        {QUICK_COLORS.map(c => (
          <div
            key={c}
            onClick={() => onChange(c)}
            style={{
              height: 18,
              borderRadius: 3,
              background: c,
              cursor: 'pointer',
              border: color.toUpperCase() === c.toUpperCase() ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.3)',
              boxSizing: 'border-box'
            }}
          />
        ))}
      </div>

      {/* ネイティブカラーピッカーの呼び出し (微細調整用) */}
      <label
        style={{
          width: '100%',
          textAlign: 'center',
          fontSize: 10,
          background: '#1C2742',
          color: '#A4D3FF',
          padding: '4px 0',
          borderRadius: 4,
          cursor: 'pointer',
          border: '1px solid #243B54'
        }}
      >
        カスタム色 (詳細)...
        <input
          type="color"
          value={color}
          onChange={e => onChange(e.target.value)}
          style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
        />
      </label>
    </div>
  );
}

// --- 色空間ヘルパー ---
function hslToHex(h: number, s: number, l: number): string {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}