import { test } from "node:test";
import assert from "node:assert/strict";
import { Reader, concat } from "../src/bytes.ts";
import { handshake } from "../src/protocol.ts";
import { validate, defaults } from "../src/config.ts";
import { subscription } from "../src/subscription.ts";
import { issue, authenticated, cookie } from "../src/auth.ts";
import { createHash } from "node:crypto";
const env = {
  NODE_UUID: "00000000-0000-4000-8000-000000000001",
  TROJAN_PASSWORD: "test-only-trojan-password",
  ADMIN_PASSWORD: "test-only-admin-password",
  SESSION_SECRET: "test-only-session-secret-32-characters",
  SUB_TOKEN: "test-only-subscription-token-32-chars",
} as Env;
const uuid = Buffer.from(env.NODE_UUID.replaceAll("-", ""), "hex");
const vless = concat(
  new Uint8Array([0]),
  uuid,
  new Uint8Array([0, 1, 1, 187, 2, 11]),
  Buffer.from("example.com"),
);
function reader(data: Uint8Array) {
  let i = 0;
  return new Reader(
    new ReadableStream({
      pull(c) {
        if (i === data.length) c.close();
        else c.enqueue(data.slice(i, (i += 1)));
      },
    }).getReader(),
  );
}
test("VLESS fragmented TCP header authenticates and parses target", async () => {
  const h = await handshake(reader(vless), "vless", env);
  assert.equal(h.host, "example.com");
  assert.equal(h.port, 443);
  assert.deepEqual([...h.response], [0, 0]);
});
test("wrong UUID rejected before outbound", async () => {
  const bad = vless.slice();
  bad[1] = 1;
  await assert.rejects(handshake(reader(bad), "vless", env), /Authentication/);
});
test("UDP commands explicitly rejected", async () => {
  const bad = vless.slice();
  bad[18] = 2;
  await assert.rejects(handshake(reader(bad), "vless", env), /TCP only/);
});
test("Trojan header supports fragmentation", async () => {
  const data = concat(
    Buffer.from(createHash("sha224").update(env.TROJAN_PASSWORD).digest("hex")),
    new Uint8Array([13, 10, 1, 3, 11]),
    Buffer.from("example.com"),
    new Uint8Array([1, 187, 13, 10]),
  );
  assert.equal((await handshake(reader(data), "trojan", env)).port, 443);
});
test("cookie signing, tampering and password rotation", () => {
  const token = issue(env);
  const req = (t: string) =>
    new Request("https://panel.test", { headers: { Cookie: cookie(t) } });
  assert.equal(authenticated(req(token), env), true);
  assert.equal(authenticated(req(token + "x"), env), false);
  assert.equal(
    authenticated(req(token), { ...env, ADMIN_PASSWORD: "changed" }),
    false,
  );
});
test("invalid modes and only mode without proxy rejected", () => {
  assert.throws(() => validate({ ...defaults, mode: "only" }));
  assert.throws(() => validate({ ...defaults, ports: [0] }));
  assert.deepEqual(validate(defaults), defaults);
});
test("subscriptions isolate outbound credentials and client transports", async () => {
  const c = {
    ...defaults,
    outbound: "socks5://private-user:private-password@private.test:1080",
  };
  for (const format of ["uri", "clash", "singbox"]) {
    const body = await subscription(
      new URL("https://panel.test/sub/token?format=" + format),
      c,
      env,
    ).text();
    assert.ok(!body.includes("private-password"));
    assert.ok(!body.includes(env.ADMIN_PASSWORD));
    if (format !== "uri") assert.ok(!body.includes("xhttp"));
    else assert.ok(body.includes("mode=packet-up"));
  }
});
