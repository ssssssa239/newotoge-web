import React, { useState, useEffect, useRef } from 'react';
import { MidiDeviceManager } from './engine/midi/MidiDeviceManager';
import { PlaybackEngine } from './engine/audio/PlaybackEngine';
import { MidiParser } from './engine/parser/MidiParser';
import { StorageManager, SongMetadata } from './storage/StorageManager';
import { MidiSongData, EnsemblePreset, LaneSlot } from './models/SongModels';
import { UnifiedMidiEndpoint } from './engine/midi/types';
import { loadRegisteredPresets, InstrumentPreset, NONE_PRESET } from './models/InstrumentPreset';
import { CanvasVisualizer } from './visualizer/CanvasVisualizer';

export function App() {
  const [songs, setSongs] = useState<MidiSongData[]>([]);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<UnifiedMidiEndpoint[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);

  // 永続化されたMCU一覧（手動バインド用）および接続中デバイスから動的生成されたターゲット一覧（#1, #2 枝番付き）
  const [knownPresets, setKnownPresets] = useState<InstrumentPreset[]>(() => loadRegisteredPresets());
  const [availableTargets, setAvailableTargets] = useState<InstrumentPreset[]>(() =>
    MidiDeviceManager.getInstance().getAvailableMcuTargets()
  );

  // サイドバー表示・非表示フラグ
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // MIDIデバイスパネルの高さ管理 (初期値 260px)
  const [devicePanelHeight, setDevicePanelHeight] = useState(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // 境界線のドラッグ開始処理
  const handleStartResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);

    const startY = e.clientY;
    const initialHeight = devicePanelHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      // 下にドラッグするとYが増え、デバイス一覧の高さは小さくなる
      const deltaY = moveEvent.clientY - startY;
      const nextHeight = initialHeight - deltaY;

      // 最小 100px、最大 550px の範囲にクランプ
      const clamped = Math.min(Math.max(100, nextHeight), 550);
      setDevicePanelHeight(clamped);
    };

    const onMouseUp = () => {
      setIsResizingSidebar(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 編成プリセット
  const [presets, setPresets] = useState<EnsemblePreset[]>([{ id: 'default', name: 'プリセット 1', songSlots: {} }]);
  const [activePresetId, setActivePresetId] = useState('default');
  const [isPresetMenuOpen, setIsPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);

  // ビジュアライザー設定
  const [selectedTab, setSelectedTab] = useState<'visualizer' | 'settings'>('visualizer');
  const [isControlBarOpen, setIsControlBarOpen] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPlaybackMs, setCurrentPlaybackMs] = useState(0);
  const [isMetronome, setIsMetronome] = useState(true);
  const [isBgm, setIsBgm] = useState(true);
  const [isChromaKey, setIsChromaKey] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAllCh, setShowAllCh] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(0.20);

  // ストレージ情報ポップアップ用のステート
  const [isStorageMenuOpen, setIsStorageMenuOpen] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null);
  const storageMenuRef = useRef<HTMLDivElement | null>(null);

  // 単音テスト設定
  const [testPitch, setTestPitch] = useState(60);

  // プリセットメニュー & ストレージメニューの外側クリック検知
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (presetMenuRef.current && !presetMenuRef.current.contains(target)) {
        setIsPresetMenuOpen(false);
      }
      if (storageMenuRef.current && !storageMenuRef.current.contains(target)) {
        setIsStorageMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // StorageManager API から使用量と上限を取得する
  const handleOpenStorageInfo = async () => {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      setStorageInfo({
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0
      });
    }
    setIsStorageMenuOpen(prev => !prev);
  };

  // バイト数を用途に応じた単位 (KB / MB / GB) に変換
  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  // ミリ秒を YouTube 風の「分:秒 (m:ss)」形式に変換
  const formatTime = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const formattedSec = seconds.toString().padStart(2, '0');

    if (hours > 0) {
      const formattedMin = minutes.toString().padStart(2, '0');
      return `${hours}:${formattedMin}:${formattedSec}`;
    }
    return `${minutes}:${formattedSec}`;
  };

  // --- 1. 起動時：IndexedDB から楽曲・BGM・プリセット・スロットを復元 ---
  useEffect(() => {
    const midiMgr = MidiDeviceManager.getInstance();
    midiMgr.initWebMidi();
    const unsubMidi = midiMgr.subscribe(newEndpoints => {
      setEndpoints(newEndpoints);
      setKnownPresets(loadRegisteredPresets());
      setAvailableTargets(midiMgr.getAvailableMcuTargets());
    });

    const engine = PlaybackEngine.getInstance();
    const unsubAudio = engine.subscribe((playing, ms) => {
      setIsPlaying(playing);
      setCurrentPlaybackMs(ms);
    });

    const initLoad = async () => {
      const storage = StorageManager.getInstance();

      // (1) 編成プリセットをロード
      let loadedPresets: EnsemblePreset[] = [{ id: 'default', name: 'プリセット 1', songSlots: {} }];
      let loadedActiveId = 'default';

      const presetData = await storage.loadPresetsData();
      if (presetData && presetData.presets.length > 0) {
        loadedPresets = presetData.presets;
        loadedActiveId = presetData.activePresetID;
        setPresets(loadedPresets);
        setActivePresetId(loadedActiveId);
      }

      // (2) 楽曲リストとバイナリをロード
      const metadataList = await storage.loadSongMetadataList();
      const loadedSongs: MidiSongData[] = [];

      for (const meta of metadataList) {
        const midiBuffer = await storage.getBlob(meta.midiBlobKey);
        if (!midiBuffer) continue;

        const song = MidiParser.parse(midiBuffer, meta.fileName, meta.id);
        song.bgmBlobKey = meta.bgmBlobKey;
        song.bgmFileName = meta.bgmFileName;

        const activePreset = loadedPresets.find(p => p.id === loadedActiveId);
        if (activePreset && activePreset.songSlots[meta.id] && activePreset.songSlots[meta.id].length > 0) {
          song.slots = activePreset.songSlots[meta.id];
        } else if (meta.slots && meta.slots.length > 0) {
          song.slots = meta.slots;
        }

        loadedSongs.push(song);
      }

      if (loadedSongs.length > 0) {
        setSongs(loadedSongs);
        const first = loadedSongs[0];
        setSelectedSongId(first.id);
        engine.prepareSong(first);

        if (first.bgmBlobKey) {
          const bgmBuf = await storage.getBlob(first.bgmBlobKey);
          if (bgmBuf) await engine.setBgmAudio(bgmBuf);
        }
      }
    };

    initLoad();

    return () => {
      unsubMidi();
      unsubAudio();
    };
  }, []);

  // --- 2. 再生中のシークバー追従（50ms周期） ---
  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setCurrentPlaybackMs(PlaybackEngine.getInstance().getCurrentPlaybackMs());
    }, 50);
    return () => clearInterval(timer);
  }, [isPlaying]);

  const currentSong = songs.find(s => s.id === selectedSongId) ?? null;
  const currentEndpoint = endpoints.find(e => e.id === selectedEndpointId) ?? null;
  const activePreset = presets.find(p => p.id === activePresetId);

  // --- 3. 永続化ヘルパー ---
  const persistAll = async (
    targetSongs: MidiSongData[] = songs,
    targetPresets: EnsemblePreset[] = presets,
    targetActivePresetId: string = activePresetId
  ) => {
    const storage = StorageManager.getInstance();

    const syncedPresets = targetPresets.map(p => {
      if (p.id === targetActivePresetId) {
        const slotsMap: Record<string, LaneSlot[]> = { ...p.songSlots };
        for (const s of targetSongs) {
          slotsMap[s.id] = s.slots;
        }
        return { ...p, songSlots: slotsMap };
      }
      return p;
    });

    setPresets(syncedPresets);

    await storage.savePresetsData({
      activePresetID: targetActivePresetId,
      presets: syncedPresets
    });

    const metaList: SongMetadata[] = targetSongs.map(s => ({
      id: s.id,
      fileName: s.fileName,
      midiBlobKey: s.midiBlobKey,
      bgmBlobKey: s.bgmBlobKey,
      bgmFileName: s.bgmFileName,
      slots: s.slots
    }));
    await storage.saveSongMetadataList(metaList);
  };

  // --- 4. 楽曲追加 ---
  const handleMidiUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newSongs: MidiSongData[] = [];
    const storage = StorageManager.getInstance();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buffer = await file.arrayBuffer();
      const parsed = MidiParser.parse(buffer, file.name);
      await storage.saveBlob(parsed.midiBlobKey, buffer);
      newSongs.push(parsed);
    }

    const updatedSongs = [...songs, ...newSongs];
    setSongs(updatedSongs);

    if (!selectedSongId && newSongs.length > 0) {
      const first = newSongs[0];
      setSelectedSongId(first.id);
      PlaybackEngine.getInstance().prepareSong(first);
    }

    await persistAll(updatedSongs);
  };

  // --- 5. 楽曲削除 ---
  const handleDeleteSong = async (songToDelete: MidiSongData) => {
    const storage = StorageManager.getInstance();
    await storage.deleteSong(songToDelete.id, songToDelete.midiBlobKey, songToDelete.bgmBlobKey);

    const updatedSongs = songs.filter(s => s.id !== songToDelete.id);
    setSongs(updatedSongs);

    const updatedPresets = presets.map(p => {
      const newSlots = { ...p.songSlots };
      delete newSlots[songToDelete.id];
      return { ...p, songSlots: newSlots };
    });

    if (selectedSongId === songToDelete.id) {
      if (updatedSongs.length > 0) {
        setSelectedSongId(updatedSongs[0].id);
        PlaybackEngine.getInstance().prepareSong(updatedSongs[0]);
      } else {
        setSelectedSongId(null);
        PlaybackEngine.getInstance().prepareSong(null);
      }
    }

    await persistAll(updatedSongs, updatedPresets);
  };

  // --- 6. 楽曲選択切り替え ---
  const handleSelectSong = async (song: MidiSongData) => {
    if (selectedSongId === song.id) return;
    setSelectedSongId(song.id);
    const engine = PlaybackEngine.getInstance();
    engine.prepareSong(song);

    if (song.bgmBlobKey) {
      const bgmBuf = await StorageManager.getInstance().getBlob(song.bgmBlobKey);
      if (bgmBuf) await engine.setBgmAudio(bgmBuf);
    } else {
      engine.clearBgmAudio();
    }
  };

  // --- 7. BGM 紐付け ---
  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentSong) return;

    const buffer = await file.arrayBuffer();
    const blobKey = `bgm_${currentSong.id}`;
    await StorageManager.getInstance().saveBlob(blobKey, buffer);
    await PlaybackEngine.getInstance().setBgmAudio(buffer);

    const updatedSongs = songs.map(s =>
      s.id === currentSong.id ? { ...s, bgmBlobKey: blobKey, bgmFileName: file.name } : s
    );
    setSongs(updatedSongs);
    await persistAll(updatedSongs);
  };

  // --- 8. プリセット操作 ---
  const handleSelectPreset = async (targetId: string) => {
    if (activePresetId === targetId) return;

    const targetPreset = presets.find(p => p.id === targetId);
    if (!targetPreset) return;

    const updatedSongs = songs.map(song => {
      const savedSlots = targetPreset.songSlots[song.id];
      return savedSlots && savedSlots.length > 0 ? { ...song, slots: savedSlots } : song;
    });

    setActivePresetId(targetId);
    setSongs(updatedSongs);

    if (currentSong) {
      const currentUpdated = updatedSongs.find(s => s.id === currentSong.id);
      if (currentUpdated) {
        PlaybackEngine.getInstance().updateSlotConfiguration(currentUpdated);
      }
    }

    await persistAll(updatedSongs, presets, targetId);
  };

  const handleAddPreset = async () => {
    const newId = crypto.randomUUID();
    const newPreset: EnsemblePreset = {
      id: newId,
      name: `プリセット ${presets.length + 1}`,
      songSlots: {}
    };

    const updatedPresets = [...presets, newPreset];
    setPresets(updatedPresets);
    setActivePresetId(newId);

    await persistAll(songs, updatedPresets, newId);
  };

  const handleRenamePreset = async () => {
    if (!activePreset) return;
    const newName = window.prompt('編成プリセットの新しい名前を入力してください:', activePreset.name);
    if (!newName || !newName.trim()) return;

    const trimmed = newName.trim();
    const updatedPresets = presets.map(p =>
      p.id === activePresetId ? { ...p, name: trimmed } : p
    );
    setPresets(updatedPresets);
    await persistAll(songs, updatedPresets, activePresetId);
  };

  const handleDeletePreset = async () => {
    if (presets.length <= 1) {
      alert('これ以上プリセットを削除することはできません。');
      return;
    }
    if (!activePreset) return;

    const confirmDelete = window.confirm(`プリセット「${activePreset.name}」を削除してもよろしいですか？`);
    if (!confirmDelete) return;

    const targetIdx = presets.findIndex(p => p.id === activePresetId);
    const updatedPresets = presets.filter(p => p.id !== activePresetId);
    const nextPreset = updatedPresets[Math.max(0, targetIdx - 1)];
    const nextId = nextPreset.id;

    const updatedSongs = songs.map(song => {
      const savedSlots = nextPreset.songSlots[song.id];
      return savedSlots && savedSlots.length > 0 ? { ...song, slots: savedSlots } : song;
    });

    setActivePresetId(nextId);
    setPresets(updatedPresets);
    setSongs(updatedSongs);

    if (currentSong) {
      const currentUpdated = updatedSongs.find(s => s.id === currentSong.id);
      if (currentUpdated) {
        PlaybackEngine.getInstance().updateSlotConfiguration(currentUpdated);
      }
    }

    await persistAll(updatedSongs, updatedPresets, nextId);
  };

  // --- 9. スロット操作 (初期値は常に NONE_PRESET) ---
  const handleAddSlot = async () => {
    if (!currentSong) return;
    const defaultCh = currentSong.usedChannels[0] ?? 0;
    const newSlot: LaneSlot = {
      id: crypto.randomUUID(),
      isEnabled: true,
      selectedChannel: defaultCh,
      assignedPreset: NONE_PRESET,
      latencyOffsetMs: 0.0
    };
    const updatedSlots = [...currentSong.slots, newSlot];
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  const handleUpdateSlot = async (slotId: string, updates: Partial<LaneSlot>) => {
    if (!currentSong) return;
    const updatedSlots = currentSong.slots.map(s => (s.id === slotId ? { ...s, ...updates } : s));
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  const handleDeleteSlot = async (slotId: string) => {
    if (!currentSong) return;
    const updatedSlots = currentSong.slots.filter(s => s.id !== slotId);
    const updatedSong = { ...currentSong, slots: updatedSlots };
    const updatedSongs = songs.map(s => (s.id === currentSong.id ? updatedSong : s));

    setSongs(updatedSongs);
    PlaybackEngine.getInstance().updateSlotConfiguration(updatedSong);
    await persistAll(updatedSongs);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0A0E1A', color: '#E2EFFF', fontFamily: 'sans-serif' }}>
      {/* 1. トランスポートバー */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', background: '#141D34', borderBottom: '2px solid #243B54', gap: 12 }}>
        {/* macOS風 サイドバー開閉トグルボタン */}
        <button
          onClick={() => setIsSidebarOpen(prev => !prev)}
          title={isSidebarOpen ? 'サイドバーを隠す' : 'サイドバーを表示'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '5px 8px',
            background: isSidebarOpen ? '#243B54' : '#1C2742',
            border: '1px solid #243B54',
            borderRadius: 4,
            color: '#A4D3FF',
            cursor: 'pointer'
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>

        <button
          onClick={() => PlaybackEngine.getInstance().togglePlayPause()}
          style={{ padding: '6px 14px', background: '#587CEA', border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer', color: '#ffffff' }}
        >
          {isPlaying ? 'PAUSE' : 'PLAY'}
        </button>
        <button
          onClick={() => PlaybackEngine.getInstance().stop()}
          style={{ padding: '6px 11px', background: '#3E4163', border: 'none', borderRadius: 4, color: '#E2EFFF', cursor: 'pointer' }}
        >
          STOP
        </button>

        {/* シークバー */}
        <input
          type="range"
          min={0}
          max={currentSong?.durationMs ?? 100}
          value={currentPlaybackMs}
          onChange={e => PlaybackEngine.getInstance().seek(Number(e.target.value))}
          style={{ flex: 1, accentColor: '#A4D3FF' }}
        />
        <span style={{ fontSize: 12, fontFamily: 'monospace', minWidth: 80, textAlign: 'center' }}>
          {formatTime(currentPlaybackMs)} / {formatTime(currentSong?.durationMs ?? 0)}
        </span>

        {/* トグルボタン群 */}
        <button
          onClick={() => {
            const next = !isMetronome;
            setIsMetronome(next);
            PlaybackEngine.getInstance().isMetronomeEnabled = next;
          }}
          style={{ padding: '4px 8px', background: isMetronome ? '#706cad' : '#1C2742', border: 'none', borderRadius: 4, color: '#E2EFFF', fontSize: 11, cursor: 'pointer' }}
        >
          Click {isMetronome ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => {
            const next = !isBgm;
            setIsBgm(next);
            PlaybackEngine.getInstance().isBgmEnabled = next;
          }}
          style={{ padding: '4px 8px', background: isBgm ? '#8871c4' : '#1C2742', border: 'none', borderRadius: 4, color: '#E2EFFF', fontSize: 11, cursor: 'pointer' }}
        >
          BGM {isBgm ? 'ON' : 'OFF'}
        </button>

        {/* 編成プリセット管理 ドロップダウンメニュー */}
        <div ref={presetMenuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setIsPresetMenuOpen(prev => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#1C2742',
              color: '#E2EFFF',
              border: '1px solid #243B54',
              borderRadius: 4,
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            <span>{activePreset?.name ?? 'プリセット選択'}</span>
            <span style={{ fontSize: 9, color: '#A4D3FF' }}>▼</span>
          </button>

          {isPresetMenuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                minWidth: 200,
                background: '#141D34',
                border: '1px solid #243B54',
                borderRadius: 6,
                boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
                padding: '4px 0',
                zIndex: 1000
              }}
            >
              <div style={{ padding: '5px 12px', fontSize: 10, fontWeight: 'bold', color: '#8FA4C4' }}>
                編成プリセット選択
              </div>
              {presets.map(p => (
                <div
                  key={p.id}
                  onClick={() => {
                    handleSelectPreset(p.id);
                    setIsPresetMenuOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    background: p.id === activePresetId ? 'rgba(78, 167, 230, 0.15)' : 'transparent',
                    color: p.id === activePresetId ? '#A4D3FF' : '#E2EFFF'
                  }}
                  onMouseEnter={e => {
                    if (p.id !== activePresetId) e.currentTarget.style.background = '#1C2742';
                  }}
                  onMouseLeave={e => {
                    if (p.id !== activePresetId) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span>{p.name}</span>
                  {p.id === activePresetId && <span style={{ fontSize: 11 }}>✓</span>}
                </div>
              ))}

              <div style={{ height: 1, background: '#243B54', margin: '4px 0' }} />

              <div
                onClick={() => {
                  setIsPresetMenuOpen(false);
                  handleAddPreset();
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#A4D3FF',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>＋</span>
                <span>プリセットを追加</span>
              </div>

              <div
                onClick={() => {
                  setIsPresetMenuOpen(false);
                  handleRenamePreset();
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#E2EFFF',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>✎</span>
                <span>プリセット名を変更...</span>
              </div>

              {presets.length > 1 && (
                <div
                  onClick={() => {
                    setIsPresetMenuOpen(false);
                    handleDeletePreset();
                  }}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: '#FF4444',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1C2742')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span>🗑</span>
                  <span>現在のプリセットを削除</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* タブ切り替え（Visualizer / Track Settings） */}
        <div style={{ background: '#1C2742', borderRadius: 4, padding: 2, display: 'flex' }}>
          <button
            onClick={() => setSelectedTab('visualizer')}
            style={{ padding: '4px 10px', background: selectedTab === 'visualizer' ? '#A4D3FF' : 'transparent', color: selectedTab === 'visualizer' ? '#101F33' : '#E2EFFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Visualizer
          </button>
          <button
            onClick={() => setSelectedTab('settings')}
            style={{ padding: '4px 10px', background: selectedTab === 'settings' ? '#A4D3FF' : 'transparent', color: selectedTab === 'settings' ? '#101F33' : '#E2EFFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Track Settings
          </button>
        </div>

        {/* タブ枠から分離した独立ボタン (固定サイズ 32x28px でズレを防止) */}
        {selectedTab === 'visualizer' ? (
          <button
            onClick={() => setIsControlBarOpen(prev => !prev)}
            title={isControlBarOpen ? 'コントロールバーを収納' : 'コントロールバーを展開'}
            style={{
              width: 32,
              height: 28,
              boxSizing: 'border-box',
              padding: 0,
              background: isControlBarOpen ? '#243B54' : '#1C2742',
              border: '1px solid #243B54',
              borderRadius: 4,
              color: isControlBarOpen ? '#A4D3FF' : '#8FA4C4',
              cursor: 'pointer',
              fontSize: 10,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            {isControlBarOpen ? '▲' : '▼'}
          </button>
        ) : (
          <div ref={storageMenuRef} style={{ position: 'relative', width: 32, height: 28, flexShrink: 0 }}>
            <button
              onClick={handleOpenStorageInfo}
              title="ストレージ使用状況を確認"
              style={{
                width: 32,
                height: 28,
                boxSizing: 'border-box',
                padding: 0,
                background: isStorageMenuOpen ? '#243B54' : '#1C2742',
                border: '1px solid #243B54',
                borderRadius: 4,
                color: isStorageMenuOpen ? '#A4D3FF' : '#8FA4C4',
                cursor: 'pointer',
                fontSize: 10,
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
              </svg>
            </button>

            {/* ストレージ情報ポップオーバー */}
            {isStorageMenuOpen && storageInfo && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  width: 230,
                  background: '#141D34',
                  border: '1px solid #243B54',
                  borderRadius: 6,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
                  padding: '12px',
                  zIndex: 1000
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 'bold', color: '#A4D3FF', marginBottom: 8 }}>
                  ローカルストレージ (IndexedDB)
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: '#8FA4C4' }}>使用量:</span>
                  <span style={{ fontWeight: 'bold', color: '#E2EFFF' }}>{formatBytes(storageInfo.usage)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                  <span style={{ color: '#8FA4C4' }}>割当上限:</span>
                  <span style={{ color: '#E2EFFF' }}>{formatBytes(storageInfo.quota)}</span>
                </div>

                <div style={{ width: '100%', height: 6, background: '#1C2742', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(1, (storageInfo.usage / (storageInfo.quota || 1)) * 100))}%`,
                      background: '#A4D3FF',
                      borderRadius: 3
                    }}
                  />
                </div>

                <div style={{ fontSize: 10, color: '#8FA4C4', textAlign: 'right' }}>
                  使用率: {((storageInfo.usage / (storageInfo.quota || 1)) * 100).toFixed(2)}%
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. メイン 2ペイン構造 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左ペイン: 楽曲リスト & 検出デバイス */}
        {isSidebarOpen && (
          <div style={{ width: 280, borderRight: '2px solid #243B54', display: 'flex', flexDirection: 'column', background: '#1D202C' }}>
            
            {/* 楽曲リスト (残り高さいっぱいに広がり、最小100pxを確保) */}
            <div style={{ flex: 1, minHeight: 100, padding: 12, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 'bold', color: '#8FA4C4' }}>楽曲リスト ({songs.length})</span>
                <label style={{ fontSize: 11, background: '#A4D3FF', color: '#101F33', padding: '1px 8px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
                  + 追加
                  <input type="file" multiple accept=".mid,.midi" onChange={handleMidiUpload} style={{ display: 'none' }} />
                </label>
              </div>
              {songs.map(song => (
                <div
                  key={song.id}
                  onClick={() => handleSelectSong(song)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '8px',
                    marginBottom: 4,
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: song.id === selectedSongId ? 'rgba(78, 167, 230, 0.12)' : '#181822',
                    border: song.id === selectedSongId ? '1px solid #A4D3FF' : '1px solid transparent'
                  }}
                >
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 13, fontWeight: song.id === selectedSongId ? 'bold' : 'normal', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                      {song.fileName}
                    </div>
                    <div style={{ fontSize: 11, color: '#8FA4C4', marginTop: 2 }}>
                      {formatTime(song.durationMs)} {song.bgmFileName && '• BGM付'}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSong(song);
                    }}
                    title="楽曲を削除"
                    style={{ background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', padding: 4, fontSize: 12 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#FF4444')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#666')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* 上下ドラッグリサイズ用スプリッター境界線 */}
            <div
              onMouseDown={handleStartResize}
              title="上下にドラッグしてサイズを調整"
              style={{
                height: 8,
                cursor: 'row-resize',
                background: isResizingSidebar ? '#587CEA' : '#141D34',
                borderTop: '1px solid #243B54',
                borderBottom: '1px solid #243B54',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                userSelect: 'none',
                transition: 'background 0.15s',
                zIndex: 10
              }}
              onMouseEnter={e => {
                if (!isResizingSidebar) e.currentTarget.style.background = '#2A3C5A';
              }}
              onMouseLeave={e => {
                if (!isResizingSidebar) e.currentTarget.style.background = '#141D34';
              }}
            >
              {/* つまみアイコン (3本のドット) */}
              <div style={{ display: 'flex', gap: 3 }}>                
                <div style={{ width: 24, height: 2, background: isResizingSidebar ? '#E2EFFF' : '#8FA4C4', borderRadius: 1 }} />
              </div>
            </div>

            {/* 検出デバイス一覧 (高さを動的 state で制御) */}
            <div style={{ height: devicePanelHeight, padding: 12, overflowY: 'auto', background: '#1D202C' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 'bold', color: '#8FA4C4' }}>MIDIデバイス ({endpoints.length})</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => MidiDeviceManager.getInstance().probeSerialDeviceManually()}
                    title="USB接続されたマイコンから楽器名を直接取得して自動照合します"
                    style={{ fontSize: 11, background: '#175883', border: 'none', color: '#E2EFFF', padding: '2px 7px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
                  >
                    + USB照合
                  </button>
                  <button
                    onClick={() => MidiDeviceManager.getInstance().connectBleDevice()}
                    style={{ fontSize: 11, background: '#4058C2', border: 'none', color: '#E2EFFF', padding: '2px 7px', borderRadius: 4, cursor: 'pointer' }}
                  >
                    + Bluetooth
                  </button>
                </div>
              </div>

              {endpoints.length === 0 && (
                <div style={{ fontSize: 11, color: '#8FA4C4', padding: '4px 0' }}>接続中のデバイスはありません</div>
              )}

              {endpoints.map(ep => (
                <div
                  key={ep.id}
                  onClick={() => setSelectedEndpointId(ep.id)}
                  style={{
                    fontSize: 12,
                    padding: '8px',
                    marginBottom: 6,
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: ep.id === selectedEndpointId ? 'rgba(78, 167, 230, 0.12)' : '#181822',
                    border: ep.id === selectedEndpointId ? '1px solid #587CEA' : '1px solid #243B54'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 'bold' }}>{ep.name}</span>
                    <span style={{ fontSize: 9, background: '#243B54', padding: '1px 5px', borderRadius: 3, color: '#A4D3FF' }}>
                      {ep.transport.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: '#8FA4C4' }}>楽器:</span>
                    <select
                      value={ep.identifiedPreset?.id ?? 0}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        e.stopPropagation();
                        MidiDeviceManager.getInstance().setEndpointPreset(ep.id, Number(e.target.value));
                      }}
                      style={{
                        flex: 1,
                        background: '#243B54',
                        color: ep.identifiedPreset && ep.identifiedPreset.id !== 0 ? '#A4D3FF' : '#8FA4C4',
                        border: '1px solid #4e598c',
                        borderRadius: 3,
                        fontSize: 11,
                        padding: '2px 4px'
                      }}
                    >
                      {knownPresets.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}

              {/* 単音テストUI */}
              {currentEndpoint && (
                <div style={{ marginTop: 10, padding: 8, background: '#1A1A24', borderRadius: 4 }}>
                  <div style={{ fontSize: 11, color: '#8FA4C4', marginBottom: 6 }}>
                    単音テスト [{currentEndpoint.name} → {currentEndpoint.identifiedPreset?.name ?? '未割当'}]
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="number"
                      min={0}
                      max={127}
                      value={testPitch}
                      onChange={e => setTestPitch(Number(e.target.value))}
                      style={{ width: 45, background: '#243B54', color: '#E2EFFF', border: '1px solid #243B54', borderRadius: 3, fontSize: 11, padding: 2 }}
                    />
                    <button
                      onClick={() => MidiDeviceManager.getInstance().testSingleNote(currentEndpoint, 0, testPitch)}
                      style={{ fontSize: 11, background: '#A4D3FF', border: 'none', padding: '1px 8px', borderRadius: 3, cursor: 'pointer', fontWeight: 'bold', color: '#101F33' }}
                    >
                      送信
                    </button>
                    <button
                      onClick={() => MidiDeviceManager.getInstance().sendAllNotesOff(currentEndpoint, 0)}
                      style={{ fontSize: 11, background: '#FF4444', color: '#E2EFFF', border: 'none', padding: '1px 8px', borderRadius: 3, cursor: 'pointer' }}
                    >
                      Off
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 右ペイン: ビジュアライザー or トラック設定 */}
        <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          {selectedTab === 'visualizer' ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
              {/* 補助コントロールバー */}
              {isControlBarOpen && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 16px',
                    background: isChromaKey ? '#00CC00' : '#121217',
                    borderBottom: '1px solid #243B54',
                    fontSize: 12,
                    flexShrink: 0
                  }}
                >
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF' }}>
                    速度:
                    <input
                      type="range"
                      min={0.05}
                      max={1.0}
                      step={0.01}
                      value={scrollSpeed}
                      onChange={e => setScrollSpeed(Number(e.target.value))}
                      style={{ marginLeft: 6, width: 80, verticalAlign: 'middle' }}
                    />
                    <span style={{ marginLeft: 4 }}>{scrollSpeed.toFixed(2)}</span>
                  </label>
                  <label style={{ color: isChromaKey ? '#331010' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> 拍グリッド
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={isChromaKey} onChange={e => setIsChromaKey(e.target.checked)} /> クロマキー
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showAllCh} onChange={e => setShowAllCh(e.target.checked)} /> 全Ch表示
                  </label>
                  <label style={{ color: isChromaKey ? '#101F33' : '#E2EFFF', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} /> HUD
                  </label>
                </div>
              )}

              {/* ビジュアライザー描画領域 */}
              <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
                <CanvasVisualizer
                  song={currentSong}
                  scrollSpeedPxPerMs={scrollSpeed}
                  isChromaKeyEnabled={isChromaKey}
                  showGridLines={showGrid}
                  showAllChannels={showAllCh}
                  showDebugHUD={showDebug}
                />
              </div>
            </div>
          ) : (
            <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
              <h3 style={{ marginTop: 0 }}>
                レーン・スロット設定 [{activePreset?.name}] - {currentSong?.fileName ?? '未選択'}
              </h3>
              {currentSong ? (
                <div>
                  <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <label style={{ fontSize: 12, background: '#175883', padding: '6px 11px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
                      BGM音声を紐付け (.mp3, .wav, .ogg)
                      <input type="file" accept="audio/*" onChange={handleBgmUpload} style={{ display: 'none' }} />
                    </label>
                    {currentSong.bgmFileName && <span style={{ fontSize: 12, color: '#88D5DA' }}>✓ {currentSong.bgmFileName}</span>}
                    <button
                      onClick={handleAddSlot}
                      style={{ marginLeft: 'auto', fontSize: 12, background: '#A4D3FF', border: 'none', padding: '6px 11px', borderRadius: 4, color: '#101F33', fontWeight: 'bold', cursor: 'pointer' }}
                    >
                      + レーン追加
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {currentSong.slots.map(slot => (
                      <div
                        key={slot.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 16,
                          padding: '10px 14px',
                          background: slot.isEnabled ? '#31344b' : '#181822',
                          border: '1px solid #575b77',
                          borderRadius: 6
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={slot.isEnabled}
                          onChange={e => handleUpdateSlot(slot.id, { isEnabled: e.target.checked })}
                        />

                        {/* 抽出チャンネル */}
                        <select
                          value={slot.selectedChannel}
                          onChange={e => handleUpdateSlot(slot.id, { selectedChannel: Number(e.target.value) })}
                          style={{ background: '#2D376A', color: '#E2EFFF', border: '1px solid #4e598c', borderRadius: 4, padding: '4px 8px' }}
                        >
                          {Array.from({ length: 16 }, (_, i) => {
                            const count = currentSong.channelCaches[i]?.noteCount ?? 0;
                            return (
                              <option key={i} value={i}>
                                Ch {i + 1} ({count} notes)
                              </option>
                            );
                          })}
                        </select>

                        {/* 送信先楽器 (動的ターゲット一覧を描画: #1, #2 枝番付き) */}
                        <select
                          value={
                            slot.assignedPreset?.endpointId ??
                            (slot.assignedPreset?.instanceIndex
                              ? `${slot.assignedPreset.mcuName}#${slot.assignedPreset.instanceIndex}`
                              : slot.assignedPreset?.mcuName ?? 'None')
                          }
                          onChange={e => {
                            const val = e.target.value;
                            const target = availableTargets.find(
                              t => (t.endpointId ? t.endpointId === val : t.mcuName === val)
                            ) ?? NONE_PRESET;
                            handleUpdateSlot(slot.id, { assignedPreset: target, latencyOffsetMs: target.defaultOffsetMs });
                          }}
                          style={{ background: '#2D376A', color: '#E2EFFF', border: '1px solid #4e598c', borderRadius: 4, padding: '4px 8px' }}
                        >
                          {availableTargets.map(p => {
                            const optValue = p.endpointId ?? p.mcuName;
                            return (
                              <option key={optValue} value={optValue}>
                                {p.name} {p.id !== 0 ? `(Ch:${p.midiChannel + 1})` : ''}
                              </option>
                            );
                          })}
                        </select>

                        {/* 遅延補正スライダー */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 12, minWidth: 50, textAlign: 'right', fontFamily: 'monospace' }}>{slot.latencyOffsetMs}ms</span>
                          <input
                            type="range"
                            min={-200}
                            max={200}
                            step={1}
                            value={slot.latencyOffsetMs}
                            onChange={e => handleUpdateSlot(slot.id, { latencyOffsetMs: Number(e.target.value) })}
                            style={{ width: 100 }}
                          />
                        </div>

                        <button
                          onClick={() => handleDeleteSlot(slot.id)}
                          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#FF4444', cursor: 'pointer', fontSize: 14 }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ color: '#8FA4C4' }}>左側の楽曲リストから楽曲を選択してください。</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;