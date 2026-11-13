# 让ta画图（imagegen）

给机器人**一支笔**：你说「画个 xx」，它调生图接口画出来，存进自己的画作库，再把图发进聊天。

标准 MCP server，stdio，**零依赖**（只要 Node ≥ 20），4 个工具。

> 和 `comfy-draw`、`anime-img` 那些框架插件的区别：那些跑在框架进程里、有自己的面板和按钮；
> 这个跑在 DSH 侧、**只提供工具**，发不发、跟哪句话一起发由模型按语境决定。
> 好处是不用改宿主就能装；代价是所有「按钮」都得变成一句话（见最后一节）。

## 一张图是怎么发出去的

扩展**不自己发消息**。宿主只给它 `ROOST_API_URL` / `ROOST_EXT_ID` / 配置和令牌，
**没有「当前是哪个会话」这个信息**（MCP 的工具调用只带参数）。所以：

```
模型 → image_gen(prompt) → 扩展画图 → 存 out/ → 返回绝对路径
                                              ↓
模型在回复里写 <<image-alone: 路径>>  → 出站动作层上传 → QQ
```

这个绕法不是妥协，反而更对：画完不会往群里甩一张图，而是由模型决定
「跟这句话一起发」还是「单独发一条」，也可以干脆先不发。

**代价**：模型必须记得写标记。所以 `image_gen` 的返回文案里就带着可直接复制的
`<<image-alone: 路径>>`，工具描述里也反复写了「不写标记对方收不到」。
`test/tools.mjs` 有一条断言钉住这件事。

## 工具

| 工具 | 什么时候用 | 入参 |
|---|---|---|
| `image_gen` | 「画个 xx」「给我画一张」 | `prompt`、`shape`（square/portrait/landscape/wide）、`size`、`ref` |
| `image_list` | 「刚才那张再发一次」「你都画过什么」 | `limit` 1–50 |
| `image_test` | 「你能画图吗」「生图是不是坏了」——真画一张验证（花钱） | `prompt` |
| `image_delete` | 从画作库删一张 | `file`、`confirm: true` |

模型看到的名字是 `mcp__imagegen__image_gen` 这样。

`ref` 只接受**画作库里的编号**（`#1` 是最新那张）或文件名，不接受路径和网址——
扩展不该因为模型随手写的一个字符串就去读本机的任意文件。

`image_gen` 的输出大概长这样：

```
画好了：C:\Users\me\.dsh\dsh-roost\extensions\imagegen\out\20261114-031501-一只橘猫.png
把它发给对方：回复里写 <<image-alone: C:\...\out\20261114-031501-一只橘猫.png>>（想跟文字同一条就用 <<image: 路径>>）
1024x1536 · 1.8MB · 用时 7.2 秒 · 主接口
今天还能画 19 张。
画好之后别描述画面细节——你看不到这张图。
```

## 三种接法

面板「表达 → 让ta画图 → 设置」里选，改完保存即可（**扩展是独立进程，改配置要重启 DSH 才生效**）。

### ① OpenAI 兼容（默认，覆盖绝大多数）

填**服务地址 + API Key + 模型名**就能画：

| 服务 | 服务地址 | 模型名（看文档） |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-image-1` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Kwai-Kolors/Kolors` |
| 通义万相兼容层 | 看服务商 | `wanx2.1-t2i-turbo` |
| 本地 ComfyUI / SD WebUI 的 OpenAI 代理 | `http://127.0.0.1:端口/v1` | 按代理的说明 |

服务地址写根地址（到 `/v1`）或直接贴完整的 `/images/generations` 地址都认——
面板上写地址的人一半会直接贴文档里的完整 URL，认不出来就会拼成
`.../generations/images/generations` 然后报 404，还查不出原因。

`response_format` / `image_size` 这两个参数不是每家都认。被拒（400 且消息里点名）时
会自动去掉那一个重发一次：**被拒的请求没出图，重发不会多画一张**。
其它 400 一律不重试——重试也不会成功，只是多花一次钱。

### ② 自定义接口

什么都不兼容时手写：URL 模板 + 参数表 + 从返回 JSON 里取图。

```
接口地址：https://api.xxx.com/draw?q={prompt}&size={size}
方法：    GET
参数：    n=1
返回值路径：（留空则自动在 JSON 里找图片地址）
```

