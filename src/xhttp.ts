import { DurableObject } from "cloudflare:workers";
import { bridge } from "./transport";
import { bounded } from "./bytes";
import type { Settings } from "./config";
export class XhttpSession extends DurableObject<Env> {
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private packets = new Map<number, Uint8Array>();
  private next = 0;
  private downloaded = false;
  private closed = false;
  private region = "";
  private config?: Settings;
  async handle(req: Request, c: Settings, region: string): Promise<Response> {
    if (this.closed) return new Response("Session closed", { status: 410 });
    if (!this.config) {
      this.config = c;
      this.region = region;
      await this.ctx.storage.setAlarm(Date.now() + 30000);
    }
    if (region !== this.region) return new Response(null, { status: 400 });
    if (req.method === "GET") {
      if (this.downloaded) return new Response(null, { status: 409 });
      this.downloaded = true;
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60000);
      const input = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            this.controller = controller;
            this.flush();
          },
          cancel: () => this.finish(),
        },
        { highWaterMark: 2 * 1024 * 1024, size: (b) => b.length },
      );
      const output = new TransformStream<Uint8Array, Uint8Array>();
      this.ctx.waitUntil(
        bridge(
          input,
          output.writable,
          "vless",
          this.env,
          this.config,
          this.region,
        )
          .catch(() => {})
          .finally(() => this.finish()),
      );
      return new Response(output.readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          "X-Padding": "X".repeat(128),
        },
      });
    }
    const seqText = new URL(req.url).pathname
      .split("/")
      .filter(Boolean)
      .at(-1)!;
    if (req.method !== "POST" || !/^\d{1,10}$/.test(seqText))
      return new Response(null, { status: 400 });
    const seq = Number(seqText);
    if (seq < this.next || this.packets.has(seq) || seq > this.next + 30)
      return new Response(null, { status: 409 });
    const bytes = await bounded(req.body, 1024 * 1024);
    if (this.closed) return new Response(null, { status: 410 });
    if (
      this.packets.size >= 30 ||
      [...this.packets.values()].reduce((n, b) => n + b.length, 0) +
        bytes.length >
        4 * 1024 * 1024
    )
      return new Response(null, { status: 429 });
    if (seq < this.next || this.packets.has(seq))
      return new Response(null, { status: 409 });
    this.packets.set(seq, bytes);
    this.flush();
    return new Response(null, { status: 200 });
  }
  private flush() {
    while (this.controller && this.packets.has(this.next)) {
      const b = this.packets.get(this.next)!;
      if ((this.controller.desiredSize ?? 0) < b.length) {
        this.finish();
        return;
      }
      this.controller.enqueue(b);
      this.packets.delete(this.next++);
    }
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller?.close();
    } catch {}
    this.packets.clear();
  }
  async alarm() {
    this.finish();
    await this.ctx.storage.deleteAll();
  }
}
