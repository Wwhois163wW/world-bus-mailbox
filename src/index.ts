import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentExtension, BusEvent, RawBusEventInput } from "world-bus-agent";

export const MAIL_CHANNELS = [
  "stream:orders",
  "stream:order_events",
  "stream:reports",
  "stream:heartbeat",
] as const;

export type MailChannel = (typeof MAIL_CHANNELS)[number];
export const MailChannelSchema = z.enum(MAIL_CHANNELS);

export type NodeRole = "leadership" | "dry" | "wet";

export const DEFAULT_ROLE_SUBSCRIPTIONS: Record<NodeRole, readonly MailChannel[]> = {
  leadership: ["stream:order_events", "stream:reports", "stream:heartbeat"],
  dry: ["stream:orders"],
  wet: ["stream:orders"],
};

const OutboxPayloadSchema = z
  .object({
    channel: MailChannelSchema,
  })
  .passthrough();

interface StoredMessage {
  messageId: string;
  channel: MailChannel;
  publishedAt: string;
  event: BusEvent;
}

export interface MailboxExtensionOptions {
  /** 当前节点角色，决定默认消费组 (cg:<role>) 与订阅频道 */
  role: NodeRole;
  /** Information Center 服务地址，默认 http://127.0.0.1:3200 */
  infoCenterUrl?: string;
  /** 可选：显式覆盖订阅频道列表 */
  subscribeChannels?: MailChannel[];
  /** 可选：Inbox 自动轮询间隔毫秒数（0 表示仅手动调用，默认 1000ms） */
  pollIntervalMs?: number;
  /** 可选：心跳上报间隔毫秒数（0 表示禁用，默认 0） */
  heartbeatIntervalMs?: number;
  /** 可选：自定义 fetch 实现（测试时可直接注入 Hono ic.app.request） */
  fetch?: typeof globalThis.fetch;
}

export interface MailboxController {
  pullInboxOnce(): Promise<number>;
  sendHeartbeatOnce(extraPayload?: Record<string, unknown>): Promise<void>;
  stop(): void;
}

/** 从本地 workspace/events.jsonl 预热已入账的远端 messageId，防止重启时重复入账 */
function loadIngestedMessageIds(workspaceDir: string): Set<string> {
  const ids = new Set<string>();
  const ledgerPath = join(workspaceDir, "events.jsonl");
  if (!existsSync(ledgerPath)) return ids;

  const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const msgId = parsed?.payload?._mailMeta?.messageId;
      if (typeof msgId === "string" && msgId.length > 0) {
        ids.add(msgId);
      }
    } catch {
      // 账本格式校验由 world-bus-agent 启动阶段负责
    }
  }
  return ids;
}

