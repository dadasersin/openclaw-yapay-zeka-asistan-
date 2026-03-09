---
read_when:
  - 想在智能体中分析 PDF 文档
  - 需要了解 pdf 工具的参数和限制
  - 调试原生 PDF 模式和提取 fallback 模式
summary: 分析一个或多个 PDF 文档，支持原生 provider 模式和提取 fallback 模式
title: PDF 工具
x-i18n:
  source_path: tools/pdf.md
---

# PDF 工具

`pdf` 工具用于分析一个或多个 PDF 文档并返回文本。

快速概览：

- 对 Anthropic 和 Google model provider 使用原生 provider 模式。
- 对其他 provider 使用提取 fallback 模式（先提取文本，需要时再提取页面图片）。
- 支持单个（`pdf`）或多个（`pdfs`）输入，每次调用最多 10 个 PDF。

## 可用性

该工具仅在 OpenClaw 能为智能体解析到支持 PDF 的 model 配置时才会注册：

1. `agents.defaults.pdfModel`
2. fallback 到 `agents.defaults.imageModel`
3. 根据可用认证信息，fallback 到最佳 provider 默认值

如果无法解析到可用 model，`pdf` 工具不会暴露。

## 输入参考

- `pdf`（`string`）：单个 PDF 路径或 URL
- `pdfs`（`string[]`）：多个 PDF 路径或 URL，总计最多 10 个
- `prompt`（`string`）：分析提示词，默认 `Analyze this PDF document.`
- `pages`（`string`）：页码过滤，如 `1-5` 或 `1,3,7-9`
- `model`（`string`）：可选的 model 覆盖（`provider/model`）
- `maxBytesMb`（`number`）：每个 PDF 的大小上限（MB）

输入说明：

- `pdf` 和 `pdfs` 会在加载前合并并去重。
- 如果未提供 PDF 输入，工具会报错。
- `pages` 按 1 开始的页码解析，去重、排序，并限制在配置的最大页数范围内。
- `maxBytesMb` 默认为 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支持的 PDF 引用方式

- 本地文件路径（支持 `~` 展开）
- `file://` URL
- `http://` 和 `https://` URL

引用说明：

- 其他 URI scheme（例如 `ftp://`）会被拒绝，返回 `unsupported_pdf_reference`。
- 在 sandbox 模式下，远程 `http(s)` URL 会被拒绝。
- 启用 workspace-only 文件策略时，超出允许根目录的本地文件路径会被拒绝。

## 执行模式

### 原生 provider 模式

原生模式用于 provider `anthropic` 和 `google`。
工具将原始 PDF 字节直接发送到 provider API。

原生模式限制：

- 不支持 `pages` 参数。如果设置了该参数，工具会返回错误。

### 提取 fallback 模式

Fallback 模式用于非原生 provider。

流程：

1. 从选定页面提取文本（最多 `agents.defaults.pdfMaxPages` 页，默认 `20`）。
2. 如果提取的文本长度低于 `200` 字符，将选定页面渲染为 PNG 图片并包含在内。
3. 将提取的内容加上 prompt 发送到选定的 model。

Fallback 细节：

- 页面图片提取使用 `4,000,000` 的像素预算。
- 如果目标 model 不支持图片输入且没有可提取的文本，工具会报错。
- 提取 fallback 模式需要 `pdfjs-dist`（图片渲染还需要 `@napi-rs/canvas`）。

## 配置

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

详见 [配置参考](/gateway/configuration-reference)。

## 输出详情

工具在 `content[0].text` 中返回文本，在 `details` 中返回结构化元数据。

常见 `details` 字段：

- `model`：解析后的 model 引用（`provider/model`）
- `native`：原生 provider 模式为 `true`，fallback 模式为 `false`
- `attempts`：成功前失败的 fallback 尝试次数

路径字段：

- 单个 PDF 输入：`details.pdf`
- 多个 PDF 输入：`details.pdfs[]`，包含 `pdf` 条目
- sandbox 路径重写元数据（如适用）：`rewrittenFrom`

## 错误行为

- 缺少 PDF 输入：抛出 `pdf required: provide a path or URL to a PDF document`
- PDF 数量过多：在 `details.error = "too_many_pdfs"` 中返回结构化错误
- 不支持的引用 scheme：返回 `details.error = "unsupported_pdf_reference"`
- 原生模式下使用 `pages`：抛出明确的 `pages is not supported with native PDF providers` 错误

## 示例

单个 PDF：

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

多个 PDF：

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

使用页码过滤和 fallback model：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```
