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
  await writeFile(
    join(root, "mock-read-api.mjs"),
    `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      fs.appendFileSync('api-calls.txt', url + '\\n');
      if (!url.endsWith('/workers/subdomain') || options.method || !options.headers.Authorization) throw Error('unexpected API call');
      if (process.env.TEST_SUBDOMAIN_FAIL) return Response.json({success:false}, {status:403});
      return Response.json({success:true,result:{subdomain:'assigned-account'}});
    };
  `,
  );
  return root;
}
function run(root, lines, args = [], env = {}) {
  const r = spawnSync("/bin/bash", ["deploy.sh", ...args], {
    cwd: root,
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "",
      NODE_OPTIONS: "--import=" + join(root, "mock-read-api.mjs"),
      ...env,
    },
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
 if(url.endsWith('/workers/subdomain'))return Response.json({success:true,result:{subdomain:'assigned-account'}});
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

test("successful deploy prints a VLESS URI using the first configured custom domain", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  c.routes = [
    { pattern: "ordinary.example.com/*" },
    { pattern: "preferred.example.com", custom_domain: true },
    { pattern: "second.example.com", custom_domain: true },
  ];
  await writeFile(join(root, "wrangler.jsonc"), JSON.stringify(c));
  const result = run(root, ["reuse", token, "deploy"]);
  assert.equal(result.status, 0);
  const link = new URL(
    result.output.split(/\r?\n/).find((line) => line.startsWith("vless://")),
  );
  assert.equal(link.hostname, "preferred.example.com");
  assert.equal(link.port, "443");
  assert.equal(
    link.username,
    JSON.parse(await readFile(join(root, ".deploy-secrets.json"))).NODE_UUID,
  );
  for (const [key, value] of Object.entries({
    host: "preferred.example.com",
    sni: "preferred.example.com",
    type: "ws",
    path: "/ws",
    security: "tls",
    encryption: "none",
  }))
    assert.equal(link.searchParams.get(key), value);
  assert.equal(decodeURIComponent(link.hash.slice(1)), c.name);
  await assert.rejects(stat(join(root, "api-calls.txt")));
});

test("without a custom domain the URI uses the account subdomain returned by Cloudflare", async (t) => {
  const root = await fixture(t);
  const result = run(root, [...answers(), token, "deploy"]);
  assert.equal(result.status, 0);
  const link = new URL(
    result.output.split(/\r?\n/).find((line) => line.startsWith("vless://")),
  );
  assert.equal(link.hostname, "test-worker.assigned-account.workers.dev");
  assert.equal(link.searchParams.get("sni"), link.hostname);
  assert.equal(link.searchParams.get("host"), link.hostname);
  assert.ok(
    (await readFile(join(root, "api-calls.txt"), "utf8")).includes(
      "/workers/subdomain",
    ),
  );
});

test("dry run, cancellation, failed deployment and failed domain lookup do not print a usable-looking URI", async (t) => {
  const root = await fixture(t);
  const dry = run(root, answers(), ["--dry-run"]);
  assert.equal(dry.status, 0);
  assert.ok(!dry.output.includes("vless://"));
  await assert.rejects(stat(join(root, "api-calls.txt")));
  const cancelled = run(root, ["reuse", token, "cancel"]);
  assert.ok(!cancelled.output.includes("vless://"));
  const failed = run(root, ["reuse", token, "deploy"], [], {
    TEST_WRANGLER_FAIL: "1",
  });
  assert.equal(failed.status, 1);
  assert.ok(!failed.output.includes("vless://"));
  await assert.rejects(stat(join(root, "api-calls.txt")));
  const lookup = run(root, ["reuse", token, "deploy"], [], {
    TEST_SUBDOMAIN_FAIL: "1",
  });
  assert.equal(lookup.status, 1);
  assert.ok(lookup.output.includes("部署已成功"));
  assert.ok(!lookup.output.includes("vless://"));
});

test("disabled workers.dev without custom domain does not generate an inaccessible URI", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  c.workers_dev = false;
  await writeFile(join(root, "wrangler.jsonc"), JSON.stringify(c));
  const result = run(root, ["reuse", token, "deploy"]);
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("workers.dev 已禁用"));
  assert.ok(!result.output.includes("vless://"));
  await assert.rejects(stat(join(root, "api-calls.txt")));
});