export function attachMailboxExtension(
  bus: Parameters<AgentExtension>[0],
  opts: MailboxExtensionOptions
): MailboxController {
  if (!opts?.role) {
    throw new Error("[ext-mailbox] 缺少必填配置: role");
  }

  const baseUrl = (opts.infoCenterUrl ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const consumerGroup = `cg:${opts.role}`;
  const subscribedChannels =
    opts.subscribeChannels ?? DEFAULT_ROLE_SUBSCRIPTIONS[opts.role];

  const ingestedMessageIds = loadIngestedMessageIds(bus.workspaceDir);
  let needPendingRecovery = true;
  let polling = false;

  async function publishToInfoCenter(channel: MailChannel, event: BusEvent): Promise<string> {
    const res = await fetchFn(`${baseUrl}/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      throw new Error(`InformationCenter publish failed (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as { messageId: string };
    return data.messageId;
  }

  // 1. 注册发信箱参与者 (Outbox BusParticipant)
  bus.registerParticipant({
    id: "ext.mailbox.outbox",
    manifest: {
      description:
        "跨节点邮局发信箱：自动将本节点产生的外发事件 (outbound=true) 投递至 Information Center。发信时必须在 payload.channel 中显式指定契约频道。",
      consumes: [
        {
          type: "* (任意 outbound=true 且 target != 本节点的事件)",
          description: "调用 emit_event 发送跨节点指令、状态、报告或告警时触发",
          payloadSchema: {
            channel: `必填枚举: ${MAIL_CHANNELS.join(" | ")}`,
          },
        },
      ],
      produces: [
        {
          type: "远端节点事件 (由 Inbox 自动接收并写入本地总线)",
          description: `当前节点 (${opts.role}) 订阅频道: [${subscribedChannels.join(", ")}]`,
        },
      ],
    },

    consume(eventsWindow, pendingBatch): BusEvent | null {
      for (const evt of eventsWindow) {
        const meta = evt.payload?._mailMeta as { messageId?: string } | undefined;
        if (meta?.messageId) ingestedMessageIds.add(meta.messageId);
      }

      const hit = pendingBatch.find(
        (e) =>
          e.outbound === true &&
          e.source === bus.nodeId &&
          e.target !== bus.nodeId
      );
      return hit ?? null;
    },

    async execute(event) {
      const parsed = OutboxPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new Error(
          `外发事件 "${event.type}" (${event.id}) 缺少合法的 payload.channel！` +
            `必须显式指定为以下契约频道之一: [${MAIL_CHANNELS.join(", ")}]`
        );
      }
      const messageId = await publishToInfoCenter(parsed.data.channel, event);
      return { channel: parsed.data.channel, messageId };
    },

    produce() {
      return [];
    },
  });

  // 2. 收信箱拉取：首次成功轮询自动带 includePending=true 恢复崩溃前未 ACK 的 PEL 消息
  async function pullInboxOnce(): Promise<number> {
    if (polling || subscribedChannels.length === 0) return 0;
    polling = true;
    try {
      const qs = new URLSearchParams({
        nodeId: bus.nodeId,
        consumerGroup,
        channels: subscribedChannels.join(","),
        ...(needPendingRecovery ? { includePending: "true" } : {}),
      });

      const res = await fetchFn(`${baseUrl}/poll?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`InformationCenter poll failed (${res.status})`);
      }
      const { messages } = (await res.json()) as { messages: StoredMessage[] };

      for (const msg of messages) {
        if (!ingestedMessageIds.has(msg.messageId)) {
          const localInput: RawBusEventInput = {
            source: msg.event.source,
            target: msg.event.target,
            type: msg.event.type,
            prompt: msg.event.prompt,
            wake: msg.event.wake,
            responseMode: msg.event.responseMode,
            outbound: false, // 远端来信入本地账本后，禁止二次触发本机 Outbox
            payload: {
              ...msg.event.payload,
              _mailMeta: {
                channel: msg.channel,
                messageId: msg.messageId,
                publishedAt: msg.publishedAt,
              },
            },
          };
          await bus.ingest(localInput);
          ingestedMessageIds.add(msg.messageId);
        }

        const ackRes = await fetchFn(`${baseUrl}/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            consumerGroup,
            channel: msg.channel,
            messageId: msg.messageId,
          }),
        });
        if (!ackRes.ok) {
          throw new Error(`InformationCenter ack failed (${ackRes.status})`);
        }
      }

      // 确认首轮拉取与签收完整成功后，再关闭 PEL 恢复标志
      needPendingRecovery = false;
      return messages.length;
    } finally {
      polling = false;
    }
  }

  // 3. 心跳上报
  async function sendHeartbeatOnce(extraPayload: Record<string, unknown> = {}): Promise<void> {
    const now = new Date().toISOString();
    await publishToInfoCenter("stream:heartbeat", {
      id: `HB-${bus.nodeId}-${Date.now()}`,
      ts: now,
      source: bus.nodeId,
      target: "leadership.center",
      type: "NODE_HEARTBEAT",
      prompt: `节点 ${bus.nodeId} (${opts.role}) 心跳正常`,
      wake: false,
      responseMode: "optional",
      outbound: true,
      payload: {
        channel: "stream:heartbeat",
        role: opts.role,
        ...extraPayload,
      },
    });
  }

  // 4. Layer 2 底层崩溃旁路遗言 -> 抢发告警至 stream:order_events
  bus.onCrash(async (report) => {
    await publishToInfoCenter("stream:order_events", {
      id: report.id,
      ts: report.ts,
      source: bus.nodeId,
      target: "leadership.center",
      type: "NODE_CRASH_ALERT",
      prompt: `[CRITICAL CRASH] 节点 "${bus.nodeId}" 在 ${report.stage} 阶段崩溃: ${report.error.message}`,
      wake: true,
      responseMode: "respond",
      outbound: true,
      payload: {
        channel: "stream:order_events",
        stage: report.stage,
        error: report.error,
      },
    });
  });

  // 5. 后台定时器
  const timers: NodeJS.Timeout[] = [];
  const pollMs = opts.pollIntervalMs ?? 1000;
  if (pollMs > 0) {
    const t = setInterval(() => {
      pullInboxOnce().catch((err) =>
        console.error(`[ext-mailbox][${bus.nodeId}] Inbox poll error:`, err)
      );
    }, pollMs);
    t.unref();
    timers.push(t);
  }

  const hbMs = opts.heartbeatIntervalMs ?? 0;
  if (hbMs > 0) {
    const t = setInterval(() => {
      sendHeartbeatOnce().catch((err) =>
        console.error(`[ext-mailbox][${bus.nodeId}] Heartbeat error:`, err)
      );
    }, hbMs);
    t.unref();
    timers.push(t);
  }

  return {
    pullInboxOnce,
    sendHeartbeatOnce,
    stop: () => {
      for (const t of timers) clearInterval(t);
    },
  };
}

export const mailboxExtension: AgentExtension = (bus, rawOptions = {}) => {
  attachMailboxExtension(bus, rawOptions as unknown as MailboxExtensionOptions);
};

export default mailboxExtension;
