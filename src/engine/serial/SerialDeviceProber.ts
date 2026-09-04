export interface SerialMcuInfo {
  instId: number;
  mcuName: string;
  pwmFreq?: number;
  pwmMin?: number;
  pwmMax?: number;
}

export class SerialDeviceProber {
  public static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in (navigator as any);
  }

  /**
   * ユーザーに対話型ポート選択を開いてハンドシェイク実行
   */
  public static async probeDevice(): Promise<SerialMcuInfo | null> {
    if (!this.isSupported()) {
      throw new Error('Web Serial API はこのブラウザで利用できません。');
    }

    const serial = (navigator as any).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: 115200 });

    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      const writer = port.writable?.getWriter();
      const reader = port.readable?.getReader();
      if (!writer || !reader) return null;

      // 1. キャリブレーション要求 [0x9F, 0x01, 0x01] 送信
      await writer.write(new Uint8Array([0x9f, 0x01, 0x01]));
      writer.releaseLock();

      // 2. ACK (0x9F) 受信
      let ackFound = false;
      const ackTimeout = performance.now() + 500;
      while (performance.now() < ackTimeout) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && Array.from(value as Uint8Array).includes(0x9f)) {
          ackFound = true;
          break;
        }
      }
      if (!ackFound) return null;

      // 3. 識別要求コマンド [0x05] 送信
      const writer2 = port.writable!.getWriter();
      await writer2.write(new Uint8Array([0x05]));
      writer2.releaseLock();

      // 4. [0xFF, INST_ID, MCU_NAME..., 0x00] 受信
      const responseBytes: number[] = [];
      const respTimeout = performance.now() + 1000;
      while (performance.now() < respTimeout && responseBytes.length < 64) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const bytes = Array.from(value as Uint8Array);
          responseBytes.push(...bytes);
          if (responseBytes.length >= 2 && responseBytes[0] === 0xff) {
            if (responseBytes.slice(2).includes(0)) break;
          }
        }
      }
      reader.releaseLock();

      if (responseBytes.length >= 2 && responseBytes[0] === 0xff) {
        const instId = responseBytes[1];
        const nameBytes = responseBytes.slice(2).filter(b => b !== 0);
        const mcuName = new TextDecoder('utf-8').decode(new Uint8Array(nameBytes));
        return { instId, mcuName };
      }
      return null;
    } finally {
      await port.close();
    }
  }
}