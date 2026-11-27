import type { ChatSettings } from '@shared/contracts/chat';

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/** Which upstream API a reply goes through (the gateway resolves the same; chat needs it for the stored limit). */
export type ChatRoute = 'chat' | 'responses' | 'router';

export interface ChatPlan {
  route: ChatRoute;
  /** Model id (null for the router, which picks one). */
  model: string | null;
  settings: ChatSettings;
  history: HistoryMessage[];
}
