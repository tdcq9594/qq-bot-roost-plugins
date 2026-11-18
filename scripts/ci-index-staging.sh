#!/usr/bin/env bash
# CI 专用：索引出现“预期漂移”时，准备一份临时重建的索引供检查使用。
#
# 为什么需要：
#   投稿 PR 按约定不碰 index.json / index.json.sig（作者没有私钥），
#   所以「索引与插件目录一致」和依赖索引的契约测试必然红。
#   合并后、维护者在 release-signing 里重签之前，main 上也是同样的暂时漂移。
#   这个脚本只在 CI 的临时副本里重算索引，让检查能真实验证插件内容，
#   而绝不改写仓库里的正式索引与签名。
#
# 红线：PR 里出现 index.json / index.json.sig / trust-public.pem 的改动 → 直接失败。
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

# 1) 签名链三件套：PR 一律不许碰
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  touched=$(git diff --name-only "$base"...HEAD -- index.json index.json.sig trust-public.pem || true)
  if [ -n "$touched" ]; then
    echo "::error::PR 不得改动索引 / 签名 / 公钥（$touched）。索引由维护者合并后在 release-signing 里重建并签名。"
    exit 1
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
    echo "::error::索引与插件目录不一致。仅在 PR / push 事件启用临时索引复核；请检查是否漏了重签。"
    exit 1
    ;;
esac

stage="${RUNNER_TEMP:-/tmp}/ci-index-staging"
rm -rf "$stage"
mkdir -p "$stage"
tar --exclude=.git -cf - . | tar -xf - -C "$stage"

cd "$stage"
# build-index.mjs 见到 index.json.sig 会拒绝无签名改写；临时副本里先把签名挪开。
# 这只是 CI 的临时目录，仓库里的 index.json.sig 原封不动。
mv index.json.sig index.json.sig.original
node scripts/build-index.mjs
node scripts/build-index.mjs --check

echo "CI_INDEX_DIR=$stage" >> "$GITHUB_ENV"
echo "CI_INDEX_STAGED=1" >> "$GITHUB_ENV"
echo "::warning::索引与插件目录漂移（投稿 PR 不改签名链，属预期）。已用临时重建索引完成一致性复核；正式索引仍需在 release-signing 中手动重签。"
