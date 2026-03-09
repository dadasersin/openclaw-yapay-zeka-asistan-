---
title: "Diffs 工具"
summary: "只读 diff 查看器和文件渲染器（可选 plugin 工具），供智能体使用"
description: "使用可选的 Diffs plugin 将前后文本或 unified patch 渲染为 gateway 托管的 diff 视图、文件（PNG 或 PDF），或两者兼有。"
read_when:
  - 你希望智能体以 diff 形式展示代码或 markdown 编辑
  - 你需要一个可在 canvas 中展示的查看器 URL 或渲染后的 diff 文件
  - 你需要具有安全默认值的受控临时 diff 产物
x-i18n:
  source_path: tools/diffs.md
---

# Diffs

`diffs` 是一个可选的 plugin 工具，具有简短的内置系统引导和配套 skill，可将变更内容转化为只读 diff 产物供智能体使用。

它接受以下输入之一：

- `before` 和 `after` 文本
- unified `patch`

它可以返回：

- 用于 canvas 展示的 gateway 查看器 URL
- 用于消息投递的渲染文件路径（PNG 或 PDF）
- 在一次调用中同时返回两种输出

启用后，plugin 会在 system-prompt 空间中添加简洁的使用引导，并暴露一个详细的 skill 以供智能体在需要更完整说明时使用。

## 快速开始

1. 启用 plugin。
2. 使用 `mode: "view"` 调用 `diffs`，适用于 canvas 优先的流程。
3. 使用 `mode: "file"` 调用 `diffs`，适用于聊天文件投递流程。
4. 使用 `mode: "both"` 调用 `diffs`，同时获取两种产物。

## 启用 plugin

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
      },
    },
  },
}
```

## 禁用内置系统引导

如果你想保持 `diffs` 工具启用但禁用其内置的 system-prompt 引导，将 `plugins.entries.diffs.hooks.allowPromptInjection` 设为 `false`：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
      },
    },
  },
}
```

这会阻止 diffs plugin 的 `before_prompt_build` hook，同时保留 plugin、工具和配套 skill 可用。

如果你想同时禁用引导和工具，请改为禁用 plugin。

## 典型智能体工作流

1. 智能体调用 `diffs`。
2. 智能体读取 `details` 字段。
3. 智能体执行以下操作之一：
   - 使用 `canvas present` 打开 `details.viewerUrl`
   - 使用 `message` 工具的 `path` 或 `filePath` 发送 `details.filePath`
   - 同时执行以上两种操作

## 输入示例

前后对比模式：

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

Patch 模式：

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## 工具输入参考

除特别注明外，所有字段均为可选：

- `before`（`string`）：原始文本。当省略 `patch` 时，需与 `after` 一起提供。
- `after`（`string`）：更新后的文本。当省略 `patch` 时，需与 `before` 一起提供。
- `patch`（`string`）：unified diff 文本。与 `before` 和 `after` 互斥。
- `path`（`string`）：前后对比模式下的显示文件名。
- `lang`（`string`）：前后对比模式下的语言覆盖提示。
- `title`（`string`）：查看器标题覆盖。
- `mode`（`"view" | "file" | "both"`）：输出模式。默认值取 plugin 默认配置 `defaults.mode`。
- `theme`（`"light" | "dark"`）：查看器主题。默认值取 plugin 默认配置 `defaults.theme`。
- `layout`（`"unified" | "split"`）：diff 布局。默认值取 plugin 默认配置 `defaults.layout`。
- `expandUnchanged`（`boolean`）：当完整上下文可用时展开未更改部分。仅限单次调用选项（不是 plugin 默认键）。
- `fileFormat`（`"png" | "pdf"`）：渲染文件格式。默认值取 plugin 默认配置 `defaults.fileFormat`。
- `fileQuality`（`"standard" | "hq" | "print"`）：PNG 或 PDF 渲染的质量预设。
- `fileScale`（`number`）：设备缩放覆盖（`1`-`4`）。
- `fileMaxWidth`（`number`）：最大渲染宽度，单位为 CSS 像素（`640`-`2400`）。
- `ttlSeconds`（`number`）：查看器产物 TTL，单位为秒。默认 1800，最大 21600。
- `baseUrl`（`string`）：查看器 URL origin 覆盖。必须为 `http` 或 `https`，不含 query/hash。

验证与限制：

- `before` 和 `after` 各最大 512 KiB。
- `patch` 最大 2 MiB。
- `path` 最大 2048 字节。
- `lang` 最大 128 字节。
- `title` 最大 1024 字节。
- Patch 复杂度上限：最多 128 个文件，总计 120000 行。
- 同时提供 `patch` 和 `before` 或 `after` 会被拒绝。
- 渲染文件安全限制（适用于 PNG 和 PDF）：
  - `fileQuality: "standard"`：最大 8 MP（8,000,000 渲染像素）。
  - `fileQuality: "hq"`：最大 14 MP（14,000,000 渲染像素）。
  - `fileQuality: "print"`：最大 24 MP（24,000,000 渲染像素）。
  - PDF 另有最多 50 页的限制。

## 输出 details 约定

工具在 `details` 下返回结构化元数据。

