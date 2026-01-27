/**
 * API types for communication with the agent framework
 */

export interface ApiRequest {
  type: 'request';
  id?: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface ApiResponse {
  type: 'response';
  id?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ApiEvent {
  type: 'event';
  event: string;
  data: unknown;
}

export type ApiMessage = ApiResponse | ApiEvent;

export interface PersistedEvent {
  id: string;
  sequence?: number;
  timestamp: number;
  type: string;
  payload: unknown;
  source: string;
  causedBy?: string;
  agentName?: string;
  moduleName?: string;
}

export interface AgentInfo {
  name: string;
  model: string;
  status: 'idle' | 'inferring' | 'waiting_for_tools' | 'ready';
  systemPromptPreview: string;
  allowedTools: 'all' | string[];
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}

// Event Log Types

export interface ModuleEventResponse {
  moduleName: string;
  response: EventResponse;
}

export interface EventResponse {
  addMessages?: { participant: string; content: string }[];
  editMessages?: { messageId: string; content: string }[];
  removeMessages?: string[];
  requestInference?: boolean | string[];
  toolsChanged?: boolean;
}

export interface EventLogEntry {
  timestamp: number;
  event: {
    type: string;
    [key: string]: unknown;
  };
  responses: ModuleEventResponse[] | { blobId: string };
}

export interface EventLogSummary {
  timestamp: number;
  eventType: string;
  moduleCount: number;
  modulesRequestingInference: string[];
  modulesAddingMessages: string[];
  responsesIsBlob: boolean;
}

export interface EventLogEntryWithId {
  sequence: number;
  entry: EventLogEntry;
  summary?: EventLogSummary;
}
