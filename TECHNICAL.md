# dsh-history-up 技术实现

用户文档见 [README.md](README.md)（英文 [README.en.md](README.en.md)）。本文只讲机制与取舍。

## 架构

分两半，各走一条加载路径：

| 半部 | 文件 | 装载方式 |
|---|---|---|
| Host | `index.js` | Loader 导入，**需要重启**才有新的模块代次 |
| Client | `client.js` | 浏览器经 module loader 拉取，刷新页面即可 |

这个错位是本项目调试时最大的时间黑洞：改 `client.js` 刷新就能看到，改 `index.js` 必须重启。排查"我明明改了却没变化"时，先确认运行中的进程加载的是哪一代。

**只有 `index.js` 的投影是数据源。** `client.js` 从不自行折叠日志事件，它只读服务端投影、只往输入框写草稿。历史因此在重载后、以及冷读（无缓存）时都从日志重建，浏览器从未见过某次提交也不影响。

## 记录（Host）

Host 注册一个键为 `inputHistory` 的 `sessionProjections` 单元，折叠已提交的 Session 事件。

**三个过滤条件缺一不可：**

| 条件 | 排除掉什么 |
|---|---|
| `type === 'user/message'` | 工具调用、生命周期等所有其它事件 |
| `surfaceOp === 'append'` | 模型可见 surface 刻意遮蔽被替换区间，替换副本不是新提示词 |
| `data.source.kind === 'user'` | `goal`、`schedule`、`subagent-settled`、`agent-message` 等注入上下文 |

**为什么用日志而不是本地状态**：Session 日志是唯一真相源。一次从未送达模型的输入本就不属于这个会话，所以「发送失败不记录」是自然结果，而不是特例。另一种做法是额外抓浏览器本地的提交回显让失败输入也保留——那要维护第二份客户端私有状态，重载后可能与日志不一致，本插件刻意不这么做。

**引用稳定性**是刻意的：每条不相关的日志事件都返回**同一个 state 引用**（`Object.is` 命中），让注册表跳过后续全部视图计算。`apply` 因此必须是纯函数、且不改动传入的 state。

**行数上限**在折叠时就截断（`entries.slice(-maxEntries)`），不是渲染时；否则超出部分会一直留在 checkpoint 里。

## 方向键（Client）

输入框是宿主自有的 Lexical 编辑器，它**不发布**任何编辑器句柄、ref 或命令注册，并且刻意把未声明的按键让给编辑器。所以按键观察走 `ctx.shortcuts.observeFixedInput()`——一个文档化的、面向功能插件的钩子，返回焦点 DOM 元素与一个 `consume()`。

它在 `window` 的冒泡阶段，**晚于**编辑器；但需要抑制的光标移动是默认动作，只在 dispatch 完成后才发生，而编辑器的 ArrowUp 处理器在没有 trigger 菜单打开时不调 `preventDefault`——所以 `consume()` 来得及。

**会话路由**照搬 composer 包自己的 stop-shortcut：最近的 `data-conversation-region` 祖先必须是 composer 座位、必须在 `data-conversation-session` 体内、且按键不能来自审批界面、内嵌 frame、终端或 inert 内容。

观察器是全局的，它碰的东西全是按会话的，所以用一个模块级 `bridges: Map<sessionId, bridge>` 搭桥：dock 条目挂载期间发布自己的 handler，观察器把按键路由到拥有该会话的那个条目。

**dock 条目不渲染任何内容**——这是个快捷键功能，dock 是一条很窄的横带，加说明文字只会是噪音。

## `/history` 两级菜单

这是纯客户端功能，注册在 `ctx.inputTriggers` 上。

### 为什么是 input-trigger source，不是命令

三条都是宿主强制的：

1. **图标**。菜单里其它带图标的行（文件、目标、计划、反馈）全是 input-trigger source。整个已发布安装里 `commandUi.register`（contribution）**一次都没被调用过**，只有 `decorate`（5 处）。命令行的渲染分支是 `builtinRowFace(c, t) ?? { description: c.description }`——第三方命令既没有 `label` 也没有 `icon`，这正是"缺图标"的直接原因。
2. **二级菜单**。只有 source 有 `drill`：

   > The row offers a drill action beside the settling pick: Tab or the row's chevron refines the query in place (directory descent) instead of resolving the candidate.

3. **不能同时是 host 命令**。`dsh-client-ui-commands` 合成候选时，`seen.has(contribution.name)` 会**直接抛错**。`/history` 一旦既是 host 命令又想要客户端能力，整个 `/` 菜单会炸。所以 `index.js` 不再注册 `/history`，只保留投影。

