<!--
@file docs/api-requirements.md
@description World Bus Mailbox 扩展接口与契约需求规格文档
@date 2026-11-20
@version 0.1.0
-->

# World Bus Mailbox API 需求文档

## 1. 业务背景与需求目标

`world-bus-mailbox` 作为 `world-bus-agent` 的跨节点通信扩展, 负责在本地事件总线 (`WorldBusContext`) 与中心邮局服务 (`world-bus-information-center`) 之间建立可靠的双向桥接, 核心需求包括:

1. **严格外发门禁与 LLM 自感知**: 通过 `ParticipantManifest` 向女仆声明 4 通道规范; 所有外发事件必须显式携带合法 `payload.channel`, 缺省或非法时立即抛错交由 `world-bus-agent` 转为 `EXTENSION_TASK_ERROR` 唤醒本机自愈.
2. **角色化消费组订阅**: 按节点角色 (`leadership` / `dry` / `wet`) 自动映射消费组 (`cg:<role>`) 与默认订阅频道, 并支持通过配置显式覆盖.
3. **断电无损与 PEL 幂等签收**: 在本地账本 (`events.jsonl`) 先落盘, 再向信息中心 `/ack`; 若入账后签收前进程崩溃, 重启首次拉取自动通过 `includePending=true` 捞回 PEL 消息, 结合 `_mailMeta.messageId` 去重并补发 `/ack`.
4. **回环隔离**: 远端拉取到本地的事件强制标记 `outbound: false`, 避免被本机 `ext.mailbox.outbox` 二次捕获重发.
5. **存活性心跳与崩溃遗言旁路**: 支持定期或按需发送 `NODE_HEARTBEAT`, 并在节点致命崩溃退出前通过 `bus.onCrash` 抢发 `NODE_CRASH_ALERT`.

---

## 2. 对外导出 API 契约 ([src/index.ts](file:///c:/codeSpace/world-bus-mailbox/src/index.ts))

### 2.1 常量与枚举校验

- `MAIL_CHANNELS`: `["stream:orders", "stream:order_events", "stream:reports", "stream:heartbeat"] as const`
- `MailChannel`: `(typeof MAIL_CHANNELS)[number]`
- `MailChannelSchema`: `z.enum(MAIL_CHANNELS)`
- `NodeRole`: `"leadership" | "dry" | "wet"`
- `DEFAULT_ROLE_SUBSCRIPTIONS`:

| 节点角色 (`NodeRole`) | 默认消费组 | 默认订阅频道 |
| --- | --- | --- |
| `"leadership"` | `cg:leadership` | `["stream:order_events", "stream:reports", "stream:heartbeat"]` |
| `"dry"` | `cg:dry` | `["stream:orders"]` |
| `"wet"` | `cg:wet` | `["stream:orders"]` |

### 2.2 配置项 (`MailboxExtensionOptions`)

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `role` | `NodeRole` | 是 | - | 节点角色, 缺省时同步抛出启动异常 |
| `infoCenterUrl` | `string` | 否 | `"http://127.0.0.1:3200"` | Information Center HTTP 基址 (自动裁剪尾部 `/`) |
| `subscribeChannels` | `MailChannel[]` | 否 | `DEFAULT_ROLE_SUBSCRIPTIONS[role]` | 显式覆盖订阅频道列表 |
| `pollIntervalMs` | `number` | 否 | `1000` | Inbox 后台轮询间隔毫秒数 (`0` 表示仅手动调用 `pullInboxOnce`) |
| `heartbeatIntervalMs` | `number` | 否 | `0` | 自动心跳间隔毫秒数 (`0` 表示关闭定时心跳) |
| `fetch` | `typeof globalThis.fetch` | 否 | `globalThis.fetch` | 自定义 `fetch` 实现 (测试时可注入 `ic.app.request`) |

### 2.3 扩展入口与控制器 (`MailboxController`)