test("blank admin password generates a private random password without confirmation", async (t) => {
  const generated = [];
  for (const blank of ["", " \t "]) {
    const root = await fixture(t);
    const lines = answers();
    lines.splice(4, 2, blank);
    const result = run(root, lines, ["--dry-run"]);
    assert.equal(result.status, 0);
    assert.ok(!result.output.includes("再次输入管理密码"));
    const secrets = JSON.parse(
      await readFile(join(root, ".deploy-secrets.json")),
    );
    assert.match(secrets.ADMIN_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!result.output.includes(secrets.ADMIN_PASSWORD));
    assert.equal(
      (await stat(join(root, ".deploy-secrets.json"))).mode & 0o777,
      0o600,
    );
    generated.push(secrets.ADMIN_PASSWORD);
    assert.equal(run(root, ["reuse"], ["--dry-run"]).status, 0);
    assert.equal(run(root, ["edit", ...lines], ["--dry-run"]).status, 0);
    assert.equal(
      JSON.parse(await readFile(join(root, ".deploy-secrets.json")))
        .ADMIN_PASSWORD,
      secrets.ADMIN_PASSWORD,
    );
  }
  assert.notEqual(generated[0], generated[1]);
});

test("manually entered admin passwords still require matching confirmation and minimum length", async (t) => {
  const root = await fixture(t);
  const mismatch = answers();
  mismatch[5] = "different-test-password";
  const result = run(root, mismatch, ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("两次管理密码不一致"));
  await assert.rejects(stat(join(root, ".deploy-secrets.json")));
  const short = answers();
  short[4] = short[5] = "short";
  const invalid = run(root, short, ["--dry-run"]);
  assert.equal(invalid.status, 1);
  assert.ok(invalid.output.includes("ADMIN_PASSWORD 至少需要 16 字符"));
});

test("invalid values are retried at each prompt without losing earlier valid answers", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const uuid = "00000000-0000-4000-8000-000000000001";
  const result = run(
    root,
    [
      "wrong-mode",
      "edit",
      "bad-account",
      account,
      "Invalid Worker",
      "test-worker",
      "bad-kv",
      kv,
      "https://panel.example.com",
      "panel.example.com",
      "short",
      password,
      "mismatch",
      password,
      "short",
      "s".repeat(32),
      "invalid-uuid",
      uuid,
      "short",
      "u".repeat(32),
      "short",
      "trojan-test-password",
      "",
      "bad token",
      token,
      "typo",
      "deploy",
    ],
    [],
    { TEST_EXPECT_TOKEN: token },
  );
  assert.equal(result.status, 0);
  const expectedErrors = [
    "请输入 reuse 或 edit。",
    "Account ID 必须是",
    "Worker 名称需为",
    "KV Namespace ID 必须是",
    "自定义域名格式错误",
    "ADMIN_PASSWORD 至少需要",
    "两次管理密码不一致",
    "SESSION_SECRET 至少需要",
    "NODE_UUID 必须是",
    "SUB_TOKEN 至少需要",
    "TROJAN_PASSWORD 至少需要",
    "API Token 必填",
    "请输入 deploy 或 cancel。",
  ];
  let last = -1;
  for (const error of expectedErrors) {
    const index = result.output.indexOf(error);
    assert.ok(index > last, "errors should appear at their input step");
    last = index;
  }
  assert.ok(
    result.output.indexOf("Account ID 必须是") <
      result.output.indexOf("用途：部署的应用名称"),
  );
  assert.ok(
    result.output.indexOf("ADMIN_PASSWORD 至少需要") <
      result.output.indexOf("再次输入管理密码"),
  );
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  assert.equal(c.account_id, account);
  assert.equal(c.name, "test-worker");
  assert.equal(c.kv_namespaces[0].id, kv);
  assert.equal(c.routes[0].pattern, "panel.example.com");
  const secrets = JSON.parse(
    await readFile(join(root, ".deploy-secrets.json")),
  );
  assert.equal(secrets.ADMIN_PASSWORD, password);
  assert.equal(secrets.NODE_UUID, uuid);
  assert.equal(secrets.SESSION_SECRET, "s".repeat(32));
  assert.equal(secrets.SUB_TOKEN, "u".repeat(32));
  assert.equal(secrets.TROJAN_PASSWORD, "trojan-test-password");
});

