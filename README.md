# CF VLESS Panel

可审计的 Cloudflare Workers 代理面板，使用 TypeScript、KV 和 Durable Objects。全新实现，不包含 CFAPEX 混淆产物或公共中继列表。

## 功能

- VLESS / WebSocket、Trojan / WebSocket、VLESS / XHTTP packet-up，TCP 转发。
- 中文响应式面板：节点列表、优选入口、地区 TLS 中继、真实出站、协议开关和目标端口。
- 通用 URI（可选 Base64）、Clash / Mihomo YAML、sing-box JSON。XHTTP 只在 URI 中下发，供支持它的 Xray 客户端使用。
- SOCKS5（可选用户名密码）、HTTP CONNECT、HTTPS CONNECT，以及 Shadowsocks SIP002 的 aes-128-gcm、aes-256-gcm、chacha20-ietf-poly1305。
- 独立管理密码、签名密钥、订阅令牌、VLESS UUID、Trojan 密码。安全 Cookie 登录，所有修改接口检查 Origin。
- 默认直连。没有内置中继、远程脚本、遥测或配置日志。还原只删除 `cf-vless-panel:settings:v1`。

## 部署

支持 macOS / Linux 的 x64、ARM64，使用 Bash 3.2+。Linux 需要 glibc 发行版（例如 Ubuntu 22.04/24.04、Debian 12）；不支持 Alpine/musl。当前仓库只使用 `main`，不使用 worktree。

```sh
./install_deps.sh
./deploy.sh
```

`install_deps.sh` 优先复用已有 Node.js 22+ 与 npm；缺少时从 Node.js 官网下载固定版本 22.23.4，验证内置 SHA-256 后安装到项目 `.tools/node`，无需 sudo，也不修改 shell 启动文件。下载需要 curl、tar 及 sha256sum 或 shasum；随后通过 `npm ci` 安装锁定版本依赖，包括 Wrangler。若使用项目内 Node，手动执行 npm 命令前运行 `export PATH="$PWD/.tools/node/bin:$PATH"`。

`deploy.sh` 交互收集以下参数，输入全部隐藏且不回显已有值：

- Cloudflare Account ID 和 Worker 名称。
- KV Namespace ID：可提供已有 ID，首次留空会在目标账号创建专用 KV。创建结果立即保存，后续部署失败时可直接复用。
- 自定义域名（可选）：留空使用 workers.dev；填写时需为当前 Cloudflare 账号已管理的域名。
- 管理密码（至少 16 字符，需重复确认）；SESSION_SECRET、NODE_UUID、SUB_TOKEN、TROJAN_PASSWORD 首次留空自动随机生成，也可手动指定。
- Cloudflare API Token：隐藏输入，仅用于本次进程，不保存；也支持通过已配置的 `CLOUDFLARE_API_TOKEN` 环境变量提供。

Token 需授权目标账号的 Workers Scripts 编辑、Workers KV Storage 编辑；使用自定义域名还需对应 Zone 的读取及 Workers Routes 编辑权限。使用 workers.dev 时，先在 Cloudflare 控制台启用账号的 workers.dev 子域名。脚本不使用浏览器登录，适用于无桌面的 Linux。

录入后生成 `wrangler.jsonc` 和 `.deploy-secrets.json`，权限均为 `0600`，都已加入 `.gitignore`。前者只含部署配置；后者保存五项独立应用密钥，便于重试与重复部署。请妥善保管本地密钥文件。API Token 不写入任一文件。再次运行可输入 `reuse` 复用配置与密钥，或输入 `edit` 重新设置；编辑时域名留空会改用 workers.dev。

输入 `deploy` 后才创建远端资源并部署。脚本通过 Wrangler 的 `deploy --secrets-file` 同时上传代码与密钥，不先发布缺少密钥的版本。配置同时创建 XHTTP 所需的 Durable Object。Wrangler 原始输出与调试日志被丢弃，避免打印账号、绑定、URL 或密钥；失败时返回非零退出码及不含敏感值的说明，成功后在 Cloudflare 控制台查看访问地址。

仅生成本地配置、密钥并验证构建，不访问 Cloudflare API：

```sh
./deploy.sh --dry-run
```

仓库只跟踪 `wrangler.jsonc.example`。该模板采用标准 JSON（也是合法 JSONC）；生成的本地配置请保留标准 JSON 格式，便于脚本再次读取。`npm run types/check/build` 使用模板生成的忽略文件 `.wrangler-check.jsonc`，新克隆无需填写线上参数，也不会使用本地部署配置。`npm run build` 仅 dry-run，产物在 `dist/`。

