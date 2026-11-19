import type { AgentExtension, BusEvent } from "world-bus-agent";
import {
  DEFAULT_ROLE_SUBSCRIPTIONS,
  MAIL_CHANNELS,
  OutboxPayloadSchema,
  envelopeToLocalIngest,
  type MailChannel,
  type NodeRole,
  type PostOfficeTransport,
} from "./contract.js";

export interface MailboxExtensionOptions {
  role: NodeRole;
  transport: PostOfficeTransport;
  /** 可选：显式覆盖该节点订阅的通道列表 */
  subscribeChannels?: MailChannel[];
  /** 可选：Inbox 轮询间隔毫秒数（0 表示仅手动/事件触发拉取，默认 1000ms） */
  pollIntervalMs?: number;
  /** 可选：心跳发送间隔毫秒数（dry/wet 默认开启，0 表示禁用） */
  heartbeatIntervalMs?: number;
}

/**
 * 独立收发信插件 (ext-mailbox)：
 * - 严格要求外发事件显式填写 payload.channel（4 个契约枚举之一），否则抛错转 EXTENSION_TASK_ERROR 交女仆自愈
 * - 暴露 ParticipantManifest 让女仆自动感知四通道发信规范
 * - 集成 onCrash 旁路遗言投递至 stream:order_events
 */
export const mailboxExtension: AgentExtension = (bus, rawOptions = {}) => {
  const opts = rawOptions as unknown as MailboxExtensionOptions;
  if (!opts?.transport || !opts?.role) {
    throw new Error("[ext-mailbox] 启动配置缺少必填项: role 或 transport");
  }

  const consumerGroup = `cg:${opts.role}`;
  const subscribedChannels =
    opts.subscribeChannels ?? DEFAULT_ROLE_SUBSCRIPTIONS[opts.role];

  // 1. 注册发信箱参与者 (Outbox BusParticipant)
  bus.registerParticipant({
    id: "ext.mailbox.outbox",
    manifest: {
      description:
        "跨节点邮局发信箱：将本节点产生的外发事件 (outbound=true) 投递至信息中心。发信时必须在 payload.channel 中显式指定契约通道。",
      consumes: [
        {
          type: "* (任意 outbound=true 且 target!=本节点的事件)",
          description: "通过 emit_event 发送跨节点消息时触发",
          payloadSchema: {
            channel: `必填枚举: ${MAIL_CHANNELS.join(" | ")}`,
          },
        },
      ],
      produces: [
        {
          type: "远端节点事件 (通过 Inbox 接收)",
          description: `当前节点 (${opts.role}) 订阅通道: ${subscribedChannels.join(", ")}`,
        },
      ],
    },

    /** 纯消费过滤：仅捕获本机产生的、发往外部的 outbound 事件 */
    consume(_window, pendingBatch): BusEvent | null {
      const hit = pendingBatch.find(
        (e) =>
          e.outbound === true &&
          e.source === bus.nodeId &&
          e.target !== bus.nodeId
      );
      return hit ?? null;
    },

    /** 执行外发：严格校验 payload.channel，缺失或非法直接抛出任务异常交女仆自愈 */
    async execute(event) {
      const parsed = OutboxPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new Error(
          `外发事件 "${event.type}" (${event.id}) 缺少合法的 payload.channel！` +
            `必须显式指定为以下契约通道之一: [${MAIL_CHANNELS.join(", ")}]`
        );
      }

      const channel = parsed.data.channel;
      await opts.transport.publish(channel, event);
      return { channel, eventId: event.id };
    },

    /** 纯生产：投递成功不产生多余内部事件，保持账本干净 */
    produce() {
      return [];
    },
  });

  // 2. 收信箱拉取函数 (Inbox Poll -> bus.ingest -> ACK)
  let polling = false;
  async function pullInboxOnce(): Promise<number> {
    if (polling || subscribedChannels.length === 0) return 0;
    polling = true;
    try {
      const envelopes = await opts.transport.poll({
        nodeId: bus.nodeId,
        consumerGroup,
        channels: subscribedChannels,
      });

      for (const env of envelopes) {
        // 先确保本地 bus.ingest 成功写入 events.jsonl，再向邮局 ACK
        await bus.ingest(envelopeToLocalIngest(env));
        await opts.transport.ack({
          consumerGroup,
          channel: env.channel,
          messageId: env.messageId,
        });
      }
      return envelopes.length;
    } finally {
      polling = false;
    }
  }

  // 3. 注册底层崩溃旁路钩子：节点崩溃退出前抢发紧急告警至 stream:order_events
  bus.onCrash(async (report) => {
    await opts.transport.publish("stream:order_events", {
      id: report.id,
      ts: report.ts,
      source: bus.nodeId,
      target: "leadership.center",
      type: "NODE_CRASH_ALERT",
      prompt: `[CRITICAL CRASH] 节点 ${bus.nodeId} 在 ${report.stage} 阶段崩溃: ${report.error.message}`,
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

  // 4. 启动后台定时收信与可选心跳
  const pollMs = opts.pollIntervalMs ?? 1000;
  if (pollMs > 0) {
    const timer = setInterval(() => {
      pullInboxOnce().catch((err) => {
        console.error(`[ext-mailbox][${bus.nodeId}] Inbox 轮询异常:`, err);
      });
    }, pollMs);
    timer.unref();
  }

  const hbMs = opts.heartbeatIntervalMs ?? 0;
  if (hbMs > 0) {
    const hbTimer = setInterval(() => {
      opts.transport
        .publish("stream:heartbeat", {
          id: `HB-${Date.now()}`,
          ts: new Date().toISOString(),
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
          },
        })
        .catch((err) => {
          console.error(`[ext-mailbox][${bus.nodeId}] 心跳发送失败:`, err);
        });
    }, hbMs);
    hbTimer.unref();
  }
};

export default mailboxExtension;
