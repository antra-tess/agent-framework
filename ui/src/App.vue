<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useWebSocket } from './composables/useWebSocket';
import { useEventsStore } from './stores/events';
import { useAgentsStore } from './stores/agents';
import { useEventLogsStore } from './stores/eventLogs';
import EventTimeline from './components/EventTimeline.vue';
import FilterPanel from './components/FilterPanel.vue';
import AgentPanel from './components/AgentPanel.vue';
import EventLogPanel from './components/EventLogPanel.vue';
import type { PersistedEvent, AgentInfo, BranchInfo, EventLogEntryWithId, ModuleEventResponse } from './api/types';

const eventsStore = useEventsStore();
const agentsStore = useAgentsStore();
const eventLogsStore = useEventLogsStore();

const { connected, send, on } = useWebSocket({
  url: 'ws://localhost:8765/ws',
});

// Update connection status
watch(connected, (isConnected) => {
  agentsStore.setConnected(isConnected);
  if (isConnected) {
    loadInitialData();
  }
});

async function loadInitialData() {
  eventsStore.setLoading(true);
  eventLogsStore.setLoading(true);
  try {
    // Load agents
    const agentResult = await send<{ agents: AgentInfo[] }>('agent.list');
    agentsStore.setAgents(agentResult.agents);

    // Load branches
    const branchResult = await send<{ branches: BranchInfo[] }>('branch.list');
    agentsStore.setBranches(branchResult.branches);
    const current = branchResult.branches.find((b) => b.isCurrent);
    if (current) {
      agentsStore.setCurrentBranch(current.name);
    }

    // Subscribe to events and get history
    const patterns = eventsStore.enabledPatterns;
    const subResult = await send<{ subscribed: string[]; history: PersistedEvent[] }>(
      'events.subscribe',
      { types: patterns, limit: 100 }
    );
    eventsStore.setSubscriptions(subResult.subscribed);
    eventsStore.setEvents(subResult.history);

    // Load historical event logs
    try {
      const eventLogsResult = await send<{ entries: EventLogEntryWithId[] }>(
        'events.tail',
        { count: 100 }
      );
      eventLogsStore.setHistoricalLogs(eventLogsResult.entries);
    } catch (e) {
      console.error('Failed to load event logs:', e);
    }
  } catch (e) {
    eventsStore.setError(e instanceof Error ? e.message : String(e));
  } finally {
    eventsStore.setLoading(false);
    eventLogsStore.setLoading(false);
  }
}

// Handle incoming events
function handleEvent(data: { event: string; data: unknown }) {
  // Convert framework event to persisted event format for display
  const persistedEvent: PersistedEvent = {
    id: `live-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    type: data.event,
    payload: data.data,
    source: 'live',
  };
  eventsStore.addEvent(persistedEvent);

  // Update agent status if relevant
  if (data.event === 'inference:started') {
    const { agentName } = data.data as { agentName: string };
    agentsStore.updateAgentStatus(agentName, 'inferring');
  } else if (data.event === 'inference:completed' || data.event === 'inference:failed') {
    const { agentName } = data.data as { agentName: string };
    agentsStore.updateAgentStatus(agentName, 'idle');
  }

  // Handle process:completed for process log panel
  if (data.event === 'process:completed') {
    const eventData = data.data as {
      timestamp: number;
      processEvent: { type: string; [key: string]: unknown };
      responses: ModuleEventResponse[];
      durationMs: number;
    };
    // Convert to the format the store expects
    eventLogsStore.addLogFromEvent({
      timestamp: eventData.timestamp,
      event: eventData.processEvent,
      responses: eventData.responses,
    });
  }
}

async function sendMessage(content: string) {
  try {
    await send('message.send', {
      participant: 'user',
      content,
      triggerInference: true,
    });
  } catch (e) {
    console.error('Failed to send message:', e);
  }
}

// Subscribe to events
onMounted(() => {
  on('*', handleEvent as (data: unknown) => void);
});

// Update subscriptions when filters change
watch(
  () => eventsStore.enabledPatterns,
  async (patterns) => {
    if (!connected.value) return;
    try {
      const result = await send<{ subscribed: string[] }>('events.subscribe', {
        types: patterns,
      });
      eventsStore.setSubscriptions(result.subscribed);
    } catch (e) {
      console.error('Failed to update subscriptions:', e);
    }
  }
);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>Agent Framework</h1>
      <div class="branch-info">
        Branch: <strong>{{ agentsStore.currentBranch }}</strong>
      </div>
    </header>

    <main class="app-main">
      <aside class="sidebar">
        <AgentPanel @send-message="sendMessage" />
        <FilterPanel />
      </aside>

      <section class="content content-split">
        <EventTimeline />
        <EventLogPanel />
      </section>
    </main>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  background: #121212;
  color: #e0e0e0;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
}

.app-header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.branch-info {
  font-size: 13px;
  color: #888;
}

.branch-info strong {
  color: #3b82f6;
}

.app-main {
  display: flex;
  flex: 1;
  overflow: hidden;
  padding: 16px;
  gap: 16px;
}

.sidebar {
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex-shrink: 0;
}

.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.content-split {
  flex-direction: row;
  gap: 16px;
}

.content-split > * {
  flex: 1;
  min-width: 0;
}
</style>
