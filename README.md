# dsh-history-up

English version: [README.en.md](README.en.md) · 技术实现：[TECHNICAL.md](TECHNICAL.md)

一个 DeepSeek Harness 插件：记录每个会话里你提交过的输入，支持用 <kbd>↑</kbd> 方向键逐条回溯，也可以用 <kbd>/</kbd> 菜单挑一条填进输入框。按会话隔离的 shell 式输入历史。

## 功能

- **记录**。每个会话中你提交的每一条提示词都会进入该会话的历史。注入的上下文（`goal`、`schedule`、子智能体消息、工具通知等）不会被记录。
- **回溯**。在输入框中：
  - <kbd>↑</kbd> 从最近一条往前回溯。
  - <kbd>↓</kbd> 往后走；越过最新一条后，恢复你开始回溯前原本输入的内容。
  - 先输入了半行文字时，会按它作为前缀过滤列表，行为与 `fish` 一致。
- **菜单挑选**。敲 <kbd>/</kbd> 打开命令菜单，选「历史输入」展开二级列表，挑一条直接填进输入框。
- **按会话隔离**。切换到另一个会话，回溯的就是那个会话的历史。

## 使用

### 方向键回溯

清空输入框，连按 <kbd>↑</kbd> 即可依次回显上一条、上一条……；到最旧一条后再按不会让光标乱跳。<kbd>↓</kbd> 往回走，走过最新一条时恢复你原来的输入。

### 菜单挑选

1. 敲 <kbd>/</kbd>，菜单里出现「历史输入」这一组（带图标）。
2. 点它或按回车展开**第二级**——本会话提交过的提示词，**最新的在最上面**。下钻后顶部有「历史输入」面包屑，点它回到第一级。
3. 选中一条，直接填进输入框，再按回车发送。

第二级最多显示 20 条；每条只显示首行（超过 72 个字符以 `…` 截断），其余行显示在副标题。

### 行为细节

| 场景 | 结果 |
|---|---|
| 光标在第一行 | <kbd>↑</kbd> 回溯历史 |
| 光标在第二行及以下 | <kbd>↑</kbd> 移动光标，与 shell 一致 |
| 斜杠命令补全打开（`/…`） | 方向键归补全菜单所有 |
| 按住修饰键，或长按不放 | 编辑器自身行为不受影响 |
| 回溯途中你又改了输入框 | 回溯重新开始，并按你现在的输入过滤 |
| 只发送了图片/文件的提示词 | 不记录——没有可回溯的纯文本 |
| 发送失败的提示词 | 不记录；此时草稿会被恢复，重发即入历史 |
| 从其他会话分叉（fork）而来 | 显示分叉点之前父会话的提示词——因为它们确实在该会话历史里 |

## 配置

插件详情页里可以改：侧边栏 **Plugins** → 点开本插件 → 点 `dsh-history-up` 那一行。

| 设置 | 类型 | 默认 | 范围 | 含义 |
|---|---|---|---|---|
| `maxEntries` | 整数 | `200` | 1–5000 | 每个会话保留的提示词条数，超出的从最早一条开始丢弃 |

改完点保存。**需要重启 Harness 才生效。**

也可以直接改 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-history-up
      name: '@invoker-bandit/dsh-history-up'
      config:
        maxEntries: 200
```

> 详情页表单对本插件是自绘的。实现上有几个必须遵守的约束（`plugins.row.config` 槽位、`.volatile()`、cell 读取），改代码前请先看 [TECHNICAL.md](TECHNICAL.md#配置表单的三个坑)。

## 界面语言

面板里的标题与说明默认显示**中文**。界面语言是英文时显示英文。

## 安装

包名：`@invoker-bandit/dsh-history-up`（[npm](https://www.npmjs.com/package/@invoker-bandit/dsh-history-up)）。

### 方式一：从 npm 安装（推荐）

侧边栏 **Plugins** 面板 → 添加插件 → 在「包名或地址」里填：

```
@invoker-bandit/dsh-history-up
```

装完后在列表里启用。若提示需要重启，请重启 Harness。

### 方式二：从本地目录安装

还没发布、或你想装自己的改动时，走这条路。侧边栏 **Plugins** 面板 → 添加插件 → 填本目录的**绝对路径**：

```
/absolute/path/to/dsh-history-up
```

> **用本地路径安装时，先在插件目录里跑一次 `npm install`。** `install_bundle` 只把目录以 `link:` 挂进 profile，**不会**安装它自己的 `dependencies`；缺这一步会报 `Cannot find package 'zod'`，控制台出现 `1 entry did not activate dsh-history-up`。
>
> 从 npm 安装则不需要这步——依赖会随包一起正常解析。
>
> 单测全绿不能证明这一条：测试用的是 `test/setup.mjs` 里的替身依赖。

### 其它说明

- **不要手工编辑 profile 的 `package.json` 或 `cordis.patch.yml`**，不要在 `$DSH_HOME` 下建包，也不要在 profile 目录里跑 `pnpm`——安装流程会完成这些步骤。
- 卸载：在界面中移除即可。
- 本插件没有声明 `dsh.peers`，安装时因此跳过 DSH 版本兼容性预检。代价是升级 DSH 后不会收到兼容性预警。

## 故障排查

**控制台报 `1 entry did not activate dsh-history-up`。**
本地路径安装时漏了 `npm install`，`node_modules` 缺失。在插件目录里补一次再重启 Harness。

**菜单里没有「历史输入」，或没有图标。**
客户端代码没重新加载。刷新页面；仍然不行就在面板里移除后重装一次，再重启 Harness。

**改了 `maxEntries` 但没生效。**
需要重启 Harness。替换已安装的包要新的 JavaScript 模块代次。

**配置输入框是灰的、点不动。**
说明宿主没有把这一行的配置暴露给页面，值暂时只能在 `cordis.patch.yml` 里改。详见 [TECHNICAL.md](TECHNICAL.md#配置表单的三个坑)。

## 开发

```bash
node test/run.mjs
```

54 项单元测试，不需要浏览器。覆盖范围与替身说明见 [TECHNICAL.md](TECHNICAL.md#测试)。

## 后续可做

- 用 `ctx.shortcuts.registerFixed({ code: 'ArrowUp' })` 注册一条固定快捷键，让该绑定出现在快捷键参考面板中。
- 在回溯过程中于 dock 显示当前位置（如 `3 / 12`）。