test("EOF during retry does not advance to the next field or save partial configuration", async (t) => {
  const root = await fixture(t);
  const result = run(root, ["invalid-account"], ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("请重新输入"));
  assert.ok(!result.output.includes("用途：部署的应用名称"));
  await assert.rejects(stat(join(root, "wrangler.jsonc")));
  await assert.rejects(stat(join(root, "called.json")));
});

test("reuse prompts only for invalid saved fields and allows correcting them", async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, answers(), ["--dry-run"]).status, 0);
  const before = JSON.parse(await readFile(join(root, ".deploy-secrets.json")));
  const broken = { ...before, NODE_UUID: "bad-uuid" };
  await writeFile(join(root, ".deploy-secrets.json"), JSON.stringify(broken));
  const result = run(
    root,
    ["reuse", "still-bad", before.NODE_UUID],
    ["--dry-run"],
  );
  assert.equal(result.status, 0);
  assert.ok(result.output.includes("本地 NODE_UUID 无效"));
  assert.ok(result.output.includes("NODE_UUID 必须是"));
  assert.ok(!result.output.includes("Cloudflare Account ID"));
  assert.deepEqual(
    JSON.parse(await readFile(join(root, ".deploy-secrets.json"))),
    before,
  );
});

test("required token retries blank input even when an environment token exists", async (t) => {
  const root = await fixture(t);
  const environmentToken = "environment-token-for-test-only";
  const result = run(root, [...answers(), "", " \t ", token, "deploy"], [], {
    CLOUDFLARE_API_TOKEN: environmentToken,
    TEST_EXPECT_TOKEN: token,
  });
  assert.equal(result.status, 0);
  const prompt = "Cloudflare API Token（必填，仅本次使用，不保存）：";
  assert.equal(result.output.split(prompt).length - 1, 3);
  assert.equal(
    result.output.split("此项为必填项，不能为空。请重新输入。").length - 1,
    2,
  );
  assert.ok(
    result.output.lastIndexOf(prompt) <
      result.output.indexOf("输入 deploy 执行"),
  );
  assert.ok(!result.output.includes(environmentToken));
  const args = JSON.parse(await readFile(join(root, "called.json")));
  assert.ok(args.includes("deploy"));
});

test("required account and password confirmation retry blank answers", async (t) => {
  const root = await fixture(t);
  const lines = answers();
  lines.splice(5, 0, "", " \t ");
  lines.unshift("", " \t ");
  const result = run(root, lines, ["--dry-run"]);
  assert.equal(result.status, 0);
  assert.equal(
    result.output.split("此项为必填项，不能为空。请重新输入。").length - 1,
    4,
  );
  const c = JSON.parse(await readFile(join(root, "wrangler.jsonc")));
  assert.equal(c.account_id, account);
});

test("EOF after an empty required token stops without using an environment token", async (t) => {
  const root = await fixture(t);
  const result = run(root, [...answers(), " \t "], [], {
    CLOUDFLARE_API_TOKEN: "environment-token-for-test-only",
  });
  assert.equal(result.status, 1);
  assert.ok(result.output.includes("此项为必填项，不能为空。请重新输入。"));
  assert.ok(!result.output.includes("输入 deploy 执行"));
  await assert.rejects(stat(join(root, "called.json")));
  await assert.rejects(stat(join(root, "api-calls.txt")));
});
