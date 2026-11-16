#!/usr/bin/env bash
set +x
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077
export PATH="$PWD/.tools/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || [ ! -f node_modules/wrangler/bin/wrangler.js ]; then
  echo '请先运行 ./install_deps.sh。' >&2; exit 1
fi
exec node scripts/deploy.mjs "$@"
