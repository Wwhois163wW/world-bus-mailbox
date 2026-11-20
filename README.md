<!--
@file README.md
@description World Bus Mailbox 跨节点收发信扩展说明文档
@date 2026-11-20
@version 0.1.0
-->

# world-bus-mailbox

`world-bus-mailbox` 是面向 `world-bus-agent` 的跨节点邮局客户端扩展 (`AgentExtension`), 基于 TypeScript (ESM) 与 Zod v3 构建, 用于将本地事件总线接入独立部署的 `world-bus-information-center` 信息中心服务.

## 1. 目录结构

```text
world-bus-mailbox/
├── src/
│   ├── index.ts              # 核心扩展实现 (attachMailboxExtension / mailboxExtension)
│   └── index.md              # src/index.ts 伴生设计说明
├── tests/
│   ├── mailbox.e2e.test.ts   # 端到端集成测试 (Agent <-> Info Center <-> Agent)
│   └── mailbox.e2e.test.md   # tests/mailbox.e2e.test.ts 伴生设计说明
├── docs/
│   ├── api-requirements.md     # API 需求规格文档
│   ├── architecture.md         # 架构设计文档
│   ├── development-progress.md # 开发进度与里程碑文档
│   └── dialog/                 # 会话工作日志
├── dist/                     # tsc 编译产物 (index.js, index.d.ts)
├── package.json
├── tsconfig.json             # 编译配置 (rootDir: src, outDir: dist)
└── .gitignore
```

## 2. 快速开始

### 安装依赖

```bash
npm install
```

> 注: `devDependencies` 中通过本地路径引用了兄弟仓库 `file:../world-bus-agent` 与 `file:../world-bus-information-center`, 请确保这两个仓库位于同级目录并已完成构建.

### 构建与测试脚本

| 命令 | 说明 |
| --- | --- |
| `npm run typecheck` | 执行 `tsc --noEmit` 对 `src/` 进行类型检查 |
| `npm run build` | 执行 `tsc` 将 `src/` 编译输出至 `dist/` |
| `npm test` | 执行 `vitest run` 运行端到端测试 |
| `npm run test:watch` | 以监听模式运行 Vitest 测试 |

## 3. 核心能力与使用方式

### 挂载扩展

```typescript
import { createAgentRuntime } from "world-bus-agent/dist/main.js";
import { attachMailboxExtension } from "world-bus-mailbox";

const runtime = await createAgentRuntime(config);
const mailbox = attachMailboxExtension(runtime.bus, {
  role: "dry",
  infoCenterUrl: "http://127.0.0.1:3200",
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 30000,
});
```

也可将 `mailboxExtension` (默认导出) 作为 `AgentExtension` 挂载至 `WorldBusContext`.

### 频道与角色默认订阅 (`DEFAULT_ROLE_SUBSCRIPTIONS`)

| 角色 (`NodeRole`) | 消费组 (`consumerGroup`) | 默认订阅频道 (`subscribeChannels`) |
| --- | --- | --- |
| `leadership` | `cg:leadership` | `stream:order_events`, `stream:reports`, `stream:heartbeat` |
| `dry` | `cg:dry` | `stream:orders` |
| `wet` | `cg:wet` | `stream:orders` |

### 发信门禁与收信幂等

- **显式频道门禁**: 所有本机外发事件 (`outbound: true`, `source === bus.nodeId`, `target !== bus.nodeId`) 必须在 `payload.channel` 中显式指定 4 个合法频道之一 (`stream:orders`, `stream:order_events`, `stream:reports`, `stream:heartbeat`), 否则抛错转为 `EXTENSION_TASK_ERROR` 唤醒本机女仆自愈.
- **PEL 断电幂等恢复**: 启动时扫描本地 `workspaceDir/events.jsonl` 预热 `_mailMeta.messageId`; 首次轮询自动携带 `includePending=true` 拉取未签收消息, 保证不重复入账并补发 `/ack`.
- **旁路心跳与崩溃告警**: 支持定时或手动调用 `sendHeartbeatOnce()` 上报 `NODE_HEARTBEAT`, 并挂载 `bus.onCrash` 钩子在节点崩溃前抢发 `NODE_CRASH_ALERT` 至 `stream:order_events`.

## 4. 项目文档

- [API 需求文档](docs/api-requirements.md)
- [架构设计文档](docs/architecture.md)
- [开发进度文档](docs/development-progress.md)
