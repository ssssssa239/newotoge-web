export interface SerialMcuInfo {
  instId: number;
  mcuName: string;
}

class ByteBufferReader {
  private reader: any;
  private buffer: number[] = [];

  constructor(reader: any) {
    this.reader = reader;
  }

  async readByte(timeoutMs: number): Promise<number | null> {
    const startTime = Date.now();
    while (this.buffer.length === 0) {
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (remainingTime <= 0) return null;

      const readPromise = this.reader.read();
      const timeoutPromise = new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: true }), remainingTime)
      );

      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.done || !result.value) {
        return null;
      }
      for (let i = 0; i < result.value.length; i++) {
        this.buffer.push(result.value[i]);
      }
    }
    return this.buffer.shift() ?? null;
  }
}

export class SerialDeviceProber {
  /**
   * 1つのシリアルポートに対して Swift版と同一のハンドシェイクを実行
   */
  public static async probePort(port: any): Promise<SerialMcuInfo | null> {
    try {
      await port.open({ baudRate: 115200 });
      if (port.setSignals) {
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      }
      await new Promise(r => setTimeout(r, 100));

      const writer = port.writable.getWriter();
      const reader = port.readable.getReader();
      const byteReader = new ByteBufferReader(reader);

      try {
        // 1. キャリブレーションモード要求 [0x9F, 0x01, 0x01] 送信
        await writer.write(new Uint8Array([0x9F, 0x01, 0x01]));

        // 2. ACK (0x9F) 受信待機 (500ms)
        const ack = await byteReader.readByte(500);
        if (ack !== 0x9F) return null;

        // 3. 識別要求コマンド [0x05] 送信
        await writer.write(new Uint8Array([0x05]));

        // 4. ヘッダー [0xFF, INST_ID] 受信 (500ms)
        const head = await byteReader.readByte(500);
        if (head !== 0xFF) return null;
        const instId = await byteReader.readByte(500);
        if (instId === null) return null;

        // 5. MCU_NAME 受信 (0x00 終端まで、最大64バイト)
        const nameBytes: number[] = [];
        while (true) {
          const b = await byteReader.readByte(200);
          if (b === null || b === 0) break;
          nameBytes.push(b);
          if (nameBytes.length > 64) break;
        }

        const mcuName = new TextDecoder('utf-8').decode(new Uint8Array(nameBytes)).trim();
        if (!mcuName) return null;

        return { instId, mcuName };
      } finally {
        writer.releaseLock();
        reader.releaseLock();
        await port.close();
      }
    } catch {
      return null;
    }
  }
}