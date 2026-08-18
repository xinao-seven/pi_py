import { afterEach, describe, expect, it } from "vitest";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import { createApp } from "../src/app.js";
import { AgentRegistry, type PiSession, type PiSessionFactory } from "../src/services/agent-registry.js";
import { PLAN_CHANNEL_STATE, PlanModeService } from "../src/services/plan-mode-service.js";

class FakePiSession implements PiSession {
  readonly sessionId = "node-test-session";
  isStreaming = false;
  thinkingLevel = "medium";
  model = { provider: "test", id: "fake" };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  private listeners: Array<(event: { type: "agent_start" | "agent_end"; messages?: never[]; willRetry?: boolean }) => void> = [];

  getActiveToolNames(): string[] { return ["read", "bash", "edit", "write"]; }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.push(listener as never);
    return () => { this.listeners = this.listeners.filter((item) => item !== listener); };
  }
  async prompt(): Promise<void> { this.listeners.forEach((listener) => listener({ type: "agent_start" })); }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  async setModel(model: { provider: string; id: string }): Promise<void> { this.model = model; }
  setThinkingLevel(level: string): void { this.thinkingLevel = level; }
  setActiveToolsByName(): void {}
  async compact(): Promise<void> {}
  async navigateTree(): Promise<void> {}
  async reload(): Promise<void> {}
  dispose(): void {}
}

class FakePiSessionFactory implements PiSessionFactory {
  readonly session = new FakePiSession();
  async create(): Promise<PiSession> { return this.session; }
}

describe("Fastify application", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("exposes the frontend-compatible health endpoint", async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("creates an original-Pi-compatible agent session", async () => {
    const registry = new AgentRegistry(new FakePiSessionFactory());
    const app = createApp({ registry });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/new",
      payload: { cwd: process.cwd(), message: "hello" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ success: true, sessionId: "node-test-session" });
    expect(registry.state("node-test-session")).toMatchObject({ isStreaming: false });

    const [sessions, detail] = await Promise.all([
      app.inject({ method: "GET", url: "/api/sessions" }),
      app.inject({ method: "GET", url: "/api/sessions/node-test-session" }),
    ]);
    expect(sessions.json()).toMatchObject({ sessions: [{ id: "node-test-session", cwd: process.cwd() }] });
    expect(detail.json()).toMatchObject({
      sessionId: "node-test-session",
      context: { thinkingLevel: "medium", model: { provider: "test", modelId: "fake" } },
    });

    const modelChange = await app.inject({
      method: "POST",
      url: "/api/agent/node-test-session",
      payload: { type: "set_model", provider: "next", modelId: "model" },
    });
    expect(modelChange.statusCode).toBe(200);
    expect(registry.state("node-test-session")).toMatchObject({ model: { provider: "next", modelId: "model" } });
  });

  it("exposes the session Plan snapshot through the agent API", async () => {
    const events = createEventBus();
    const plans = new PlanModeService(events);
    const registry = new AgentRegistry(new FakePiSessionFactory(), undefined, plans);
    const app = createApp({ registry, planService: plans });
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/agent/new", payload: { cwd: process.cwd(), message: "hello" } });
    events.emit(PLAN_CHANNEL_STATE, {
      sessionId: "node-test-session",
      mode: "planning",
      todos: [{ step: 1, text: "Inspect the API", completed: false }],
      awaitingConfirmation: true,
    });

    const response = await app.inject({ method: "GET", url: "/api/agent/node-test-session/plan" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan: { mode: "planning", awaitingConfirmation: true, todos: [{ text: "Inspect the API" }] },
    });
  });
});
