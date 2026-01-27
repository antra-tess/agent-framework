<script setup lang="ts">
import { computed } from 'vue';
import { useEventLogsStore } from '../stores/eventLogs';
import EventLogItem from './EventLogItem.vue';

const eventLogsStore = useEventLogsStore();

const logs = computed(() => eventLogsStore.allLogs);
const loading = computed(() => eventLogsStore.loading);
const eventTypes = computed(() => eventLogsStore.eventTypes);
const moduleNames = computed(() => eventLogsStore.moduleNames);
const filterEventType = computed(() => eventLogsStore.filterEventType);
const filterModuleName = computed(() => eventLogsStore.filterModuleName);

function setEventTypeFilter(type: string | null) {
  eventLogsStore.setFilterEventType(type);
}

function setModuleFilter(name: string | null) {
  eventLogsStore.setFilterModuleName(name);
}
</script>

<template>
  <div class="event-log-panel">
    <div class="panel-header">
      <h2>Process Log</h2>
      <span class="log-count">{{ logs.length }} events</span>
    </div>

    <div class="filters">
      <select
        class="filter-select"
        :value="filterEventType ?? ''"
        @change="setEventTypeFilter(($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">All event types</option>
        <option v-for="type in eventTypes" :key="type" :value="type">
          {{ type }}
        </option>
      </select>

      <select
        class="filter-select"
        :value="filterModuleName ?? ''"
        @change="setModuleFilter(($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">All modules</option>
        <option v-for="name in moduleNames" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
    </div>

    <div v-if="loading" class="loading">Loading process logs...</div>

    <div v-else-if="logs.length === 0" class="empty">
      No process logs to display.
    </div>

    <div v-else class="logs-list">
      <EventLogItem
        v-for="log in logs"
        :key="log.id"
        :log="log"
        :selected="eventLogsStore.selectedLogId === log.id"
        @select="eventLogsStore.selectLog(log.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.event-log-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1e1e1e;
  border-radius: 8px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #252525;
  border-bottom: 1px solid #333;
}

.panel-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.log-count {
  font-size: 12px;
  color: #888;
}

.filters {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
}

.filter-select {
  flex: 1;
  padding: 6px 8px;
  font-size: 12px;
  background: #252525;
  border: 1px solid #333;
  border-radius: 4px;
  color: #e0e0e0;
}

.filter-select:focus {
  outline: none;
  border-color: #3b82f6;
}

.loading,
.empty {
  padding: 24px;
  text-align: center;
  color: #888;
}

.logs-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
</style>
