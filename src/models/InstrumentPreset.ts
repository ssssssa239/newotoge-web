export interface InstrumentPreset {
  id: number;
  instId: number;
  name: string;
  mcuName: string;
  midiChannel: number;
  defaultOffsetMs: number;
  instanceIndex?: number; // 同名MCUの枝番 (1, 2, ...)
  endpointId?: string;    // 接続ポートの一意な内部ID
}

export const NONE_PRESET: InstrumentPreset = {
  id: 0,
  instId: 0,
  name: 'None',
  mcuName: 'None',
  midiChannel: 0,
  defaultOffsetMs: 0.0
};

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [NONE_PRESET];

const STORAGE_KEY = 'otoge_registered_mcu_presets';

export function loadRegisteredPresets(): InstrumentPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list: InstrumentPreset[] = JSON.parse(raw);
      if (Array.isArray(list)) {
        return [NONE_PRESET, ...list.filter(p => p.id !== 0 && p.mcuName !== 'None')];
      }
    }
  } catch {
    /* fallback */
  }
  return [NONE_PRESET];
}

export function saveRegisteredPresets(presets: InstrumentPreset[]): void {
  try {
    const toSave = presets.filter(p => p.id !== 0 && p.mcuName !== 'None');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    /* no-op */
  }
}

export function registerMcuPreset(mcuName: string, instId: number = 0): InstrumentPreset {
  const trimmed = mcuName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return NONE_PRESET;

  const current = loadRegisteredPresets();
  const existing = current.find(p => p.mcuName.toLowerCase() === trimmed.toLowerCase());
  
  if (existing) {
    if (instId > 0 && existing.instId === 0) {
      existing.instId = instId;
      existing.midiChannel = (instId - 1) & 0x0f;
      saveRegisteredPresets(current);
    }
    return existing;
  }

  const maxId = current.reduce((max, p) => Math.max(max, p.id), 0);
  const newId = maxId + 1;
  const channel = instId > 0 ? (instId - 1) & 0x0f : (newId - 1) & 0x0f;

  const newPreset: InstrumentPreset = {
    id: newId,
    instId: instId,
    name: trimmed,
    mcuName: trimmed,
    midiChannel: channel,
    defaultOffsetMs: -30.0
  };

  const updated = [...current, newPreset];
  saveRegisteredPresets(updated);
  return newPreset;
}