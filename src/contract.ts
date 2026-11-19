import { z } from "zod";
import type { BusEvent, RawBusEventInput } from "world-bus-agent";

/** 平台唯一合法的四条订阅通道（无任何隐式推断） */
export const MAIL_CHANNELS = [
  "stream:orders",
  "stream:order_events",
  "stream:reports",
  "stream:heartbeat",
] as const;

export type MailChannel = (typeof MAIL_CHANNELS)[number];
export const MailChannelSchema = z.enum(MAIL_CHANNELS);

/** 节点角色预设订阅表（也可通过扩展 options 显式覆盖） */
export type NodeRole = "leadership" | "dry" | "wet";

export const DEFAULT_ROLE_SUBSCRIPTIONS: Record<NodeRole, readonly MailChannel[]> = {
  leadership: ["stream:order_events", "stream:reports", "stream:heartbeat"],
  dry: ["stream:orders"],
  wet: ["stream:orders"],
};

/** 邮箱发信校验契约：要求事件 payload 中必须显式声明合法的 channel */
export const OutboxPayloadSchema = z
  .object({
    channel: MailChannelSchema,
  })
  .passthrough();

/** 信息中心流转的标准信封格式 */
export interface MailEnvelope {
  messageId: string;
  channel: MailChannel;
  publishedAt: string;
  event: BusEvent;
}

/** 信息中心传输抽象接口（生产环境对接独立容器 HTTP/Redis，测试环境可直接用内存邮局） */
export interface PostOfficeTransport {
  publish(channel: MailChannel, event: BusEvent): Promise<{ messageId: string }>;
  poll(params: {
    nodeId: string;
    consumerGroup: string;
    channels: readonly MailChannel[];
  }): Promise<MailEnvelope[]>;
  ack(params: {
    consumerGroup: string;
    channel: MailChannel;
    messageId: string;
  }): Promise<void>;
}

/** 将远端收到的信封还原为本地 bus.ingest() 输入（强制 outbound=false 防止回环重发） */
export function envelopeToLocalIngest(envelope: MailEnvelope): RawBusEventInput {
  const { event, channel, messageId } = envelope;
  return {
    source: event.source,
    target: event.target,
    type: event.type,
    prompt: event.prompt,
    wake: event.wake,
    responseMode: event.responseMode,
    outbound: false, // 收到远端信件入本地账本后，绝不再触发本机 Outbox 二次外发
    payload: {
      ...event.payload,
      _mailMeta: {
        channel,
        messageId,
        publishedAt: envelope.publishedAt,
      },
    },
  };
}
