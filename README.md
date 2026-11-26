<div align="center">
  <img src="icon-180.png" alt="dsh-next-reply" width="112">

# dsh-next-reply

**简体中文** | [English](README.en.md)

<img alt="许可证" src="https://img.shields.io/badge/license-MIT-1f2430?style=flat-square">
<img alt="依赖数" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
<img alt="构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
<img alt="适配内核" src="https://img.shields.io/badge/dsh-0.2.2--rc.5-2f6f4f?style=flat-square">
<img alt="额外模型调用" src="https://img.shields.io/badge/extra%20model%20calls-0-f0a441?style=flat-square">
<img alt="npm" src="https://img.shields.io/badge/npm-dsh--next--reply-cb3837?style=flat-square">

`v0.8.0` · DSH `0.2.2-rc.x` · 桌面 / Web

**每条回答下方，三条竖排的下一步。点文字填入输入框，点按钮直接发送。**

建议由主回复自身给出，**不额外调用模型**；竖排让每条能写成一整句话，不必压成四字短语。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="preview-dark.png">
  <img src="preview-light.png" width="820" alt="示意图：一条回答下方三条竖排建议，每条右侧有发送与填入两个按钮">
</picture>

</div>

---

## 💡 你能拿它做什么

建议内容由模型按当轮回答生成。因为每行独占一整行、可以换行，它通常直接是一句能发出去的话：

| 当回答是这样的 | 你很可能看到 |
|---|---|
| 给了两个方案 | 「按方案 A 继续，先不动第二步」「换成方案 B，把第一步的数据重算」 |
| 摆了一堆数据 | 「先把这张表导成 CSV 我再核对」「按 1550 nm 重算一遍，其余不动」 |
| 停在需要你拍板的地方 | 「就按这个定，接着往下做」「先不动，我要自己复核一遍」 |
| 做完了但没说下一步 | 「跑一下测试，通过后把改动提交」「先别提交，我要先看 diff」 |

## ✨ 功能

- 每轮回答结束后，在本轮动作行**上方**显示最多 3 条**竖排**建议。
- **三种点击行为**（设置 → 下一步建议）：

  | 模式 | 点文字 | 右侧按钮 |
  |---|---|---|
  | **智能**（默认） | 填入输入框光标处 | 纸飞机＝直接发送；气泡＝填入输入框 |
  | 直接发送 | 直接发送 | 无 |
  | 填入输入框 | 填入输入框 | 无 |

- **不覆盖你正在打的字**：填入走 `captureInsertion()` + `insertText()` 的一次可撤销插入；任何"发送"动作在输入框有草稿时**一律置灰**，不静默清空。
- **整行竖排、自动换行**：文字不再被省略号截断，最多保留 160 字。
- **防连点**：同一动作 + 同一句话 900 ms 内只认一次点击。
- **发送后本轮冻结**：整行换成「已发送：…」，不会再被重复点。
- **为什么没出建议**，设置页直接告诉你原因（见下）。
- 建议随主回复一起产出，**每轮零附加延迟、零附加费用**。
- 代理（子）会话不显示建议，也不会被注入格式指令。
- 颜色跟随 DSH 深浅主题；会话进行中或正在提交时全部置灰。
- 无依赖、无构建步骤；装与卸都是 `dsh plugin` 一条命令。

## 📦 安装

> **0.7.0 起本插件已从 `dsh-next-reply-chips` 改名为 `dsh-next-reply`。** 旧名不再更新；升级请先移除旧包。

从 GitHub（推荐）：

```powershell
dsh plugin --profile desktop remove dsh-next-reply-chips
dsh plugin --profile desktop add "github:Charlieeeo/dsh-next-reply"
```

或在 **设置 → 插件 → 添加插件** 里粘贴 `github:Charlieeeo/dsh-next-reply`。

从 npm：

```powershell
dsh plugin --profile desktop add dsh-next-reply
```

从本地目录：

```powershell
dsh plugin --profile desktop add "E:\\path\\to\\dsh-next-reply"
```

