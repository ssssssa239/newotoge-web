import { UnifiedMidiEndpoint } from './types';
import { INSTRUMENT_PRESETS, InstrumentPreset } from '../../models/InstrumentPreset';
import { SerialDeviceProber } from '../serial/SerialDeviceProber';

// M5Stack AtomS3 (ESP32-S3) の USB Vendor ID
const ESP32_S3_VENDOR_ID = 0x303A;

export class MidiDeviceManager {
  private static instance: MidiDeviceManager;
  private endpoints: UnifiedMidiEndpoint[] = [];
  private listeners: Set<(endpoints: UnifiedMidiEndpoint[]) => void> = new Set();

  private midiAccess: any = null;
  private manualAssignments: Record<string, number> = {};
  private isProbingSerial = false;

  private constructor() {
    this.loadManualAssignments();
    this.setupSerialHotplugListener();
  }

  public static getInstance(): MidiDeviceManager {
    if (!MidiDeviceManager.instance) {
      MidiDeviceManager.instance = new MidiDeviceManager();
    }
    return MidiDeviceManager.instance;
  }

  private loadManualAssignments(): void {
    try {
      const data = localStorage.getItem('otoge_manual_midi_assignments');
      if (data) this.manualAssignments = JSON.parse(data);
    } catch {
      this.manualAssignments = {};
    }
  }

  private saveManualAssignments(): void {
    try {
      localStorage.setItem('otoge_manual_midi_assignments', JSON.stringify(this.manualAssignments));
    } catch {
      /* no-op */
    }
  }

  /**
   * USBケーブル挿入時の自動問い合わせリスナー
   */
  private setupSerialHotplugListener(): void {
    const nav = navigator as any;
    if (nav.serial && nav.serial.addEventListener) {
      nav.serial.addEventListener('connect', () => {
        // デバイスが接続されたら自動で順次問い合わせ
        setTimeout(() => {
          this.autoProbeAllGrantedPorts();
        }, 500);
      });
    }
  }

  public async initWebMidi(): Promise<void> {
    const nav = navigator as any;
    if (!nav.requestMIDIAccess) return;

    try {
      this.midiAccess = await nav.requestMIDIAccess({ sysex: true });
      this.refreshEndpoints();

      this.midiAccess.onstatechange = () => {
        this.refreshEndpoints();
        // MIDIデバイスが増減した際もシリアル自動照合を走らせる
        this.autoProbeAllGrantedPorts();
      };
    } catch {
      try {
        this.midiAccess = await nav.requestMIDIAccess({ sysex: false });
        this.refreshEndpoints();
      } catch {
        /* no-op */
      }
    }

    // 起動時に既存の許可済みポートを順に自動問い合わせ
    this.autoProbeAllGrantedPorts();
  }

  public refreshEndpoints(): void {
    const nextEndpoints: UnifiedMidiEndpoint[] = [];

    if (this.midiAccess) {
      const outputs: any[] = Array.from(this.midiAccess.outputs.values());

      for (const out of outputs) {
        let identified: InstrumentPreset | undefined;
        if (this.manualAssignments[out.id]) {
          identified = INSTRUMENT_PRESETS.find(p => p.id === this.manualAssignments[out.id]);
        }
        if (!identified) {
          identified = INSTRUMENT_PRESETS.find(p =>
            p.id !== 0 && (out.name || '').toLowerCase().includes(p.mcuName.toLowerCase())
          );
        }

        const endpoint: UnifiedMidiEndpoint = {
          id: out.id,
          name: out.name || 'USB MIDI Device',
          transport: 'web-midi',
          rawOutputPort: out,
          identifiedPreset: identified
        };

        nextEndpoints.push(endpoint);
      }
    }

    for (const ep of this.endpoints) {
      if (ep.transport === 'ble-gatt') {
        nextEndpoints.push(ep);
      }
    }

    this.endpoints = nextEndpoints;
    this.notify();
  }

  /**
   * 「+ USB照合」ボタン:
   * M5Stack AtomS3 のみをフィルタリングしてダイアログを開き、
   * 許可されたポートおよび既存ポートに対して順に自動問い合わせを行う
   */
  public async probeSerialDeviceManually(): Promise<void> {
    const nav = navigator as any;
    if (!nav.serial) {
      alert('お使いのブラウザは Web Serial に対応していません。Google Chrome をご利用ください。');
      return;
    }

    try {
      // 1. M5Stack AtomS3 (ESP32-S3) を優先フィルタリングしてポート選択ダイアログを表示
      let port: any;
      try {
        port = await nav.serial.requestPort({
          filters: [{ usbVendorId: ESP32_S3_VENDOR_ID }]
        });
      } catch {
        // フィルタで一致しない互換デバイスの場合は全シリアルポートをフォールバック表示
        port = await nav.serial.requestPort();
      }

      // 2. 選択されたポートに問い合わせ
      if (port) {
        const info = await SerialDeviceProber.probePort(port);
        if (info) {
          this.bindSerialMcuToEndpoint(info.instId, info.mcuName);
        }
      }

      // 3. 他に許可済みのポートがあれば、それらも続けて順次問い合わせ
      await this.autoProbeAllGrantedPorts();
    } catch {
      /* ユーザーキャンセル時は何もしない */
    }
  }