- `attachMailboxExtension(bus, opts): MailboxController`
  - 在 `bus` 上注册 `ext.mailbox.outbox` 参与者与 `bus.onCrash` 回调, 并按需启动后台 `.unref()` 定时器.
  - 返回 `MailboxController`:
    - `pullInboxOnce(): Promise<number>`: 执行一次拉取, 入账与 `/ack`, 返回本次拉取到的消息数量 (并发重入或订阅为空时直接返回 `0`).
    - `sendHeartbeatOnce(extraPayload?: Record<string, unknown>): Promise<void>`: 立即向 `stream:heartbeat` 发送一条 `NODE_HEARTBEAT` 事件.
    - `stop(): void`: 清除内部注册的所有轮询与心跳定时器.
- `mailboxExtension` (具名导出 & `export default`): 标准 `AgentExtension` 适配器, 内部调用 `attachMailboxExtension`.

---

## 3. 参与者与信封内部契约

### 3.1 Outbox 参与者 (`ext.mailbox.outbox`)

- **消费过滤 (`consume`)**:
  - 遍历 `eventsWindow` 将已存在 `payload._mailMeta.messageId` 补充至内存去重集合 `ingestedMessageIds`.
  - 仅匹配 `pendingBatch` 中第一条满足 `e.outbound === true && e.source === bus.nodeId && e.target !== bus.nodeId` 的事件.
- **执行校验 (`execute`)**:
  - 使用 `OutboxPayloadSchema` (`z.object({ channel: MailChannelSchema }).passthrough()`) 校验 `event.payload`.
  - 校验失败抛出带合法频道列表提示的 `Error`, 由 `world-bus-agent` 捕获生成 `EXTENSION_TASK_ERROR`.
  - 校验通过则调用 `POST /channels/:channel/messages` 返回 `{ channel, messageId }`.
- **产出 (`produce`)**: 返回 `[]`, 不额外污染本地账本.

### 3.2 Inbox 本地入账格式 (`RawBusEventInput`)

远端消息入本地总线时, 保留源消息的 `source`, `target`, `type`, `prompt`, `wake`, `responseMode`, 并强制覆盖:

- `outbound: false` (防止触发本机 Outbox 二次外发)
- `payload`: 在原 `payload` 上附加 `_mailMeta`:
  ```json
  {
    "_mailMeta": {
      "channel": "stream:orders",
      "messageId": "1732000000000-1",
      "publishedAt": "2026-11-20T01:30:00.000Z"
    }
  }
  ```

### 3.3 旁路内置事件

1. **节点心跳 (`NODE_HEARTBEAT`)**:
   - 投递频道: `stream:heartbeat`
   - 字段: `source: bus.nodeId`, `target: "leadership.center"`, `wake: false`, `responseMode: "optional"`, `outbound: true`, `payload: { channel: "stream:heartbeat", role: opts.role, ...extraPayload }`.
2. **崩溃告警 (`NODE_CRASH_ALERT`)**:
   - 触发时机: `bus.onCrash(report)`
   - 投递频道: `stream:order_events`
   - 字段: `id: report.id`, `ts: report.ts`, `source: bus.nodeId`, `target: "leadership.center"`, `wake: true`, `responseMode: "respond"`, `outbound: true`, `payload: { channel: "stream:order_events", stage: report.stage, error: report.error }`.

---

## 4. 对接的信息中心 HTTP 接口需求

本扩展作为客户端依赖 `world-bus-information-center` 提供以下 3 个端点:

| 方法与路径 | 用途 | 关键参数 / 请求体 | 期望响应 |
| --- | --- | --- | --- |
| `POST /channels/:channel/messages` | 外发消息, 心跳与崩溃告警 | Body 为完整 `BusEvent` JSON | `2xx` JSON `{ messageId: string }` |
| `GET /poll` | 拉取未签收或 PEL 待恢复消息 | Query: `nodeId`, `consumerGroup`, `channels`, 可选 `includePending=true` | `2xx` JSON `{ messages: StoredMessage[] }` |
| `POST /ack` | 确认消息已写入本地 `events.jsonl` | Body: `{ consumerGroup, channel, messageId }` | `2xx` |

任何非 `res.ok` 响应均会抛出包含状态码的 `Error`, 在 `pullInboxOnce()` 场景下会保留 `needPendingRecovery = true` 以便下次拉取继续尝试 PEL 恢复.