装完在 **设置 → 插件** 确认已启用。**主机半**改动需要重启 DSH；**浏览器半**改动只需刷新页面。

> **CLI 只负责装包。** 用 CLI 装时，`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里也要有 `"dsh-next-reply"`，否则插件路由 404、什么都不加载。设置页里的「添加插件」会替你处理这一步。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-next-reply
```

## 🖱️ 使用

装好后无需配置：下一轮回答结束，三条建议就出现在回答下方。

| 操作 | 效果 |
| --- | --- |
| 点建议文字 | 按当前模式：智能／填入模式下插入到光标处，发送模式下直接发出 |
| 点纸飞机（仅智能模式） | 直接作为你的下一条消息发出；输入框有草稿时置灰 |
| 点气泡（仅智能模式） | 插入到光标处（可撤销），不发出去 |
| 输入框里已有字 | 所有"发送"控件置灰，`title` 说明原因；填入类照常可用 |

点击行为在 **设置 → 下一步建议** 里切换，改完立即生效、无需重启。

想彻底关掉：**设置 → 插件 → dsh-next-reply** 关闭开关。这会同时移除建议、设置页、代码块隐藏层和系统提示指令，不会留下脏状态。

## ⚙️ 配置

唯一的状态是一个字符串，存在 `~/.dsh/next-reply.json`：

```json
{ "mode": "smart" }
```

`mode` 取 `smart` / `send` / `draft`，缺省 `smart`。

**升级不会重置你的选择**：0.7.x 的 `~/.dsh/next-reply.json` 里若是旧的 `{ "directSend": true|false }`，会分别折叠成 `send` / `draft`；`~/.dsh/next-reply-chips.json`（0.6.x 用的名字）和包目录里的 `config.json`（0.5 及更早）也会按序回读。老版本读到新格式时同理反向兼容。

## 🩺 为什么没出建议

设置页底部有一块「最近没有出现建议的轮次」。它读的是**主机端内存里最多 8 条**记录（重启即清空、**不落盘**），每条写明时间和原因：

| 原因 | 意思 | 怎么办 |
| --- | --- | --- |
| 回答里没有 suggest 标记 | 模型这一轮没按格式收尾 | 最常见，重开一轮即可 |
| 有标记但没有可用选项 | 标记里的内容全被清洗掉了 | 换一轮 |
| 本轮没有助手回答节点 | 这一轮还在跑，或被中断 | 等它结束 |
| 拿不到会话快照 | 内核快照结构和本插件预期不符 | 报 issue，附上原因 |

只有**最新一轮**才会记一条：整页刷新会把所有历史轮次重放一遍，八格环形缓冲塞满旧数据就什么都答不上了。

## 🧠 设计取舍

这一节记录的每一条，都是**实测撞出来之后才敢写**的，不是设计时的猜测。

### 为什么从横排药丸改成竖排

横排一行放三条，每条只能分到约 260 px，长一点就被省略号吃掉——而被吃掉的部分恰好是"这句话到底要发什么"。悬停展开只是补救，不是解法。改成竖排后每条独占一整行、可换行，模型也就能写成一整句可发的话，而不是「按方案 A 继续」这种要用户自己补全的碎片。

代价是纵向占位变大，所以列表整体收紧：行间距 6 px、文字 13 px、上下留白 10/4 px。

### 为什么加了「智能」模式，还把它设成默认

只有两个模式时，用户每换一次意图都要去设置页翻一次：想批量填入时切"填入"，想一键发出时切"发送"。而同一轮里这两种意图经常交替出现。

智能模式把两个动作并排放在每条建议右侧，点文字默认走**非破坏性**的那个（填入）。默认值必须是这个：任何"点一下就发送"的默认，都会让第一次误点的用户丢掉他正在写的半句话。

### 为什么 `turn` 要先折成数字

`turnTail` 的 owner prop 声明是 `turn: TurnLocation`——**是对象，不是数字**。第一版直接拿它与 `node.location.turn` 比较，数字永远不等于对象，于是每次匹配都失败，界面**静默**没有建议、也不报错。

