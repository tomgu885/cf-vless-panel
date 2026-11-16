// 检查与构建始终使用模板，避免读取或打印本地部署账号、绑定和密钥。
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const config = JSON.parse(await readFile("wrangler.jsonc.example", "utf8"));
await writeFile(".wrangler-check.jsonc", JSON.stringify(config));
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    ...process.argv.slice(2),
    "--config",
    ".wrangler-check.jsonc",
  ],
  { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
child.on("error", () => {
  console.error("无法启动本地 Wrangler。");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