占位符：`{prompt}` `{model}` `{size}` `{width}` `{height}` `{image}`（base64）。
GET 的参数拼进地址，POST 的按「请求体」选项发 JSON 或表单。
`{image}` 出现在地址或某个参数值里才算「支持参考图」——传了图却没地方放，
会当场拒绝，而不是画一张和参考图无关的图。

### ③ 备用接口

主接口失败后按顺序再试，每行一条：

```
https://api.siliconflow.cn/v1|Kwai-Kolors/Kolors
https://other.test/v1|sd3
```

只写地址就沿用主模型；密钥沿用上面那一个（面板的配置项只有 `array<string>`，
没有「对象数组」，所以这里用竖线分隔）。按张收钱的服务偶尔 502，
换一条能用的接口比让人起来改配置快得多。

**Codex 订阅接法没做**：它依赖登录态和一条实验性通道，坏了没法排查，收益也不大。

## 面板页面（6.1 声明式界面）

装好后「表达 → 让ta画图」会多一页，表格列出最近画过的图（提示词、时间、大小、文件名）。

**没有缩略图**：宿主的 `image` 字段只收 http(s) 地址，不会去读本地文件。
要显示缩略图得宿主补一个「扩展目录文件」路由（像 `/stickers/file` 那样），
那是宿主侧的另一件事，不在这个扩展能做的范围里。

数据文件是扩展目录里的 `ui-data.json`，**只在画完一张 / 删掉一张之后写**，
不额外发请求、不定时轮询。`ui.view.fields` 的 `key` 必须和 `lib/ui-data.mjs` 的
`rowsOf()` 输出一一对应，`test/ui-data.mjs` 有一条断言钉住。

## 花钱这件事

生图按张计费，所以有两个闸：

- **每天最多几张**（默认 20，0 = 不限）：账本是扩展目录里的 `state.json`，**先扣后画**，
  画失败退回——工具调用是并发进来的，先查后扣会让两次调用同时通过检查；
- **失败不自动重试**（除了上面那个「去掉不支持的参数」）：真正的重试只发生在备用链接上。

配额按本地日期比，跨天自动归零。账本文件坏了当成 0，不拦人——省钱的手段不该变成故障点。

## 目录

```
plugins/imagegen/
├── plugin.json          清单：config / ui / usage
├── server.mjs           MCP stdio：initialize / tools/list / tools/call / ping
├── lib/
│   ├── config.mjs       ROOST_EXT_CONFIG + secrets → 一份能用的配置
│   ├── providers.mjs    OpenAI 兼容 / 自定义 / 备用链（纯函数 + 注入 fetch）
│   ├── net.mjs          下载图片、按文件头判类型
│   ├── paint.mjs        画作库：存 / 列 / 编号定位 / 删
│   ├── state.mjs        当日配额账本
│   ├── tools.mjs        四个工具 + 参数校验 + 结果文案
│   └── ui-data.mjs      面板数据文件
└── test/                6 个离线用例 + 1 个手动联调（live.mjs）
```

运行时数据（装进 `<dataDir>/extensions/imagegen/` 之后）：

```
out/           画作（文件名 = 时间 + 提示词，删了就是删了）
state.json     当天配额
ui-data.json   面板数据
```

## 测试

```bash
cd plugins/imagegen
node test/config.mjs      # 配置解析：默认值、密钥只从 env 来、竖线格式
node test/providers.mjs   # 三种接法的请求形状 + 降级（假 fetch，不联网）
node test/tools.mjs       # 配额、参考图、结果文案（假生图）
node test/paint.mjs       # 存 / 列 / 编号 / 安全文件名
node test/state.mjs       # 跨天、失败退回、账本坏了
node test/ui-data.mjs     # 字段与 plugin.json 对齐
node test/smoke.mjs       # 真起进程跑 MCP 协议面
node test/live.mjs        # 真画一张（要真接口，花钱，不进 CI）
```

## 已知限制

- **面板点不了「现在画一张」**：声明式界面没有按钮。要画就让机器人在聊天里画——
  「模型是操作者」本来就是这个架构的前提。真想加按钮，得宿主补 `ui.actions`
  （声明按钮 → 面板点击 → 宿主代调扩展工具），那是单独一件事。
- **发不出去的情况要人提醒**：模型偶尔会忘记写 `<<image:>>`，那张图就只躺在画作库里
  （`image_list` 还能找回来）。
- **同一个会话里连画多张**：去重按「会话 + 动作 + 值」算，不同文件不会互相顶掉。
