import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { createServer } from "node:net";
import { once } from "node:events";
const bindings = {
  NODE_UUID: "00000000-0000-4000-8000-000000000001",
  TROJAN_PASSWORD: "test-only-trojan-password",
  ADMIN_PASSWORD: "test-only-admin-password",
  SESSION_SECRET: "test-only-session-secret-32-characters",
  SUB_TOKEN: "test-only-subscription-token-32-chars",
};
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "test",
        modules: [
          {
            type: "ESModule",
            path: resolve("dist/index.js"),
            contents: readFileSync("dist/index.js", "utf8"),
          },
          ...readdirSync("dist")
            .filter((f) => f.endsWith(".html"))
            .map((f) => ({
              type: "Text" as const,
              path: resolve("dist", f),
              contents: readFileSync("dist/" + f, "utf8"),
            })),
        ],
        compatibilityDate: "2026-11-14",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["CONFIG"],
        durableObjects: {
          XHTTP: { className: "XhttpSession", useSQLite: true },
        },
        bindings,
      },
    ],
    log: new Log(LogLevel.NONE),
  }),
);
test(
  "runtime: authenticated API, CSRF, scoped reset, WS and XHTTP TCP echo",
  { timeout: 60000 },
  async () => {
    const server = createServer((s) => s.pipe(s));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const request = (path: string, init?: RequestInit) =>
        mf.dispatchFetch("https://panel.test" + path, init);
      assert.equal((await request("/api/settings")).status, 401);
      assert.equal(
        (
          await request("/api/login", {
            method: "POST",
            body: JSON.stringify({ password: bindings.ADMIN_PASSWORD }),
          })
        ).status,
        403,
      );
      const login = await request("/api/login", {
        method: "POST",
        headers: { Origin: "https://panel.test" },
        body: JSON.stringify({ password: bindings.ADMIN_PASSWORD }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const headers = {
        Origin: "https://panel.test",
        Cookie: cookie,
        "Content-Type": "application/json",
      };
      assert.equal((await request("/api/settings", { headers })).status, 200);
      const kv = await mf.getKVNamespace("CONFIG");
      await kv.put("unrelated", "keep");
      const c = {
        nodes: [],
        relays: [],
        outbound: "",
        mode: "direct",
        ports: [port],
        xhttp: true,
        trojan: true,
      };
      assert.equal(
        (
          await request("/api/settings", {
            method: "PUT",
            headers,
            body: JSON.stringify(c),
          })
        ).status,
        200,
      );
      const h = Buffer.concat([
        Buffer.from([0]),
        Buffer.from(bindings.NODE_UUID.replaceAll("-", ""), "hex"),
        Buffer.from([0, 1, port >> 8, port & 255, 1, 127, 0, 0, 1]),
        Buffer.from("hello"),
      ]);
      const upgraded = await request("/ws", {
        headers: { Upgrade: "websocket" },
      });
      assert.equal(upgraded.status, 101);
      const ws = upgraded.webSocket!;
      ws.binaryType = "arraybuffer";
      ws.accept();
      const received: Buffer[] = [];
      const echoed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("WS echo timeout")), 10000);
        ws.addEventListener("message", (e) => {
          received.push(Buffer.from(e.data as ArrayBuffer));
          if (Buffer.concat(received).includes(Buffer.from("hello"))) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      ws.send(h);
      await echoed;
      assert.deepEqual(
        Buffer.concat(received),
        Buffer.concat([Buffer.from([0, 0]), Buffer.from("hello")]),
      );
      ws.close();
      const id = "test-session-00000001";
      const down = await request("/xhttp/" + id);
      assert.equal(down.status, 200);
      const post = await request("/xhttp/" + id + "/0", {
        method: "POST",
        body: h,
      });
      assert.equal(post.status, 200);
      const reader = down.body!.getReader();
      let data = Buffer.alloc(0);
      while (data.length < 7) {
        const result = await reader.read();
        assert.equal(result.done, false);
        data = Buffer.concat([data, Buffer.from(result.value!)]);
      }
      assert.deepEqual(
        data,
        Buffer.concat([Buffer.from([0, 0]), Buffer.from("hello")]),
      );
      await reader.cancel();
      assert.equal(
        (await request("/api/reset", { method: "POST", headers })).status,
        200,
      );
      assert.equal(await kv.get("unrelated"), "keep");
      assert.equal(await kv.get("cf-vless-panel:settings:v1"), null);
    } finally {
      await mf.dispose();
      server.close();
    }
  },
);
