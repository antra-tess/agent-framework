import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { EventLogEntryWithId, ModuleEventResponse } from '../api/types';

export interface LiveEventLog {
  id: string;
  timestamp: number;
  event: {
    type: string;
    [key: string]: unknown;
  };
  responses: ModuleEventResponse[];
}

export const useEventLogsStore = defineStore('eventLogs', () => {
  // State
  const logs = ref<LiveEventLog[]>([]);
  const historicalLogs = ref<EventLogEntryWithId[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const selectedLogId = ref<string | null>(null);

  // Filter state
  const filterEventType = ref<string | null>(null);
  const filterModuleName = ref<string | null>(null);

  // Getters
  const allLogs = computed(() => {
    let result = [...logs.value];

    if (filterEventType.value) {
      result = result.filter((log) => log.event.type === filterEventType.value);
    }

    if (filterModuleName.value) {
      result = result.filter((log) =>
        log.responses.some((r) => r.moduleName === filterModuleName.value)
      );
    }

    // Sort by timestamp descending (newest first)
    return result.sort((a, b) => b.timestamp - a.timestamp);
  });

  const selectedLog = computed(() => {
    if (!selectedLogId.value) return null;
    return logs.value.find((log) => log.id === selectedLogId.value) ?? null;
  });

  const eventTypes = computed(() => {
    const types = new Set<string>();
    for (const log of logs.value) {
      types.add(log.event.type);
    }
    return Array.from(types).sort();
  });

  const moduleNames = computed(() => {
    const names = new Set<string>();
    for (const log of logs.value) {
      for (const resp of log.responses) {
        names.add(resp.moduleName);
      }
    }
    return Array.from(names).sort();
  });

  // Actions
  function addLog(log: LiveEventLog) {
    logs.value.push(log);
    // Keep max 500 logs in memory
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-500);
    }
  }

  function addLogFromEvent(data: {
    timestamp: number;
    event: { type: string; [key: string]: unknown };
    responses: ModuleEventResponse[];
  }) {
    const log: LiveEventLog = {
      id: `live-${data.timestamp}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: data.timestamp,
      event: data.event,
      responses: data.responses,
    };
    addLog(log);
  }

  function setHistoricalLogs(entries: EventLogEntryWithId[]) {
    historicalLogs.value = entries;
    // Also add them to the logs for display
    for (const entry of entries) {
      const responses = Array.isArray(entry.entry.responses)
        ? entry.entry.responses
        : [];
      // Support both old format (event) and new format (processEvent)
      const eventData = (entry.entry as any).processEvent ?? entry.entry.event;
      const log: LiveEventLog = {
        id: `hist-${entry.sequence}`,
        timestamp: entry.entry.timestamp,
        event: eventData,
        responses,
      };
      // Add if not already present
      if (!logs.value.some((l) => l.id === log.id)) {
        logs.value.push(log);
      }
    }
  }

  function clearLogs() {
    logs.value = [];
    historicalLogs.value = [];
  }

  function selectLog(id: string | null) {
    selectedLogId.value = id;
  }

  function setFilterEventType(type: string | null) {
    filterEventType.value = type;
  }

  function setFilterModuleName(name: string | null) {
    filterModuleName.value = name;
  }

  function setLoading(isLoading: boolean) {
    loading.value = isLoading;
  }

  function setError(err: string | null) {
    error.value = err;
  }

  return {
    // State
    logs,
    historicalLogs,
    loading,
    error,
    selectedLogId,
    filterEventType,
    filterModuleName,
    // Getters
    allLogs,
    selectedLog,
    eventTypes,
    moduleNames,
    // Actions
    addLog,
    addLogFromEvent,
    setHistoricalLogs,
    clearLogs,
    selectLog,
    setFilterEventType,
    setFilterModuleName,
    setLoading,
    setError,
  };
});
