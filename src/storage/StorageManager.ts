import { openDB, type IDBPDatabase } from 'idb';
import type { EnsemblePreset, PresetsStorageData, LaneSlot } from '../models/SongModels';

export interface SongMetadata {
  id: string;
  fileName: string;
  midiBlobKey: string;
  bgmBlobKey?: string;
  bgmFileName?: string;
  slots: LaneSlot[];
}

const DB_NAME = 'NewOtogeDB';
const DB_VERSION = 1;

export class StorageManager {
  private static instance: StorageManager;
  private dbPromise: Promise<IDBPDatabase>;

  private constructor() {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('presets')) {
          db.createObjectStore('presets', { keyPath: 'key' });
        }
      }
    });
  }

  public static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }

  // --- バイナリ Blob 管理 (MIDI / BGM 音声) ---
  public async saveBlob(key: string, data: ArrayBuffer): Promise<void> {
    const db = await this.dbPromise;
    await db.put('blobs', data, key);
  }

  public async getBlob(key: string): Promise<ArrayBuffer | null> {
    const db = await this.dbPromise;
    const data = await db.get('blobs', key);
    if (!data) return null;
    return data as ArrayBuffer;
  }

  public async deleteBlob(key: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('blobs', key);
  }

  // --- 楽曲メタデータ管理 ---
  public async saveSongMetadataList(list: SongMetadata[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('metadata', 'readwrite');
    await tx.store.clear();
    for (const item of list) {
      await tx.store.put(item);
    }
    await tx.done;
  }

  public async loadSongMetadataList(): Promise<SongMetadata[]> {
    const db = await this.dbPromise;
    return await db.getAll('metadata');
  }

  public async deleteSong(id: string, midiBlobKey: string, bgmBlobKey?: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('metadata', id);
    await db.delete('blobs', midiBlobKey);
    if (bgmBlobKey) {
      await db.delete('blobs', bgmBlobKey);
    }
  }

  // --- 全体編成プリセット管理 ---
  public async savePresetsData(data: PresetsStorageData): Promise<void> {
    const db = await this.dbPromise;
    await db.put('presets', { key: 'ensemble_presets', ...data });
  }

  public async loadPresetsData(): Promise<PresetsStorageData | null> {
    const db = await this.dbPromise;
    const res = await db.get('presets', 'ensemble_presets');
    if (!res) return null;
    return {
      activePresetID: res.activePresetID,
      presets: res.presets
    };
  }
}