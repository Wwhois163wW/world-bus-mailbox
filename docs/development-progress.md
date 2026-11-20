<!--
@file docs/development-progress.md
@description World Bus Mailbox 开发进度与里程碑记录文档
@date 2026-11-20
@version 0.1.0
-->

# World Bus Mailbox 开发进度文档

- **当前版本**: `0.1.0`
- **当前阶段**: 纯客户端扩展定型, 冗余代码清理完成, 全量端到端测试全绿通过
- **最近一次验证**: 2026-11-20 (`npm run typecheck`, `npm run build`, `npm test` 全部退出码 `0`, [mailbox.e2e.test.ts](file:///c:/codeSpace/world-bus-mailbox/tests/mailbox.e2e.test.ts) `3/3` 通过)

---

## 1. 功能与工程进度总览

| 模块 / 任务项 | 状态 | 对应产物 | 备注 |
| --- | --- | --- | --- |
| 邮局客户端扩展核心 | 已完成 | [src/index.ts](file:///c:/codeSpace/world-bus-mailbox/src/index.ts), [src/index.md](file:///c:/codeSpace/world-bus-mailbox/src/index.md) | `ext.mailbox.outbox`, `pullInboxOnce`, `sendHeartbeatOnce`, `onCrash` |
| 旧版内置邮局残留清理 | 已完成 | - | 已移除冗余文件 `src/post-office.ts`, `src/contract.ts`, `src/extension.ts` 并重建 `dist/` |
| 端到端集成测试套件 | 已完成 | [tests/mailbox.e2e.test.ts](file:///c:/codeSpace/world-bus-mailbox/tests/mailbox.e2e.test.ts), [tests/mailbox.e2e.test.md](file:///c:/codeSpace/world-bus-mailbox/tests/mailbox.e2e.test.md) | 覆盖频道门禁, Leadership/Dry 闭环, PEL 断电幂等恢复 |
| 工程依赖与构建输出 | 已完成 | [package.json](file:///c:/codeSpace/world-bus-mailbox/package.json), [tsconfig.json](file:///c:/codeSpace/world-bus-mailbox/tsconfig.json), [dist/index.js](file:///c:/codeSpace/world-bus-mailbox/dist/index.js) | ESM `NodeNext`, 输出 `dist/index.js` 与 `dist/index.d.ts` |
| 项目说明与工程文档 | 已完成 | [README.md](file:///c:/codeSpace/world-bus-mailbox/README.md), [.gitignore](file:///c:/codeSpace/world-bus-mailbox/.gitignore), `docs/*.md` | 已补齐 API 需求, 架构设计, 开发进度与会话日志 |
| 测试覆盖率扩展 | 待开始 | - | 当前未单独覆盖 `onCrash` 旁路告警, `heartbeatIntervalMs` 自动定时器与 `mailboxExtension` 默认导出路径 |
| 测试文件独立 TypeScript 检查 | 待开始 | - | 当前 `tsconfig.json` 仅包含 `src/`, 后续可考虑补充 `tsconfig.test.json` 覆盖 `tests/` |
| 网络抖动退避重试策略 | 规划中 | - | 针对 `/channels/:channel/messages` 与 `/poll` 的短暂网络异常增加可配置重试或退避 |

---

## 2. 已达成里程碑明细

### 里程碑 M1: 邮局扩展与信息中心解耦实现 (已完成)

1. 实现 [src/index.ts](file:///c:/codeSpace/world-bus-mailbox/src/index.ts), 将早期基于内置 `PostOfficeTransport` 的实现收敛为直接对接 `world-bus-information-center` HTTP 接口的纯客户端扩展.
2. 完成 4 通道显式门禁校验 (`MAIL_CHANNELS`), 角色默认订阅映射 (`DEFAULT_ROLE_SUBSCRIPTIONS`), 本地 `events.jsonl` 预热去重 (`loadIngestedMessageIds`) 与 PEL 恢复 (`includePending=true`).
3. 完成心跳上报 (`NODE_HEARTBEAT`) 与 `bus.onCrash` 旁路告警 (`NODE_CRASH_ALERT`).

### 里程碑 M2: 联调排障, 冗余清理与文档封版 (已完成)

1. 完成依赖安装 (`npm install`), 定位并解决两项联调问题:
   - 移除导入未声明依赖 `hono` 的旧版残留文件 `src/post-office.ts`, 修复 `tsc --noEmit` 报错.
   - 修复 [tests/mailbox.e2e.test.ts](file:///c:/codeSpace/world-bus-mailbox/tests/mailbox.e2e.test.ts) 中 `world-bus-agent/dist/main.js` 导入路径, 对齐 `LlmConfig` 契约 (`provider: "openai-compatible"`), 并按实际跨频道实时唤醒语义更新用例 2 断言与 `stock` 校验.
2. 清理冗余旧版模块 (`src/contract.ts`, `src/extension.ts`) 及旧 `dist/` 产物, 完成全量验证 (`typecheck`, `build`, `test` 3/3 通过).
3. 补齐伴生澄清文档 ([src/index.md](file:///c:/codeSpace/world-bus-mailbox/src/index.md), [tests/mailbox.e2e.test.md](file:///c:/codeSpace/world-bus-mailbox/tests/mailbox.e2e.test.md)), [.gitignore](file:///c:/codeSpace/world-bus-mailbox/.gitignore), [README.md](file:///c:/codeSpace/world-bus-mailbox/README.md) 及 `docs/` 核心设计文档.

---

## 3. 近期后续工作建议 (Next Steps)

1. **P0 (测试边界补强)**:
   - 增加 `onCrash` 旁路发送 `NODE_CRASH_ALERT` 到 `stream:order_events` 的集成测试用例.
   - 增加 `mailboxExtension` (经由 `RuntimeConfig.extensions` 配置加载) 与 `subscribeChannels` 显式覆盖测试用例.
   - 增加 `tsconfig.test.json` 使 `npm run typecheck` 同时覆盖 `tests/`.
2. **P1 (可观测性与健壮性)**:
   - 为 `publishToInfoCenter` / `pullInboxOnce` 增加可配置请求超时 (`AbortSignal.timeout`) 与结构化错误上下文, 避免网络挂起阻塞 `polling` 锁.
