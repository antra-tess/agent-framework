import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { PersistedEvent } from '../api/types';

export interface EventFilter {
  id: string;
  label: string;
  pattern: string;
  enabled: boolean;
  color: string;
}

const DEFAULT_FILTERS: EventFilter[] = [
  { id: 'messages', label: 'Messages', pattern: 'api:message', enabled: true, color: '#3b82f6' },
  { id: 'inference', label: 'Inference', pattern: 'inference:*', enabled: true, color: '#10b981' },
  { id: 'tools', label: 'Tools', pattern: 'tool:*', enabled: true, color: '#f59e0b' },
  { id: 'modules', label: 'Modules', pattern: 'module:*', enabled: false, color: '#8b5cf6' },
  { id: 'branches', label: 'Branches', pattern: 'branch:*', enabled: false, color: '#ec4899' },
];

export const useEventsStore = defineStore('events', () => {
  // State
  const events = ref<PersistedEvent[]>([]);
  const filters = ref<EventFilter[]>([...DEFAULT_FILTERS]);
  const subscriptions = ref<string[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Getters
  const enabledPatterns = computed(() =>
    filters.value.filter((f) => f.enabled).map((f) => f.pattern)
  );

  const filteredEvents = computed(() => {
    const patterns = enabledPatterns.value;
    if (patterns.length === 0) return [];

    return events.value.filter((event) =>
      patterns.some((pattern) => matchEventType(pattern, event.type))
    );
  });

  const eventsByType = computed(() => {
    const result: Record<string, PersistedEvent[]> = {};
    for (const event of events.value) {
      if (!result[event.type]) {
        result[event.type] = [];
      }
      result[event.type]!.push(event);
    }
    return result;
  });

  // Actions
  function addEvent(event: PersistedEvent) {
    events.value.push(event);
    // Keep max 1000 events in memory
    if (events.value.length > 1000) {
      events.value = events.value.slice(-1000);
    }
  }

  function setEvents(newEvents: PersistedEvent[]) {
    events.value = newEvents;
  }

  function clearEvents() {
    events.value = [];
  }

  function toggleFilter(id: string) {
    const filter = filters.value.find((f) => f.id === id);
    if (filter) {
      filter.enabled = !filter.enabled;
    }
  }

  function setFilterEnabled(id: string, enabled: boolean) {
    const filter = filters.value.find((f) => f.id === id);
    if (filter) {
      filter.enabled = enabled;
    }
  }

  function setSubscriptions(subs: string[]) {
    subscriptions.value = subs;
  }

  function setLoading(isLoading: boolean) {
    loading.value = isLoading;
  }

  function setError(err: string | null) {
    error.value = err;
  }

  function getEventColor(eventType: string): string {
    for (const filter of filters.value) {
      if (matchEventType(filter.pattern, eventType)) {
        return filter.color;
      }
    }
    return '#6b7280'; // gray default
  }

  return {
    // State
    events,
    filters,
    subscriptions,
    loading,
    error,
    // Getters
    enabledPatterns,
    filteredEvents,
    eventsByType,
    // Actions
    addEvent,
    setEvents,
    clearEvents,
    toggleFilter,
    setFilterEnabled,
    setSubscriptions,
    setLoading,
    setError,
    getEventColor,
  };
});

// Helper function
function matchEventType(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  }
  return pattern === eventType;
}
