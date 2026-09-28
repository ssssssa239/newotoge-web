import { MidiNote } from '../models/SongModels';

export const KEY_SWITCH_BORDER_COLORS: Record<number, string> = {
  2: '#FFA500',
  3: '#00E5FF',
  4: '#389BFF',
  5: '#a851ff',
  6: '#FF5E7E',
  7: '#FF3344',
  8: '#00FF7F',
  9: '#FFD700',
  10: '#FF69B4',
};

export interface LoadedKeySwitchPreset {
  fileName: string;
  jsonContent: string;
  keySwitchMap: Map<number, { name: string; isEnabled: boolean }>;
}

export class KeySwitchManager {
  /**
   * JSON文字列からキースイッチ設定のみを安全に抽出
   */
  public static parsePresetKeySwitches(fileName: string, jsonString: string): LoadedKeySwitchPreset | null {
    try {
      const data = JSON.parse(jsonString);
      const map = new Map<number, { name: string; isEnabled: boolean }>();

      if (Array.isArray(data.keySwitches)) {
        for (const ks of data.keySwitches) {
          if (typeof ks.note === 'number') {
            map.set(ks.note, {
              name: ks.customName || ks.standardType || `KS-${ks.note}`,
              isEnabled: ks.isEnabled ?? true
            });
          }
        }
      }
      // ★ jsonContent に元の jsonString を含めて返す
      return { fileName, jsonContent: jsonString, keySwitchMap: map };
    } catch (e) {
      console.error('キースイッチ設定のパースに失敗しました:', e);
      return null;
    }
  }

  /**
   * トラック内の演奏ノーツ(#11以上)に奏法情報を付与
   */
  public static applyKeySwitchesToNotes(
    notes: MidiNote[],
    keySwitchMap?: Map<number, { name: string; isEnabled: boolean }>
  ): void {
    const sorted = [...notes].sort((a, b) => a.startTimeMs - b.startTimeMs);
    let currentKeySwitch: number = 1; // 初期状態: 通常奏法 (1)

    for (const note of sorted) {
      if (note.pitch >= 1 && note.pitch <= 10) {
        currentKeySwitch = note.pitch;
        continue;
      }

      if (keySwitchMap && currentKeySwitch > 1 && currentKeySwitch <= 10) {
        const config = keySwitchMap.get(currentKeySwitch);
        const borderColor = KEY_SWITCH_BORDER_COLORS[currentKeySwitch];

        if (config && config.isEnabled && borderColor) {
          note.articulation = {
            noteNumber: currentKeySwitch,
            name: config.name,
            borderColor: borderColor
          };
          continue;
        }
      }
      note.articulation = undefined;
    }
  }
}