> 代价：host 端不再有 `/history`，任何非桌面端或脚本化的"列出历史"能力随之消失。桌面 UI 不需要。

### 下钻协议

权威形状来自官方 `dsh-client-ui-reference` 的目录下钻：

```js
if (directory && action === 'drill') return { text: value.mention, continue: true }
```

`continue: true` 让 input-trigger 保持触发符存活，`drilled` 置位，菜单重新取数。

两条路都能进第二级，本插件两条都留：

| 操作 | 路径 |
|---|---|
| 点行 / 按回车 | `onPick` 返回 `{ text: '/history', continue: true }` → 触发符存活 → `candidates` 看到 `query === 'history'` |
| 点箭头 / 按 <kbd>Tab</kbd> | `action === 'drill'` → `drilled` 置位 → `candidates` 看到 `req.drilled` |

只有光秃秃敲一个 `/` 时才显示第一级。`header()` 只在下钻时返回面包屑，点它经 `action: 'drill'` 回到第一级。

**写入走管道**：`onPick` 返回 `{ text }`，由 input-trigger 通过 `slash/input-insert-text` 事件写入草稿。source 自己**不碰** composer，所以"选中一条"和"↑ 键回溯"天然一致。

**每行一个 `value`**（`root` / `entry:<seq>`），`onPick` 据此分派；未知值返回 `undefined` 而不是猜。

### 图标

`HistoryIcon`（上箭头）和 `HistoryEntryIcon`（回转箭头）都是本插件自己画的，只吃 `{ size, className }`，颜色继承 `currentColor`。

**没有** import `@deepseek-ai/dsh-client-ui-primitives`——`practices.md` 明令禁止加载任何 Harness Client 包（这些图标随时会变，且无类型检查）。所以 `icon` 字段虽然声明为 `ComponentType<IconProps>`，这里传的是自己写的组件。

## 配置表单的三个坑

想让某一行在插件详情页里可编辑，有三处必须同时满足。少任何一处，输入框就是灰的（**但不会报错**）。

### 坑一：`Config` 本身不够

`dsh-client-ui-plugin-manager` 判断某行「可配置」的方式**只有一条**：Client 有没有往 `plugins.row.config` 槽位注册一个 key 为 `<包名>#<行 id>` 的条目。

```js
has: (row) => ledger.rows.has(rowConfigKey(pkg.name, row.rowId))
```

宿主**没有任何**通用桥接把 `Config` 自动变成表单。`dsh-session-log-export` 同样声明了 `Config`，它的详情页里也没有表单。

所以表单是本插件自己画的（`MaxEntriesConfig`）：

- key 必须是 `@invoker-bandit/dsh-history-up#dsh-history-up`，行 id 就是 `cordis.patch.yml` 里那个 `id`。
- 页面把 `form`（`ConfigPageForm`）作为 prop 传进来。`form` **可能整个是 `undefined`**——宿主只有在设置镜像把这一行列为已暴露命名空间时才传。表单对这种情况降级提示"值只能在 `cordis.patch.yml` 里改"，而不是抛异常。
- 读用 `form.state`，存用 `form.mutate(ops, revision)`，并带上读到的 `revision` 做并发栅栏。
- 样式只用主题 token，不 import 任何包。

### 坑二：字段必须 `.volatile()`

`dsh-settings` 用 `volatileForm` 折叠每个 schema 决定哪些条目可编辑：

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)   // volatile → 保留
  if (schema.type === "object") { /* 只递归 object 子字段 */ }
  // 普通标量 → 隐式返回 undefined
}
```

一个"全是普通标量"的 `Config` 会折成空对象 → **整个命名空间被丢掉** → 页面不传 `form` → 控件永久禁用。官方可编辑设置全都标了（`dsh-client-ui-theme` 的 `fontSize` 与本插件同形）。

### 坑三：`.volatile()` 字段解析出来是 cell

必须 `config.maxEntries.get()` 读，和 `dsh-client-ui-theme` 的 `config.fontSize.get()` 一样。

```js
// 实际拿到的
maxEntries: { get: [Function], Symbol(cosmokit.volatile.write): [Function] }
```

直接读 `config.maxEntries` 拿到的是对象，`Number()` 得到 `NaN`，上限被**静默**钉死在默认值、用户设置完全不起作用。`readMaxEntries` 因此同时兼容 cell 与裸标量。

> 这三个坑都是"静默失败"：没有异常、没有警告，只有控件变灰或设置不生效。改这块前先跑那三条回归测试。

## 依赖：本地路径安装要自己装，npm 安装不用

从 **npm** 安装时依赖随包正常解析，无需任何额外操作。

从**本地路径**安装时必须先在插件目录跑 `npm install`。安装器只把目录以 `link:` 挂进 profile，**不会**安装它自己的 `dependencies`；Node 解析符号链接的真实路径，于是从 `index.js` 出发的解析链走的是 workspace 那一侧——profile 的 `node_modules` 里没有本插件的依赖。缺这一步时 Host 导入入口抛 `Cannot find package 'zod'`，控制台报 `1 entry did not activate dsh-history-up`。

两个真实依赖：`zod`（投影 schema）与 `@deepseek-ai/schemastery`（`Config`）。

## 发布到 npm

`files` 白名单里**必须**有 `cordis.patch.yml`——`dsh.bundle.patch` 指向它，漏掉的话发出去的包根本不是 bundle，安装器会以"没有声明组合包"拒收。npm 只自动附带 `README*`、`LICENSE`、`package.json`，所以 `TECHNICAL*.md` 也要显式列出。

包名一旦发布就永久占用，不能改名或删除后复用。

改包名时要同步改三处：`package.json` 的 `name`、`cordis.patch.yml` 里那一行的 `name`、以及 `client.js` 中注册 slot 用的 key（`<包名>#<行 id>`）——`configure.has(row)` 靠这个字符串匹配，改漏了配置入口会静默消失。

