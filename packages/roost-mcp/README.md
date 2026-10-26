# roost-mcp

把 [Roost](https://github.com/tdcq9594/qq-bot-roost) 的 QQ 能力做成 **MCP 工具**，
让 Claude Desktop / Cursor / Cline / Continue / Windsurf 这些工作台能直接发 QQ 消息。

方向跟 `ai-chat` 插件相反：

| | 谁当大脑 | 干什么 |
|---|---|---|
| `ai-chat` 插件 | 工作台 | QQ 消息进来 → 工作台想 → 插件发出去 |
| `roost-mcp` | 工作台 | 在工作台里说「帮我在群里发一句」→ 它调 QQ |

两个可以同时用：`ai-chat` 负责「AI 住在群里」，`roost-mcp` 负责「你顺手让它发一句」。

---

## 已发布

```bash
npx -y roost-mcp
```

包名 `roost-mcp`（npm，v0.1.0）。下面所有配置里的 `npx -y roost-mcp` 都是指这个。

## 前置

Roost 要跑着，并且 ≥ 0.8.0（`POST /api/qq/call` 是这个版本加的）。

---

## 装

### Claude Desktop

`claude_desktop_config.json`：

```jsonc
{
  "mcpServers": {
    "qq": {
      "command": "npx",
      "args": ["-y", "roost-mcp"],
      "env": {
        "ROOST_URL": "http://127.0.0.1:8080",
        "ROOST_KEY": "面板访问密钥"
      }
    }
  }
}
```

### Cursor / Cline / 其他支持 MCP 的

同样三件事：命令 `npx -y roost-mcp`、环境变量 `ROOST_URL` / `ROOST_KEY`。
具体写在哪个配置文件里各家不同，看各自文档。

### 本地调试

```bash
ROOST_URL=http://127.0.0.1:8080 ROOST_KEY=xxx node index.js
# 然后在 stdin 里敲一行 JSON-RPC：
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ROOST_URL` | `http://127.0.0.1:8080` | Roost 面板地址 |
| `ROOST_KEY` | 空 | 面板访问密钥（`webui.accessKey`）。只监听本机时可以留空 |
| `ROOST_BOT` | 空 | 多机器人时只操作这一个；留空 = 默认机器人 |

---

## 工具

| 工具 | 干什么 |
|---|---|
| `qq_send` | 发文本 / Markdown / 图片到群或私聊 |
| `qq_recall` | 撤回机器人自己发的消息 |
| `qq_mute` | 群成员禁言 / 解除（需管理员） |
| `qq_group_info` | 查群信息 |
| `qq_capabilities` | 列出 Roost 封装了哪些官方接口（AI 不知道能调什么时先看这个） |
| `qq_api` | 调其余任意官方接口，兜底 |

`qq_api` 的参数约定：`__target` 是第一个位置参数，`__rest` 是后续位置参数，
其余键合成一个对象追加在最后。危险操作（踢人、黑名单、审批策略）要 `confirm: true`。

---

## 设计说明

**为什么不给 47 个接口各做一个工具**：AI 选不过来，也没人维护。
六个工具 + 一个能力清单，剩下的靠 `qq_api` 兜底。官方加接口时，
Roost 那边在 `endpoints.js` 加一行，这里零改动。

**为什么日志走 stderr**：MCP 的 stdio 传输里 stdout 是协议通道，
混一行日志客户端就解析失败。这是这类 server 最常见的坑。

**为什么工具失败返回 `isError` 而不是抛异常**：让模型看到失败原因
（比如「被动回复超限」），它才有机会换个做法；进程崩了就只能等用户重启。

---

## 测试

```bash
node test/mcp.test.mjs
```

起一个假 Roost，spawn 真的 MCP server，按协议发 JSON-RPC，验证：
协议形状、stdout 里只有 JSON-RPC、工具失败走 `isError`、未知方法返回正确错误码。