现在 `turnOf()` 会把 `3` / `{turn:3}` / `{kind:'turn',turn:3}` / `{turn:{turn:3}}` 全部折成数字再比；折不出来时还有一个兜底：只认「收尾回答」，避免旧轮次重复显示。

### 为什么助手消息要按"猜不到就遍历"来读

用户消息的载荷是 `data.content` 的块数组，但**助手消息不保证是这个形状**——可能是扁平 `text`，也可能是渲染好的 markdown。第一版按用户消息的结构去读助手节点，取到空字符串，于是永远找不到标记。

现在先试已知形状（`content[].text` / `data.text` / `data.markdown`），都落空才遍历整个值，并跳过 `type`/`kind`/`role` 这类结构键——否则 `type: "text"` 这个值会被当成正文混进选项里。

### 为什么点击不用 `setDraft`

`setDraft(text)` 会**整块替换**草稿：用户打了半句话，点一下建议，那半句就没了，而且不可撤销。

现在走 `captureInsertion()` 拿一个带 `draftRev` 的选区，再 `insertText(text, span)`：一次可撤销的纯文本插入，版本对不上就返回 `false`。返回 `false` 时**不再退化成 `setDraft`**——宁可这次不生效，也不拿草稿换建议。只有输入框确实为空、且内核没有 `insertText`（老版本）时才用 `setDraft`。

### 为什么"发送"在有草稿时会拒绝

发送要 `submit()`。如果输入框里有草稿，任何"先清空再发送"的实现都是**不可撤销的删除**。所以输入框非空（或带附件）时，所有发送控件一律置灰，`title` 写明「先清空，或改用填入」。

这里的取舍是明确的：**任何「先清空再发送」的实现都是不可撤销的删除**，所以输入框非空时发送控件直接置灰，而不是替你清空。宁可这次点了没反应，也不让你丢掉正在写的字。

### 为什么助手消息要读 `data.blocks`，而且只读 `kind: 'text'`

这条是**用真实会话日志回放才发现**的，之前的单元测试全绿也没抓出来。

内核的客户端投影（`projectAssistant`）给助手步骤构造的是 `data.blocks[]`：

```js
{ status, turn, step, blocks: [{ kind: 'text' | 'reasoning' | 'tool-call', text }], time }
```

而用户消息才是 `data.content[]`。**我的读取器一开始只认 `data.content` / `data.text` / `data.markdown`——三种都不是助手消息的真实形状。** 它之所以一直能用，是靠兜底遍历**碰巧**捡到了 `blocks[].text`。

这个"碰巧"有两个真实后果：

1. 兜底遍历会把 `reasoning` 一起拼进来，推理里提到 `suggest` 就会造出**假按钮**；
2. 推理文本插在两段正文之间，会**把围栏切断**，真按钮反而消失。

内核自己的 `hasAssistantReplyContent` 明确只把 `kind === 'text'` 当回答，排除 `reasoning` 与 `tool-call`。现在读取器按同一规则写：先读 `data.blocks` 且只取 `kind: 'text'`，再退回 `content[]` / `text` / `markdown`，最后才兜底遍历。

`npm run test:real` 把这条规则跑在真实日志上（本机这个会话，165 条 assistant 消息）：

```
events whose reply text yields chips: 3
events with readable prose: 111/165
events where including reasoning WOULD change the result: 0
```

那 54 条读不出文本的逐条分类过，**全部是纯工具调用步骤**（`tool-call` 或 `reasoning+tool-call`），本来就没有正文。

### 为什么诊断不落盘

排查类功能最容易顺手写个日志文件，但这个插件的公开承诺是「唯一落盘文件是那一个 JSON」。所以诊断只进主机端内存，八条封顶，重启即空，设置页按需读。要更细的排查再开浏览器控制台的 `window.__NR_DIAG__ = true`。

### 为什么偏好不写在包目录

