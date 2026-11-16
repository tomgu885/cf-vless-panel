# CF VLESS Panel

可审计的 Cloudflare Workers 代理面板，使用 TypeScript、KV 和 Durable Objects。全新实现，不包含 CFAPEX 混淆产物或公共中继列表。

## 功能

- VLESS / WebSocket、Trojan / WebSocket、VLESS / XHTTP packet-up，TCP 转发。
- 中文响应式面板：节点列表、优选入口、地区 TLS 中继、真实出站、协议开关和目标端口。
- 通用 URI（可选 Base64）、Clash / Mihomo YAML、sing-box JSON。XHTTP 只在 URI 中下发，供支持它的 Xray 客户端使用。
- SOCKS5（可选用户名密码）、HTTP CONNECT、HTTPS CONNECT，以及 Shadowsocks SIP002 的 aes-128-gcm、aes-256-gcm、chacha20-ietf-poly1305。
- 独立管理密码、签名密钥、订阅令牌、VLESS UUID、Trojan 密码。安全 Cookie 登录，所有修改接口检查 Origin。
- 默认直连。没有内置中继、远程脚本、遥测或配置日志。还原只删除 `cf-vless-panel:settings:v1`。

## 快速开始

在 macOS / Linux 终端运行：

```sh
git clone https://github.com/tomgu885/cf-vless-panel.git
cd cf-vless-panel
./install_deps.sh
./deploy.sh
```

已有仓库时，在项目目录执行最后两条命令即可。仓库只跟踪 [wrangler.jsonc.example](wrangler.jsonc.example)，无需手动复制模板；部署脚本会生成实际配置。

### 环境要求

- macOS 或使用 glibc 的 Linux，x64 / ARM64；不支持 Alpine/musl。
- Bash 3.2+。克隆仓库需要 Git；自动下载 Node.js 需要 curl、tar，以及 sha256sum 或 shasum。
- Cloudflare 账号和目标账号的 API Token。脚本无需浏览器登录，可用于无桌面的 Linux。

[install_deps.sh](install_deps.sh) 复用已有 Node.js 22+ 与 npm；缺少时从 Node.js 官网下载固定版本 22.23.4，校验内置 SHA-256，再安装到项目 `.tools/node`。它无需 sudo、不修改系统 Node.js 或 shell 启动文件，随后通过 `npm ci` 安装锁定版本依赖，包括 Wrangler。

两个 Shell 脚本会自动使用项目内的 Node.js。如果要手动运行 npm 命令，先在项目目录执行：

```sh
export PATH="$PWD/.tools/node/bin:$PATH"
```

### 首次部署

运行 [deploy.sh](deploy.sh)，按提示输入以下参数。**输入内容直接在终端显示，包括密码和 API Token。** 每项参数输入前会显示简要用途及获取位置。所有输入统一去掉首尾空白字符，保留中间空格；仅输入空白视为留空，按下表使用默认值或保留已有值。除部署成功后输出的 VLESS 链接包含节点 UUID 外，脚本不会额外打印已保存的密钥、环境变量值或自动生成的密钥。

| 参数                  | 输入要求                                        | 留空行为                                                   |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Cloudflare Account ID | 目标账号的 32 位十六进制 ID                     | 首次必填；编辑时保留已有值                                 |
| Worker 名称           | 1–63 个小写字母、数字或连字符，以字母或数字开头 | 默认 `cf-vless-panel`；编辑时保留已有值                    |
| KV Namespace ID       | 目标账号下的 32 位十六进制 ID                   | 首次自动创建；编辑时保留已有有效 ID                        |
| 自定义域名            | 当前账号管理的域名，不带协议、端口或路径        | 使用 workers.dev，编辑时也如此                             |
| 管理密码              | 至少 16 字符，随后需再次输入确认                | 首次必填；编辑时保留已有密码，但仍须再次输入确认           |
| `SESSION_SECRET`      | 至少 32 字符，用于登录会话签名                  | 首次随机生成；编辑时保留                                   |
| `NODE_UUID`           | 标准 UUID，用于 VLESS 认证                      | 首次随机生成；编辑时保留                                   |
| `SUB_TOKEN`           | 至少 32 字符，用于订阅访问                      | 首次随机生成；编辑时保留                                   |
| `TROJAN_PASSWORD`     | 至少 16 字符，用于 Trojan 认证                  | 首次随机生成；编辑时保留                                   |
| Cloudflare API Token  | 目标账号的 API Token                            | 使用已配置的 `CLOUDFLARE_API_TOKEN` 环境变量；未配置时必填 |

