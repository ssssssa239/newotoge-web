const BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_MIDI_CHAR_UUID    = '7772e5db-3868-4112-a1a9-f2669d106bf3';

export class BleMidiDriver {
  public static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  public static async connectDevice(): Promise<{
    device: BluetoothDevice;
    characteristic: BluetoothRemoteGATTCharacteristic;
  }> {
    if (!this.isSupported()) {
      throw new Error('Web Bluetooth API はこのブラウザでサポートされていません。');
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_MIDI_SERVICE_UUID] }]
    });

    const server = await device.gatt?.connect();
    if (!server) throw new Error('GATTサーバーへの接続に失敗しました。');

    const service = await server.getPrimaryService(BLE_MIDI_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_MIDI_CHAR_UUID);

    return { device, characteristic };
  }

  public static async sendBytes(
    characteristic: BluetoothRemoteGATTCharacteristic,
    midiBytes: number[] | Uint8Array
  ): Promise<void> {
    const timestamp = Math.floor(performance.now()) & 0x1fff;
    const header = 0x80 | ((timestamp >> 7) & 0x3f);
    const timestampByte = 0x80 | (timestamp & 0x7f);

    const packet = new Uint8Array(2 + midiBytes.length);
    packet[0] = header;
    packet[1] = timestampByte;
    packet.set(midiBytes, 2);

    const charAny = characteristic as any;
    if (typeof charAny.writeValueWithoutResponse === 'function') {
      await charAny.writeValueWithoutResponse(packet);
    } else if (typeof charAny.writeValue === 'function') {
      await charAny.writeValue(packet);
    }
  }
}