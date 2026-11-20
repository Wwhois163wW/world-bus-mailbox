# index.ts 伴生澄清文档

## 1. 技术设计要点与总结

- **模块定位**: `world-bus-mailbox` 核心客户端扩展入口, 通过 `attachMailboxExtension` 与标准 `AgentExtension` (`mailboxExtension`) 将 `world-bus-agent` 节点接入 `world-bus-information-center` 跨节点邮局.
- **四通道契约**:
  - `MAIL_CHANNELS`: 唯一合法枚举 `["stream:orders", "stream:order_events", "stream:reports", "stream:heartbeat"]`, 由 `MailChannelSchema` (`zod`) 严格校验.
  - `DEFAULT_ROLE_SUBSCRIPTIONS`: 按 `NodeRole` (`"leadership" | "dry" | "wet"`) 分配默认消费组 (`cg:<role>`) 与订阅频道; 可通过 `subscribeChannels` 显式覆盖.
- **发信门禁与感知 (`ext.mailbox.outbox`)**:
  - 注册 `BusParticipant` 并暴露 `manifest` 供女仆 LLM 识别发信规范.
  - 仅消费 `outbound === true`, `source === bus.nodeId`, `target !== bus.nodeId` 的事件.
  - 校验 `payload.channel` 合法性, 缺失或非法时直接抛错转 `EXTENSION_TASK_ERROR` 触发本机自愈; 合法则 POST 至 `/channels/:channel/messages`.
- **收信幂等与 PEL 恢复 (`pullInboxOnce`)**:
  - 启动时扫描 `workspaceDir/events.jsonl` 预热 `_mailMeta.messageId` 集合, `consume` 阶段亦持续同步窗口内已入账 ID.
  - 首次成功轮询自动携带 `includePending=true` 拉取重启前未 ACK 的 PEL 消息; 已入账消息跳过 `bus.ingest` 仅补发 `/ack`, 新消息以 `outbound: false` 入本地账本后再 ACK.
- **心跳与崩溃旁路**:
  - 提供 `sendHeartbeatOnce()` 及可选 `heartbeatIntervalMs` 定时器向 `stream:heartbeat` 上报节点存活.
  - 注册 `bus.onCrash` 钩子, 崩溃退出前抢发 `NODE_CRASH_ALERT` 至 `stream:order_events`.

## 2. 变更记录流水

- **2026-11-20 (@Antigravity, [DOC])**:
  - 补全 `src/index.ts` 伴生澄清文档.
