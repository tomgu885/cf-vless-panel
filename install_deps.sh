#!/usr/bin/env bash
set +x
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077
export PATH="$PWD/.tools/node/bin:$PATH"
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo '仅支持 macOS / Linux。' >&2; exit 1 ;; esac
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || ! command -v npm >/dev/null 2>&1; then
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo '仅支持 x64 / ARM64。' >&2; exit 1 ;; esac
  command -v curl >/dev/null 2>&1 || { echo '请先安装 curl（Linux 使用系统包管理器）。' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo '请先安装 tar。' >&2; exit 1; }
  version=v22.23.4
  archive="node-$version-$platform-$arch.tar.gz"
  case "$platform-$arch" in
    darwin-arm64) checksum=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    darwin-x64) checksum=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    linux-arm64) checksum=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9 ;;
    linux-x64) checksum=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
  esac
  mkdir -p .tools
  task_tmp=$(mktemp -d "$PWD/.tools/install.XXXXXX")
  trap 'rm -rf "$task_tmp"' EXIT
  echo '正在下载并校验官方 Node.js 22（项目内安装，不需要 sudo）…'
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$version/$archive" -o "$task_tmp/node.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$task_tmp/node.tar.gz"); actual=${actual%% *}
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$task_tmp/node.tar.gz"); actual=${actual%% *}
  else
    echo '需要 sha256sum 或 shasum 校验下载内容。' >&2; exit 1
  fi
  [ "$actual" = "$checksum" ] || { echo 'Node.js 校验失败，停止安装。' >&2; exit 1; }
  mkdir "$task_tmp/node"
  tar -xzf "$task_tmp/node.tar.gz" -C "$task_tmp/node" --strip-components=1
  "$task_tmp/node/bin/node" --version >/dev/null
  rm -rf .tools/node
  mv "$task_tmp/node" .tools/node
fi
echo '正在按 package-lock.json 安装项目依赖…'
# 不转发 npm 调试输出，防止用户 registry 配置或环境信息进入日志。
if ! npm ci --no-audit --no-fund --loglevel=silent --logs-max=0 >/dev/null 2>&1; then
  echo '依赖安装失败，请检查网络、npm registry 与 Node.js 运行环境。' >&2; exit 1
fi
echo '依赖已安装。下一步运行 ./deploy.sh。'
