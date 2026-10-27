# AI 原生对话（ai-native）

直连模型（OpenAI 兼容 `/chat/completions`）的群聊 AI，自带**人格**、**短期上下文**、**摘要压缩**和**长期记忆**。不依赖 DSH，也不依赖任何第三方库。

> 和 `ai-chat` 的区别：`ai-chat` 只做「QQ ↔ DSH 的桥」，模型是谁归 DSH 管；`ai-native` 自己拿 Key、自己调模型。**同一个群不要同时开这两个**，否则两个都会接话。

---

## 功能

- **多服务商**：DeepSeek / Kimi / 通义 / 智谱 / 硅基流动 / 火山 / Ollama / vLLM / one-api / LiteLLM 等，只要是 OpenAI 兼容形状就能用。
- **人格**：命名人格库，每个会话可以绑不同人格（技术群严谨、亲友群皮一点）。
- **短期上下文**：每个会话独立，默认带最近 12 轮。
- **摘要压缩**：对话超过阈值后，让模型把旧对话压成一段摘要，防止上下文无限长。
- **长期记忆**：用户明确让它记的事（`/ai 记住`），跨重启保留。
- **两种接话模式**：只在被 @ 时说话（省 token）／AI 自己判断该不该接话。

---

## 命令

| 命令 | 作用 | 权限 |
|---|---|---|
| `/ai 模型` | 查看可用模型，`▶` 是当前用的 | 所有人 |
| `/ai 模型 <id>` | 本会话切换到某服务商 | 管理员 |
| `/ai 人格` | 查看可用人格 | 所有人 |
| `/ai 人格 <名称>` | 本会话切换人格 | 管理员 |
| `/ai 新对话` | 清空本会话上下文与摘要（长期事实保留） | 所有人 |
| `/ai 记住 <内容>` | 让它记住一件事 | 所有人 |
| `/ai 忘记 <关键词>` | 忘掉匹配的记忆 | 所有人 |
| `/ai 记忆` | 查看当前会话的摘要与事实 | 所有人 |
| `/ai` 或 `/ai 帮助` | 用法 | 所有人 |

> 管理员权限指「当前群/会话的管理员」。想让普通成员也能切模型/人格，把配置里的 `allowMemberConfig` 打开。

---

## 配置项（面板「插件 → ai-native → 配置」）

| 配置 | 默认 | 说明 |
|---|---|---|
| `decide` | `mention` | `mention` 只在被 @/回复时说话；`ai` 让模型自己判断（每条消息都过模型，费 token） |
| `cooldownSec` | `3` | 同一会话两次回复最小间隔 |
| `minChars` | `1` | 太短的消息不接 |
| `historyTurns` | `12` | 带多少轮上下文 |
| `compressAfterTurns` | `24` | 超过多少轮后压缩旧对话 |
| `vision` | `false` | 是否把图片 URL 直接发给模型（需多模态模型） |
| `providers` | 见下 | 服务商列表（JSON 数组） |
| `defaultProvider` | `default` | 默认服务商 id |
| `personas` | 见下 | 人格库（JSON 对象） |
| `defaultPersona` | `默认` | 默认人格名称 |
| `allowMemberConfig` | `false` | 是否允许普通成员切换模型/人格 |

`providers` 示例：

```json
[
  {
    "id": "default",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "maxTokens": 1024,
    "temperature": 0.7
  },
  {
    "id": "qwen",
    "name": "通义千问",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-yyy",
    "model": "qwen-plus"
  }
]
```

`personas` 示例：

```json
{
  "默认": {
    "prompt": "你是一个友善、简洁、有点幽默的群聊助手。回答要短。",
    "beginDialogs": []
  },
  "严谨助手": {
    "prompt": "你是一个严谨的技术助手，回答准确、给结论也给依据。",
    "beginDialogs": [
      { "role": "user", "content": "这个报错怎么办？" },
      { "role": "assistant", "content": "先看完整堆栈，再说结论。" }
    ]
  }
}
```

---

## 数据存哪

| 内容 | 位置 |
|---|---|
| 配置（含 API Key） | `config/bots/<机器人id>/plugins/ai-native.json` |
| 长期事实、摘要 | `data/bots/<机器人id>/plugins/ai-native.json`（`ctx.storage`） |
| 短期上下文 | 内存（`ctx.state`），重启即丢 |
| 日志 | `logs/bots/<机器人id>/plugins/ai-native.log` |

> ⚠️ API Key 明文存在本机配置文件里（和框架其他配置一致）。别把 `config/` 提交到公开仓库；面板默认只监听 127.0.0.1，别对外暴露。

---

## 说明

- 不引任何第三方依赖，`fetch` 是 Node 自带的。
- 语音消息直接用官方 ASR 结果（`msg.voices[].asrText`），不用自己识别。
- 图片默认只标注「[图片×N]」；开了 `vision` 才把 URL 发给模型（部分服务商需要 base64，届时再扩展）。
- 长任务不会超过 5 分钟被动回复窗口；超时会由框架自动降级为主动消息。
