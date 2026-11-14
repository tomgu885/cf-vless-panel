import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { createServer, connect as netConnect } from "node:net";
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
import { createServer as httpServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const executable = process.env.XRAY_BIN;
if (!executable) throw Error("Set XRAY_BIN to an official Xray executable");
const tmp = mkdtempSync(resolve(tmpdir(), "cf-vless-interop-"));
const children: ReturnType<typeof spawn>[] = [];
const echo = httpServer((_req, res) => res.end("worker-interop-ok"));
echo.listen(0, "127.0.0.1");
await once(echo, "listening");
const targetPort = (echo.address() as import("node:net").AddressInfo).port;
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}
async function run(config: unknown) {
  const path = resolve(tmp, children.length + ".json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const p = spawn(executable!, ["run", "-config", path], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(p);
  p.stderr.resume();
  const port = (config as { inbounds: { port: number }[] }).inbounds[0].port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (p.exitCode !== null) throw Error("Xray failed to start");
    const ready = await new Promise<boolean>((resolve) => {
      const socket = netConnect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Xray startup timeout");
}
async function probe(port: number) {
  const { stdout } = await promisify(execFile)("curl", [
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    "--noproxy",
    "",
    "--socks5-hostname",
    `127.0.0.1:${port}`,
    `http://127.0.0.1:${targetPort}/`,
  ]);
  assert.equal(stdout, "worker-interop-ok");
}
try {
  const endpoint = await mf.ready;
  const kv = await mf.getKVNamespace("CONFIG");
  const c = {
    nodes: [],
    relays: [],
    outbound: "",
    mode: "direct",
    ports: [targetPort],
    xhttp: true,
    trojan: true,
  };
  await kv.put("cf-vless-panel:settings:v1", JSON.stringify(c));
  for (const protocol of ["vless", "trojan", "xhttp"]) {
    const port = await freePort();
    const p = protocol === "trojan" ? "trojan" : "vless";
    const outbound = {
      protocol: p,
      settings: {
        vnext:
          p === "vless"
            ? [
                {
                  address: "127.0.0.1",
                  port: Number(endpoint.port),
                  users: [{ id: bindings.NODE_UUID, encryption: "none" }],
                },
              ]
            : undefined,
        servers:
          p === "trojan"
            ? [
                {
                  address: "127.0.0.1",
                  port: Number(endpoint.port),
                  password: bindings.TROJAN_PASSWORD,
                },
              ]
            : undefined,
      },
      streamSettings: {
        network: protocol === "xhttp" ? "xhttp" : "ws",
        security: "none",
        wsSettings: { path: protocol === "trojan" ? "/trojan" : "/ws" },
        xhttpSettings: { path: "/xhttp", mode: "packet-up" },
      },
    };
    await run({
      log: { loglevel: "none" },
      inbounds: [
        {
          listen: "127.0.0.1",
          port,
          protocol: "socks",
          settings: { auth: "noauth", udp: false },
        },
      ],
      outbounds: [outbound],
    });
    await probe(port);
    console.log("Xray inbound interoperability passed: " + protocol);
  }
  // Reuse the real Xray VLESS/WS client to exercise Worker outbound proxies.
  const clientPort = await freePort();
  await run({
    log: { loglevel: "none" },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: clientPort,
        protocol: "socks",
        settings: { auth: "noauth", udp: false },
      },
    ],
    outbounds: [
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "127.0.0.1",
              port: Number(endpoint.port),
              users: [{ id: bindings.NODE_UUID, encryption: "none" }],
            },
          ],
        },
        streamSettings: {
          network: "ws",
          security: "none",
          wsSettings: { path: "/ws" },
        },
      },
    ],
  });
  for (const kind of [
    "socks",
    "http",
    "aes-128-gcm",
    "aes-256-gcm",
    "chacha20-ietf-poly1305",
  ]) {
    const port = await freePort();
    const ss = kind !== "socks" && kind !== "http";
    await run({
      log: { loglevel: "none" },
      inbounds: [
        {
          listen: "127.0.0.1",
          port,
          protocol: ss ? "shadowsocks" : kind,
          settings: ss
            ? {
                method: kind,
                password: "interop-test-password",
                network: "tcp",
              }
            : kind === "socks"
              ? {
                  auth: "password",
                  accounts: [{ user: "test", pass: "interop-test-password" }],
                  udp: false,
                }
              : { accounts: [{ user: "test", pass: "interop-test-password" }] },
        },
      ],
      outbounds: [
        {
          protocol: "freedom",
          settings: {
            finalRules: [
              { action: "allow", ip: ["127.0.0.1/32"], port: targetPort },
            ],
          },
        },
      ],
    });
    const outbound = ss
      ? `ss://${Buffer.from(kind + ":interop-test-password").toString("base64url")}@127.0.0.1:${port}`
      : `${kind === "socks" ? "socks5" : "http"}://test:interop-test-password@127.0.0.1:${port}`;
    await kv.put(
      "cf-vless-panel:settings:v1",
      JSON.stringify({ ...c, mode: "only", outbound }),
    );
    await probe(clientPort);
    console.log("Xray outbound interoperability passed: " + kind);
  }
} finally {
  for (const child of children) child.kill();
  await mf.dispose();
  echo.closeAllConnections();
  echo.close();
  rmSync(tmp, { recursive: true, force: true });
}
