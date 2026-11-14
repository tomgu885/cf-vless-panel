# 本项目约定

- 只使用 `main`，在当前目录开发，不创建分支或 worktree。
- 配置、密钥、密码、Token 和连接串不得写入日志或提交 Git；只用本地测试凭据进行测试。
- 禁止引入默认公共中继、远程运行代码或混淆产物。
- 提交前运行 `npm run check`、`npm test`、`npm run test:runtime` 和 `npm run format:check`，审查 staged diff。
- 完成并验证后普通 push `main`，核对远端 SHA；部署 Cloudflare 需要用户明确授权。
