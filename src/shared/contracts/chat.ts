import type { RouterMode } from './app';
import type { GmiErrorShape } from './errors';

/** `model` = a specific GMI model; `auto` = GMI Router picks per message (plain chat only, no tools). */
export type ChatMode = 'model' | 'auto';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Range the main process clamps `ChatSettings.maxTokens` to. */
export const CHAT_MAX_TOKENS_MIN = 16;
export const CHAT_MAX_TOKENS_MAX = 262_144;

export interface ChatSettings {
  mode: ChatMode;
  model: string | null;
  routerMode: RouterMode;
  maxTokens: number;
  temperature: number | null;
  reasoningEffort: ReasoningEffort | null;
  systemPrompt: string | null;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

export interface RoutingInfo {
  selectedModel: string;
  taskType: string | null;
  mode: string | null;
  fallbackModels: string[];
  recommendationId: string | null;
}

export type ChatMessageStatus = 'complete' | 'streaming' | 'error' | 'stopped';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning text (reasoning_content / <think> blocks), shown collapsed. */
  reasoning: string | null;
  /** Model that produced an assistant message. */
  model: string | null;
  routing: RoutingInfo | null;
  usage: TokenUsage | null;
  /**
   * True when GMI reported no token usage for the reply (stopped, timed out, failed mid-stream, or a
   * stream without a usage chunk), so `usage` and `costUsd` were estimated from the text instead.
   */
  usageEstimated?: boolean;
  /** Estimated cost from list prices and the org discount; null when unknown. */
  costUsd: number | null;
  createdAt: string;
  status: ChatMessageStatus;
  error: GmiErrorShape | null;
  /** Why the model stopped (`stop`, `length` = hit max tokens, `content_filter`...), when GMI said. */
  finishReason?: string | null;
  /** When an assistant reply finished streaming (complete, stopped or failed). */
  completedAt?: string | null;
  /**
   * The output limit sent with the request that produced an assistant reply. Null when none was sent
   * (GMI Router takes no max_tokens); absent on replies saved before it was recorded.
   */
  maxTokens?: number | null;
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  mode: ChatMode;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Total estimated cost of the thread. */
  costUsd: number;
  /** True while a reply is streaming in this thread. */
  streaming?: boolean;
}

export interface ChatThread extends ChatThreadSummary {
  settings: ChatSettings;
  messages: ChatMessage[];
}

export type ChatStreamEvent =
  | { threadId: string; messageId: string; type: 'start'; model: string | null }
  | {
      threadId: string;
      messageId: string;
      type: 'delta';
      content?: string;
      reasoning?: string;
      /** Length of the message's content before this delta (lets the renderer apply deltas exactly once). */
      contentOffset?: number;
      /** Length of the message's reasoning before this delta. */
      reasoningOffset?: number;
    }
  | { threadId: string; messageId: string; type: 'routing'; routing: RoutingInfo }
  | { threadId: string; messageId: string; type: 'done'; message: ChatMessage }
  | { threadId: string; messageId: string; type: 'error'; error: GmiErrorShape; message: ChatMessage };

export interface CreateThreadInit {
  title?: string;
  settings?: Partial<ChatSettings>;
  /**
   * Creating a thread discards other empty, unnamed threads (abandoned "New chat" drafts). Threads listed
   * here are kept, e.g. those with unsent composer text. Threads with a system prompt or temperature are always kept.
   */
  keepIds?: string[];
}

export interface ChatApi {
  listThreads(): Promise<ChatThreadSummary[]>;
  getThread(id: string): Promise<ChatThread>;
  createThread(init?: CreateThreadInit): Promise<ChatThread>;
  updateThread(id: string, patch: { title?: string; settings?: Partial<ChatSettings> }): Promise<ChatThread>;
  deleteThread(id: string): Promise<void>;
  /**
   * Appends the user message and starts streaming the reply. Progress arrives on `chat:stream`.
   * `budgetWarning` is set when a budget limit is reached but not enforced (warn-only mode): show it, do not block.
   */
  send(threadId: string, content: string): Promise<{ userMessageId: string; assistantMessageId: string; budgetWarning: string | null }>;
  stop(threadId: string): Promise<void>;
  /** Replaces the last assistant reply with a new one. `budgetWarning` as for send(). */
  regenerate(threadId: string): Promise<{ assistantMessageId: string; budgetWarning: string | null }>;
}
