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

> ⚠️ **不要动这三个文件**：`index.json`、`index.json.sig`、`trust-public.pem`。
> 它们由维护者用离线私钥统一重建，原因见下面「签名与信任链」。

**PR 的 CI 里「索引与插件目录一致」「索引签名有效」这两项会红，这是预期的**——
索引和签名必须由私钥产生，贡献者手上没有。维护者合并后会统一重建并签名，
`main` 分支的 CI 才是绿的。其余几项（语法、版本号、换行符、插件测试）请务必自己过。

合并后，用户刷新面板的插件市场就能看到并安装。

---

## 签名与信任链

插件市场要回答一个具体问题：**用户下载到的插件，是不是仓库里那一份**。
两个校验串起来：

```
① 内容完整性
   index.json 里的 sha256  ──►  用户下载插件目录  ──►  本地重算 sha256  ──►  比对
   对不上 = 内容被改过（或换行符被转换过）→ 拒绝安装

② 索引没被篡改
   index.json.sig（ed25519 签名）  ──►  用 trust-public.pem 验签
   验不过 = 索引被人动过 → 整个市场拒绝加载
```

只做 ① 不够：攻击者改了插件，同时把 `index.json` 里的 sha256 一起改掉，① 就自洽了。
② 把「索引本身」也锁住——没有私钥就签不出新的 `.sig`。

### 三个文件分别是什么

| 文件 | 内容 | 在哪 | 谁能改 |
|---|---|---|---|
| `index.json` | 插件清单 + 每个插件的 sha256 | 仓库根 | 维护者（脚本生成，别手改） |
| `index.json.sig` | 对 `index.json` 的 ed25519 签名 | 仓库根 | **只有维护者**（要私钥） |
| `trust-public.pem` | 验签用的公钥 | 仓库根 | **只有维护者**（只在轮换时改） |

- **公钥**是公开的：进仓库、进 CI，谁都能看。它只能**验**，不能签。
- **私钥** `keys/trust-private.pem` **永远不进仓库**（`keys/` 在 `.gitignore` 里），
  只在维护者机器上。丢了只能轮换（见下）。
- 框架那边内嵌了同一把公钥（`src/trust.js` 的 `EMBEDDED_PUBKEY`），
  用来兜住「仓库根公钥本身也被换掉」的情况。

### 为什么 PR 不能改 `trust-public.pem`

改了公钥 = 换掉验签的根。后果分两种：

1. **CI 用仓库内公钥验签**（我们的 CI 就是这样）→ PR 里三件套一起换，CI 会绿；
   但用户端框架用**内嵌公钥**验签 → 全部失败，市场对所有人变空。
2. 如果哪天框架改成读仓库公钥 → 任何人都能自己生成一对密钥、签一份恶意索引，
   用户装到的是攻击者的插件。

所以：**签名公钥的轮换是维护者的单方面动作，不接受任何 PR**。

### 密钥轮换（唯一正确做法）

私钥泄露或丢失时才做，且必须三处同时改、配一次框架发版：

1. 生成新密钥对（ed25519），私钥留在本机 `keys/`，**不进 git**
2. 换掉仓库根 `trust-public.pem`
3. 换掉框架 `src/trust.js` 的 `EMBEDDED_PUBKEY`，**发一个新版框架**
4. 用新私钥重签 `index.json`，提交 `.sig`

漏了第 3 步 → 老版本框架验不过新签名，市场对他们变空。
所以轮换必须配框架发版，不能只改插件仓。

---

## 改完插件要更新索引（维护者）

```bash
# 重建 + 自动签名（找到私钥才签）
ROOST_TRUST_KEY=../bot/keys/trust-private.pem node scripts/build-index.mjs

# 只校验一致性（CI 跑的就是这个）
node scripts/build-index.mjs --check

# 单独验签
node scripts/sign-index.mjs --verify --key trust-public.pem
```

> 私钥在**框架仓** `bot/keys/trust-private.pem`，不在本仓库（本仓库没有 `keys/`）。
> 不传 `ROOST_TRUST_KEY` 时脚本会去 `keys/trust-private.pem` 找，找不到就
> **静默跳过签名** → json 更新了、`.sig` 还是旧的 → CI 验签必红。

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

```bash
ls -l ../bot/keys/trust-private.pem        # 私钥在不在，不在就别往下走
```

还要确认**插件仓公钥 == 框架内嵌公钥**（DER 主体相同）。
不一致说明有一边被换过，先查清楚再发。

### 1. 收 PR / 放插件

贡献者的 PR 只含 `plugins/<id>/**`。**不要直接点合并**，先拉到本地看：

```bash
git fetch https://github.com/<贡献者>/qq-bot-roost-plugins.git <分支>
git checkout FETCH_HEAD -- plugins/<id>
```

