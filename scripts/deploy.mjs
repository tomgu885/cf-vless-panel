import {
  readFile,
  writeFile,
  chmod,
  mkdtemp,
  symlink,
  rm,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
class DeployError extends Error {}

const dryRun = process.argv.includes("--dry-run");
if (process.argv.includes("--help")) {
  console.log(
    "用法：./deploy.sh [--dry-run]\n交互生成本地配置与密钥，再部署。--dry-run 仅本地构建，不调用 Cloudflare API。",
  );
  process.exit(0);
}
if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
  console.error("不支持的参数；运行 ./deploy.sh --help 查看用法。");
  process.exit(1);
}
process.umask(0o077);
// 使用终端正常回显显示输入；不额外打印已保存的密钥或环境变量。
const input = createInterface({ input: process.stdin, terminal: false });
const lines = input[Symbol.asyncIterator]();
async function ask(label, fallback = "", description = "") {
  if (description) process.stdout.write("\n" + description + "\n");
  process.stdout.write(
    label + (fallback ? "（留空保留已有值/默认值）" : "") + "：",
  );
  const answer = await lines.next();
  if (answer.done) throw new DeployError("输入已结束，未继续部署。");
  process.stdout.write("\n");
  return answer.value.trim() || fallback;
}
async function readLocal(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new DeployError("本地配置必须是有效 JSON；请修正后重试。");
  }
}
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}
async function wrangler(args, token, accountId) {
  // Wrangler 会打印绑定、账号与 URL；丢弃原始输出，并禁止写调试日志。
  const logDir = await mkdtemp(join(tmpdir(), "cf-vless-deploy-"));
  const logPath = join(logDir, "wrangler.log");
  await symlink("/dev/null", logPath);
  try {
    const child = spawn(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", ...args],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          WRANGLER_LOG_PATH: logPath,
          WRANGLER_LOG_SANITIZE: "true",
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
        },
      },
    );
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (status !== 0)
      throw new DeployError(
        "Wrangler 执行失败。请检查账号权限、KV 归属、域名归属与网络；原始输出已隐藏。",
      );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
}
try {
  const template = await readLocal("wrangler.jsonc.example");
  const previous = await readLocal("wrangler.jsonc", null);
  const secrets = await readLocal(".deploy-secrets.json", {});
  let config = structuredClone(previous ?? template);
  if (
    previous &&
    (await ask("检测到本地配置。输入 reuse 复用；输入 edit 重新设置")) ===
      "reuse"
  ) {
    // 仍要求核对认证与部署意图；不旋转已有密钥。
  } else {
    config.account_id = await ask(
      "Cloudflare Account ID（32 位十六进制）",
      config.account_id,
      "用途：指定部署账号。获取：Cloudflare 控制台 → Workers & Pages → Account Details → Account ID；也可在控制台搜索 Copy account ID。",
    );
    config.name = await ask(
      "Worker 名称",
      config.name,
      "用途：部署的应用名称。新建时自行命名；更新已有应用时，从 Cloudflare 控制台 → Workers & Pages 复制对应 Worker 名称。",
    );
    const oldId = config.kv_namespaces?.find((n) => n.binding === "CONFIG")?.id;
    const id = await ask(
      "KV Namespace ID（留空自动创建）",
      /^[a-f0-9]{32}$/i.test(oldId ?? "") ? oldId : "",
      "用途：保存面板配置。获取：Cloudflare 控制台 → Workers KV，找到已有命名空间并复制 Namespace ID；首次部署可留空，由脚本创建。",
    );
    config.kv_namespaces = [{ binding: "CONFIG", id }];
    const domain = await ask(
      "自定义域名（留空使用 workers.dev；不要带协议）",
      "",
      "用途：面板与节点的访问域名。从你已接入当前 Cloudflare 账号的域名中选择一个子域名，例如 panel.example.com；无需自定义域名可留空。",
    );
    config.workers_dev = !domain;
    config.routes = domain ? [{ pattern: domain, custom_domain: true }] : [];
    if (
      domain &&
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
    )
      throw new DeployError("自定义域名格式错误。");
    secrets.ADMIN_PASSWORD = await ask(
      "管理密码（至少 16 字符）",
      secrets.ADMIN_PASSWORD,
      "用途：登录本项目管理面板。由你自行设置，不是 Cloudflare 登录密码；请使用至少 16 字符的独立密码。",
    );
    if (
      (await ask(
        "再次输入管理密码",
        "",
        "再次输入刚才设置或保留的管理密码，用于确认两次输入一致。",
      )) !== secrets.ADMIN_PASSWORD
    )
      throw new DeployError("两次管理密码不一致。");
    for (const [name, description] of Object.entries({
      SESSION_SECRET:
        "用途：签名面板登录会话。无需从 Cloudflare 获取；首次留空自动生成，也可自行提供至少 32 字符的随机密钥。",
      NODE_UUID:
        "用途：VLESS 节点认证。首次留空自动生成标准 UUID；迁移已有节点时可从原节点配置获取 UUID。",
      SUB_TOKEN:
        "用途：保护订阅链接。无需从 Cloudflare 获取；首次留空自动生成，也可自行提供至少 32 字符的随机令牌。",
      TROJAN_PASSWORD:
        "用途：Trojan 节点认证。首次留空自动生成，也可自行设置至少 16 字符的独立密码；迁移时可从原 Trojan 节点配置获取。",
    })) {
      const fallback =
        secrets[name] ||
        (name === "NODE_UUID"
          ? randomUUID()
          : randomBytes(32).toString("base64url"));
      secrets[name] = await ask(
        name + "（首次留空自动生成）",
        fallback,
        description,
      );
    }
    // 校验完成后统一落盘，不在输入中途覆盖已有配置。
  }
  await validateAndSave(config, secrets);
  let token = "";
  if (!dryRun) {
    token = await ask(
      "Cloudflare API Token（仅本次使用，不保存）",
      process.env.CLOUDFLARE_API_TOKEN,
      "用途：授权本次部署。获取：Cloudflare 控制台 → My Profile → API Tokens → Create Token。授予目标账号 Workers Scripts、Workers KV Storage 编辑权限；自定义域名还需对应 Zone 读取及 Workers Routes 编辑权限。",
    );
    if (!token) throw new DeployError("必须提供 Cloudflare API Token。");
    if (
      (await ask(
        "将向录入的账号/Worker 部署，并创建所需资源。输入 deploy 执行",
      )) !== "deploy"
    ) {
      console.log("已保存本地配置，未执行远端操作。");
      process.exit(0);
    }
    const namespace = config.kv_namespaces.find((n) => n.binding === "CONFIG");
    if (!namespace.id) {
      console.log("正在创建专用 KV…");
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/storage/kv/namespaces`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: `${config.name}-CONFIG` }),
          signal: AbortSignal.timeout(30000),
        },
      );
      const data = await response.json();
      if (
        !response.ok ||
        !data.success ||
        !/^[a-f0-9]{32}$/i.test(data.result?.id ?? "")
      )
        throw new DeployError(
          "KV 创建失败；请检查 Token 的 KV 编辑权限及 Account ID。",
        );
      namespace.id = data.result.id;
      await save("wrangler.jsonc", config);
      console.log("KV 已创建并保存；后续失败可复用，不会自动删除资源。");
    }
  }
  console.log(
    dryRun ? "正在本地验证部署产物…" : "正在构建并部署 Worker（含 Secrets）…",
  );
  const buildConfig = dryRun
    ? ".wrangler-deploy-check.jsonc"
    : "wrangler.jsonc";
  if (dryRun) {
    const localConfig = structuredClone(config);
    for (const namespace of localConfig.kv_namespaces) {
      if (!namespace.id) namespace.id = "00000000000000000000000000000000";
    }
    await save(buildConfig, localConfig);
  }
  try {
    await wrangler(
      [
        "deploy",
        "--config",
        buildConfig,
        "--secrets-file",
        ".deploy-secrets.json",
        ...(dryRun ? ["--dry-run", "--outdir", "dist"] : []),
      ],
      token,
      config.account_id,
    );
  } finally {
    if (dryRun) await rm(buildConfig, { force: true });
  }
  if (dryRun) {
    console.log("本地构建验证通过，未调用远端 API；未生成线上 VLESS 链接。");
  } else {
    console.log("部署成功。");
    // 仅在部署成功后输出用户请求的节点链接，不回显其他凭据。
    const routes = config.routes ?? (config.route ? [config.route] : []);
    let hostname = routes.find(
      (route) => route?.custom_domain === true,
    )?.pattern;
    if (!hostname && config.workers_dev === false) {
      throw new DeployError(
        "部署已成功，但未配置自定义域名且 workers.dev 已禁用，无法生成 VLESS 链接。",
      );
    }
    if (!hostname) {
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/subdomain`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30000),
          },
        );
        const data = await response.json();
        if (
          !response.ok ||
          !data.success ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(
            data.result?.subdomain ?? "",
          )
        ) {
          throw new Error("Unavailable subdomain");
        }
        hostname = `${config.name}.${data.result.subdomain}.workers.dev`;
      } catch {
        throw new DeployError(
          "部署已成功，但读取 Cloudflare 分配域名失败，未生成 VLESS 链接。请检查网络与 Token 的 Workers Scripts 权限。",
        );
      }
    }
    const params = new URLSearchParams({
      encryption: "none",
      security: "tls",
      type: "ws",
      host: hostname,
      sni: hostname,
      path: "/ws",
    });
    console.log("VLESS / WebSocket（TLS，端口 443），复制到客户端导入：");
    console.log(
      `vless://${encodeURIComponent(secrets.NODE_UUID)}@${hostname}:443?${params}#${encodeURIComponent(config.name)}`,
    );
  }
} catch (error) {
  // 只显示脚本自己的错误，网络/系统异常可能包含配置或凭据。
  console.error(
    error instanceof DeployError
      ? error.message
      : "操作失败，请检查输入文件、网络及文件权限。",
  );
  process.exitCode = 1;
} finally {
  input.close();
}

async function validateAndSave(config, secrets) {
  if (!/^[a-f0-9]{32}$/i.test(config.account_id ?? ""))
    throw new DeployError("Account ID 格式错误。");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name ?? ""))
    throw new DeployError("Worker 名称格式错误。");
  const id = config.kv_namespaces?.find((n) => n.binding === "CONFIG")?.id;
  if (id !== "" && !/^[a-f0-9]{32}$/i.test(id ?? ""))
    throw new DeployError("KV Namespace ID 格式错误。");
  for (const [key, min] of Object.entries({
    ADMIN_PASSWORD: 16,
    SESSION_SECRET: 32,
    SUB_TOKEN: 32,
    TROJAN_PASSWORD: 16,
  }))
    if (typeof secrets[key] !== "string" || secrets[key].length < min)
      throw new DeployError(key + " 长度不足。");
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      secrets.NODE_UUID ?? "",
    )
  )
    throw new DeployError("NODE_UUID 格式错误。");
  await save(".deploy-secrets.json", secrets);
  await save("wrangler.jsonc", config);
}
