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

const rules = {
  account_id: (value) =>
    /^[a-f0-9]{32}$/i.test(value ?? "")
      ? ""
      : "Account ID 必须是 32 位十六进制字符。",
  name: (value) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
      ? ""
      : "Worker 名称需为 1–63 个小写字母、数字或连字符，并以字母或数字开头。",
  id: (value) =>
    value === "" || /^[a-f0-9]{32}$/i.test(value ?? "")
      ? ""
      : "KV Namespace ID 必须是 32 位十六进制字符，或留空自动创建。",
  domain: (value) =>
    value === "" ||
    (typeof value === "string" &&
      value.length <= 253 &&
      value.split(".").every((label) => label.length <= 63) &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value))
      ? ""
      : "自定义域名格式错误；请填写纯域名，不要带协议、端口或路径，也可留空。",
  ADMIN_PASSWORD: (value) =>
    typeof value === "string" && value.length >= 16
      ? ""
      : "ADMIN_PASSWORD 至少需要 16 字符。",
  SESSION_SECRET: (value) =>
    typeof value === "string" && value.length >= 32
      ? ""
      : "SESSION_SECRET 至少需要 32 字符。",
  SUB_TOKEN: (value) =>
    typeof value === "string" && value.length >= 32
      ? ""
      : "SUB_TOKEN 至少需要 32 字符。",
  TROJAN_PASSWORD: (value) =>
    typeof value === "string" && value.length >= 16
      ? ""
      : "TROJAN_PASSWORD 至少需要 16 字符。",
  NODE_UUID: (value) =>
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? "")
      ? ""
      : "NODE_UUID 必须是标准 UUID（8-4-4-4-12）。",
};

