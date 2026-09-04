export interface InstrumentPreset {
  id: number;
  instId: number;
  name: string;
  mcuName: string;
  midiChannel: number; // 0〜15
  defaultOffsetMs: number;
}

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  { id: 0, instId: 0,  name: "None",              mcuName: "None",              midiChannel: 0,  defaultOffsetMs: 0.0 },
  { id: 1, instId: 23, name: "KeyHarmonica",       mcuName: "KeyHarmonica",       midiChannel: (23 - 1) & 0x0F, defaultOffsetMs: -30.0 },
  { id: 2, instId: 26, name: "AcousticGuitar",     mcuName: "AcousticGuitar",     midiChannel: (26 - 1) & 0x0F, defaultOffsetMs: -50.0 },
  { id: 3, instId: 30, name: "PowerChordGT",       mcuName: "PowerChordGT",       midiChannel: (30 - 1) & 0x0F, defaultOffsetMs: -40.0 },
  { id: 4, instId: 31, name: "LEADGT_DOUBLE",      mcuName: "LEADGT_DOUBLE",      midiChannel: (31 - 1) & 0x0F, defaultOffsetMs: -40.0 },
  { id: 5, instId: 31, name: "LEADGT_PEDALBEND",   mcuName: "LEADGT+PEDALBEND",   midiChannel: (31 - 1) & 0x0F, defaultOffsetMs: -40.0 },
  { id: 6, instId: 64, name: "AltoSax",            mcuName: "AltoSax",            midiChannel: (64 - 1) & 0x0F, defaultOffsetMs: -30.0 },
  { id: 7, instId: 64, name: "AltoSax_PedalBend",   mcuName: "AltoSax+PedalBend",   midiChannel: (64 - 1) & 0x0F, defaultOffsetMs: -30.0 },
  { id: 8, instId: 65, name: "SopranoSax",         mcuName: "SopranoSax",         midiChannel: (65 - 1) & 0x0F, defaultOffsetMs: -30.0 },
  { id: 9, instId: 99, name: "Other",              mcuName: "Other",              midiChannel: (99 - 1) & 0x0F, defaultOffsetMs: 0.0 }
];

export function findPresetByMcuName(rawName: string): InstrumentPreset | undefined {
  const trimmed = rawName.trim().toLowerCase();
  if (!trimmed) return undefined;
  return (
    INSTRUMENT_PRESETS.find(p => p.id !== 0 && p.mcuName.toLowerCase() === trimmed) ||
    INSTRUMENT_PRESETS.find(p => p.id !== 0 && (trimmed.includes(p.mcuName.toLowerCase()) || p.mcuName.toLowerCase().includes(trimmed)))
  );
}

export function findPresetByInstId(instId: number): InstrumentPreset | undefined {
  return INSTRUMENT_PRESETS.find(p => p.id !== 0 && p.instId === instId);
}