`dsh plugin add github:...` 会把包装进 `node_modules`。第一版把 `config.json` 写在包目录，那样一旦升级就会被覆盖，某些环境还可能只读。

现在落在 `~/.dsh/next-reply.json`。没用 `localStorage`，是因为 Web GUI 的 origin 带端口、且这个端口在每次启动时都会变（实测见过 `:52778` → `:21537` → `:32235`），浏览器域内的值会莫名复位。

### 为什么不用插件 `Config` 承载偏好

除了 `Config` 需要 `@deepseek-ai/schemastery`（`link:` 安装时解析不到），还有一个更隐蔽的坑：**写在 profile 的 `cordis.patch.yml` 里改同一 `id` 的 `config` 会被静默忽略**——profile 补丁先于插件自己的插入行应用，那时这条行还不存在。要改只能改包内的 `cordis.patch.yml` 并重启。

与其让一个开关有一半概率改了没反应，不如把它放在自己的路由上。

### 为什么坚持零依赖

- 插件 `Config` 表单需要 `@deepseek-ai/schemastery`，而 `link:` 安装的包是从**自己目录**解析裸模块，不是 profile 的 `node_modules`——表单在本地安装时根本加载不出来。
- 声明官方 `@deepseek-ai/*` 的 `peerDependencies` 有版本陷阱：范围里若没有与目标 `major.minor.patch` 同元组、且自带预发布标签的比较符，预发布版会被静默排除；而 peer 不满足会**直接阻断安装**。

所以偏好是一个普通 JSON 文件，设置面是一个 `settings.section` 页面。代价是多写了点代码，收益是从任何路径都能装。

### 为什么测试要有一个真会记住状态的 React 替身

最初的替身里 `useState` 的 setter 是空函数，于是「发送后冻结」这条测试**永远走不到那个分支**——它在断言一个从未被渲染过的路径，属于假绿灯。现在替身按 hook 槽位真正保存值，`check` 之间重置，冻结分支才真的被渲染并断言（"冻结后一个按钮都不剩"）。

## ⭐ 我们的优势

每一条都能在代码里指到具体位置，不是宣传语。

### 零额外模型调用

建议由**主回复自身**在收尾时一并产出，插件不发起任何模型请求。客户端与主机端全文搜不到 LLM 调用。

这意味着：**每轮零附加延迟、零附加费用**。一天聊 100 轮，就省下 100 次辅助调用——不需要为「猜你下一句」额外付钱，也不需要等一次串行请求。

代价说清楚：模型不按格式收尾的那一轮没有建议。我们把这个代价做成**可见的诊断**（见下），而不是靠加调用去消灭它。

### 不覆盖你正在打的字

点建议走 `captureInsertion()` + `insertText(text, span)`：一次**可撤销**的纯文本插入，带 `draftRev` 版本校验，版本对不上就返回 `false`。

版本对不上时**不退化成 `setDraft`**——宁可这次不生效，也不拿你的草稿换建议。`setDraft` 只在输入框确实为空、且内核没有 `insertText`（老版本）时才会用。

发送同理：输入框里有草稿（或带附件）时，所有发送控件**一律置灰**，`title` 写明原因。任何「先清空再发送」的实现都是不可撤销的删除，我们不这么做。

### 一个模式同时给出两种动作

每条建议右侧两个按钮：**纸飞机＝直接发送**，**气泡＝填入光标处**；点文字默认走非破坏性的「填入」。

不用为了换个意图跑一趟设置页——想批量填入还是想一键发出，同一行里都能做。默认取「填入」是因为：任何「点一下就发送」的默认，都会让第一次误点的人丢掉正在写的半句话。

### 竖排让建议写成一整句话

三条建议竖排，每条独占整行、可换行，数据上限 160 字，提示词要求「每项 8–40 个汉字」。

横排一行放三条，每条只能分到约 260px，长一点就被省略号吃掉——而被吃掉的部分恰好是「这句话到底要不要发」。竖排之后，模型能写出「先别定稿，把 Raman 那条下限从 100 dB 收紧到 95 dB 再看结论」这种可以直接发的话，而不是要你自己补全的碎片。

