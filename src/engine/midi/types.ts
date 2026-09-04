import { InstrumentPreset } from '../../models/InstrumentPreset';

export type MidiTransportType = 'web-midi' | 'ble-gatt';

export interface UnifiedMidiEndpoint {
  id: string;
  name: string;
  transport: MidiTransportType;
  identifiedPreset?: InstrumentPreset;
  customAlias?: string;
  rawOutputPort?: MIDIOutput;
  bleCharacteristic?: BluetoothRemoteGATTCharacteristic;
}