<script setup lang="ts">
import { ref, computed } from 'vue';
import type { LiveEventLog } from '../stores/eventLogs';
import type { ModuleEventResponse } from '../api/types';

const props = defineProps<{
  log: LiveEventLog;
  selected: boolean;
}>();

defineEmits<{
  (e: 'select'): void;
}>();

const expanded = ref(false);
const expandedModules = ref<Set<string>>(new Set());

const eventType = computed(() => props.log.event.type);
const eventPrefix = computed(() => {
  const parts = eventType.value.split(':');
  return parts.length > 1 ? parts[0] : '';
});
const eventLabel = computed(() => {
  const parts = eventType.value.split(':');
  return parts.length > 1 ? parts[1] : parts[0];
});

const activeResponses = computed(() => {
  return props.log.responses.filter((r) => hasContent(r));
});

const inactiveResponses = computed(() => {
  return props.log.responses.filter((r) => !hasContent(r));
});

function hasContent(response: ModuleEventResponse): boolean {
  const r = response.response;
  return !!(
    r.addMessages?.length ||
    r.editMessages?.length ||
    r.removeMessages?.length ||
    r.requestInference ||
    r.toolsChanged
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function toggleModule(moduleName: string) {
  if (expandedModules.value.has(moduleName)) {
    expandedModules.value.delete(moduleName);
  } else {
    expandedModules.value.add(moduleName);
  }
  // Force reactivity
  expandedModules.value = new Set(expandedModules.value);
}

function formatResponse(response: ModuleEventResponse['response']): string {
  const parts: string[] = [];

  if (response.addMessages?.length) {
    parts.push(`+${response.addMessages.length} msg`);
  }
  if (response.editMessages?.length) {
    parts.push(`~${response.editMessages.length} edit`);
  }
  if (response.removeMessages?.length) {
    parts.push(`-${response.removeMessages.length} del`);
  }
  if (response.requestInference) {
    if (response.requestInference === true) {
      parts.push('infer:all');
    } else if (Array.isArray(response.requestInference)) {
      parts.push(`infer:${response.requestInference.join(',')}`);
    }
  }
  if (response.toolsChanged) {
    parts.push('tools changed');
  }

  return parts.length ? parts.join(', ') : 'no action';
}

function getEventColor(type: string): string {
  if (type.startsWith('inference:')) return '#10b981';
  if (type.startsWith('tool:')) return '#f59e0b';
  if (type.startsWith('api:')) return '#3b82f6';
  if (type.startsWith('module:')) return '#8b5cf6';
  if (type.startsWith('external')) return '#ec4899';
  return '#6b7280';
}

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
</script>

<template>
  <div
    class="event-log-item"
    :class="{ expanded, selected }"
    @click="expanded = !expanded"
  >
    <div class="item-header">
      <div
        class="event-indicator"
        :style="{ backgroundColor: getEventColor(eventType) }"
      ></div>
      <div class="event-type">
        <span class="type-prefix" v-if="eventPrefix">{{ eventPrefix }}:</span>
        <span class="type-label">{{ eventLabel }}</span>
      </div>
      <div class="response-badges" v-if="activeResponses.length > 0">
        <span class="badge" v-for="r in activeResponses" :key="r.moduleName">
          {{ r.moduleName }}
        </span>
      </div>
      <div class="event-time">{{ formatTime(log.timestamp) }}</div>
    </div>

    <div v-if="expanded" class="item-details">
      <!-- Event payload -->
      <div class="detail-section">
        <div class="section-header">Event</div>
        <pre class="json-content">{{ formatJson(log.event) }}</pre>
      </div>

      <!-- Module responses -->
      <div class="detail-section" v-if="log.responses.length > 0">
        <div class="section-header">
          Module Responses ({{ log.responses.length }})
        </div>

        <div class="module-responses">
          <!-- Active responses first -->
          <div
            v-for="resp in activeResponses"
            :key="resp.moduleName"
            class="module-response active"
          >
            <div
              class="module-header"
              @click.stop="toggleModule(resp.moduleName)"
            >
              <span class="module-name">{{ resp.moduleName }}</span>
              <span class="module-summary">{{ formatResponse(resp.response) }}</span>
              <span class="expand-icon">
                {{ expandedModules.has(resp.moduleName) ? '−' : '+' }}
              </span>
            </div>
            <div
              v-if="expandedModules.has(resp.moduleName)"
              class="module-details"
              @click.stop
            >
              <pre class="json-content">{{ formatJson(resp.response) }}</pre>
            </div>
          </div>

          <!-- Inactive responses (collapsed by default) -->
          <div
            v-for="resp in inactiveResponses"
            :key="resp.moduleName"
            class="module-response inactive"
          >
            <div
              class="module-header"
              @click.stop="toggleModule(resp.moduleName)"
            >
              <span class="module-name muted">{{ resp.moduleName }}</span>
              <span class="module-summary muted">no action</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-log-item {
  background: #252525;
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: background 0.15s;
  border: 1px solid transparent;
}

.event-log-item:hover {
  background: #2a2a2a;
}

.event-log-item.selected {
  border-color: #3b82f6;
}

.event-log-item.expanded {
  background: #2a2a2a;
}

.item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.event-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.event-type {
  font-size: 13px;
  font-family: monospace;
  min-width: 120px;
}

.type-prefix {
  color: #888;
}

.type-label {
  color: #e0e0e0;
  font-weight: 500;
}

.response-badges {
  display: flex;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.badge {
  font-size: 10px;
  padding: 2px 6px;
  background: #3b3b3b;
  border-radius: 3px;
  color: #10b981;
}

.event-time {
  font-size: 11px;
  color: #666;
  font-family: monospace;
  flex-shrink: 0;
}

.item-details {
  padding: 0 12px 12px;
}

.detail-section {
  margin-top: 12px;
}

.section-header {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.json-content {
  margin: 0;
  padding: 8px;
  background: #1a1a1a;
  border-radius: 4px;
  font-size: 11px;
  color: #a0a0a0;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}

.module-responses {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.module-response {
  background: #1f1f1f;
  border-radius: 4px;
  overflow: hidden;
}

.module-response.active .module-header {
  background: #252525;
}

.module-response.inactive .module-header {
  background: #1a1a1a;
}

.module-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
}

.module-header:hover {
  background: #2a2a2a;
}

.module-name {
  font-size: 12px;
  font-weight: 500;
  color: #e0e0e0;
  font-family: monospace;
}

.module-name.muted {
  color: #666;
}

.module-summary {
  flex: 1;
  font-size: 11px;
  color: #10b981;
}

.module-summary.muted {
  color: #555;
}

.expand-icon {
  font-size: 14px;
  color: #666;
  width: 16px;
  text-align: center;
}

.module-details {
  padding: 8px 10px;
  border-top: 1px solid #333;
}
</style>
