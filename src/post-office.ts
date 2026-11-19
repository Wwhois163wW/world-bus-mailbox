import { Hono } from "hono";
import type { BusEvent } from "world-bus-agent";
import {
  MailChannelSchema,
  type MailChannel,
  type MailEnvelope,
  type PostOfficeTransport,
} from "./contract.js";

/**
 * 信息中心核心路由引擎（支持 Consumer Group 投递与 ACK 语义）
 * 生产环境可替换为 Redis XADD / XREADGROUP / XACK 后端，接口完全一致
 */
export class InMemoryPostOffice implements PostOfficeTransport {
  private streams = new Map<MailChannel, MailEnvelope[]>([
    ["stream:orders", []],
    ["stream:order_events", []],
    ["stream:reports", []],
    ["stream:heartbeat", []],
  ]);

  /** 记录每个 consumerGroup 在各 channel 已确认签收的 messageId 集合 */
  private ackedByGroup = new Map<string, Set<string>>();
  private seq = 0;

  async publish(channel: MailChannel, event: BusEvent): Promise<{ messageId: string }> {
    const validChannel = MailChannelSchema.parse(channel);
    const messageId = `${Date.now()}-${++this.seq}`;
    const envelope: MailEnvelope = {
      messageId,
      channel: validChannel,
      publishedAt: new Date().toISOString(),
      event,
    };
    this.streams.get(validChannel)!.push(envelope);
    return { messageId };
  }

  async poll(params: {
    nodeId: string;
    consumerGroup: string;
    channels: readonly MailChannel[];
  }): Promise<MailEnvelope[]> {
    const groupKey = params.consumerGroup;
    if (!this.ackedByGroup.has(groupKey)) {
      this.ackedByGroup.set(groupKey, new Set());
    }
    const acked = this.ackedByGroup.get(groupKey)!;
    const delivered: MailEnvelope[] = [];

    for (const ch of params.channels) {
      const list = this.streams.get(ch) ?? [];
      for (const env of list) {
        if (acked.has(env.messageId)) continue;
        // 排除发件人自己，并匹配 target === nodeId 或广播 "*"
        if (env.event.source === params.nodeId) continue;
        if (env.event.target === params.nodeId || env.event.target === "*") {
          delivered.push(env);
        }
      }
    }
    return delivered;
  }

  async ack(params: {
    consumerGroup: string;
    channel: MailChannel;
    messageId: string;
  }): Promise<void> {
    if (!this.ackedByGroup.has(params.consumerGroup)) {
      this.ackedByGroup.set(params.consumerGroup, new Set());
    }
    this.ackedByGroup.get(params.consumerGroup)!.add(params.messageId);
  }

  /** 构建独立容器部署时的 Hono HTTP 网关 */
  createHttpApp(): Hono {
    const app = new Hono();
    app.post("/channels/:channel/messages", async (c) => {
      const channel = MailChannelSchema.parse(c.req.param("channel"));
      const event = (await c.req.json()) as BusEvent;
      const res = await this.publish(channel, event);
      return c.json({ ok: true, ...res }, 201);
    });

    app.get("/poll", async (c) => {
      const nodeId = c.req.query("nodeId") ?? "";
      const consumerGroup = c.req.query("consumerGroup") ?? "";
      const rawChannels = (c.req.query("channels") ?? "").split(",").filter(Boolean);
      const channels = rawChannels.map((ch) => MailChannelSchema.parse(ch));
      const messages = await this.poll({ nodeId, consumerGroup, channels });
      return c.json({ ok: true, messages });
    });

    app.post("/ack", async (c) => {
      const body = await c.req.json();
      await this.ack({
        consumerGroup: body.consumerGroup,
        channel: MailChannelSchema.parse(body.channel),
        messageId: body.messageId,
      });
      return c.json({ ok: true });
    });

    return app;
  }
}

/** 供独立容器运行时的 HTTP 客户端传输适配器 */
export class HttpPostOfficeClient implements PostOfficeTransport {
  constructor(private readonly baseUrl: string) {}

  async publish(channel: MailChannel, event: BusEvent): Promise<{ messageId: string }> {
    const res = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`PostOffice publish failed: ${res.status}`);
    return res.json();
  }

  async poll(params: {
    nodeId: string;
    consumerGroup: string;
    channels: readonly MailChannel[];
  }): Promise<MailEnvelope[]> {
    const qs = new URLSearchParams({
      nodeId: params.nodeId,
      consumerGroup: params.consumerGroup,
      channels: params.channels.join(","),
    });
    const res = await fetch(`${this.baseUrl}/poll?${qs.toString()}`);
    if (!res.ok) throw new Error(`PostOffice poll failed: ${res.status}`);
    const data = await res.json();
    return data.messages;
  }

  async ack(params: {
    consumerGroup: string;
    channel: MailChannel;
    messageId: string;
  }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`PostOffice ack failed: ${res.status}`);
  }
}