本地开发：在权限为 0600 的 `.dev.vars` 中设置以上五项测试密钥，然后 `npm run dev`。此文件已忽略，禁止使用线上密钥。Cookie 有 Secure 属性，浏览器测试建议本地 HTTPS。Wrangler 的本地绑定仅用于开发。

## 配置与使用

优选入口每行 `host:port#名称#地区`，IPv6 写成 `[地址]:port#名称#地区`，地区为两个大写字母。最多 1000 个入口，留空使用部署域名；当前仅生成 TLS 节点，请填写可接受 TLS 的端口。面板支持粘贴列表，不会自动拉取外部优选列表或提供内置优选池。

地区中继采用同样格式，最多 100 个。仅在直连建立失败且目标端口为 443 时尝试，先匹配节点地区及通用条目。它接收原始 TLS 数据流，需要自行支持 SNI 转发；并非任意普通 IP 都能作为中继。中继并不保证能替代通用代理出口。

出站支持 `socks5://user:password@host:1080`、`http://user:password@host:8080`、`https://user:password@host:443`、SIP002 `ss://`，裸 `host:port` 视为 SOCKS5。凭据中的特殊字符要 URL 编码。SS 不支持插件、旧式整串 Base64 URI、SS2022。

- **直连**：先尝试目标，建立失败时可用显式配置的 TLS 中继。
- **优先出口**：代理连接/握手失败后尝试直连；应用数据已发出后的错误不会重放请求。
- **仅出口**：出口失败即终止，不回退直连。

Cloudflare 的 TCP socket 本身禁止访问 Cloudflare IP、私有网络和端口 25；访问这些目标通常需要你控制的可达代理出口。[官方 TCP socket 约束](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。本地 workerd 测试不能证明公网所有目的地址可达。

更改凭据时重新执行对应 `wrangler secret put`。更改管理密码或签名密钥会使旧面板 Cookie 失效；更改订阅令牌后更新客户端订阅地址；更改 UUID/Trojan 密码后更新订阅并断开旧连接。现有连接最多保留 15 分钟。

KV 为最终一致存储，配置保存与重置在不同地区可能延迟生效。[KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。出站凭据存储在你的 KV 中，有账号读取权限的人可以读取；面板 API 不返回已存储的出站凭据。

## 协议边界

只支持 TCP，不支持 UDP、QUIC、MUX 或 XHTTP stream-one/stream-up。单连接上行 64 MiB、下行 128 MiB、最长 15 分钟；协议认证等待最多 10 秒。XHTTP 使用默认路径形式的 session ID 和序号，不支持客户端自定义头部/查询参数携带会话。

订阅地址含令牌，分享它等同于分享节点访问权限。应用代码关闭 observability 且不输出配置；自行启用平台访问日志时，应过滤订阅 URL，避免记录令牌。

## 开发验证

```sh
npm run types
npm run check
npm test
npm run test:runtime
npm run test:scripts
```

单元测试覆盖分片协议头、错误认证、UDP 拒绝、会话签名与密码轮换、订阅格式隔离。运行时测试使用 Miniflare/workerd、真实本地 TCP echo 服务以及 KV/DO，检查登录、CSRF、WebSocket、XHTTP 和有作用域的重置。构建产物和本地测试数据不提交。

协议参考：[Xray XHTTP](https://github.com/XTLS/Xray-core/tree/main/transport/internet/splithttp)、[Shadowsocks AEAD](https://github.com/shadowsocks/shadowsocks-org/blob/main/docs/doc/aead.md)。代码模块位于 `src/`，测试位于 `test/`。

### Xray 互通测试

安装官方 Xray 后，设置 `XRAY_BIN` 为可执行文件路径，运行 `npm run test:interop`。测试只启动本地进程、临时配置及回环 HTTP 服务；测试结束后清理。本地 SS 服务仅对该测试目标端口精确放行回环地址，以兼容新版 Xray 的默认私网限制。

已使用官方 Xray **26.11.9** 验证 VLESS/WS、Trojan/WS、VLESS/XHTTP packet-up 入站，及 SOCKS5、HTTP CONNECT、三种 SS AEAD 出站。HTTPS CONNECT 保持平台证书校验，但尚未用公网有效证书代理做端到端验证；地区中继亦需用自有服务器验收。尚未进行 Cloudflare 线上部署或公网连通性验收。

面板在内置浏览器检查过 1920×1080 桌面与 402×874 移动视口；后者仅为视口测试，没有模拟 DPR 3、完整 iPhone 设备能力或真机网络。
