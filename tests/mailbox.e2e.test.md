# mailbox.e2e.test.ts 伴生澄清文档

## 1. 技术设计要点与总结

- **测试定位**: 端到端集成测试文件, 验证 `world-bus-mailbox` (`attachMailboxExtension`) 与 `world-bus-agent` (`createAgentRuntime`) 及 `world-bus-information-center` (`createInfoCenter`, `MemoryStreamStore`) 之间的完整交互闭环.
- **覆盖场景**:
  1. **显式频道门禁**: 缺少 `payload.channel` 的 `outbound=true` 事件被 `ext.mailbox.outbox` 拦截抛错, 转为 `EXTENSION_TASK_ERROR` 唤醒本机女仆, 且不会写入 `stream:orders`.
  2. **跨节点完整闭环**: Leadership 下发订单至 `stream:orders` -> Dry 拉取并回传 `STAGE_REPORT` 至 `stream:reports` -> Dry 上报心跳并触发信息中心超时巡检 -> Leadership 一次性拉取并唤醒处理.
  3. **PEL 断电幂等恢复**: 消息已写入本地 `events.jsonl` 但 `/ack` 返回 503 失败后重启节点, 首次 `pullInboxOnce()` 携带 `includePending=true` 并依赖 `_mailMeta.messageId` 预热去重, 做到不重复入账且自动补发 ACK.
- **关键依赖契约**:
  - 通过 `world-bus-agent/dist/main.js` 引入 `createAgentRuntime` 与 `RuntimeConfig`.
  - 通过注入自定义 `fetch` (`ic.app.request`) 与 `maidExecute` 替身实现无外部网络与无真实 LLM 依赖的确定性测试.

## 2. 变更记录流水

- **2026-11-20 (@Antigravity, [FIX])**:
  - 修正 `createAgentRuntime` 与 `RuntimeConfig` 的导入路径为 `world-bus-agent/dist/main.js` (原包根导出 `dist/index.js` 未包含运行时入口).
  - 更新 `makeConfig` 中的 `llm` 配置对象, 补齐 `provider: "openai-compatible"` 并调整 `baseURL` 为 `"http://127.0.0.1:11434/v1"` 以对齐 `world-bus-agent` 的 `LlmConfig` 契约.
- **2026-11-20 (@Antigravity, [FIX])**:
  - 调整用例 2 断言: 按 `leadership` 默认订阅顺序 (`stream:order_events`, `stream:reports`, `stream:heartbeat`) 校验 2 次 `wake: true` 实时唤醒 (`NODE_HEARTBEAT_TIMEOUT` 与 `STAGE_REPORT`), 并断言静默心跳 `NODE_HEARTBEAT` (`wake: false`) 留存于 `leader.getState().stock` (长度为 1).
- **2026-11-20 (@Antigravity, [CLEANUP])**:
  - 清理历史修改保留的旧代码注释, 保持测试源码整洁.
