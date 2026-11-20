import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime, type RuntimeConfig } from "world-bus-agent/dist/main.js";
import { MemoryStreamStore, createInfoCenter } from "world-bus-information-center";
import { attachMailboxExtension } from "../src/index.js";

describe("World Bus Mailbox E2E (Agent <-> Information Center <-> Agent)", () => {
  let leaderDir: string;
  let dryDir: string;

  beforeEach(async () => {
    leaderDir = await mkdtemp(join(tmpdir(), "wba-leader-"));
    dryDir = await mkdtemp(join(tmpdir(), "wba-dry-"));
  });

  afterEach(async () => {
    await rm(leaderDir, { recursive: true, force: true });
    await rm(dryDir, { recursive: true, force: true });
  });

  const makeConfig = (nodeId: string, workspaceDir: string): RuntimeConfig => ({
    nodeId,
    workspaceDir,
    port: 0,
    windowSize: 30,
    tickIntervalMs: 0,
    llm: {
      enabled: true,
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "mock-key",
      model: "mock-model",
      systemPrompt: "Test",
      maxSteps: 3,
    },
    extensions: [],
  });

  it("1. 显式频道门禁: 缺 payload.channel 的外发事件被拒绝并转为 EXTENSION_TASK_ERROR 唤醒本机女仆", async () => {
    const ic = createInfoCenter({ store: new MemoryStreamStore() });
    const hFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      ic.app.request(String(input), init)) as typeof fetch;

    const wokenPrompts: string[] = [];
    const leader = await createAgentRuntime(makeConfig("leadership.center", leaderDir), {
      maidExecute: async (input) => {
        wokenPrompts.push(input.promptText);
        return { finalText: "Fixed", consumedEventIds: input.consumedEventIds, toolTrace: [] };
      },
    });

    const box = attachMailboxExtension(leader.bus, {
      role: "leadership",
      pollIntervalMs: 0,
      fetch: hFetch,
    });

    await leader.bus.ingest({
      source: "leadership.center",
      target: "dry.hub.01",
      type: "ORDER_DISPATCH",
      prompt: "漏写 channel 的订单",
      wake: false,
      outbound: true,
      payload: { orderId: "ORD-BAD" },
    });

    expect(wokenPrompts).toHaveLength(1);
    expect(wokenPrompts[0]).toContain("EXTENSION_TASK_ERROR");
    expect(wokenPrompts[0]).toContain("缺少合法的 payload.channel");

    const health = await (await ic.app.request("/health")).json();
    expect(health.streams["stream:orders"].total).toBe(0);
    box.stop();
  });

  it("2. 完整跨节点闭环: Leadership 下单 -> Dry 执行并回传报告 -> 心跳超时巡检唤醒 Leadership", async () => {
    const ic = createInfoCenter({
      store: new MemoryStreamStore(),
      heartbeatTimeoutMs: 50,
    });
    const hFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      ic.app.request(String(input), init)) as typeof fetch;

    const leaderWakes: string[] = [];
    const dryWakes: string[] = [];

    const leader = await createAgentRuntime(makeConfig("leadership.center", leaderDir), {
      maidExecute: async (input) => {
        leaderWakes.push(input.promptText);
        return { finalText: "Leader ok", consumedEventIds: input.consumedEventIds, toolTrace: [] };
      },
    });
    const dry = await createAgentRuntime(makeConfig("dry.hub.01", dryDir), {
      maidExecute: async (input) => {
        dryWakes.push(input.promptText);
        await dry.bus.ingest({
          source: "dry.hub.01",
          target: "leadership.center",
          type: "STAGE_REPORT",
          prompt: "Dry 已完成谱图入库 (ORD-2026)",
          wake: true,
          outbound: true,
          payload: { channel: "stream:reports", orderId: "ORD-2026" },
        });
        return { finalText: "Dry ok", consumedEventIds: input.consumedEventIds, toolTrace: [] };
      },
    });

    const leaderBox = attachMailboxExtension(leader.bus, {
      role: "leadership",
      pollIntervalMs: 0,
      fetch: hFetch,
    });
    const dryBox = attachMailboxExtension(dry.bus, {
      role: "dry",
      pollIntervalMs: 0,
      fetch: hFetch,
    });

    // Leadership 下发订单
    await leader.bus.ingest({
      source: "leadership.center",
      target: "dry.hub.01",
      type: "ORDER_DISPATCH",
      prompt: "请处理订单 ORD-2026",
      wake: true,
      outbound: true,
      payload: { channel: "stream:orders", orderId: "ORD-2026" },
    });

    // Dry 收单执行并回传报告
    expect(await dryBox.pullInboxOnce()).toBe(1);
    expect(dryWakes).toHaveLength(1);

    // Dry 发送心跳 -> 随后推进时间触发信息中心超时巡检
    await dryBox.sendHeartbeatOnce({ stockCount: 0 });
    await ic.runPatrolOnce(Date.now() + 200);

    // Leadership 一次性收取：NODE_HEARTBEAT_TIMEOUT (wake:true) + STAGE_REPORT (wake:true) + NODE_HEARTBEAT (wake:false)
    // 因 mock maidExecute 瞬时完成，两条 wake:true 消息各自触发一次实时唤醒；静默心跳则留在 Stock 中不打扰女仆
    expect(await leaderBox.pullInboxOnce()).toBe(3);
    expect(leaderWakes).toHaveLength(2);
    const combinedPrompts = leaderWakes.join("\n");
    expect(combinedPrompts).toContain("NODE_HEARTBEAT_TIMEOUT");
    expect(combinedPrompts).toContain("Dry 已完成谱图入库 (ORD-2026)");

    const leaderState = leader.getState();
    expect(leaderState.stock).toHaveLength(1);
    expect(leaderState.stock[0].type).toBe("NODE_HEARTBEAT");

    leaderBox.stop();
    dryBox.stop();
  });

  it("3. PEL 断电幂等恢复: 消息已写入本地 events.jsonl 但 /ack 失败后重启，不重复入账且自动补发 ACK", async () => {
    const ic = createInfoCenter({ store: new MemoryStreamStore() });
    let failAckOnce = true;

    const flakyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ack") && failAckOnce) {
        failAckOnce = false;
        return new Response(JSON.stringify({ ok: false, error: "Simulated network drop" }), {
          status: 503,
        });
      }
      return ic.app.request(url, init);
    }) as typeof fetch;

    // 投递一条订单给 dry.hub.01
    await ic.app.request("/channels/stream:orders/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ORD-PEL-1",
        ts: new Date().toISOString(),
        source: "leadership.center",
        target: "dry.hub.01",
        type: "ORDER_DISPATCH",
        prompt: "测试 PEL 幂等恢复",
        wake: false,
        payload: { channel: "stream:orders" },
      }),
    });

    // 第一次运行：拉取并写入 dryDir/events.jsonl 成功，但 /ack 遭遇 503 失败
    const dry1 = await createAgentRuntime(makeConfig("dry.hub.01", dryDir));
    const box1 = attachMailboxExtension(dry1.bus, {
      role: "dry",
      pollIntervalMs: 0,
      fetch: flakyFetch,
    });
    await expect(box1.pullInboxOnce()).rejects.toThrow("InformationCenter ack failed (503)");
    box1.stop();

    // 模拟 Dry 节点重启（加载同一个 dryDir，预热 events.jsonl 中的 _mailMeta.messageId）
    const dry2 = await createAgentRuntime(makeConfig("dry.hub.01", dryDir));
    const box2 = attachMailboxExtension(dry2.bus, {
      role: "dry",
      pollIntervalMs: 0,
      fetch: flakyFetch,
    });

    // 重启后首次 pullInboxOnce 带 includePending=true 捞回该消息：
    // 1) 不会向 dryDir/events.jsonl 重复写入第二条；2) 自动补发 /ack 清空 PEL
    expect(await box2.pullInboxOnce()).toBe(1);
    const ledgerLines = (await readFile(join(dryDir, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n");
    expect(ledgerLines).toHaveLength(1);

    // 再次带 includePending=true 轮询，确认服务端 PEL 已彻底清空
    const verifyPoll = await ic.app.request(
      "/poll?nodeId=dry.hub.01&consumerGroup=cg:dry&channels=stream:orders&includePending=true"
    );
    expect((await verifyPoll.json()).messages).toHaveLength(0);
    box2.stop();
  });
});
