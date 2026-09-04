import { UnifiedMidiEndpoint } from './types';
import { BleMidiDriver } from './BleMidiDriver';
import { findPresetByMcuName, InstrumentPreset } from '../../models/InstrumentPreset';

export class MidiDeviceManager {
  private static instance: MidiDeviceManager;
  private midiAccess: MIDIAccess | null = null;
  private endpoints: Map<string, UnifiedMidiEndpoint> = new Map();
  private listeners: Set<(endpoints: UnifiedMidiEndpoint[]) => void> = new Set();

  private constructor() {}

  public static getInstance(): MidiDeviceManager {
    if (!MidiDeviceManager.instance) {
      MidiDeviceManager.instance = new MidiDeviceManager();
    }
    return MidiDeviceManager.instance;
  }

  public subscribe(cb: (endpoints: UnifiedMidiEndpoint[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.getEndpoints());
    return () => this.listeners.delete(cb);
  }

  public getEndpoints(): UnifiedMidiEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  public async initWebMidi(): Promise<void> {
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI API は未サポートです。');
      return;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      this.refreshWebMidiPorts();
      this.midiAccess.onstatechange = () => this.refreshWebMidiPorts();
    } catch (err) {
      console.error('Web MIDI アクセス要求失敗:', err);
    }
  }

  public refreshWebMidiPorts(): void {
    if (!this.midiAccess) return;

    for (const [id, ep] of this.endpoints.entries()) {
      if (ep.transport === 'web-midi') this.endpoints.delete(id);
    }

    const outputs = this.midiAccess.outputs.values();
    for (const output of outputs) {
      const preset = findPresetByMcuName(output.name ?? '');
      this.endpoints.set(output.id, {
        id: output.id,
        name: output.name ?? `MIDI Output ${output.id}`,
        transport: 'web-midi',
        identifiedPreset: preset,
        rawOutputPort: output
      });
    }
    this.notify();
  }

  public async connectBleDevice(): Promise<void> {
    const { device, characteristic } = await BleMidiDriver.connectDevice();
    const id = `ble-${device.id}`;
    const name = device.name ?? 'BLE-MIDI Device';
    const preset = findPresetByMcuName(name);

    const endpoint: UnifiedMidiEndpoint = {
      id,
      name,
      transport: 'ble-gatt',
      identifiedPreset: preset,
      bleCharacteristic: characteristic
    };

    device.addEventListener('gattserverdisconnected', () => {
      this.endpoints.delete(id);
      this.notify();
    });

    this.endpoints.set(id, endpoint);
    this.notify();
  }

  public sendBytes(endpoint: UnifiedMidiEndpoint, bytes: number[] | Uint8Array): void {
    if (endpoint.transport === 'web-midi' && endpoint.rawOutputPort) {
      endpoint.rawOutputPort.send(bytes);
    } else if (endpoint.transport === 'ble-gatt' && endpoint.bleCharacteristic) {
      BleMidiDriver.sendBytes(endpoint.bleCharacteristic, bytes).catch(err => {
        console.error(`[BLE-MIDI Send Error] ${endpoint.name}:`, err);
      });
    }
  }

  public sendAllNotesOff(endpoint: UnifiedMidiEndpoint, channel: number): void {
    for (let pitch = 0; pitch <= 127; pitch++) {
      this.sendBytes(endpoint, [0x80 | (channel & 0x0f), pitch, 0]);
    }
  }

  public testSingleNote(endpoint: UnifiedMidiEndpoint, channel: number, pitch: number): void {
    this.sendBytes(endpoint, [0x90 | (channel & 0x0f), pitch, 100]);
    setTimeout(() => {
      this.sendBytes(endpoint, [0x80 | (channel & 0x0f), pitch, 0]);
    }, 300);
  }

  public testSweepRange(endpoint: UnifiedMidiEndpoint, channel: number, startPitch: number, endPitch: number): void {
    const low = Math.min(startPitch, endPitch);
    const high = Math.max(startPitch, endPitch);
    let current = low;

    const interval = setInterval(() => {
      if (current > high) {
        clearInterval(interval);
        return;
      }
      const p = current++;
      this.sendBytes(endpoint, [0x90 | (channel & 0x0f), p, 90]);
      setTimeout(() => {
        this.sendBytes(endpoint, [0x80 | (channel & 0x0f), p, 0]);
      }, 80);
    }, 100);
  }

  private notify(): void {
    const current = this.getEndpoints();
    this.listeners.forEach(cb => cb(current));
  }
}