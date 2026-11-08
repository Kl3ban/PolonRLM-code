import { Transform, type TransformCallback } from 'node:stream';

export interface TerminalMouseEvent {
  action: 'down' | 'up' | 'wheel' | 'move';
  button: number;
  x: number;
  y: number;
}

/** Forwards terminal input unchanged while exposing SGR mouse reports to the UI. */
export class TerminalInputRouter extends Transform {
  private pending = '';

  constructor(readonly source: NodeJS.ReadStream) {
    super();
    Object.defineProperties(this, {
      isTTY: { configurable: true, get: () => source.isTTY },
      setRawMode: { configurable: true, value: (enabled: boolean) => source.setRawMode(enabled) },
      ref: { configurable: true, value: () => source.ref?.() },
      unref: { configurable: true, value: () => source.unref?.() },
    });
    source.pipe(this);
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const input = `${this.pending}${chunk.toString('utf8')}`;
    const mouse = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let match: RegExpExecArray | null;
    while ((match = mouse.exec(input))) {
      const code = Number(match[1]);
      const wheel = (code & 64) !== 0;
      const motion = (code & 32) !== 0;
      this.emit('mouse', {
        action: wheel ? 'wheel' : motion ? 'move' : match[4] === 'M' ? 'down' : 'up',
        button: wheel ? code & 1 : code & 3,
        x: Number(match[2]) - 1,
        y: Number(match[3]) - 1,
      } satisfies TerminalMouseEvent);
    }

    const lastEscape = input.lastIndexOf('\u001b');
    const tail = lastEscape < 0 ? '' : input.slice(lastEscape);
    this.pending = tail.startsWith('\u001b[<') && !/[Mm]/.test(tail) && tail.length <= 40 ? tail : '';
    callback(null, chunk);
  }

  dispose(): void {
    this.source.unpipe(this);
    this.destroy();
  }
}
