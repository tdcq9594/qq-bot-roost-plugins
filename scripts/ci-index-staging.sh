#!/usr/bin/env bash
# CI 专用：索引出现「预期漂移」时，准备一份临时重建的索引供检查使用。
#
# 为什么需要：
#   投稿 PR 按约定不碰 index.json（作者只交 plugins/<id>/），
#   所以「索引与插件目录一致」和依赖索引的契约测试必然红。
#   合并后、sync-artifacts.yml 重建索引之前，main 上也是同样的暂时漂移。
#   这个脚本只在 CI 的临时副本里重算索引，让检查能真实验证插件内容，
#   而绝不改写仓库里的正式索引。
#
# 2026-11-19 起插件索引不再签名：临时副本里没有 .sig 需要挪开，
# build-index.mjs 也不再因「已签名但没私钥」拒绝写。
#
# 红线：fork 投稿 PR 里出现 index.json 改动 → 直接失败。
# 本仓维护者 PR（改索引脚本、重建索引本身）不受此限——否则取消签名这类
# 索引改造 PR 会把自己拦住。投稿越界的完整拦截在 pr-guard.yml。
# 用 GITHUB_EVENT_PATH 读事件 JSON 判断，不依赖调用方传 env。
#
# 输入环境变量：
#   CI_BASE_REF      基准 ref（PR 用 origin/<base>，push 用 before）
#   GITHUB_EVENT_NAME pull_request / push / workflow_dispatch
#   GITHUB_ENV        Actions 环境文件（写回 CI_INDEX_DIR / CI_INDEX_STAGED）
#   RUNNER_TEMP       临时目录父级
# 输出环境变量：
#   CI_INDEX_DIR      本轮索引相关检查应使用的目录
#   CI_INDEX_STAGED   1 = 用了临时索引，0 = 用仓库正式索引

set -euo pipefail

base="${CI_BASE_REF:-}"
if [ -z "$base" ]; then
  echo "::error::CI_BASE_REF 未设置，无法确定比较基准"
  exit 1
fi

# 1) 索引：fork 投稿一律不许碰（索引由合并后的 bot 重建）
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  # 本仓 PR 允许改 index.json（维护者重建索引、改构建脚本都属合法改造）
  is_fork=false
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
    is_fork=$(node -e '
      try {
        const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const head = e.pull_request?.head?.repo?.full_name || "";
        const base = e.repository?.full_name || "";
        process.stdout.write(head && head !== base ? "true" : "false");
      } catch { process.stdout.write("false"); }
    ' "$GITHUB_EVENT_PATH")
  fi
  if [ "$is_fork" = "true" ]; then
    touched=$(git diff --name-only "$base"...HEAD -- index.json || true)
    if [ -n "$touched" ]; then
      echo "::error::fork 投稿 PR 不得改动 index.json（$touched）。索引由合并后的 sync-artifacts.yml 自动重建。"
      exit 1
    fi
  fi
fi

# 2) 正式索引本来就一致：直接用原目录，行为与以前完全一样
if node scripts/build-index.mjs --check >/dev/null 2>&1; then
  echo "CI_INDEX_DIR=$PWD" >> "$GITHUB_ENV"
  echo "CI_INDEX_STAGED=0" >> "$GITHUB_ENV"
  echo "索引已一致，使用仓库正式索引"
  exit 0
fi

# 3) 真漂移了：只在 PR / push main 上用临时副本复核；手动触发仍按严格模式失败
case "${GITHUB_EVENT_NAME:-}" in
  pull_request|push) ;;
  *)
    echo "::error::索引与插件目录不一致。仅在 PR / push 事件启用临时索引复核；请检查是否漏了重建索引。"
    exit 1
    ;;
esac

stage="${RUNNER_TEMP:-/tmp}/ci-index-staging"
rm -rf "$stage"
mkdir -p "$stage"
tar --exclude=.git -cf - . | tar -xf - -C "$stage"

cd "$stage"
node scripts/build-index.mjs
node scripts/build-index.mjs --check

echo "CI_INDEX_DIR=$stage" >> "$GITHUB_ENV"
echo "CI_INDEX_STAGED=1" >> "$GITHUB_ENV"
echo "::warning::索引与插件目录漂移（投稿 PR 不改索引，属预期）。已用临时重建索引完成一致性复核；正式索引仍需在合并后重建。"
