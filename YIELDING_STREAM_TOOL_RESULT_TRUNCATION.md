# Yielding Stream Tool Result Truncation

## Problem

Tool results returned during a yielding stream bypass the context strategy's `maxMessageTokens` truncation. The context manager's `select()` method (which enforces per-message token limits) only runs once at stream start via `compile()`. After that, each tool round-trip within the yielding stream appends raw, untruncated tool results to the Membrane's internal message array — which is sent verbatim to the API on the next round.

A single large tool result can push the total prompt past the API's 200K token limit, killing the inference.

## Incident

`position_loading_excavator` called `get_channel_history` with `format: "raw"` and `max_messages: 500`, returning 721,411 chars (~180K tokens). The Membrane appended this raw result to its messages and the next API call was rejected:

```
400 invalid_request_error: prompt is too long: 220715 tokens > 200000 maximum
```

Breakdown of the failed request (from the inference log blob):
- Compiled messages (29 messages): ~19K tokens
- System prompt: ~1.4K tokens
- Tool definitions (38 tools): ~3.8K tokens
- **Total before tool loop**: ~24K tokens — well within limits

The 220K came from the yielding stream's tool loop appending the 180K tool result on top of the initial 24K context.

## Root Cause

Two code paths convert AF `ToolResult` → string content using `JSON.stringify(tc.result.data)`:

### Path 1: Context Manager storage (line 962–971)
```typescript
// Store tool results as a user message (tool_result blocks)
const toolResultContent: ContentBlock[] = currentState.toolResults.map(tc => ({
  type: 'tool_result' as const,
  toolUseId: tc.id,
  content: tc.result.isError
    ? (tc.result.error ?? 'Unknown error')
    : JSON.stringify(tc.result.data),      // ← full content stored
  isError: tc.result.isError,
}));
agent.getContextManager().addMessage('user', toolResultContent);
```

This path is **safe**: the stored message will be truncated by `AutobiographicalStrategy.select()` on the next `compile()` call, via `truncateContent()` with `maxMessageTokens`.

### Path 2: Membrane handoff (line 985–988 → 1540–1548)
```typescript
// Streaming path: convert results and resume the stream
const membraneResults = currentState.toolResults.map(tc =>
  this.toMembraneToolResult(tc.id, tc.result)
);
currentState.stream.provideToolResults(membraneResults);
```

Where `toMembraneToolResult` is:
```typescript
private toMembraneToolResult(callId: string, afResult: ToolResult): MembraneToolResult {
  return {
    toolUseId: callId,
    content: afResult.isError
      ? (afResult.error ?? 'Unknown error')
      : JSON.stringify(afResult.data),        // ← full content, no truncation
    isError: afResult.isError,
  };
}
```

This content flows into the Membrane's yielding stream (`runNativeToolsYielding`, membrane.ts:2128–2136), which appends it raw to the messages array sent to the next API call. **No truncation is ever applied.**

## Fix

Truncate the serialized tool result in `toMembraneToolResult()` before handing it to the Membrane. This is the single choke point between tool execution and the yielding stream.

### Where

`agent-framework/src/framework.ts`, the `toMembraneToolResult()` method (line 1540).

### What

Add a `maxToolResultChars` parameter (derived from the agent's strategy config or a framework-level default) and truncate the serialized content:

```typescript
private toMembraneToolResult(
  callId: string,
  afResult: ToolResult,
  maxChars?: number
): MembraneToolResult {
  let content: string;
  if (afResult.isError) {
    content = afResult.error ?? 'Unknown error';
  } else {
    content = JSON.stringify(afResult.data);
    if (maxChars && content.length > maxChars) {
      content = content.slice(0, maxChars) +
        '\n\n[truncated — original was ' + content.length + ' chars]';
    }
  }
  return { toolUseId: callId, content, isError: afResult.isError };
}
```

### Choosing the limit

The limit should come from the agent, not be a global constant, since different agents may have different context budgets. Options:

1. **Derive from `maxMessageTokens`**: `maxChars = agent.config.strategy.maxMessageTokens * 4`. This keeps each tool result consistent with the per-message limit applied at compile time. For the zulip-app config (`maxMessageTokens: 10000`), this would be 40,000 chars.

2. **New config field**: `maxToolResultTokens` on the agent or framework config. More explicit, allows tool results to have a different limit than general messages.

3. **Fallback default**: If no limit is configured, use a sensible default (e.g., 40,000 chars = ~10K tokens). This ensures safety even for agents that don't configure a strategy.

Option 1 is simplest and maintains consistency: the same limit that `select()` would apply on the next compile also applies in-flight.

### Call site change

In `handleProcessEvent` where `toMembraneToolResult` is called (line 985–988), pass the limit:

```typescript
const agent = this.agents.get(event.agentName);
const maxChars = this.getMaxToolResultChars(agent);

const membraneResults = currentState.toolResults.map(tc =>
  this.toMembraneToolResult(tc.id, tc.result, maxChars)
);
```

Where `getMaxToolResultChars` reads the agent's strategy config:

```typescript
private getMaxToolResultChars(agent: Agent | undefined): number | undefined {
  const strategy = agent?.getContextManager()?.getStrategy?.();
  if (strategy && 'config' in strategy) {
    const maxTokens = (strategy as any).config?.maxMessageTokens;
    if (maxTokens > 0) return maxTokens * 4;
  }
  return undefined; // no limit if not configured
}
```

Alternatively, expose `maxMessageTokens` as a readable property on the strategy interface to avoid the `any` cast.

### Also apply to context manager storage

For consistency, apply the same truncation to the context manager storage path (line 962–971). While `select()` will truncate on the next compile, storing the full 721K string in Chronicle is wasteful — the blob storage still holds it, and any direct message inspection (e.g., `messages.mjs`) shows the bloated version.

```typescript
const toolResultContent: ContentBlock[] = currentState.toolResults.map(tc => {
  let content: string;
  if (tc.result.isError) {
    content = tc.result.error ?? 'Unknown error';
  } else {
    content = JSON.stringify(tc.result.data);
    if (maxChars && content.length > maxChars) {
      content = content.slice(0, maxChars) +
        '\n\n[truncated — original was ' + content.length + ' chars]';
    }
  }
  return {
    type: 'tool_result' as const,
    toolUseId: tc.id,
    content,
    isError: tc.result.isError,
  };
});
```

## Secondary Issue: Agent Guidance

The offending tool call used `format: "raw"` and `max_messages: 500`:

```json
{
  "channel": "router_ops",
  "end_date": "now",
  "format": "raw",
  "max_messages": 500,
  "start_date": "2026-01-01"
}
```

Even with the truncation fix, this is wasteful — the agent retrieves 721K of data only to have it truncated to 40K. The system prompt for agents using Zulip tools should include guidance:

- Prefer `format: "detailed"` over `"raw"` (raw includes 15+ unused API fields per message)
- Use `max_messages: 50–100` per call, paginate if needed
- For exploratory scanning, use `format: "summary"` first

This is a prompt-level fix in `zulip-app/src/index.ts`, not an AF change.

## Files

| File | Change |
|------|--------|
| `agent-framework/src/framework.ts` | Truncate in `toMembraneToolResult()` (line 1540); optionally also in context manager storage (line 962) |
| `zulip-app/src/index.ts` | Add tool usage guidance to system prompt |

## Verification

1. Run the zulip-app with the fix
2. Have the agent call `get_channel_history` with `max_messages: 500, format: "raw"`
3. Confirm the tool result is truncated to ~40K chars in the Membrane's messages
4. Confirm the API call succeeds (no prompt-too-long error)
5. Confirm the truncation marker appears in the agent's conversation