只取插件目录，**不取** `index.json` / `index.json.sig` / `trust-public.pem`。

然后过一遍：

```bash
node --check plugins/<id>/index.js                     # 语法
git grep -Il $'\r' -- 'plugins/**'                     # 不能有 CRLF
grep -rn "eval(\|new Function\|child_process" plugins/<id>/*.js   # 跑外部命令的要人工看
```

### 2. 重建索引 + 签名

```bash
ROOST_TRUST_KEY=../bot/keys/trust-private.pem node scripts/build-index.mjs
```

漏了 `ROOST_TRUST_KEY` → 静默不签名 → CI 验签红。

### 3. 验签 + 一致性

```bash
node scripts/sign-index.mjs --verify --key trust-public.pem
node scripts/build-index.mjs --check
```

两条都要绿。`--check` 会比对每个插件的 sha256，也会报「目录里有、索引里没有」。

### 4. 提交

```bash
git add plugins/<id> index.json index.json.sig
git commit -m "feat(plugins): 收录 <id> <version>"
```

**`.sig` 必须和 `index.json` 进同一个提交**，否则中间那个 commit 的 CI 会红。

### 5. 推 GitHub

```bash
node scripts/sync-github.mjs tdcq9594/qq-bot-roost-plugins main
```

这个脚本递归对比本地树和远端树、自动算差异、推完回读校验。
**不要手写文件列表**——漏一个文件就会让 Gitee 和 GitHub 的树不一样。

### 6. 推 Gitee

```bash
git fetch gitee main
git merge-base --is-ancestor refs/remotes/gitee/main HEAD && git push gitee main
```

历史分叉（Gitee 上有本地没有的提交）时**造同树提交，不强推**：

```bash
TIP=$(git rev-parse refs/remotes/gitee/main)
NEW=$(git commit-tree "HEAD^{tree}" -p "$TIP" -m "$(git log -1 --format=%B HEAD)")
git push gitee "$NEW:main"
```

Gitee 有内容审查（个别文件 451），推完用 **API** 读 `contents/index.json` 核对，
**别信 raw**（有 CDN 缓存）。

### 7. 等 CI

六个 job 都要绿：语法 / 版本号 / 索引一致 / 索引签名 / 插件测试 / 换行符。

`test` job 会把框架 checkout 到 `.framework/`，ref 由 `.github/workflows/ci.yml`
的 `FRAMEWORK_REF`（或仓库 Variables）决定。**发框架新版时要同步改这个 ref**，
否则插件测试跑在旧框架上，可能假绿也可能假红。

### 8. 三端核对

```bash
# 索引里确实是新版本
node -e "const j=require('./index.json');console.log(j.plugins.find(p=>p.id==='<id>').version)"
```

再确认 GitHub 的 `main` 和 Gitee 的 `main` 树一致（顶层 tree 指纹相同，不是 commit SHA）。

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| CI「索引和插件目录对不上：索引里没有这个插件」 | 加了插件没重建索引 | 走第 2 步 |
| CI「索引签名无效」 | 重建时没给私钥，或 `.sig` 没跟着提交 | 带 `ROOST_TRUST_KEY` 重跑，`.sig` 一起提交 |
| CI「以下文件含 CRLF」 | Windows 检出被转成 CRLF，sha256 就对不上 | `.gitattributes` 已有 `* text=auto eol=lf`；用 `git add --renormalize .` 重新规范化 |
| 用户装不上，报 sha256 不符 | 索引哈希和实际目录不一致 | 重建索引，确认提交的是 LF |
| 用户市场整个空白 | 索引验签失败 | 核对 `trust-public.pem` 与框架 `EMBEDDED_PUBKEY` 是否同一把 |
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
- 内置了广告、引流、收费引导的（本项目许可禁止任何收费）
- 会读取或上传用户凭证的
- 明显抄袭别人的插件
- 恶意刷屏、无冷却的大量发消息

---

## 贡献者

这些插件是外面的人写出来的，收录时不改代码风格，只做索引和签名：

| 贡献者 | 插件 | 提交 |
|---|---|---|
| [@haibiandefengshu](https://github.com/haibiandefengshu) | `media-vision`（识图与看视频）、`pixiv-pid`（Pixiv 发图） | [PR #1](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/1)、[PR #2](https://github.com/tdcq9594/qq-bot-roost-plugins/pull/2) |

索引条目里的 `author` 写维护者、作者记在 `credits`，是签名链的要求（索引必须由维护者的私钥签），
不代表抹掉署名——插件目录里的代码和 README 都保持投稿时的样子。

---

## 许可

与本项目一致：**永久免费、禁止任何收费、禁止商业使用**。见 [LICENSE](LICENSE)。

提交 PR 即表示你同意你的插件按同一许可发布。