### 真能定位「为什么没出建议」

设置页底部有一块「最近没有出现建议的轮次」，读主机端内存里最多 8 条记录，每条写明时间与原因：

| 原因 | 意思 |
|---|---|
| 回答里没有 suggest 标记 | 模型这轮没按格式收尾（最常见） |
| 有标记但没有可用选项 | 内容全被清洗掉了 |
| 本轮没有助手回答节点 | 还在跑，或被中断 |
| 拿不到会话快照 | 内核快照结构与预期不符 |

只有**最新一轮**才记一条：整页刷新会把所有历史轮次重放一遍，八格塞满旧数据就什么都答不上。诊断**只进内存、不落盘**——插件的公开承诺是「唯一落盘文件是那一个 JSON」。

### 读的是内核的真实负载形状

助手消息的真实形状是 `data.blocks[]`（`{kind: 'text'|'reasoning'|'tool-call', text}`），不是用户消息那种 `data.content[]`。

读取时**只取 `kind: 'text'`**，与内核自己的 `hasAssistantReplyContent` 一致。这个细节很重要：把 `reasoning` 一起读进来，推理里提到 `suggest` 就会造出假按钮，推理插在两段正文之间还会把围栏切断。

这条是用**真实会话日志回放**发现的——77 项单元测试全绿也没抓出来。所以仓库里带了 `npm run test:real`，解压真实 `session.v4.jsonl.zstd` 再跑一遍读取器。

### 零依赖，从任何路径都能装

`dependencies` 和 `peerDependencies` 都是空。

这不是洁癖，是两个实际原因：插件 `Config` 表单需要 `@deepseek-ai/schemastery`，而 `link:` 安装的包从**自己目录**解析裸模块，表单根本加载不出来；声明官方 `@deepseek-ai/*` 的 peer 又有版本陷阱，预发布版会被静默排除、peer 不满足还会**直接阻断安装**。

所以偏好是一个普通 JSON 文件，设置面是一个 `settings.section` 页面。代价是多写了点代码，收益是 `dsh plugin add <任意路径>` 都能装。

### 几条工程纪律

- **77 项测试 + 2 个探针**：组件测试、配置路由探针（用临时文件，绝不碰真实偏好）、真实日志回放。
- **测试替身真会记住状态**：早期替身的 `useState` setter 是空函数，「发送后冻结」那条测试永远走不到分支——属于假绿灯。现在按 hook 槽位真正存值、每场景重置。
- **预览图由脚本从源码渲染**：`scripts/render-preview.mjs` 从 `lib/client.js` 读字号、间距、圆角、图标尺寸等 8 项，任何一项对不上就拒绝渲染。手工画的图会过期——上一版预览图就还在画早已不存在的横排药丸。
- **条目声明逐条可核对**：`scripts/awesome-entry.mjs` 把描述里的每一句对着代码验一遍（「最多 3 条」对 `MAX_CHIPS`、「零调用」对两半源码、「插入光标处」对 `captureInsertion`）。

## 🔒 数据与隐私

- **不联网**。插件不发起任何外部请求。
- **不额外调用模型**。没有辅助请求，没有把会话内容发到别处。
- 唯一的网络往返是**同源**的 `GET/POST /plugins/dsh-next-reply/config` 与 `/plugins/dsh-next-reply/diag`，前者只读写一个字符串，后者只写原因字符串与轮次号。
- 唯一的落盘文件是 `~/.dsh/next-reply.json`；诊断只在内存里。
- 不采集任何遥测。

## 🧩 兼容性

| 项 | 说明 |
| --- | --- |
| 实测内核 | DSH `0.2.2-rc.5` |
| 依赖槽位 | `conversation.chat.turnTail`、`conversation.chat.markdown.fence`、`settings.section` |
| 依赖标准 props | `useChat` / `useSession` / `useInput` / `inputActions`；缺 `useInput` 时退化成 0.6 的行为 |
| 槽位缺失时 | 那一格不渲染，其余功能照常 |
| 依赖 / peer / private | `0` / `0` / `false` |

