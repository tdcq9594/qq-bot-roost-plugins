# 让ta画图（imagegen 0.2.0）

给机器人**一支笔**：你说「画个 xx」，它调生图接口画出来，存进自己的画作库，
把可直接复制的发送标记交给模型，由模型决定跟哪句话一起发。

标准 MCP server，stdio，**零依赖**（只要 Node ≥ 20），6 个工具 + 一页自己的面板。

> **0.2 是重做，不是打补丁。** 参照物有两个：
> aurabot 的生图模块（`dsh-aurabot-qq(-beta)/src/features/imagegen.js` 一带）和
> 我们自己的 B 站扩展（`plugins/bili/`，0.11.8）。前者提供「生图这件事该怎么做」
> 的判断，后者提供「一个成熟扩展该长什么样」的骨架。调研结论见最后一节。

## 和 0.1 比，重做了什么

| 面 | 0.1 | 0.2 |
|---|---|---|
| 面板 | 宿主声明式表格，只有文件名 | 自己的页面：分区设置 + 测试生图按钮 + **缩略图画廊** + 状态条 |
| 改设置 | 要重启 DSH | **配置热读**，下一轮工具调用就生效 |
| 工具 | 4 个 | 6 个，多 `image_send`（编号 → 标记串）、`image_status`（不花钱的自检） |
| 发图链路 | 模型得自己照着路径拼标记 | `image_send` 给出整行现成标记，路径只从画作库查表得到 |
| 按钮 | 没有（声明式界面不给按钮） | 进程内动作：`test_draw` / `refresh` / `delete` / `send` / `status` |
| 失败原因 | 一律「接口返回 4xx」 | 上游错误分类：余额 / 限流 / 内容审核 / 不支持参考图 / 尺寸 / 模型名 / 地址 |
| 备用链 | 配了就一定会试 | 多了「失败自动切换」开关，排障时可关掉看主接口的真错误 |
| 超时 | 写死 180 秒 | 可配 10–180 秒；面板按钮自动夹到 120 秒（宿主通道 150 秒封顶） |
| 画作库 | 只增不减 | 可设保留上限，**只删扩展自己按时间戳命名的文件** |
| 数据 | `ui-data.json` 一份 | 再拆出 `gallery.json` 数组（宿主 `meta` 只收标量） |

**保留没动**：provider 抽象（OpenAI 兼容 / 自定义 / 备用链）、按文件头判图片类型、
参考图白名单、先扣后画的配额账本、「你看不到这张图，别描述画面」的如实反馈。
这几块 0.1 就写对了，重写只会引入回归。

## 一张图是怎么发出去的（核心边界没变）

扩展**不自己发消息**。宿主只给扩展 `ROOST_API_URL` / `ROOST_EXT_ID` /
`ROOST_LAUNCHER_DIR` / 配置和令牌，**没有「当前是哪个会话」**（MCP 的工具调用
只带 arguments），`/v1/send` 却必须给 `target`。所以：

```
模型 → image_gen(prompt) → 扩展画图 → 存 out/ → 返回绝对路径 + 标记串
                                            ↓
模型在回复里写 <<image-alone: 路径>> → 出站动作层上传 → QQ
```

这不是妥协：画完不会往群里甩一张图，发不发、跟哪句话一起发由模型按语境决定。
代价是模型必须记得写标记，所以 `image_gen` / `image_send` 的返回里都直接带
可复制的整行，`test/tools.mjs` 与 `test/tools02.mjs` 各有一条断言钉住这件事。

## 工具（6 个）

| 工具 | 什么时候用 | 入参 |
|---|---|---|
| `image_gen` | 「画个 xx」「给我画一张」 | `prompt`、`shape`、`size`、`ref` |
| `image_list` | 「刚才那张再发一次」「你都画过什么」 | `limit` 1–50 |
| `image_send` | 把 `#1` 这类编号换成现成标记串 | `file`、`style`（alone / inline） |
| `image_test` | 「你能画图吗」「生图是不是坏了」——真画一张（花钱） | `prompt` |
| `image_delete` | 从画作库删一张 | `file`、`confirm: true` |
| `image_status` | 「你还能画吗」「今天画了几张」——不花钱不联网 | 无 |

