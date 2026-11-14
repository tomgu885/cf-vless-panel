export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
export class Reader {
  private rest = new Uint8Array(0);
  constructor(readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async take(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.rest.length < n) {
      const r = await this.reader.read();
      if (r.done) throw Error("Unexpected EOF");
      this.rest = concat(this.rest, r.value);
    }
    const out = this.rest.slice(0, n);
    this.rest = this.rest.slice(n);
    return out;
  }
  stream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream({
      async pull(c) {
        if (self.rest.length) {
          c.enqueue(self.rest);
          self.rest = new Uint8Array(0);
          return;
        }
        const r = await self.reader.read();
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel() {
        return self.reader.cancel();
      },
    });
  }
}
export function equal(a: string, b: string): boolean {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export async function bounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const r = body.getReader();
  let data = new Uint8Array(0);
  try {
    for (;;) {
      const v = await r.read();
      if (v.done) return data;
      if (data.length + v.value.length > max) throw Error("请求过大");
      data = concat(data, v.value);
    }
  } finally {
    await r.cancel().catch(() => {});
  }
}
