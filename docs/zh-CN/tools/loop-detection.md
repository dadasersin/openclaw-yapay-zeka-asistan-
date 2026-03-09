---
read_when:
  - 用户报告智能体重复执行工具调用而卡住
  - 需要调整重复调用保护机制
  - 正在编辑智能体工具/运行时策略
summary: 如何启用和调整检测重复工具调用循环的 guardrail
title: 工具循环检测
description: 配置可选的 guardrail 以防止重复或停滞的工具调用循环
x-i18n:
  source_path: tools/loop-detection.md
---

# 工具循环检测（Tool-loop detection）

OpenClaw 可以防止智能体陷入重复的工具调用模式。
该防护功能**默认关闭**。

仅在需要时启用，因为严格的设置可能会阻止合法的重复调用。

## 为什么需要这个功能

- 检测没有进展的重复序列。
- 检测高频无结果循环（相同工具、相同输入、重复错误）。
- 检测已知 polling 工具的特定重复调用模式。

## 配置块

全局默认值：

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

Per-agent 覆盖（可选）：

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### 字段说明

- `enabled`：主开关。`false` 表示不执行 loop detection。
- `historySize`：保留用于分析的最近工具调用数量。
- `warningThreshold`：将模式分类为 warning 的阈值。
- `criticalThreshold`：阻止重复循环模式的阈值。
- `globalCircuitBreakerThreshold`：全局无进展 circuit breaker 阈值。
- `detectors.genericRepeat`：检测重复的相同工具 + 相同参数模式。
- `detectors.knownPollNoProgress`：检测已知的无状态变化的 polling 模式。
- `detectors.pingPong`：检测交替的 ping-pong 模式。

## 推荐设置

- 先以 `enabled: true` 启用，保持默认值不变。
- 保持阈值顺序为 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`。
- 如果出现误报：
  - 提高 `warningThreshold` 和/或 `criticalThreshold`
  - （可选）提高 `globalCircuitBreakerThreshold`
  - 仅禁用导致问题的 detector
  - 减小 `historySize` 以降低历史上下文的严格程度

## 日志和预期行为

当检测到循环时，OpenClaw 会报告 loop 事件，并根据严重程度阻止或抑制下一个工具调用周期。
这可以保护用户免受失控的 token 消耗和锁死，同时保留正常的工具访问。

- 优先使用 warning 和临时抑制。
- 仅在重复证据累积时才升级处理。

## 注意事项

- `tools.loopDetection` 会与 agent 级别的覆盖配置合并。
- Per-agent 配置完全覆盖或扩展全局值。
- 如果没有配置，guardrail 保持关闭状态。