## ⚠️ 已知限制

- 依赖模型遵守格式；**不遵守格式的那一轮没有建议**——不报错、不留空行。设置页能看到这一轮被记了原因。
- 智能模式下每条建议占一整行，三条建议在窄窗口里会比较占纵向空间。
- 输入框里已有草稿时，所有"发送"控件不可点（故意的：不覆盖你的字）。
- 用户消息里若手动粘贴 ```` ```suggest ```` 代码块，也会被同一个隐藏层吞掉。
- 子代理会话拿不到格式指令，因此它们的回答里不会出现建议。

## 🛠️ 开发

```powershell
npm test                 # 77 项组件测试 + 配置探针
node test/smoke.mjs      # 只跑组件测试
node test/probe-config.mjs  # 只跑配置路由探针（用临时文件，不碰真实偏好）
```

<details>
<summary><b>77 项测试覆盖了什么</b></summary>

| 分组 | 覆盖 |
| --- | --- |
| 主机段 | 注入 `systemPrompt`；只注册一条 section；模板含代码块标记；指令已改为 8–40 字并说明竖排 |
| 代理会话 | 根代理保留指令、子代理返回空串 |
| 偏好路由 | 注册路径与 `kind`；GET 默认 `smart`；三种模式各自落盘并可回读；未知模式 400 且不改文件；旧 `{directSend}` 载荷折叠成模式；不支持的 405 |
| 诊断路由 | POST 追加、GET 回读、时间戳格式；环形缓冲封顶 8 条；非法 `turn` 被丢弃；DELETE 405 |
| 旧值迁移 | 旧名字下的 `{directSend:false}` 折叠成 `draft` |
| 注册 | 导出 `inject=['slots']`；`turnTail` 序位 60；`settings.section` 序位 55 与中文标题；`suggest` hoc 层存在且返回 `null` |
| 布局 | 列表 `flexDirection: column`；每条一个行容器；文字 `whiteSpace: normal` 可换行、无省略号、无 260px 宽度上限 |
| 解析 | 三选项；跨块标记；无标记返回 `null`；轮次隔离；超过 3 项截断；重复与空项丢弃；`{turn:{turn}}` 形态；JSON 数组兜底；剥引号与列表符；空白折叠；不分大小写去重；长句保留；160 字截断 |
| 真实负载形状 | `data.blocks` 能读出标记；跨两个 text 块拼接；**推理块里的围栏不出按钮**；**推理不切断真围栏**；tool-call 块被忽略；只有推理时不渲染；纯工具步骤不渲染；旧 `content[]` 不回归 |
| 发送模式 | `setDraft` + `submit`；有 `insertText` 时优先走守护插入；**草稿非空时置灰且不动作**；附件也算草稿 |
| 填入模式 | 只插入不提交；有草稿时仍可用；插入被拒时**不退化成 `setDraft`**；老版本回落 `setDraft` |
| 智能模式 | 每条三个控件；点文字只填入；纸飞机发送；气泡只填入；有草稿时纸飞机置灰而文字与气泡仍可用；两个图标可访问标签与图形各不相同；设置页首项且标"推荐" |
| 守卫 | 同动作同句 900 ms 一次；文字与气泡共享冷却而发送独立；`phase` 非 `plain` 全部置灰；运行中全部置灰；**发送后整行冻结且不剩任何按钮**；填入不冻结 |
| 健壮性 | 缺 `inputActions` 不抛错且置灰；畸形快照返回 `null`；悬停反馈覆盖三种控件；设置页含诊断块；客户端默认值与主机默认值一致；测试只碰临时文件 |

</details>

调试"没出建议"：在浏览器控制台执行 `window.__NR_DIAG__ = true` 并刷新，最新一条回答下方会打印一行形状诊断（`turn`、`order` 长度、`nodes` 是否 map、尾部节点种类）。不想开控制台就看设置页底部的诊断块。

## 📜 许可

[MIT](LICENSE)