模型看到的名字是 `mcp__imagegen__image_gen` 这样。

`ref` / `image_send` 的 `file` 只接受**画作库里的编号**（`#1` 是最新那张）或文件名，
不接受路径和网址——扩展不该因为模型随手一个字符串就去读本机任意文件。

## 面板

装好后「表达 → 让ta画图」是一整页，分四块：

- **状态**：今天画了几张 / 上限、画作库总数、上次结果与走的哪条接口、配置自检结论。
- **测试生图**：填提示词点一下，真画一张（会花一次钱、可能等一两分钟），图直接进画廊。
- **设置**：接口（地址 / 密钥 / 模型 / 超时 / 备用链）、自定义接口、画什么（构图 / 尺寸 /
  固定风格 / 参考图）、花钱与清理。开关自动保存，文本框点保存。
  **设置还没读到时保存会被硬拦**——拿空草稿覆盖真配置是出过事故的坑。
- **ta的画作**：缩略图网格，点图看大图，每张可「复制标记」「删除」（删除有二次确认）。

缩略图走宿主的通用路由 `/ext-pages?id=imagegen&file=out/xxx.png`。
0.1 的交接里写过「要显示缩略图得宿主补一个静态文件路由」——**那条路由后来有了**
（B 站扩展的截图库就在用），所以这一版**一行宿主代码都没改**。

面板按钮走 `ui.runtime: "inprocess"`：宿主 `import()` `ui/main.mjs`，点一下就是一次
普通函数调用，没有队列、没有轮询。按钮和模型工具共用 `lib/drawOnce()`，
配额、错误文案、落盘、清理完全是同一条链路，不搞两套行为。

**配置热读**：面板保存设置后宿主不会重启 MCP 子进程（静态 `mcp-<id>` 条目不受
`mcpManager.restart()` 治理）。所以扩展每次工具调用前直接读宿主存的那两份文件
（`extensions/<id>/config.json`、`secrets/<id>.config.json`），按 mtime 跳过没变的，
`Object.assign` 原地改活引用。布局万一变了也只是回到「要重启」的老行为，不会挂。

## 三种接法

面板「接口格式」里选：

### ① OpenAI 兼容（默认）

填**服务地址 + API Key + 模型名**就能画。地址写根地址（到 `/v1`）或直接贴完整的
`/images/generations` 都认——一半人会直接贴文档里的完整 URL，认不出来就会拼成
`.../generations/images/generations` 然后报 404。

| 服务 | 服务地址 | 模型名（看文档） |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-image-1` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Kwai-Kolors/Kolors` |
| 通义万相兼容层 | 看服务商 | `wanx2.1-t2i-turbo` |
| 本地 ComfyUI / SD WebUI 的 OpenAI 代理 | `http://127.0.0.1:端口/v1` | 按代理说明 |

`response_format` / `image_size` 不是每家都认。被 400 点名时会自动去掉那一个重发一次
（被拒的请求没出图，重发不多花钱），其它 400 不重试。

### ② 自定义接口

URL 模板 + 参数表 + 从返回 JSON 里取图。占位符：
`{prompt}` `{model}` `{size}` `{width}` `{height}` `{image}`（base64）。
`{image}` 出现在地址或某个参数值里才算「支持参考图」——传了图却没地方放，
会当场拒绝，而不是画一张和参考图无关的图。

### ③ 备用接口

主接口失败后按顺序再试，每行一条 `地址|模型`（只写地址就沿用主模型），
密钥沿用上面那个。宿主配置只支持到 `array<string>`，所以这里用竖线分隔。
「失败自动切换」关掉时只打主接口，排障时不会被聚合错误盖住真原因。

**Codex 订阅 / 本地 SD 模板 / 外部 upstream 模块没照搬 aurabot**：那几条依赖它的
登录态、本机模板或宿主内建模块，MCP 扩展拿不到，坏了也没法排查。

## 花钱这件事

