import { connect } from "cloudflare:sockets";
import {
  createHash,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";
import { Reader, concat, encoder, decoder } from "./bytes";
import { address, type Target } from "./protocol";
import type { Settings } from "./config";
export interface Tunnel {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
function targetBytes(t: Target) {
  const host = encoder.encode(t.host);
  if (host.length > 255) throw Error("Host too long");
  return concat(
    new Uint8Array([3, host.length]),
    host,
    new Uint8Array([t.port >> 8, t.port & 255]),
  );
}
function authority(t: Target) {
  return `${t.host.includes(":") ? "[" + t.host + "]" : t.host}:${t.port}`;
}
export function proxyURL(raw: string): URL {
  const u = new URL(raw.includes("://") ? raw : "socks5://" + raw);
  if (
    !["socks5:", "http:", "https:", "ss:"].includes(u.protocol) ||
    !u.hostname ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== "/")
  )
    throw Error("出站地址不支持");
  if (u.protocol === "ss:") {
    const [method] = ssCredentials(u);
    if (
      !["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"].includes(method)
    )
      throw Error("SS 加密方式不支持");
  }
  return u;
}
function ssCredentials(u: URL) {
  let auth =
    decodeURIComponent(u.username) +
    (u.password ? ":" + decodeURIComponent(u.password) : "");
  if (!auth.includes(":")) auth = Buffer.from(auth, "base64url").toString();
  const i = auth.indexOf(":");
  return [auth.slice(0, i), auth.slice(i + 1)];
}
async function dial(t: Target, tls = false): Promise<Tunnel> {
  const s = connect(
    { hostname: t.host.replace(/^\[|\]$/g, ""), port: t.port },
    { secureTransport: tls ? "on" : "off", allowHalfOpen: true },
  );
  void s.closed.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      s.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Connect timeout")), 10000);
      }),
    ]);
  } catch (e) {
    await s.close().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return { readable: s.readable, writable: s.writable, close: () => s.close() };
}
async function proxy(t: Target, u: URL): Promise<Tunnel> {
  const s = await dial(
    {
      host: u.hostname,
      port: Number(
        u.port ||
          (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 1080),
      ),
    },
    u.protocol === "https:",
  );
  if (u.protocol === "ss:") return shadowsocks(s, u, t);
  const r = new Reader(s.readable.getReader()),
    w = s.writable.getWriter();
  const timer = setTimeout(() => {
    void s.close().catch(() => {});
  }, 10000);
  try {
    if (u.protocol === "socks5:") {
      await w.write(new Uint8Array(u.username ? [5, 2, 0, 2] : [5, 1, 0]));
      const method = await r.take(2);
      if (
        method[0] !== 5 ||
        ![0, 2].includes(method[1]) ||
        (method[1] === 2 && !u.username)
      )
        throw Error("SOCKS authentication");
      if (method[1] === 2) {
        const user = encoder.encode(decodeURIComponent(u.username)),
          pass = encoder.encode(decodeURIComponent(u.password));
        if (user.length > 255 || pass.length > 255)
          throw Error("Credentials length");
        await w.write(
          concat(
            new Uint8Array([1, user.length]),
            user,
            new Uint8Array([pass.length]),
            pass,
          ),
        );
        const result = await r.take(2);
        if (result[0] !== 1 || result[1] !== 0)
          throw Error("SOCKS authentication");
      }
      await w.write(concat(new Uint8Array([5, 1, 0]), targetBytes(t)));
      const h = await r.take(4);
      if (h[0] !== 5 || h[1] !== 0) throw Error("SOCKS connect");
      await address(r, h[3]);
      await r.take(2);
    } else {
      const auth = u.username
        ? "Proxy-Authorization: Basic " +
          Buffer.from(
            decodeURIComponent(u.username) +
              ":" +
              decodeURIComponent(u.password),
          ).toString("base64") +
          "\r\n"
        : "";
      await w.write(
        encoder.encode(
          `CONNECT ${authority(t)} HTTP/1.1\r\nHost: ${authority(t)}\r\n${auth}\r\n`,
        ),
      );
      let head = "";
      while (!head.endsWith("\r\n\r\n")) {
        if (head.length > 8192) throw Error("Proxy header");
        head += decoder.decode(await r.take(1));
      }
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(head))
        throw Error("CONNECT rejected");
    }
    w.releaseLock();
    return { readable: r.stream(), writable: s.writable, close: s.close };
  } catch (e) {
    w.releaseLock();
    await s.close().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function shadowsocks(s: Tunnel, u: URL, t: Target): Tunnel {
  const [method, password] = ssCredentials(u),
    size = method === "aes-128-gcm" ? 16 : 32,
    algorithm = (
      method === "chacha20-ietf-poly1305" ? "chacha20-poly1305" : method
    ) as CipherGCMTypes;
  let material = Buffer.alloc(0),
    last = Buffer.alloc(0);
  while (material.length < size) {
    last = createHash("md5").update(last).update(password).digest();
    material = Buffer.concat([material, last]);
  }
  const master = material.subarray(0, size);
  const salt = randomBytes(size),
    key = Buffer.from(hkdfSync("sha1", master, salt, "ss-subkey", size)),
    nonce = Buffer.alloc(12),
    r = new Reader(s.readable.getReader()),
    w = s.writable.getWriter();
  let readKey: Buffer | undefined;
  const readNonce = Buffer.alloc(12);
  function increment(n: Buffer) {
    for (let i = 0; i < n.length; i++) {
      n[i] = (n[i] + 1) & 255;
      if (n[i]) break;
    }
  }
  function encrypt(data: Uint8Array) {
    const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: 16 });
    const out = Buffer.concat([
      cipher.update(data),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    increment(nonce);
    return out;
  }
  function decrypt(data: Uint8Array) {
    const cipher = createDecipheriv(algorithm, readKey!, readNonce, {
      authTagLength: 16,
    });
    cipher.setAuthTag(data.subarray(-16));
    const out = Buffer.concat([
      cipher.update(data.subarray(0, -16)),
      cipher.final(),
    ]);
    increment(readNonce);
    return out;
  }
  return {
    close: s.close,
    writable: new WritableStream({
      async start() {
        const target = targetBytes(t);
        await w.write(
          concat(
            salt,
            encrypt(new Uint8Array([target.length >> 8, target.length & 255])),
            encrypt(target),
          ),
        );
      },
      async write(data) {
        for (let i = 0; i < data.length; i += 16383) {
          const part = data.subarray(i, i + 16383);
          await w.write(
            concat(
              encrypt(new Uint8Array([part.length >> 8, part.length & 255])),
              encrypt(part),
            ),
          );
        }
      },
      close() {
        return w.close();
      },
      abort() {
        return s.close();
      },
    }),
    readable: new ReadableStream({
      async pull(c) {
        try {
          if (!readKey)
            readKey = Buffer.from(
              hkdfSync("sha1", master, await r.take(size), "ss-subkey", size),
            );
          const len = decrypt(await r.take(18));
          const n = (len[0] << 8) | len[1];
          if (n > 16383) throw Error("SS frame");
          c.enqueue(decrypt(await r.take(n + 16)));
        } catch {
          c.close();
          await s.close().catch(() => {});
        }
      },
      cancel() {
        return s.close();
      },
    }),
  };
}
export async function openTunnel(
  t: Target,
  c: Settings,
  region: string,
): Promise<Tunnel> {
  if (!c.ports.includes(t.port) || !t.host || /[\s/\x00]/.test(t.host))
    throw Error("Target rejected");
  if (c.mode !== "direct" && c.outbound) {
    try {
      return await proxy(t, proxyURL(c.outbound));
    } catch {
      if (c.mode === "only") throw Error("Outbound unavailable");
    }
  }
  try {
    return await dial(t);
  } catch {
    // Explicitly configured TLS relays receive the original TLS stream, including SNI.
    if (t.port !== 443) throw Error("Direct unavailable");
    for (const relay of c.relays.filter(
      (x) => !x.region || x.region === region,
    )) {
      try {
        return await dial({ host: relay.host, port: relay.port });
      } catch {}
    }
    throw Error("No route");
  }
}
