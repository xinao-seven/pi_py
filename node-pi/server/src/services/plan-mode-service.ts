import type { EventBus } from "@earendil-works/pi-coding-agent";

import { ApiError } from "../errors.js";

export type PlanMode = "normal" | "planning" | "executing";
export interface PlanTodo { step: number; text: string; completed: boolean; }
export interface PlanSnapshot { sessionId: string; mode: PlanMode; todos: PlanTodo[]; awaitingConfirmation: boolean; }

export const PLAN_CHANNEL_SET = "pi:plan-mode:set";
export const PLAN_CHANNEL_STATE = "pi:plan-mode:state";

/**
 * Web REST/SSE 与 plan-mode 扩展之间的事件总线桥。
 *
 * Plan 的工具限制、文本解析和 JSONL 持久化均在 extensions/plan-mode.ts；此类仅缓存
 * 扩展状态并校验 Web 命令，避免 jiti 隔离的扩展直接依赖 Fastify/SSE。
 */
export class PlanModeService {
  private readonly states = new Map<string, PlanSnapshot>();
  private listener: ((state: PlanSnapshot) => void) | undefined;
  private readonly off: () => void;

  constructor(private readonly events: EventBus) {
    this.off = events.on(PLAN_CHANNEL_STATE, (data) => {
      const state = this.parse(data);
      if (!state) return;
      this.states.set(state.sessionId, state);
      this.listener?.(state);
    });
  }

  setListener(listener: (state: PlanSnapshot) => void): void { this.listener = listener; }
  state(sessionId: string): PlanSnapshot { return this.states.get(sessionId) ?? { sessionId, mode: "normal", todos: [], awaitingConfirmation: false }; }

  command(sessionId: string, action: "enable" | "disable" | "execute" | "refine", message?: string): void {
    const current = this.state(sessionId);
    if (action === "execute" && (!current.awaitingConfirmation || current.todos.length === 0)) {
      throw new ApiError(409, "plan_not_ready", "No generated plan is awaiting confirmation");
    }
    if (action === "refine" && (!current.awaitingConfirmation || !message?.trim())) {
      throw new ApiError(422, "validation_error", "A refinement message is required for the current generated plan");
    }
    this.events.emit(PLAN_CHANNEL_SET, { sessionId, action, ...(message?.trim() ? { message: message.trim() } : {}) });
  }

  remove(sessionId: string): void { this.states.delete(sessionId); }
  dispose(): void { this.off(); this.states.clear(); }

  private parse(value: unknown): PlanSnapshot | undefined {
    if (!value || typeof value !== "object") return undefined;
    const data = value as Partial<PlanSnapshot>;
    if (typeof data.sessionId !== "string" || !["normal", "planning", "executing"].includes(String(data.mode)) || !Array.isArray(data.todos)) return undefined;
    if (data.todos.some((todo) => !todo || typeof todo.step !== "number" || typeof todo.text !== "string" || typeof todo.completed !== "boolean")) return undefined;
    return { sessionId: data.sessionId, mode: data.mode as PlanMode, todos: data.todos, awaitingConfirmation: data.awaitingConfirmation === true };
  }
}
