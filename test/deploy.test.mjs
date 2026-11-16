import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const account = "a".repeat(32),
  kv = "b".repeat(32),
  password = "local-test-admin-password",
  token = "local-test-api-token";
const answers = (id = kv) => [
  account,
  "test-worker",
  id,
  "",
  password,
  password,
  "",
  "",
  "",
  "",
];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cf-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
  for (const file of [
    "deploy.sh",
    "wrangler.jsonc.example",
    "scripts/deploy.mjs",
  ])
    await copyFile(file, join(root, file));
  await writeFile(
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    `
 const fs=require('node:fs');
 const secrets=JSON.parse(fs.readFileSync('.deploy-secrets.json'));
 const args=process.argv.slice(2);
 if(args.includes('--secrets-file') && fs.readlinkSync(process.env.WRANGLER_LOG_PATH)==='/dev/null')fs.writeFileSync('called.json',JSON.stringify(args));
 console.log(secrets.ADMIN_PASSWORD);console.error(process.env.CLOUDFLARE_API_TOKEN);
 if(process.env.TEST_EXPECT_TOKEN && process.env.CLOUDFLARE_API_TOKEN!==process.env.TEST_EXPECT_TOKEN)process.exit(2);
 if(process.env.TEST_WRANGLER_FAIL)process.exit(1);
 `,
  );
  return root;
}
function run(root, lines, args = [], env = {}) {
  const r = spawnSync("/bin/bash", ["deploy.sh", ...args], {
    cwd: root,
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", ...env },
    timeout: 10000,
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  for (const secret of [account, kv, password, token])
    assert.ok(!output.includes(secret), "output must not disclose inputs");
  assert.equal(r.error, undefined);
  return { ...r, output };
}
test("dry run generates private configuration and secrets; reuse preserves keys", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  assert.equal(c.account_id, account);
  assert.equal(c.kv_namespaces[0].id, kv);
  assert.equal(c.workers_dev, true);
  const first = await readFile(join(root, ".deploy-secrets.json"), "utf8");
  assert.ok(!JSON.stringify(c).includes(password));
  assert.ok(!first.includes(token));
  for (const file of ["wrangler.jsonc", ".deploy-secrets.json"])
    assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
  assert.equal(run(root, ["reuse"], ["--dry-run"]).status, 0);
  assert.equal(
    await readFile(join(root, ".deploy-secrets.json"), "utf8"),
    first,
  );
  const args = JSON.parse(await readFile(join(root, "called.json")));
  assert.ok(args.includes("--dry-run"));
  assert.ok(args.includes("--secrets-file"));
});
test("cancel prevents deployment and failure output stays redacted", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, [...answers(), token, "cancel"]).status, 0);
  await assert.rejects(stat(join(root, "called.json")));
  const result = run(root, ["reuse", token, "deploy"], [], {
    TEST_WRANGLER_FAIL: "1",
  });
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("Wrangler 执行失败"));
});
test("bad input does not overwrite an existing configuration", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const before = await readFile(join(root, "wrangler.jsonc"), "utf8");
  const bad = answers();
  bad[0] = "invalid";
  assert.equal(run(root, ["edit", ...bad], ["--dry-run"]).status, 1);
  assert.equal(await readFile(join(root, "wrangler.jsonc"), "utf8"), before);
});
test("automatic KV creation persists ID before deployment and is reused", async (t) => {
  const root = await fixture(t);
  const preload = join(root, "mock-api.mjs");
  await writeFile(
    preload,
    `
 import fs from 'node:fs';
 globalThis.fetch=async(url,options)=>{
 if(!url.startsWith('https://api.cloudflare.com/client/v4/accounts/')||options.method!=='POST'||!options.headers.Authorization)throw Error('invalid API call');
 fs.writeFileSync('kv-created','yes');return Response.json({success:true,result:{id:'${kv}'}});
 };
 `,
  );
  const result = run(root, [...answers(""), token, "deploy"], [], {
    NODE_OPTIONS: "--import=" + preload,
  });
  assert.equal(result.status, 0);
  assert.equal(
    JSON.parse(await readFile(join(root, "wrangler.jsonc"))).kv_namespaces[0]
      .id,
    kv,
  );
  assert.equal(await readFile(join(root, "kv-created"), "utf8"), "yes");
  assert.equal(run(root, ["reuse", token, "deploy"]).status, 0);
});

test("dry run with new KV keeps creation pending and removes temporary config", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(""), ["--dry-run"]).status, 0);
  assert.equal(
    JSON.parse(await readFile(join(root, "wrangler.jsonc"))).kv_namespaces[0]
      .id,
    "",
  );
  await assert.rejects(stat(join(root, ".wrangler-deploy-check.jsonc")));
  await assert.rejects(stat(join(root, "kv-created")));
});

test("all entered fields and actions trim whitespace; internal password spaces remain", async (t) => {
  const root = await fixture(t);
  const admin = "local test admin password";
  const values = [
    account,
    "test-worker",
    kv,
    "panel.example.com",
    admin,
    admin,
    "s".repeat(32),
    "00000000-0000-4000-8000-000000000001",
    "u".repeat(32),
    "trojan test password",
    token,
    "deploy",
  ];
  const result = run(
    root,
    values.map((value) => " \t" + value + "\t "),
    [],
    { TEST_EXPECT_TOKEN: token },
  );
  assert.equal(result.status, 0);
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  const secrets = JSON.parse(
    await readFile(join(root, ".deploy-secrets.json")),
  );
  assert.equal(c.account_id, account);
  assert.equal(c.name, "test-worker");
  assert.equal(c.kv_namespaces[0].id, kv);
  assert.equal(c.routes[0].pattern, "panel.example.com");
  for (const [index, key] of [
    "ADMIN_PASSWORD",
    "SESSION_SECRET",
    "NODE_UUID",
    "SUB_TOKEN",
    "TROJAN_PASSWORD",
  ].entries())
    assert.equal(secrets[key], values[[4, 6, 7, 8, 9][index]]);
  assert.equal(run(root, [" \treuse\t "], ["--dry-run"]).status, 0);
  const edited = run(
    root,
    [
      " edit ",
      " \t ",
      " \t ",
      " \t ",
      " \t ",
      " \t ",
      " " + admin + " ",
      " \t ",
      " \t ",
      " \t ",
      " \t ",
    ],
    ["--dry-run"],
  );
  assert.equal(edited.status, 0);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, ".deploy-secrets.json"))),
    secrets,
  );
});

test("prompts explain where external parameters and application credentials come from", async (t) => {
  const root = await fixture(t);
  const result = run(root, [...answers(), token, "cancel"]);
  assert.equal(result.status, 0);
  for (const hint of [
    "Copy account ID",
    "Workers & Pages",
    "Workers KV",
    "panel.example.com",
    "不是 Cloudflare 登录密码",
    "签名面板登录会话",
    "VLESS 节点认证",
    "保护订阅链接",
    "Trojan 节点认证",
    "My Profile → API Tokens → Create Token",
  ])
    assert.ok(result.output.includes(hint));
});