参数来源速查：

- **Account ID**：Cloudflare 控制台 → Workers & Pages → Account Details → Account ID，也可搜索 `Copy account ID`。[官方获取说明](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
- **Worker 名称**：新应用自行命名；已有应用从 Workers & Pages 列表中获取。
- **KV Namespace ID**：从控制台的 Workers KV 页面复制已有命名空间 ID；首次部署可直接留空。[KV 官方说明](https://developers.cloudflare.com/kv/get-started/)
- **自定义域名**：选择已接入当前 Cloudflare 账号的域名下的子域名，例如 `panel.example.com`；也可留空使用 workers.dev。
- **管理密码及四项应用密钥**：管理密码由你设置，其余首次可留空自动生成。迁移节点时，也可使用原配置的 UUID 或 Trojan 密码；这些都不是 Cloudflare 账号登录凭据。
- **API Token**：Cloudflare 控制台 → My Profile → API Tokens → Create Token。[官方创建说明](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

API Token 与应用的五项密钥彼此独立。Token 需授权目标账号的 Workers Scripts 编辑、Workers KV Storage 编辑；使用自定义域名还需对应 Zone 的读取及 Workers Routes 编辑权限。使用 workers.dev 时，先在 Cloudflare 控制台启用账号的 workers.dev 子域名。

参数校验通过后，脚本保存本地配置与应用密钥。输入 `deploy` 才会创建远端资源和部署，输入其他内容则保留本地文件并退出。

部署过程会：

1. 在未提供 KV ID 时创建专用 KV，并立即把 ID 保存到本地配置。
2. 通过 Wrangler 的 `deploy --secrets-file` 同时部署代码与应用密钥，绑定 KV 和 XHTTP 所需的 Durable Object。
3. 返回部署结果，并在最后输出可导入客户端的 `vless://` 节点链接。通过同一域名的 HTTPS 根路径进入面板，使用管理密码登录，在“概览 → 订阅中心”获取其他格式的订阅。

API Token 仅用于本次进程，不保存。脚本丢弃 Wrangler 原始输出，并将调试日志导向空设备；终端仅输出必要状态以及你要求的 VLESS 节点链接，不打印完整配置、管理密码或 API Token。失败时返回非零退出码及不含敏感值的说明。

### 部署结束后的 VLESS 链接

部署成功后，最后一行是 `vless://` 链接，可直接复制到支持 VLESS / WebSocket 的客户端导入。连接参数与本项目入站一致：使用本次部署的 `NODE_UUID`、端口 `443`、TLS、WebSocket 和路径 `/ws`，节点地址、SNI 与 WebSocket Host 使用同一域名。

域名按以下顺序选择：

1. 优先使用 `wrangler.jsonc` 的 `routes` 中第一个 `custom_domain: true` 条目的 `pattern`；也支持单条 `route` 配置。普通路径路由不作为自定义域名。
2. 未配置自定义域名时，通过 [Cloudflare Workers Subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/) 读取账号实际分配的子域名，生成 `<Worker 名称>.<账号子域名>.workers.dev`。

`--dry-run`、取消部署或部署失败时不输出节点链接。若部署已成功但域名查询失败，脚本会明确提示“部署已成功”及无法生成链接的原因，并返回非零退出码；不会猜测域名。如果未配置自定义域名且 `workers_dev` 被禁用，也不会生成不可访问的链接。

节点链接包含 UUID，持有者可以使用节点，请只在需要导入客户端时分享。

### 先验证，不部署

```sh
./deploy.sh --dry-run
```

此命令仍会交互生成或复用本地配置、应用密钥，并执行真实 Wrangler 构建，但不询问 API Token、不创建远端 KV、不部署 Worker。首次 KV ID 留空时，本地配置会保留待创建状态；构建用的临时占位 ID 不会写回实际配置。

查看脚本帮助：

```sh
./deploy.sh --help
```

### 更新与重复部署

本项目只使用 `main`，在当前目录开发，不创建 worktree。工作区没有未提交改动时，可运行：

```sh
git pull --ff-only
./install_deps.sh
./deploy.sh
```

检测到已有 `wrangler.jsonc` 后：

- 输入 `reuse`：复用本地配置与应用密钥，不自动轮换密码、UUID 或令牌。
- 输入 `edit`：重新填写参数；带有保留提示的字段留空会沿用原值。自定义域名留空会切换为 workers.dev。

两种方式都会重新询问 API Token 和部署确认。KV 已创建但后续部署失败时，使用 `reuse` 重试即可；脚本不会自动删除已创建的资源。

### 本地文件

| 文件或目录                     | 用途                                        | 是否提交 Git                |
| ------------------------------ | ------------------------------------------- | --------------------------- |
| `wrangler.jsonc.example`       | 共享配置模板                                | 是                          |
| `wrangler.jsonc`               | 实际部署配置，包括账号、Worker、KV 和域名   | 否，权限 `0600`             |
| `.deploy-secrets.json`         | 五项独立应用密钥，供重复部署使用            | 否，权限 `0600`             |
| `.dev.vars`                    | 本地开发的测试密钥                          | 否，由开发者设置权限 `0600` |
| `.tools/node/`                 | 脚本安装的项目内 Node.js                    | 否                          |
| `.wrangler-check.jsonc`        | 从模板生成的开发、检查和构建配置            | 否                          |
| `.wrangler-deploy-check.jsonc` | 部署脚本 dry-run 使用的临时配置，结束后删除 | 否                          |
| `dist/`、`.wrangler/`          | 构建产物和本地运行数据                      | 否                          |

生成的配置采用标准 JSON（也是合法 JSONC）。手工编辑后请保持标准 JSON 格式，不加入注释或尾随逗号，以便脚本再次读取。不要将本地配置或密钥文件上传到仓库、日志或聊天中；迁移开发机器时需自行安全保管这些文件。

## 本地开发

运行安装脚本后，在权限为 `0600` 的 `.dev.vars` 中设置 `ADMIN_PASSWORD`、`SESSION_SECRET`、`NODE_UUID`、`SUB_TOKEN`、`TROJAN_PASSWORD` 五项**测试密钥**，格式为每行 `字段名=值`，长度要求同上。不要使用线上密钥。

```sh
npm run dev
```

`dev`、`types`、`check`、`build` 使用示例模板生成的 `.wrangler-check.jsonc`，不读取实际部署配置 `wrangler.jsonc`。本地配置和数据不等同于线上环境。Cookie 有 Secure 属性，浏览器测试建议使用本地 HTTPS：

```sh
npm run dev -- --local-protocol https
```

`npm run build` 仅做 dry-run，产物在 `dist/`。正式部署使用 `./deploy.sh`，以便同时上传正确的配置与密钥。

## 配置与使用

优选入口每行 `host:port#名称#地区`，IPv6 写成 `[地址]:port#名称#地区`，地区为两个大写字母。最多 1000 个入口，留空使用部署域名；当前仅生成 TLS 节点，请填写可接受 TLS 的端口。面板支持粘贴列表，不会自动拉取外部优选列表或提供内置优选池。

地区中继采用同样格式，最多 100 个。仅在直连建立失败且目标端口为 443 时尝试，先匹配节点地区及通用条目。它接收原始 TLS 数据流，需要自行支持 SNI 转发；并非任意普通 IP 都能作为中继。中继并不保证能替代通用代理出口。

出站支持 `socks5://user:password@host:1080`、`http://user:password@host:8080`、`https://user:password@host:443`、SIP002 `ss://`，裸 `host:port` 视为 SOCKS5。凭据中的特殊字符要 URL 编码。SS 不支持插件、旧式整串 Base64 URI、SS2022。

- **直连**：先尝试目标，建立失败时可用显式配置的 TLS 中继。
- **优先出口**：代理连接/握手失败后尝试直连；应用数据已发出后的错误不会重放请求。
- **仅出口**：出口失败即终止，不回退直连。

Cloudflare 的 TCP socket 本身禁止访问 Cloudflare IP、私有网络和端口 25；访问这些目标通常需要你控制的可达代理出口。[官方 TCP socket 约束](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。本地 workerd 测试不能证明公网所有目的地址可达。

更改应用密钥时，运行 `./deploy.sh` 并选择 `edit`，输入需要替换的值，其余字段按提示保留，再确认部署。更改管理密码或签名密钥会使旧面板 Cookie 失效；更改订阅令牌后需要更新客户端订阅地址；更改 UUID/Trojan 密码后需要更新订阅并断开旧连接。现有连接最多保留 15 分钟。

如果曾在 Cloudflare 控制台或通过 `wrangler secret put` 单独修改远端密钥，应同步修改本地 `.deploy-secrets.json`，或通过 `edit` 输入相同的新值。否则，下次脚本部署会用本地文件中的旧值覆盖远端密钥。

KV 为最终一致存储，配置保存与重置在不同地区可能延迟生效。[KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。出站凭据存储在你的 KV 中，有账号读取权限的人可以读取；面板 API 不返回已存储的出站凭据。

## 协议边界

只支持 TCP，不支持 UDP、QUIC、MUX 或 XHTTP stream-one/stream-up。单连接上行 64 MiB、下行 128 MiB、最长 15 分钟；协议认证等待最多 10 秒。XHTTP 使用默认路径形式的 session ID 和序号，不支持客户端自定义头部/查询参数携带会话。

订阅地址含令牌，分享它等同于分享节点访问权限。应用代码关闭 observability 且不输出配置；自行启用平台访问日志时，应过滤订阅 URL，避免记录令牌。

## 常见问题

| 现象                                | 处理方式                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 粘贴参数时带有首尾空格              | 脚本自动清除首尾空白；中间空格保留，仅空白输入按留空处理                                                                |
| 提示先安装依赖                      | 在项目目录运行 `./install_deps.sh`                                                                                      |
| Node.js 下载失败或校验失败          | 检查到 nodejs.org 的 HTTPS 网络、系统时间及 curl，不要跳过校验                                                          |
| 依赖安装失败                        | 检查 npm registry、网络和 Node.js 运行环境，再运行安装脚本                                                              |
| 提示配置必须是有效 JSON             | 在本地编辑器检查配置和密钥文件，移除注释、尾随逗号等非法内容                                                            |
| KV 创建失败                         | 核对 Account ID、Token 的目标账号范围与 KV 编辑权限                                                                     |
| Wrangler 执行失败                   | 核对 Token 权限、KV 归属、域名归属及网络；原始输出不会回显。可先运行 `./deploy.sh --dry-run` 区分本地构建与远端部署问题 |
| 更新后密码、UUID 或订阅令牌变回旧值 | 检查 `.deploy-secrets.json` 是否与远端保持一致，按上文密钥更新流程重新部署                                              |

## 开发验证

```sh
npm run types
npm run check
npm test
npm run test:runtime
npm run test:scripts
npm run format:check
```

单元测试覆盖分片协议头、错误认证、UDP 拒绝、会话签名与密码轮换、订阅格式隔离。运行时测试使用 Miniflare/workerd、真实本地 TCP echo 服务以及 KV/DO，检查登录、CSRF、WebSocket、XHTTP 和有作用域的重置。部署脚本测试使用模拟 Cloudflare API 和 Wrangler，覆盖配置生成、权限、复用、取消、失败脱敏及 KV 创建后重试；不会创建真实远端资源。构建产物和本地测试数据不提交。

协议参考：[Xray XHTTP](https://github.com/XTLS/Xray-core/tree/main/transport/internet/splithttp)、[Shadowsocks AEAD](https://github.com/shadowsocks/shadowsocks-org/blob/main/docs/doc/aead.md)。代码模块位于 `src/`，测试位于 `test/`。

### Xray 互通测试

安装官方 Xray 后，设置 `XRAY_BIN` 为可执行文件路径，运行 `npm run test:interop`。测试只启动本地进程、临时配置及回环 HTTP 服务；测试结束后清理。本地 SS 服务仅对该测试目标端口精确放行回环地址，以兼容新版 Xray 的默认私网限制。

已使用官方 Xray **26.11.9** 验证 VLESS/WS、Trojan/WS、VLESS/XHTTP packet-up 入站，及 SOCKS5、HTTP CONNECT、三种 SS AEAD 出站。HTTPS CONNECT 保持平台证书校验，但尚未用公网有效证书代理做端到端验证；地区中继亦需用自有服务器验收。尚未进行 Cloudflare 线上部署或公网连通性验收。

面板在内置浏览器检查过 1920×1080 桌面与 402×874 移动视口；后者仅为视口测试，没有模拟 DPR 3、完整 iPhone 设备能力或真机网络。

安装与交互部署脚本已在 macOS 和 Ubuntu 24.04 验证，真实 Wrangler 本地 dry-run 已通过。这些验证不等同于 Cloudflare 线上部署验收。
