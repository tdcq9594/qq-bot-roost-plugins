# 栖 Roost 插件仓库

> 提交你的插件，用户在面板「插件 → 市场」里一键安装。

- 主程序：[qq-bot-roost](https://github.com/tdcq9594/qq-bot-roost)
- 插件清单：[`index.json`](index.json)

---

## 怎么提交插件（贡献者）

1. Fork 本仓库
2. 把你的插件放进 `plugins/<插件id>/`（要求见下面「插件目录要求」）
3. 本地自检：

   ```bash
   node --check plugins/<id>/index.js                    # 语法
   node scripts/check-versions.mjs --base origin/main    # 改了内容必须升 version
   git grep -Il $'\r' -- 'plugins/**'                    # 不能有 CRLF
   ```

4. **只提交 `plugins/<插件id>/` 这一个目录**，提 PR

> ⚠️ **不要动 `index.json`**：它是维护者用脚本重建的产物。

**PR 的 CI 里「索引与插件目录一致」会红，这是预期的**——
投稿按约定不碰索引，索引必然暂时落后于插件目录。维护者合并后会统一重建，
`main` 分支的 CI 才是绿的。其余几项（语法、版本号、换行符、插件测试）请务必自己过。

合并后，用户刷新面板的插件市场就能看到并安装。

---

## 索引与内容完整性

插件市场要回答一个具体问题：**用户下载到的插件，是不是仓库里那一份**。
靠的是 `index.json` 里每个插件的 `sha256`：

```
index.json 的 sha256  ──►  用户下载插件目录  ──►  本地重算 sha256  ──►  比对
对不上 = 内容被改过（或换行符被转换过）→ 拒绝安装
```

`index.json` 由 `build-index.mjs` 从 `plugins/*/` 重算生成，**只有维护者改**；
投稿 PR 不许碰。安装时的 sha256 校验保证「装到的是索引记载的那份」，
索引本身的权威来自仓库提交历史（`main` 只收维护者合并的提交），不再来自签名。
投稿风险由 `pr-guard.yml` 拦截 + 维护者人工审；`main` 已开分支保护 +
required PR + required checks，投稿 CI 不全绿合不进来（见 `.github/CODEOWNERS`）。

> 2026-11-19 起插件索引不再签名（原 `index.json.sig` / `trust-public.pem` /
> 手动签名 workflow 均已移除）。原因是个人仓无法同时开分支保护与机器人回推，
> 没有硬闸门的签名链挡不住投稿 PR 改文件。
> **框架自更新的 `SHA256SUMS.sig` 签名不受影响，照旧保留。**

---

## 改完插件要更新索引（维护者）

```bash
# 重建索引
node scripts/build-index.mjs

# 只校验一致性（CI 跑的就是这个）
node scripts/build-index.mjs --check
```

索引里的 `sha256` 是插件目录的内容指纹，用户安装时会按同一算法重算，
对不上就拒绝安装。**手改不了**，只能让脚本算。

脚本会：

- 扫一遍 `plugins/*/`，从 `index.js`（内建）或 `plugin.json`（外部）读 `id` / `version` 等字段
- 重算每个插件的 `sha256`
- 按 `id` 合并进已有的 `index.json`：结构字段（版本、路径、哈希、`frameworkVersion`）以磁盘为准，
  展示字段（`author` / `commands` / `addedAt` / `tags` / 描述 / `credits`）保留手写内容
- 新插件自动补一条，删掉的插件自动移除

`version` 要写成字面量（`version: '1.2.3'`）。写成常量的话，
`check-versions.mjs` 和本脚本都读不到——CI 会直接判「读不到 version」。

**改任何插件内容都必须升 `version`**（`index.js` 和 `package.json` 两处）。
市场只比版本号，不升版老用户永远收不到更新。

---

## 维护者发版完整流程

> 每一步后面都写了**漏掉的后果**，都是真踩过的。

### 0. 前置检查

确认在 `main` 的最新提交上、工作区干净：

```bash
git status --short
```

### 1. 收 PR / 放插件

贡献者的 PR 只含 `plugins/<id>/**`。**不要直接点 GitHub 的合并按钮**，拉到本地：

```bash
node scripts/merge-pr.mjs 2             # 拉分支 + 校正提交身份 + merge
node scripts/merge-pr.mjs 2 --dry-run   # 只演一遍，不动仓库
```

脚本会把每个提交的 author / committer 校正成 **PR 发起人**的 GitHub 身份
（`<id>+<login>@users.noreply.github.com`）。这不是为了好看：GitHub 的 Contributors
按 commit 的 **author 邮箱**归户，贡献者在自己机器上带着别人的 `user.email` 提交时，
这次贡献会记到邮箱主人头上，作者本人在仓库里一次提交都没有。

PR 一旦动了 `index.json`，脚本直接中止（见上面「索引与内容完整性」）。

没有 PR、只是拿到一个目录时才手工放：

```bash
git checkout FETCH_HEAD -- plugins/<id>
```

只取插件目录，**不取** `index.json`。

然后过一遍：

```bash
node --check plugins/<id>/index.js                     # 语法
git grep -Il $'\r' -- 'plugins/**'                     # 不能有 CRLF
grep -rn "eval(\|new Function\|child_process" plugins/<id>/*.js   # 跑外部命令的要人工看
```

**顺手补 README 末尾的「贡献者」表**（每个 PR 都要补，别漏）：同一投稿人已有行就往后追加插件名，
没有就新起一行，插件名后面括号写中文名，提交列放 PR 链接。这一步不影响 CI，
但漏了作者在仓库里就查不到自己——署名是收投稿的一部分。

### 2. 重建索引

```bash
node scripts/build-index.mjs
```

**社区投稿的 `author` 要在这一步之前补好**：填投稿者的 GitHub 用户名，不填维护者。`build-index.mjs` 会保留手写的展示字段、不会替你改，填错了面板上就一直显示「by 维护者」。`credits` 另外记 PR 号即可。

### 3. 一致性

```bash
node scripts/build-index.mjs --check
```

要绿。`--check` 会比对每个插件的 sha256，也会报「目录里有、索引里没有」。

### 4. 开分支、提交

```bash
git switch -c feat/<插件id>-<版本>    # 或 fix/<词>；不要直接在 main 上改
git add plugins/<id> index.json
git commit -m "feat(plugins): 收录 <id> <version>"
```

### 5. 推分支、开 PR

```bash
git push -u origin HEAD
gh pr create --fill                   # 或到 GitHub 网页开
```

**不要直推 `main`**（2026-11-19 定）：个人仓虽没禁直推，但直推会绕过全部 CI 门禁，
远端回显 `Bypassed rule violations` 就是在提示这点。走 PR，等 CI 全绿再合并。
本仓 PR 没有强制人工审核，**CI 绿就是唯一的代码门禁**，别自己拆。

### 6. Gitee 不用管

Gitee 由**原生 Pull 镜像**自动同步 GitHub 的提交（2026-11-17 起），不要再手动推。
以前那种「历史分叉就造同树提交、`git push gitee`」的做法已废弃；同步滞后几分钟是正常的，
不该也不需要人工干预。

### 7. 等 CI

CI 的三个 job 都要绿：`check`（语法 / 版本号 / 索引一致）、`test`（插件测试）、
`eol`（换行符）。fork 投稿还会另跑 `pr-guard.yml` 的路径 / 凭证 / 符号链接拦截。

`test` job 会把框架 checkout 到 `.framework/`，ref 由 `.github/workflows/ci.yml`
的 `FRAMEWORK_REF`（或仓库 Variables）决定。**发框架新版时要同步改这个 ref**，
否则插件测试跑在旧框架上，可能假绿也可能假红。

### 8. 核对

```bash
# 索引里确实是新版本（本地）
node -e "const j=require('./index.json');console.log(j.plugins.find(p=>p.id==='<id>').version)"
```

合并后再核对 GitHub `main` 上的 `index.json` 已是新版本；用 API 读 `contents/index.json`，
**别信 raw**（有 CDN 缓存）。Gitee 由镜像自动同步，不用核。

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| CI「索引和插件目录对不上：索引里没有这个插件」 | 加了插件没重建索引 | 走第 2 步 |
| CI「以下文件含 CRLF」 | Windows 检出被转成 CRLF，sha256 就对不上 | `.gitattributes` 已有 `* text=auto eol=lf`；用 `git add --renormalize .` 重新规范化 |
| 用户装不上，报 sha256 不符 | 索引哈希和实际目录不一致 | 重建索引，确认提交的是 LF |
| CI「读不到 version」 | `version` 写成了常量 | 改成字面量字符串 |
| 插件测试假红/假绿 | `FRAMEWORK_REF` 钉在旧框架 tag | 改 `ci.yml` 里的 ref，或设仓库 Variables |

---

## 插件目录要求

```
plugins/<插件id>/
├── index.js          ← 内建插件（JS），或者：
├── plugin.json       ← 外部插件清单
└── main.py           ← 外部插件入口
```

**二选一**：有 `index.js` 就是内建插件（跑在主进程），有 `plugin.json` 就是外部插件（子进程）。

写之前请先读主程序的 [插件开发规范](https://github.com/tdcq9594/qq-bot-roost/blob/master/docs/插件开发规范.md)
和 [插件协议](https://github.com/tdcq9594/qq-bot-roost/blob/master/docs/插件协议.md)。

### 硬性要求

| 要求 | 说明 |
|------|------|
| `id` 全局唯一 | 命令名也是全局唯一的，别用 `help` / `status` 这类通用词 |
| 必须提供菜单 | `ctx.menu(...)` 或 `plugin.json` 的 `menus`，否则用户看不到怎么玩 |
| 零依赖优先 | 内建插件只能用 Node 内置能力；外部插件可以在 `plugin.json` 里声明依赖 |
| 不写死凭证 | 不要在自己的代码里塞 AppSecret 或 token |
| 数据存 `dataDir` | 外部插件用 `init` 下发的 `dataDir`；内建插件用 `ctx.storage` |
| 不要跨机器人读数据 | 数据是按机器人隔离的，`openid` 也不通用 |

---

## `index.json` 条目格式

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说清它能干什么",
  "author": "你的 GitHub 用户名",
  "path": "plugins/my-plugin",
  "runtime": "node",
  "tags": ["工具"],
  "commands": ["mycmd"],
  "addedAt": "2026-10-23"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 与目录名一致，小写字母数字短横线 |
| `name` | ✅ | 显示名 |
| `version` | ✅ | 语义化版本 |
| `description` | ✅ | 一句话，别超过 60 字 |
| `author` | ✅ | 你的 GitHub 用户名 |
| `path` | ✅ | 相对仓库根目录的路径 |
| `runtime` | ✅ | 外部插件的启动方式：`python` / `node` / `go` / `exec`。内建插件（`index.js`）没有 `plugin.json`，也就没有这个字段 |
| `tags` | | 分类标签 |
| `commands` | | 主要命令名，方便用户检索 |
| `addedAt` | | 收录日期 |

---

## 收录标准

会被拒绝的情况：

- 需要用户自己改代码才能跑起来的
- 内置了广告、引流、未经声明的收费引导的
- 会读取或上传用户凭证的
- 明显抄袭别人的插件
- 恶意刷屏、无冷却的大量发消息

---

## 贡献者

这里的插件来自社区投稿，谢谢这些作者。收录时保留原来的写法，只重建索引——代码长什么样，就是作者写成什么样。

| 贡献者 | 插件 | 提交 |
|---|---|---|
| [@haibiandefengshu](https://github.com/haibiandefengshu) | `media-vision`（识图与看视频）、`pixiv-pid`（Pixiv 发图）、`jm-comic`（禁漫下载）、`comfy-draw`（本地绘图）、`trpg-forwarder`（跑团转发器）、`weather-card`（天气播报）、`persona-scope`（专属人设）、`persona-grow`（人设生长扩展）、`persona-scope-ext`（专属人设扩展）、`sticker-reply`（表情标注） | [PR #1](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/1)、[PR #2](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/2)、[PR #3](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/3)、[PR #4](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/4)、[PR #5](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/5)、[PR #6](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/6)、[PR #7](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/7)、[PR #8](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/8)、[PR #9](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/9)、[PR #10](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/10)、[PR #11](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/11)、[PR #12](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/12)、[PR #13](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/13)、[PR #15](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/15)、[PR #16](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/16) |

索引条目里的 `author` **一律写投稿者的 GitHub 用户名**，维护者不占署名；`credits` 只补充 PR 编号。索引的 sha256 约束的是「装到的是哪份内容」，**不约束 `author` 字段**——两者是两回事。以后所有社区投稿都按这条办，面板上显示的就是插件作者本人。

也想放一个进来？见上面「[怎么提交插件](#怎么提交插件贡献者)」。

---

## 许可

与本项目一致：**GNU Affero General Public License v3.0 only（AGPL-3.0-only）**。允许商业使用与收费分发，但分发或通过网络提供服务时必须同样开源并提供对应源码。见 [LICENSE](LICENSE)。

提交 PR 即表示你同意你的插件按同一许可发布。

**例外**：`plugins/jm-comic/`、`plugins/pixiv-pid/` 为第三方投稿，保留各自 README 中声明的原许可（免费、禁止收费转售与商业分发），不适用本仓库的 AGPL-3.0-only。改动或再分发这两个插件时请以它们自己的声明为准。