## locale 必须嵌在 `meta` 下

Loader 读的是 `parsed.meta.title`（`dsh-app-boot`）：

```json
{ "meta": { "title": "历史输入", "description": "…" } }
```

写成扁平的 `{"title", "description"}` 会被**静默忽略**——标题回落到包名、说明回落到 `package.json`。两者都设为中文，因为 `package.json` 的 `description` 是两种语言都缺失时的最终回落。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | Bundle 清单：`dsh.bundle.patch`、`icon`、`dsh.client` |
| `cordis.patch.yml` | 插入那一行 Host 插件 |
| `index.js` | Host 半部：`inputHistory` 投影 + `Config` |
| `client.js` | Client 半部：dock 条目、方向键观察器、`/history` source、配置表单 |
| `locale/en.json`、`locale/zh.json` | 面板标题与描述 |
| `icon.svg` | 面板图标 |
| `test/` | 单元测试及其运行器（不随 bundle 发布） |

## 测试

```bash
node test/run.mjs
```

54 项，不需要浏览器、不需要 `node_modules`。`test/setup.mjs` 为 `zod` 和 `@deepseek-ai/schemastery` 各准备一个替身。

**schemastery 那个替身刻意复刻了真实行为**——边界、默认值、报错措辞、`volatile()` 标记，以及 volatile 字段的 cell 包装。这不是洁癖：三个配置坑里有两个**只**因为替身逼真才被测出来。早期替身既没有 `volatile()` 也不包 cell，于是"字段没标 volatile"和"忘记 `.get()`"两个真 bug 全都测不出来。

- `test/host-fold.test.mjs`：合成 Session 事件驱动折叠（记录、注入上下文、surface 替换、条数上限、引用稳定性、畸形输入），覆盖 `Config`（默认值、范围拒绝、配置值传到折叠、volatile 标记、宿主 volatile 折叠存活、原生 schema 识别、cell 解包），外加"不得注册 host 命令"。
- `test/client-recall.test.mjs`：用极小的 hook 框架和假元素树运行**真实的 `client.js`**，覆盖回溯走位、前缀过滤、首行规则、修饰键/长按/输入法组字/弹窗防护、会话路由、卸载清理，`/history` 的两级 source（图标、drill、面包屑、倒序、20 条上限、截断与副标题、空会话、取消信号、选中写入、未知值拒绝），以及配置表单（读宿主值、保存带 revision 栅栏、越界不可存、`form` 缺失/只读时降级、summary 视图）。

> 测试替身赶不上真实包时，**拿真实包验证**。本项目里"提交成功但行为不对"的两次根因，都是靠 `cd $DSH_PROFILE_DIR && node -e "import('@invoker-bandit/dsh-history-up')"` 才定性的。

## 验证状态

**已通过单元测试。** 但 bundle 在真实浏览器里的表现只能由使用者确认——本项目的编写会话没有 `plugin_manager` 和 `cordis_inspect_query` 工具，无法自查。逐项确认清单见 [README.md](README.md#故障排查)。

## 已知取舍

- **`/history` 只有客户端。** 见上文"为什么是 input-trigger source"。
- **替换已安装的包需要重启。** `slot id` 没变不代表浏览器代码已更新。
- **没有 `dsh.peers`。** 换来安装时跳过版本预检，代价是升级 DSH 后没有兼容性预警。
