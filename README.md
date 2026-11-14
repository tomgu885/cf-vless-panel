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

需要 Node.js 22+ 和 Cloudflare 账号。当前仓库只使用 `main`，不使用 worktree。

1. `npm ci`，然后 `npx wrangler login`。
2. `npx wrangler kv namespace create CONFIG`，将返回的 namespace ID 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。不要提交账号凭据。
3. 分别使用下列交互命令设置独立密钥。使用密码管理器生成随机值，不要把值放在命令参数、URL 或日志中。

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put NODE_UUID
   npx wrangler secret put SUB_TOKEN
   npx wrangler secret put TROJAN_PASSWORD
   ```

   管理密码及 Trojan 密码至少 16 字符；签名密钥、订阅令牌至少 32 字符；NODE_UUID 使用标准 UUID。推荐所有密码/令牌均使用至少 32 字符随机值。

4. `npm run check && npm test && npm run test:runtime`。
5. `npx wrangler deploy`。配置会创建 SQLite Durable Object 类 `XhttpSession`；请先核对 Cloudflare 账号、Worker 名称和计划资源。
6. 访问 Worker HTTPS 根路径登录。默认节点入口为当前部署域名。客户端导入订阅后即可使用。

`npm run build` 仅做 dry-run，产物在 `dist/`。部署应使用 Wrangler，它会绑定 KV 和 Durable Objects；不能只粘贴 JS 并期望 XHTTP 自动工作。本仓库不自动触发部署。

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
```

单元测试覆盖分片协议头、错误认证、UDP 拒绝、会话签名与密码轮换、订阅格式隔离。运行时测试使用 Miniflare/workerd、真实本地 TCP echo 服务以及 KV/DO，检查登录、CSRF、WebSocket、XHTTP 和有作用域的重置。构建产物和本地测试数据不提交。

协议参考：[Xray XHTTP](https://github.com/XTLS/Xray-core/tree/main/transport/internet/splithttp)、[Shadowsocks AEAD](https://github.com/shadowsocks/shadowsocks-org/blob/main/docs/doc/aead.md)。代码模块位于 `src/`，测试位于 `test/`。

### Xray 互通测试

安装官方 Xray 后，设置 `XRAY_BIN` 为可执行文件路径，运行 `npm run test:interop`。测试只启动本地进程、临时配置及回环 HTTP 服务；测试结束后清理。本地 SS 服务仅对该测试目标端口精确放行回环地址，以兼容新版 Xray 的默认私网限制。

已使用官方 Xray **26.11.9** 验证 VLESS/WS、Trojan/WS、VLESS/XHTTP packet-up 入站，及 SOCKS5、HTTP CONNECT、三种 SS AEAD 出站。HTTPS CONNECT 保持平台证书校验，但尚未用公网有效证书代理做端到端验证；地区中继亦需用自有服务器验收。尚未进行 Cloudflare 线上部署或公网连通性验收。

面板在内置浏览器检查过 1920×1080 桌面与 402×874 移动视口；后者仅为视口测试，没有模拟 DPR 3、完整 iPhone 设备能力或真机网络。