- **每天最多几张**（默认 20，0 = 不限）：账本 `state.json`，**先扣后画、失败退回**。
  工具调用是并发进来的，先查后扣会双花。
  0.2 还多了「面板按钮跑在宿主进程里」这**第二个写者**：两个进程同时读-改-写同一份
  账本，会各自把 `count` 写成 1（对抗测试实测 3 进程 barrier、`limit=1` 时 12/12 轮
  三个都拿到名额 = 画了三张、花了三次钱）。`tmp + rename` 只保证单次写原子，护不住
  「读 → 改 → 写」三步，所以 `lib/lock.mjs` 用 `openSync(path, 'wx')` 做跨进程文件锁，
  `state.json` / `ui-data.json` / `gallery.json` 的整段读-改-写都串行；
  `test/lock.mjs` 真 spawn 三个进程复现并守住。锁拿不到时退化为无锁并记日志
  ——配额是省钱的手段，不该变成新的故障点。
- **失败不自动重试**（除了「去掉不支持的参数」），真正的重试只发生在备用链上。
- **失败原因会分好类**：余额不足让你去充值、内容审核让你改提示词别反复重试、
  不支持参考图让你关开关——按张收钱的服务，把「余额不足」说成「接口出错」
  等于让人白查半天地址。
- **画作库保留**（默认 0 = 不限）：只删扩展自己按 `YYYYMMDD-HHMMSS-` 命名的文件，
  主人手动放进 `out/` 的图一律不动。

## 目录

```
plugins/imagegen/
├── plugin.json           清单：18 个配置 / usage / ui（page + actions + view + inprocess）
├── server.mjs            MCP stdio：initialize / tools/list / tools/call / ping + 配置热读
├── ui/
│   ├── index.html        面板页面（原生 JS，零依赖）
│   └── main.mjs          进程内动作 createActions()
├── lib/
│   ├── config.mjs        ROOST_EXT_CONFIG + secrets → 一份配置
│   ├── live-config.mjs   按 mtime 热读宿主存的两份配置文件
│   ├── providers.mjs     OpenAI 兼容 / 自定义 / 备用链 + 错误分类（hintOf）
│   ├── net.mjs           下载图片、按文件头判类型
│   ├── paint.mjs         画作库：存 / 列 / 编号定位 / 删 / 保留上限
│   ├── state.mjs         当日配额账本
│   ├── tools.mjs         6 个工具 + drawOnce()/markerOf()（面板与工具共用）
│   ├── gallery.mjs       gallery.json：给页面读的画作数组
│   ├── ui-data.mjs       ui-data.json：给宿主读的 rows + 标量 meta（合并写）
│   ├── lock.mjs          跨进程文件锁（配额 / 面板数据 / 画廊共用）
│   └── errors.mjs        PaintError（每条错误都带「怎么修」）
├── README.md
└── test/                 12 份离线用例 + smoke + live（手动）
```

运行时数据（装进 `<dataDir>/extensions/imagegen/` 之后）：

```
out/           画作（文件名 = 时间 + 提示词）
state.json     当天配额
ui-data.json   面板 rows + 状态标量
gallery.json   画廊数组（meta 只收标量，数组必须另放）
```

`ui-data.json` 有两个进程会写（MCP 子进程、宿主进程内动作），所以所有写入都
「先读回磁盘再合并」，直接整份覆盖会把对方刚写的状态抹掉。

## 明确不做的事

- **定时 / 主动生图**：B 站扩展有定时刷，但那套要靠 `/v1/proactive` 投素材、
  宿主决定措辞与门闸；生图按张收钱，自动画比自动刷视频贵得多，且扩展拿不到
  「当前会话」。`feed` / `push` / `ai-duty` 一概不搬。
- **按人配额 / 只有主人能画**：MCP 只带 arguments，没有调用者身份。真要做
  `ownerOnly` 得宿主侧判定，不是扩展能补的。现在的配额是**按扩展总量**。
- **画完自己发图、进度提示**：同样卡在拿不到 target。替代办法是 usage 里教模型
  画之前先说一句「我去画一下」。
- **改宿主**：这一版没碰 `dsh-roost/src/`，也没碰其它插件。

## 开工前的调研（先找现成方案，别从零硬写）

按项目规矩，动手前去 GitHub 查了同类实现：

