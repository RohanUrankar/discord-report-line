import { Writable } from 'node:stream';

export interface LogRecord {
  msg: string;
  level: number;
  [field: string]: unknown;
}

/** Collects what pino writes, as parsed JSON lines plus the raw text for "never appears" assertions. */
export class LogSink extends Writable {
  public readonly lines: string[] = [];

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(...chunk.toString().split('\n').filter(Boolean));
    callback();
  }

  public records(): LogRecord[] {
    return this.lines.map((line) => JSON.parse(line) as LogRecord);
  }

  public messages(): string[] {
    return this.records().map((record) => record.msg);
  }

  public text(): string {
    return this.lines.join('\n');
  }
}