const dryRun = process.argv.includes("--dry-run");
const reDeploy = process.argv.includes("--re-deploy");
const debugOn = process.argv.includes("--debug");
const debugOff = process.argv.includes("--no-debug");
if (process.argv.includes("--help")) {
  console.log(
    "用法：./deploy.sh [--re-deploy] [--debug | --no-debug] [--dry-run]\n--re-deploy 复用完整配置与密钥，并核实远端已有部署。\n--debug 开启错误日志与 source maps；--no-debug 关闭。再次部署未指定时交互选择。\n--dry-run 仅本地构建，不调用 Cloudflare API。",
  );
  process.exit(0);
}
if (
  process.argv
    .slice(2)
    .some(
      (arg) =>
        !["--dry-run", "--re-deploy", "--debug", "--no-debug"].includes(arg),
    ) ||
  (debugOn && debugOff)
) {
  console.error(
    "不支持的参数或同时指定了 --debug/--no-debug；运行 ./deploy.sh --help 查看用法。",
  );
  process.exit(1);
}
process.umask(0o077);
// 使用终端正常回显显示输入；不额外打印已保存的密钥或环境变量。
const input = createInterface({ input: process.stdin, terminal: false });
const lines = input[Symbol.asyncIterator]();
async function ask(
  label,
  fallback = "",
  description = "",
  validate = () => "",
) {
  if (description) process.stdout.write("\n" + description + "\n");
  while (true) {
    process.stdout.write(
      label + (fallback ? "（留空保留已有值/默认值）" : "") + "：",
    );
    const answer = await lines.next();
    if (answer.done) throw new DeployError("输入已结束，未继续部署。");
    process.stdout.write("\n");
    const value = answer.value.trim() || fallback;
    const error = validate(value);
    if (!error) return value;
    console.log(
      value === ""
        ? "此项为必填项，不能为空。请重新输入。"
        : error + " 请重新输入。",
    );
  }
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
  if (reDeploy) {
    const namespace = previous?.kv_namespaces?.find(
      (n) => n.binding === "CONFIG",
    );
    if (
      !previous ||
      rules.account_id(previous.account_id) ||
      rules.name(previous.name) ||
      !namespace?.id ||
      rules.id(namespace.id) ||
      typeof previous.main !== "string" ||
      !previous.main.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(previous.compatibility_date ?? "") ||
      !previous.durable_objects?.bindings?.some(
        (b) => b.name === "XHTTP" && b.class_name === "XhttpSession",
      )
    ) {
      throw new DeployError(
        "--re-deploy 需要完整的 wrangler.jsonc（账号、Worker、入口、兼容日期、KV 和 XHTTP 绑定）；请先运行普通部署补齐配置。",
      );
    }
    for (const key of [
      "ADMIN_PASSWORD",
      "SESSION_SECRET",
      "NODE_UUID",
      "SUB_TOKEN",
      "TROJAN_PASSWORD",
    ]) {
      if (rules[key](secrets[key]))
        throw new DeployError(
          "--re-deploy 需要完整有效的 .deploy-secrets.json；请先运行普通部署补齐密钥。",
        );
    }
    for (const route of previous.routes ??
      (previous.route ? [previous.route] : [])) {
      if (
        route?.custom_domain &&
        (!route.pattern || rules.domain(route.pattern))
      )
        throw new DeployError("本地自定义域名无效，请先修正配置。");
    }
    console.log("已复用本地配置与密钥，不重新创建 KV 或生成密码。");
  } else if (
    previous &&
    (await ask(
      "检测到本地配置。输入 reuse 复用；输入 edit 重新设置",
      "",
      "",
      (value) =>
        ["reuse", "edit"].includes(value) ? "" : "请输入 reuse 或 edit。",
    )) === "reuse"
  ) {
    // 已保存的数据在读取边界校验；只重新询问需要修正的字段。
    const namespace = config.kv_namespaces.find((n) => n.binding === "CONFIG");
    for (const [object, keys] of [
      [config, ["account_id", "name"]],
      [namespace, ["id"]],
      [
        secrets,
        [
          "ADMIN_PASSWORD",
          "SESSION_SECRET",
          "NODE_UUID",
          "SUB_TOKEN",
          "TROJAN_PASSWORD",
        ],
      ],
    ]) {
      for (const key of keys) {
        if (rules[key](object[key])) {
          console.log(`本地 ${key} 无效，需要修正。`);
          object[key] = await ask(key, "", "", rules[key]);
          if (key === "ADMIN_PASSWORD") {
            await ask("再次输入管理密码", "", "", (value) =>
              value === object[key] ? "" : "两次管理密码不一致。",
            );
          }
        }
      }
    }
    for (const route of config.routes ?? (config.route ? [config.route] : [])) {
      if (route?.custom_domain && rules.domain(route.pattern)) {
        route.pattern = await ask(
          "自定义域名",
          "",
          "本地自定义域名无效，请重新填写纯域名。",
          (value) =>
            value
              ? rules.domain(value)
              : "已有自定义域名不可为空，请输入域名。",
        );
      }
    }
  } else {
    config.account_id = await ask(
      "Cloudflare Account ID（32 位十六进制）",
      config.account_id,
      "用途：指定部署账号。获取：Cloudflare 控制台 → Workers & Pages → Account Details → Account ID；也可在控制台搜索 Copy account ID。",
      rules.account_id,
    );
    config.name = await ask(
      "Worker 名称",
      config.name,
      "用途：部署的应用名称。新建时自行命名；更新已有应用时，从 Cloudflare 控制台 → Workers & Pages 复制对应 Worker 名称。",
      rules.name,
    );
    const oldId = config.kv_namespaces?.find((n) => n.binding === "CONFIG")?.id;
    const id = await ask(
      "KV Namespace ID（留空自动创建）",
      /^[a-f0-9]{32}$/i.test(oldId ?? "") ? oldId : "",
      "用途：保存面板配置。获取：Cloudflare 控制台 → Workers KV，找到已有命名空间并复制 Namespace ID；首次部署可留空，由脚本创建。",
      rules.id,
    );
    config.kv_namespaces = [{ binding: "CONFIG", id }];
    const domain = await ask(
      "自定义域名（留空使用 workers.dev；不要带协议）",
      "",
      "用途：面板与节点的访问域名。从你已接入当前 Cloudflare 账号的域名中选择一个子域名，例如 panel.example.com；无需自定义域名可留空。",
      rules.domain,
    );
    config.workers_dev = !domain;
    config.routes = domain ? [{ pattern: domain, custom_domain: true }] : [];
    const adminPassword = await ask(
      "管理密码（手动输入至少 16 字符；首次留空自动生成）",
      "",
      "用途：登录本项目管理面板，不是 Cloudflare 登录密码。首次留空自动生成随机密码；已有配置时留空保留原密码。",
      (value) =>
        value || secrets.ADMIN_PASSWORD
          ? rules.ADMIN_PASSWORD(value || secrets.ADMIN_PASSWORD)
          : "",
    );
    if (adminPassword) {
      await ask(
        "再次输入管理密码",
        "",
        "再次输入刚才手动设置的管理密码，用于确认两次输入一致。",
        (value) => (value === adminPassword ? "" : "两次管理密码不一致。"),
      );
      secrets.ADMIN_PASSWORD = adminPassword;
    } else if (!secrets.ADMIN_PASSWORD) {
      secrets.ADMIN_PASSWORD = randomBytes(32).toString("base64url");
      console.log(
        "已生成随机管理密码；配置保存后可在本地 .deploy-secrets.json 的 ADMIN_PASSWORD 查看。",
      );
    }
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
        rules[name],
      );
    }
    // 校验完成后统一落盘，不在输入中途覆盖已有配置。
  }
  let debug = config.vars?.DEBUG === "true";
  if (debugOn || debugOff) debug = debugOn;
  else if (reDeploy) {
    debug =
      (await ask(
        "调试模式：on 开启，off 关闭",
        debug ? "on" : "off",
        "开启后记录脱敏错误定位信息并上传 source map，便于排查 1101。",
        (value) => (["on", "off"].includes(value) ? "" : "请输入 on 或 off。"),
      )) === "on";
  }
  config.vars = { ...config.vars, DEBUG: String(debug) };
  config.upload_source_maps = debug;
  config.observability = {
    enabled: debug,
    redact_query_string: true,
    logs: { enabled: debug, head_sampling_rate: 1, invocation_logs: false },
    traces: { enabled: false },
  };
  console.log(
    debug ? "调试模式：开启（错误日志 + source maps）。" : "调试模式：关闭。",
  );
  // 再次部署在确认远端已有部署后才更新本地调试配置。
  if (!reDeploy) {
    await save(".deploy-secrets.json", secrets);
    await save("wrangler.jsonc", config);
  }
  let token = "";
  if (!dryRun) {
    token = await ask(
      "Cloudflare API Token（必填，仅本次使用，不保存）",
      "",
      "用途：授权本次部署。获取：Cloudflare 控制台 → My Profile → API Tokens → Create Token。授予目标账号 Workers Scripts、Workers KV Storage 编辑权限；自定义域名还需对应 Zone 读取及 Workers Routes 编辑权限。",
      (value) =>
        typeof value === "string" && /^[\x21-\x7e]+$/.test(value)
          ? ""
          : "API Token 必填且不能包含空白或非 ASCII 字符。",
    );
    if (
      (await ask(
        reDeploy
          ? "将更新已有 Worker 的代码、配置与 Secrets。输入 deploy 执行，cancel 取消"
          : "将向录入的账号/Worker 部署，并创建所需资源。输入 deploy 执行，cancel 取消",
        "",
        "",
        (value) =>
          ["deploy", "cancel"].includes(value)
            ? ""
            : "请输入 deploy 或 cancel。",
      )) !== "deploy"
    ) {
      console.log(
        reDeploy
          ? "已取消，本地配置未修改，未执行远端操作。"
          : "已保存本地配置，未执行远端操作。",
      );
      process.exit(0);
    }
    if (reDeploy) {
      console.log(
        "正在通过 Cloudflare Deployments API 核实远端已有部署（超时 30 秒）…",
      );
      const started = performance.now();
      const signal = AbortSignal.timeout(30000);
      let response;
      let data;
      const timing = () => {
        const elapsed = `${Math.round(performance.now() - started)} ms`;
        return response ? `HTTP ${response.status}，${elapsed}` : elapsed;
      };
      const verificationError = (detail) =>
        new DeployError(
          `远端部署核实失败（${timing()}）：${detail}。尚未再次部署。`,
        );
      try {
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/deployments`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          },
        );
        data = await response.json();
      } catch (error) {
        if (signal.aborted || error?.name === "TimeoutError")
          throw verificationError(
            "请求超时，请检查到 Cloudflare API 的网络连接",
          );
        // 仅输出已知网络错误码，原始异常和响应内容可能包含敏感值。
        if (!(response && error instanceof SyntaxError)) {
          const code = error?.cause?.code ?? error?.code;
          const knownCode = [
            "ENOTFOUND",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "ECONNRESET",
            "ETIMEDOUT",
            "ENETUNREACH",
            "EHOSTUNREACH",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_SOCKET",
            "CERT_HAS_EXPIRED",
            "ERR_TLS_CERT_ALTNAME_INVALID",
            "SELF_SIGNED_CERT_IN_CHAIN",
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          ].includes(code)
            ? `（${code}）`
            : "";
          const stage = response ? "读取响应失败" : "请求 Cloudflare API 失败";
          throw verificationError(`${stage}${knownCode}，请检查网络连接`);
        }
      }
      if (!response.ok || data?.success === false) {
        const codes = Array.isArray(data?.errors)
          ? data.errors.map((error) => error?.code).filter(Number.isSafeInteger)
          : [];
        const reason =
          {
            401: "认证失败，请检查 API Token 是否有效",
            403: "访问被拒绝，请检查 Token 的账号范围与 Workers Scripts 权限",
            404: "目标资源未找到，请核对 Account ID 和 Worker 名称",
            429: "Cloudflare API 请求受限，请稍后重试",
          }[response.status] ??
          "Cloudflare API 返回错误，请根据 HTTP 状态和错误码排查";
        throw verificationError(
          codes.length
            ? `${reason}（Cloudflare 错误码 ${codes.join(", ")}）`
            : reason,
        );
      }
      const deployments = data?.result?.deployments;
      if (data?.success !== true || !Array.isArray(deployments))
        throw verificationError(
          "Cloudflare API 响应格式异常，无法读取部署列表",
        );
      if (deployments.length === 0)
        throw verificationError(
          "未查到已有部署记录，首次部署请运行 ./deploy.sh",
        );
      console.log(
        `远端部署核实通过（${timing()}，本次返回 ${deployments.length} 条部署记录）。`,
      );
      await save("wrangler.jsonc", config);
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
    if (debug)
      console.log(
        "请在 Cloudflare → Workers & Pages → 当前 Worker → Observability 查看错误，然后复现问题；排查后可运行 ./deploy.sh --re-deploy --no-debug 关闭。",
      );
    // 按用户要求，在部署成功后显示面板地址、管理密码和节点链接。
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
    console.log(`管理面板地址：https://${hostname}/`);
    console.log(`管理密码：${secrets.ADMIN_PASSWORD}`);
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
