/**
 * API Module - handles events from the API server
 *
 * This bundled module processes api:* events and converts them
 * into conversation messages and inference requests.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolCall,
  ToolResult,
  ApiMessageEvent,
  ApiInferenceRequestEvent,
} from '../../types/index.js';

// Re-export event types for convenience
export type { ApiMessageEvent, ApiInferenceRequestEvent };
export type ApiEvent = ApiMessageEvent | ApiInferenceRequestEvent;

// ============================================================================
// API Module
// ============================================================================

export class ApiModule implements Module {
  readonly name = 'api';

  private ctx!: ModuleContext;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    // Nothing to clean up
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    // API module has no tools
    return { success: false, error: 'Unknown tool' };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (!event.type.startsWith('api:')) {
      return {};
    }

    switch (event.type) {
      case 'api:message':
        return this.handleMessage(event as ApiMessageEvent);

      case 'api:inference-request':
        return this.handleInferenceRequest(event as ApiInferenceRequestEvent);

      default:
        return {};
    }
  }

  private handleMessage(event: ApiMessageEvent): EventResponse {
    const response: EventResponse = {
      addMessages: [
        {
          participant: event.participant,
          content: [{ type: 'text', text: event.content }],
          metadata: event.metadata,
        },
      ],
    };

    if (event.triggerInference !== false) {
      response.requestInference = event.targetAgents ?? true;
    }

    return response;
  }

  private handleInferenceRequest(event: ApiInferenceRequestEvent): EventResponse {
    if (event.agentName) {
      return { requestInference: [event.agentName] };
    }
    return { requestInference: true };
  }

  getTools() {
    return [];
  }
}

// Default export for convenience
export default ApiModule;
