import React, { useState, useEffect } from 'react';
import { MidiDeviceManager } from './engine/midi/MidiDeviceManager';
import { PlaybackEngine } from './engine/audio/PlaybackEngine';
import { MidiParser } from './engine/parser/MidiParser';
import { StorageManager, SongMetadata } from './storage/StorageManager';
import { MidiSongData, EnsemblePreset, LaneSlot } from './models/SongModels';
import { UnifiedMidiEndpoint } from './engine/midi/types';
import { INSTRUMENT_PRESETS } from './models/InstrumentPreset';
import { CanvasVisualizer } from './visualizer/CanvasVisualizer';

export function App() {
  const [songs, setSongs] = useState<MidiSongData[]>([]);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<UnifiedMidiEndpoint[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);

  // 編成プリセット
  const [presets, setPresets] = useState<EnsemblePreset[]>([{ id: 'default', name: 'プリセット 1', songSlots: {} }]);
  const [activePresetId, setActivePresetId] = useState('default');

  // ビジュアライザー設定
  const [selectedTab, setSelectedTab] = useState<'visualizer' | 'settings'>('visualizer');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentPlaybackMs, setCurrentPlaybackMs] = useState(0);
  const [isMetronome, setIsMetronome] = useState(true);
  const [isBgm, setIsBgm] = useState(true);
  const [isChromaKey, setIsChromaKey] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAllCh, setShowAllCh] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(0.20);

  // 単音テスト設定
  const [testPitch, setTestPitch] = useState(60);

  // --- 1. 起動時：IndexedDB から楽曲・BGM・プリセット・スロットを完全復元 ---
  useEffect(() => {
    const midiMgr = MidiDeviceManager.getInstance();
    midiMgr.initWebMidi();
    const unsubMidi = midiMgr.subscribe(setEndpoints);

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

        // アクティブプリセットに保存されているスロット設定を優先適用
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

  // --- 3. 永続化ヘルパー (変更があるたびに IndexedDB を最新状態に同期) ---
  const persistAll = async (
    targetSongs: MidiSongData[] = songs,
    targetPresets: EnsemblePreset[] = presets,
    targetActivePresetId: string = activePresetId
  ) => {
    const storage = StorageManager.getInstance();

    // 現アクティブプリセットに全楽曲の最新スロットを反映
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

    // IndexedDB へプリセット保存
    await storage.savePresetsData({
      activePresetID: targetActivePresetId,
      presets: syncedPresets
    });

    // IndexedDB へ楽曲メタデータ保存
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

    // プリセット内からも削除
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

  // --- 8. プリセット切り替え ---
  const handleSelectPreset = async (targetId: string) => {
    if (activePresetId === targetId) return;

    // 現在のスロット状態を現プリセットに同期
    const targetPreset = presets.find(p => p.id === targetId);
    if (!targetPreset) return;

    // 全楽曲のスロットを切り替え先プリセットの設定に更新
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

  // --- 9. 新規プリセット追加 ---
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

  // --- 10. スロット操作 (追加 / 変更 / 削除) ---
  const handleAddSlot = async () => {
    if (!currentSong) return;
    const defaultCh = currentSong.usedChannels[0] ?? 0;
    const newSlot: LaneSlot = {
      id: crypto.randomUUID(),
      isEnabled: true,
      selectedChannel: defaultCh,
      assignedPreset: INSTRUMENT_PRESETS[0],
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0D0D11', color: '#FFF', fontFamily: 'sans-serif' }}>
      {/* 1. トランスポートバー */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', background: '#181820', borderBottom: '1px solid #282834', gap: 12 }}>
        <button
          onClick={() => PlaybackEngine.getInstance().togglePlayPause()}
          style={{ padding: '6px 14px', background: '#00D9FF', border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer', color: '#000' }}
        >
          {isPlaying ? 'PAUSE' : 'PLAY'}
        </button>
        <button
          onClick={() => PlaybackEngine.getInstance().stop()}
          style={{ padding: '6px 12px', background: '#2C2C38', border: 'none', borderRadius: 4, color: '#FFF', cursor: 'pointer' }}
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
          style={{ flex: 1, accentColor: '#00D9FF' }}
        />
        <span style={{ fontSize: 12, fontFamily: 'monospace', minWidth: 90 }}>
          {(currentPlaybackMs / 1000).toFixed(1)}s / {((currentSong?.durationMs ?? 0) / 1000).toFixed(1)}s
        </span>

        {/* トグルボタン群 */}
        <button
          onClick={() => {
            const next = !isMetronome;
            setIsMetronome(next);
            PlaybackEngine.getInstance().isMetronomeEnabled = next;
          }}
          style={{ padding: '4px 8px', background: isMetronome ? '#2E4C38' : '#2C2C38', border: 'none', borderRadius: 4, color: '#FFF', fontSize: 11, cursor: 'pointer' }}
        >
          Click {isMetronome ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => {
            const next = !isBgm;
            setIsBgm(next);
            PlaybackEngine.getInstance().isBgmEnabled = next;
          }}
          style={{ padding: '4px 8px', background: isBgm ? '#2E4C38' : '#2C2C38', border: 'none', borderRadius: 4, color: '#FFF', fontSize: 11, cursor: 'pointer' }}
        >
          BGM {isBgm ? 'ON' : 'OFF'}
        </button>

        {/* 編成プリセットドロップダウン */}
        <select
          value={activePresetId}
          onChange={e => handleSelectPreset(e.target.value)}
          style={{ background: '#2C2C38', color: '#FFF', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}
        >
          {presets.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          onClick={handleAddPreset}
          title="新規プリセット追加"
          style={{ padding: '4px 8px', background: '#2C2C38', border: 'none', borderRadius: 4, color: '#00D9FF', fontWeight: 'bold', cursor: 'pointer' }}
        >
          +
        </button>

        {/* タブ切り替え */}
        <div style={{ background: '#2C2C38', borderRadius: 4, padding: 2, display: 'flex' }}>
          <button
            onClick={() => setSelectedTab('visualizer')}
            style={{ padding: '4px 10px', background: selectedTab === 'visualizer' ? '#00D9FF' : 'transparent', color: selectedTab === 'visualizer' ? '#000' : '#FFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Visualizer
          </button>
          <button
            onClick={() => setSelectedTab('settings')}
            style={{ padding: '4px 10px', background: selectedTab === 'settings' ? '#00D9FF' : 'transparent', color: selectedTab === 'settings' ? '#000' : '#FFF', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
          >
            Track Settings
          </button>
        </div>
      </div>

      {/* 2. メイン 2ペイン構造 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左ペイン: 楽曲リスト & 検出デバイス */}
        <div style={{ width: 280, borderRight: '1px solid #282834', display: 'flex', flexDirection: 'column', background: '#121218' }}>
          {/* 楽曲リスト */}
          <div style={{ flex: 1, padding: 12, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 'bold', color: '#AAA' }}>楽曲リスト ({songs.length})</span>
              <label style={{ fontSize: 11, background: '#00D9FF', color: '#000', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
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
                  background: song.id === selectedSongId ? 'rgba(0, 217, 255, 0.15)' : '#181822',
                  border: song.id === selectedSongId ? '1px solid #00D9FF' : '1px solid transparent'
                }}
              >
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontSize: 13, fontWeight: song.id === selectedSongId ? 'bold' : 'normal', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                    {song.fileName}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {(song.durationMs / 1000).toFixed(1)}s {song.bgmFileName && '• BGM付'}
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

          {/* 検出デバイス一覧 */}
          <div style={{ height: 260, borderTop: '1px solid #282834', padding: 12, overflowY: 'auto', background: '#0F0F14' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 'bold', color: '#AAA' }}>MIDIデバイス ({endpoints.length})</span>
              <button
                onClick={() => MidiDeviceManager.getInstance().connectBleDevice()}
                style={{ fontSize: 11, background: '#0055FF', border: 'none', color: '#FFF', padding: '3px 8px', borderRadius: 4, cursor: 'pointer' }}
              >
                + BLEペアリング
              </button>
            </div>
            {endpoints.map(ep => (
              <div
                key={ep.id}
                onClick={() => setSelectedEndpointId(ep.id)}
                style={{
                  fontSize: 12,
                  padding: '6px 8px',
                  marginBottom: 4,
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: ep.id === selectedEndpointId ? 'rgba(0, 85, 255, 0.2)' : '#181822',
                  border: ep.id === selectedEndpointId ? '1px solid #0055FF' : '1px solid transparent'
                }}
              >
                <div>{ep.name}</div>
                <div style={{ fontSize: 10, color: '#00D9FF' }}>
                  {ep.transport.toUpperCase()} {ep.identifiedPreset && `• ${ep.identifiedPreset.name}`}
                </div>
              </div>
            ))}

            {/* 単音テストUI */}
            {currentEndpoint && (
              <div style={{ marginTop: 10, padding: 8, background: '#1A1A24', borderRadius: 4 }}>
                <div style={{ fontSize: 11, color: '#AAA', marginBottom: 6 }}>単音テスト [{currentEndpoint.name}]</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="number"
                    min={0}
                    max={127}
                    value={testPitch}
                    onChange={e => setTestPitch(Number(e.target.value))}
                    style={{ width: 45, background: '#282834', color: '#FFF', border: '1px solid #444', borderRadius: 3, fontSize: 11, padding: 2 }}
                  />
                  <button
                    onClick={() => MidiDeviceManager.getInstance().testSingleNote(currentEndpoint, 0, testPitch)}
                    style={{ fontSize: 11, background: '#00D9FF', border: 'none', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontWeight: 'bold', color: '#000' }}
                  >
                    送信
                  </button>
                  <button
                    onClick={() => MidiDeviceManager.getInstance().sendAllNotesOff(currentEndpoint, 0)}
                    style={{ fontSize: 11, background: '#FF4444', color: '#FFF', border: 'none', padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}
                  >
                    Off
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右ペイン: ビジュアライザー or トラック設定 */}
        <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          {selectedTab === 'visualizer' ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 16px', background: isChromaKey ? '#00CC00' : '#14141C', fontSize: 12 }}>
                <label style={{ color: isChromaKey ? '#000' : '#AAA' }}>
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
                <label style={{ color: isChromaKey ? '#000' : '#FFF', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> 拍グリッド
                </label>
                <label style={{ color: isChromaKey ? '#000' : '#FFF', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isChromaKey} onChange={e => setIsChromaKey(e.target.checked)} /> クロマキー
                </label>
                <label style={{ color: isChromaKey ? '#000' : '#FFF', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showAllCh} onChange={e => setShowAllCh(e.target.checked)} /> 全Ch表示
                </label>
                <label style={{ color: isChromaKey ? '#000' : '#FFF', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} /> HUD
                </label>
              </div>

              <div style={{ flex: 1, position: 'relative' }}>
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
                    <label style={{ fontSize: 12, background: '#2E7D32', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>
                      BGM音声を紐付け (.mp3, .wav, .ogg)
                      <input type="file" accept="audio/*" onChange={handleBgmUpload} style={{ display: 'none' }} />
                    </label>
                    {currentSong.bgmFileName && <span style={{ fontSize: 12, color: '#4CAF50' }}>✓ {currentSong.bgmFileName}</span>}
                    <button
                      onClick={handleAddSlot}
                      style={{ marginLeft: 'auto', fontSize: 12, background: '#00D9FF', border: 'none', padding: '6px 12px', borderRadius: 4, color: '#000', fontWeight: 'bold', cursor: 'pointer' }}
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
                          background: slot.isEnabled ? '#18241C' : '#181822',
                          border: '1px solid #282834',
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
                          style={{ background: '#282834', color: '#FFF', border: '1px solid #444', borderRadius: 4, padding: '4px 8px' }}
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

                        {/* 送信先楽器 */}
                        <select
                          value={slot.assignedPreset.id}
                          onChange={e => {
                            const p = INSTRUMENT_PRESETS.find(x => x.id === Number(e.target.value))!;
                            handleUpdateSlot(slot.id, { assignedPreset: p, latencyOffsetMs: p.defaultOffsetMs });
                          }}
                          style={{ background: '#282834', color: '#FFF', border: '1px solid #444', borderRadius: 4, padding: '4px 8px' }}
                        >
                          {INSTRUMENT_PRESETS.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
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
                <div style={{ color: '#888' }}>左側の楽曲リストから楽曲を選択してください。</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;