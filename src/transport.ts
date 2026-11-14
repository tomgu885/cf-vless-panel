import { Reader } from "./bytes";
import { handshake } from "./protocol";
import { openTunnel, type Tunnel } from "./outbound";
import type { Settings } from "./config";
export async function bridge(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  protocol: "vless" | "trojan",
  env: Env,
  c: Settings,
  region: string,
) {
  let tunnel: Tunnel | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15 * 60000);
  const authTimer = setTimeout(() => abort.abort(), 10000);
  const cancel = () => {
    void input.cancel().catch(() => {});
    void tunnel?.close().catch(() => {});
  };
  abort.signal.addEventListener("abort", cancel);
  try {
    const reader = new Reader(input.getReader());
    const h = await Promise.race([
      handshake(reader, protocol, env),
      new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(Error("Timeout")), {
          once: true,
        }),
      ),
    ]);
    clearTimeout(authTimer);
    tunnel = await openTunnel(h, c, region);
    if (abort.signal.aborted) throw Error("Closed");
    const w = output.getWriter();
    if (h.response.length) await w.write(h.response);
    w.releaseLock();
    const limit = (max: number) => {
      let count = 0;
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          count += chunk.length;
          if (count > max) throw Error("Transfer limit");
          controller.enqueue(chunk);
        },
      });
    };
    await Promise.race([
      reader
        .stream()
        .pipeThrough(limit(64 * 1024 * 1024))
        .pipeTo(tunnel.writable, { signal: abort.signal }),
      tunnel.readable
        .pipeThrough(limit(128 * 1024 * 1024))
        .pipeTo(output, { signal: abort.signal }),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(authTimer);
    abort.abort();
    await tunnel?.close().catch(() => {});
    await output.abort().catch(() => {});
  }
}
export function websocket(
  req: Request,
  env: Env,
  c: Settings,
  protocol: "vless" | "trojan",
  region: string,
): Response {
  const pair = new WebSocketPair(),
    [client, server] = Object.values(pair);
  server.binaryType = "arraybuffer";
  server.accept();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {}
    try {
      server.close(1000);
    } catch {}
  };
  const input = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        stop();
      },
    },
    {
      highWaterMark: 1024 * 1024,
      size(chunk) {
        return chunk.length;
      },
    },
  );
  const push = (data: Uint8Array) => {
    if (closed) return;
    if ((controller.desiredSize ?? 0) < data.length) {
      stop();
      return;
    }
    controller.enqueue(data);
  };
  server.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      stop();
      return;
    }
    push(new Uint8Array(e.data));
  });
  server.addEventListener("close", stop);
  server.addEventListener("error", stop);
  const early = req.headers.get("Sec-WebSocket-Protocol");
  if (early) {
    try {
      if (early.length > 8192) throw Error();
      push(new Uint8Array(Buffer.from(early, "base64url")));
    } catch {
      stop();
    }
  }
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw Error("Closed");
      server.send(chunk);
    },
    close: stop,
    abort: stop,
  });
  void bridge(input, output, protocol, env, c, region).catch(stop);
  return new Response(null, { status: 101, webSocket: client });
}