- `lpenguin/openai-image-mcp`、`Maxteabag/openai-image-mcp-server` 等 MCP 生图 server
  都是「一个 `/images/generations` + 返回图片」的薄封装：没有配额账本、没有画作库、
  没有面板、没有密钥隔离、没有「扩展拿不到会话」这条链路的处理。
- aurabot 的生图模块（`src/features/imagegen.js`、`src/modules/imagegen/index.js`、
  `src/features/paintings.js`）不是 MCP 扩展，是宿主内建模块，能直接
  `hub.sendSegments()` 发图、能按会话鉴权、能开面板路由——这三条我们都用不了。
  真正可平移的是 **provider 抽象、参数兼容降级、备用链、错误分类、如实反馈、
  参考图白名单、存盘画廊**；发送链路必须整体舍弃。
- 自家 B 站扩展 0.11.8 才是「同形态」的现成方案：stdio 骨架、配置热读、
  `ui.runtime:inprocess` 动作、`/ext-pages` 缩略图、账本与原子写、双进程合并写、
  静态守门测试。这一版把这些通用基建照搬了过来，B 站业务特有的 WBI 签名、
  扫码登录、ffmpeg 抽帧、评论写接口一律不搬。

结论：**没有可直接引用的外部实现**；以两个本地参照物为准，核心 provider 层沿用
0.1 已验证的代码，重做的是骨架与可用性。

## 与 aurabot 生图源码逐项对照

> 对照对象：`dsh-aurabot-qq/src/features/imagegen.js`、`src/features/image-shape.js`、
> `src/features/paintings.js`、`src/local/templates/image.mjs`，以及 beta 版
> `dsh-aurabot-qq-beta/src/features/imagegen.js`（更新：备用链、多参考图、2K/4K）。
> 不是只看设计文档，是逐文件读的。

| aurabot 源码 | 我们 | 说明 |
|---|---|---|
| `image-shape.js` 的 `SHAPE_SIZE` / `SIZE_OPTIONS`（4 构图 / 9 尺寸） | 直接照搬 | 连 `×*` 与空白归一都是同一套 |
| `serviceError()` 的参考图张数判据 | 照搬并补「最多**支持**」 | 原正则漏了中文「支持」二字，实测「最多支持 3 张」识别不出 |
| `customRequest()` 的 GET 参数拼接（`hashAt/base/fragment`） | 直接照搬 | 原实现 `url += '?…'` 会把参数塞进 `#fragment`，服务端收不到 |
| provider 抽象（openai / custom / fallbacks） | 照搬 | 发送链路整体舍弃（见下） |
| 被 400 点名才删 `response_format` / `image_size` 重发 | 照搬 | 0.1 已有；被拒的请求没出图，重发不多花钱 |
| `paintings.js` 的画廊与 `#1` 编号 | 照搬思路 | 我们按目录现算，不维护 `index.json`（手动删图不会和索引打架） |
| `drawToolMessage()` 的「你看不到图，别描述」 | 照搬 | 0.1 已有 |
| `local/templates/image.mjs`（SD WebUI `/sdapi/v1/txt2img`） | 写成 custom 模板 | 不内置 `local` provider，用「自定义接口」就能接（见下） |
| `codex` 登录态、`upstream` 外部模块、`self` 人设图、`notice` 进度、`hub.sendSegments` | **不搬** | 依赖宿主会话、登录态或内建模块；MCP 扩展拿不到，坏了也没法排查 |

本地 SD WebUI / Forge（启动加 `--api`）用「自定义接口」接，参数照搬
`local/templates/image.mjs`：

```
接口地址：http://127.0.0.1:7860/sdapi/v1/txt2img
方法：    POST，请求体 JSON
参数：    prompt={prompt}
          width={width}
          height={height}
          steps=25
          cfg_scale=6
返回值路径：images.0
```

图生图把地址换成 `/sdapi/v1/img2img`，并在参数里加一行 `init_images={image}`
（`{image}` 出现在参数值里才算「支持参考图」）。`images.0` 是裸 base64，
`net.mjs` 会按文件头认出来再落盘。

## 测试

