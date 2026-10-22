# 栖 Roost 插件仓库

> 提交你的插件，用户在面板「插件 → 市场」里一键安装。

- 主程序：[qq-bot-roost](https://github.com/tdcq9594/qq-bot-roost)
- 插件清单：[`index.json`](index.json)

---

## 怎么提交插件

1. Fork 本仓库
2. 把你的插件放进 `plugins/<插件id>/`
3. 在 `index.json` 的 `plugins` 数组里加一条
4. 提 PR

合并后，所有用户刷新面板的插件市场就能看到并安装。

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
| `runtime` | ✅ | `node`（内建）/ `python` / `exec` |
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

## 许可

与本项目一致：**永久免费、禁止任何收费、禁止商业使用**。见 [LICENSE](LICENSE)。

提交 PR 即表示你同意你的插件按同一许可发布。