创建查看器的模式共享字段：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`

渲染 PNG 或 PDF 时的文件字段：

- `filePath`
- `path`（与 `filePath` 值相同，用于 message 工具兼容）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

模式行为摘要：

- `mode: "view"`：仅返回查看器字段。
- `mode: "file"`：仅返回文件字段，不创建查看器产物。
- `mode: "both"`：返回查看器字段和文件字段。如果文件渲染失败，查看器仍会返回并附带 `fileError`。

## 折叠的未更改区域

- 查看器可以显示类似 `N unmodified lines` 的行。
- 这些行上的展开控件是有条件的，并非对每种输入都保证存在。
- 当渲染的 diff 具有可展开的上下文数据时，展开控件会出现，这在前后对比输入中很常见。
- 对于许多 unified patch 输入，被省略的上下文主体在解析后的 patch hunk 中不可用，因此该行可能没有展开控件。这是预期行为。
- `expandUnchanged` 仅在存在可展开上下文时生效。

## 插件默认配置

在 `~/.openclaw/openclaw.json` 中设置 plugin 级默认值：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          defaults: {
            fontFamily: "Fira Code",
            fontSize: 15,
            lineSpacing: 1.6,
            layout: "unified",
            showLineNumbers: true,
            diffIndicators: "bars",
            wordWrap: true,
            background: true,
            theme: "dark",
            fileFormat: "png",
            fileQuality: "standard",
            fileScale: 2,
            fileMaxWidth: 960,
            mode: "both",
          },
        },
      },
    },
  },
}
```

支持的默认值：

- `fontFamily`
- `fontSize`
- `lineSpacing`
- `layout`
- `showLineNumbers`
- `diffIndicators`
- `wordWrap`
- `background`
- `theme`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`
- `mode`

显式工具参数会覆盖这些默认值。

## 安全配置

- `security.allowRemoteViewer`（`boolean`，默认 `false`）
  - `false`：拒绝非回环地址对查看器路由的请求。
  - `true`：如果 token 化路径有效，则允许远程查看器。

示例：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          security: {
            allowRemoteViewer: false,
          },
        },
      },
    },
  },
}
```

## 产物生命周期与存储

- 产物存储在临时子目录：`$TMPDIR/openclaw-diffs`。
- 查看器产物元数据包含：
  - 随机产物 ID（20 个十六进制字符）
  - 随机 token（48 个十六进制字符）
  - `createdAt` 和 `expiresAt`
  - 存储的 `viewer.html` 路径
- 未指定时，默认查看器 TTL 为 30 分钟。
- 最大可接受查看器 TTL 为 6 小时。
- 清理在产物创建后伺机执行。
- 过期产物会被删除。
- 元数据缺失时，回退清理会移除超过 24 小时的陈旧目录。

## 查看器 URL 与网络行为

查看器路由：

- `/plugins/diffs/view/{artifactId}/{token}`

查看器资源：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL 构建行为：

- 如果提供了 `baseUrl`，经严格验证后使用。
- 未提供 `baseUrl` 时，查看器 URL 默认为回环地址 `127.0.0.1`。
- 如果 gateway 绑定模式为 `custom` 且设置了 `gateway.customBindHost`，则使用该主机。

`baseUrl` 规则：

- 必须以 `http://` 或 `https://` 开头。
- 拒绝 query 和 hash。
- 允许 origin 加可选的 base path。

## 安全模型

查看器加固：

- 默认仅限回环地址。
- 带有严格 ID 和 token 验证的 token 化查看器路径。
- 查看器响应 CSP：
  - `default-src 'none'`
  - script 和资源仅来自 self
  - 无出站 `connect-src`
- 启用远程访问时的未命中限流：
  - 60 秒内 40 次失败
  - 60 秒锁定（`429 Too Many Requests`）

文件渲染加固：

- 截图浏览器请求路由默认拒绝。
- 仅允许来自 `http://127.0.0.1/plugins/diffs/assets/*` 的本地查看器资源。
- 外部网络请求被阻止。

## 文件模式的浏览器要求

`mode: "file"` 和 `mode: "both"` 需要兼容 Chromium 的浏览器。

解析顺序：

1. OpenClaw 配置中的 `browser.executablePath`。
2. 环境变量：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. 平台命令/路径发现回退。

常见错误提示：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

通过安装 Chrome、Chromium、Edge 或 Brave，或设置上述可执行路径选项之一来解决。

## 故障排除

输入验证错误：

- `Provide patch or both before and after text.`
  - 同时提供 `before` 和 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.`
  - 不要混用输入模式。
- `Invalid baseUrl: ...`
  - 使用 `http(s)` origin 加可选路径，不含 query/hash。
- `{field} exceeds maximum size (...)`
  - 减小 payload 大小。
- 大型 patch 被拒绝
  - 减少 patch 文件数或总行数。

查看器可访问性问题：

- 查看器 URL 默认解析为 `127.0.0.1`。
- 对于远程访问场景，可以：
  - 在每次工具调用中传递 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`
- 仅在确实需要外部查看器访问时启用 `security.allowRemoteViewer`。

未更改行没有展开按钮：

- 当 patch 输入不携带可展开上下文时可能出现。
- 这是预期行为，不代表查看器故障。

产物未找到：

- 产物因 TTL 过期。
- Token 或路径已更改。
- 清理移除了陈旧数据。

## 操作建议

- 本地 canvas 交互式审查优先使用 `mode: "view"`。
- 需要附件的出站聊天频道优先使用 `mode: "file"`。
- 除非部署确实需要远程查看器 URL，否则保持 `allowRemoteViewer` 禁用。
- 为敏感 diff 设置较短的显式 `ttlSeconds`。
- 非必要时避免在 diff 输入中发送机密信息。
- 如果你的频道对图片压缩严重（例如 Telegram 或 WhatsApp），优先使用 PDF 输出（`fileFormat: "pdf"`）。

Diff 渲染引擎：

- 由 [Diffs](https://diffs.com) 提供支持。

## 相关文档

- [工具概览](/tools)
- [插件](/tools/plugin)
- [Browser](/tools/browser)