  /**
   * 許可済みの全シリアルポート候補に対して、順に自動問い合わせ（Auto Probe）を実行
   */
  public async autoProbeAllGrantedPorts(): Promise<void> {
    const nav = navigator as any;
    if (!nav.serial || !nav.serial.getPorts || this.isProbingSerial) return;

    this.isProbingSerial = true;

    try {
      const ports: any[] = await nav.serial.getPorts();

      // 未割り当ての MIDI ポートがあるか確認
      const hasUnassignedEndpoints = this.endpoints.some(
        ep =>
          ep.transport === 'web-midi' &&
          (!ep.identifiedPreset || ep.name.toLowerCase().includes('m5') || ep.name.toLowerCase().includes('atom'))
      );

      if (!hasUnassignedEndpoints && ports.length === 0) {
        this.isProbingSerial = false;
        return;
      }

      // 候補ポートに対して「順に」問い合わせを実行
      for (const port of ports) {
        const info = await SerialDeviceProber.probePort(port);
        if (info) {
          this.bindSerialMcuToEndpoint(info.instId, info.mcuName);
        }
      }
    } catch {
      /* no-op */
    } finally {
      this.isProbingSerial = false;
    }
  }

  /**
   * 検出された MCU 情報を、未バインドの M5Stack / AtomS3 MIDI ポートに紐付け
   */
  private bindSerialMcuToEndpoint(instId: number, mcuName: string): void {
    const preset =
      INSTRUMENT_PRESETS.find(p => p.instId === instId) ??
      INSTRUMENT_PRESETS.find(p => p.mcuName.toLowerCase() === mcuName.toLowerCase());

    if (!preset) return;

    // まだ楽器が確定していない M5 / Atom ポートを探してバインド
    const target = this.endpoints.find(
      ep =>
        ep.transport === 'web-midi' &&
        (!ep.identifiedPreset ||
          ep.identifiedPreset.id === 0 ||
          ep.name.toLowerCase().includes('m5') ||
          ep.name.toLowerCase().includes('atom'))
    );

    if (target) {
      target.identifiedPreset = preset;
      this.manualAssignments[target.id] = preset.id;
      this.saveManualAssignments();
      this.notify();
    }
  }

  public setEndpointPreset(endpointId: string, presetId: number): void {
    const target = this.endpoints.find(e => e.id === endpointId);
    if (!target) return;

    if (presetId === 0) {
      delete target.identifiedPreset;
      delete this.manualAssignments[endpointId];
    } else {
      const preset = INSTRUMENT_PRESETS.find(p => p.id === presetId);
      target.identifiedPreset = preset;
      this.manualAssignments[endpointId] = presetId;
    }

    this.saveManualAssignments();
    this.notify();
  }

  public getEndpoints(): UnifiedMidiEndpoint[] {
    return this.endpoints;
  }

  public subscribe(cb: (endpoints: UnifiedMidiEndpoint[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.endpoints);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach(cb => cb([...this.endpoints]));
  }

  public sendBytes(endpoint: UnifiedMidiEndpoint, bytes: number[]): void {
    if (endpoint.transport === 'web-midi' && endpoint.rawOutputPort) {
      try {
        endpoint.rawOutputPort.send(bytes);
      } catch {
        /* 送信エラー抑制 */
      }
    } else if (endpoint.transport === 'ble-gatt' && endpoint.bleCharacteristic) {
      const header = 0x80;
      const timestamp = 0x80;
      const packet = new Uint8Array([header, timestamp, ...bytes]);
      endpoint.bleCharacteristic.writeValueWithoutResponse(packet).catch(() => {});
    }
  }

  public async connectBleDevice(): Promise<void> {
    const nav = navigator as any;
    if (!nav.bluetooth) {
      alert('お使いのブラウザは Web Bluetooth に対応していません。Google Chrome をご利用ください。');
      return;
    }

    try {
      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: ['03b80e5a-ede8-4b33-a751-6ce34ec4c700'] }]
      });

      const server = await device.gatt?.connect();
      if (!server) return;

      const service = await server.getPrimaryService('03b80e5a-ede8-4b33-a751-6ce34ec4c700');
      const characteristic = await service.getCharacteristic('7772e5db-3868-4112-a1a9-f2669d106bf3');

      const matchedPreset = INSTRUMENT_PRESETS.find(
        p => p.id !== 0 && (device.name || '').toLowerCase().includes(p.mcuName.toLowerCase())
      );

      const endpoint: UnifiedMidiEndpoint = {
        id: device.id,
        name: device.name || 'BLE-MIDI Device',
        transport: 'ble-gatt',
        bleCharacteristic: characteristic,
        identifiedPreset: matchedPreset
      };

      this.endpoints = [...this.endpoints.filter(e => e.id !== endpoint.id), endpoint];
      this.notify();
    } catch {
      /* キャンセル時はスキップ */
    }
  }

  public testSingleNote(endpoint: UnifiedMidiEndpoint, channel: number, pitch: number): void {
    const ch = channel & 0x0f;
    this.sendBytes(endpoint, [0x90 | ch, pitch & 0x7f, 100]);
    setTimeout(() => {
      this.sendBytes(endpoint, [0x80 | ch, pitch & 0x7f, 0]);
    }, 200);
  }

  public sendAllNotesOff(endpoint: UnifiedMidiEndpoint, channel: number): void {
    const ch = channel & 0x0f;
    this.sendBytes(endpoint, [0xb0 | ch, 123, 0]);
  }
}