```bash
cd plugins/imagegen
node test/config.mjs        # 配置解析（含 0.2 新字段、密钥只从 env）
node test/providers.mjs     # 三种接法的请求形状 + 降级（假 fetch）
node test/providers2.mjs    # 错误分类 / 失败自动切换 / 超时注入
node test/tools.mjs         # 配额、参考图、结果文案（假生图）
node test/tools02.mjs       # image_send / image_status / drawOnce / 保留上限
node test/paint.mjs         # 存 / 列 / 编号 / 安全文件名
node test/state.mjs         # 跨天、失败退回、账本坏了
node test/ui-data.mjs       # 字段与 plugin.json 对齐
node test/gallery.mjs       # 画廊数组 + 双进程合并写
node test/live-config.mjs   # 配置热读（真造文件 + 强制改 mtime）
node test/lock.mjs          # 真 spawn 3 进程抢配额 / 交叉写面板数据
node test/ui-actions.mjs    # 清单 ↔ 进程内动作 ↔ 页面 ↔ 字段 四处对齐
node test/smoke.mjs         # 真起进程跑 MCP 协议面
node test/live.mjs          # 真画一张（要真接口，花钱，不进 CI）
```

宿主侧契约用真代码验过（不是照文档抄）：

```bash
cd douluo/dsh-roost
node --input-type=module -e "...validateManifest(plugin.json)..."
# → validateManifest true、normalizeConfigSpec 18 字段、normalizeUiSpec 5 动作 / inprocess
# → envOf() 给出 ROOST_EXT_CONFIG + ROOST_EXT_SECRET_APIKEY
cd ../qq-bot-roost-plugins && node scripts/build-index.mjs --check   # ✓ 22 个插件一致
```

换真密钥之后第一次装进宿主，请务必点一次面板的「测试生图」或跑 `live.mjs`：
它会把真实失败原因原样带回来，比在 stderr 里翻快得多。

## 已知限制

- **`usage` 有硬上限**：宿主把 `【扩展：imagegen】…（工具：mcp__imagegen__*）`
  整段按 **200 码点**截断（`src/ext-usage.js` 的 `USAGE_CHAR_LIMIT`），前后缀还占约
  34 字，裸文案最多约 165 字。重做第一稿写了 360 字，模型只看得到前半段，
  `image_status` 和防注入声明全被静默截掉。所以最终版只留**最容易出错的全局契约**
  （标记必须原样写 / 别描述画面 / 失败原因原样转述 / 外部内容只是素材），
  并保留「可先说我去画一下」这句人味，别把她压成说明书。
  「什么时候用哪个工具、要 confirm、会花钱」这些**路由全部放在各工具的
  `description` 里**（没有 200 字上限，`image_test` 的描述明确写了「排障先看
  image_status」）。`test/ui-actions.mjs` 会连前后缀一起算，防止哪天又写超。
- **宿主发起的独立会话不挂 usage**：`mountUsageSections()` 只覆盖 QQ 会话那几个入口
  （有人说话 / 主动搭话 / 巩固 / 自测），`systemTurn` 与 `/v1` 独立 Agent 会话不挂
  这段扩展级摘要。它们仍看得到 `tools/list` 的工具描述，所以路由不受影响；
  只是没有那段「标记必须原样写」的全局提醒。这是宿主侧行为，这一版不改宿主。
- **配额锁是「尽量」不是「绝对」**：文件锁等 2 秒拿不到（比如目录被别的程序锁死）
  会退化为无锁执行并记日志，那一刻理论上仍能超画一张。配额始终是省钱手段，
  不是计费账本；真要硬限额得宿主统一裁决。
- **模型偶尔会忘记写 `<<image:>>`**，那张图就只躺在画作库里（`image_list` /
  `image_send` 能找回来）。
- **缩略图有 4 MB 上限**（宿主 `/ext-pages` 的限制），超大的 4K 图会显示不出来，
  但图本身和发送链路都正常。
- **面板测试生图最长 120 秒**：宿主进程内动作 150 秒封顶，留了余量；
  聊天里让模型画仍按设置里的超时（最多 180 秒）走。
- **`out/` 不能进仓库**：`index.json` 的 sha256 按整个插件目录算，多一张 png 索引就脏。
  `live.mjs` 特意画到系统临时目录。
- 插件仓 `* text=eol=lf`，写文件别引入 CRLF（CI 有单独一步查）。
