<script setup lang="ts">
import { computed } from 'vue';
import { useEventsStore } from '../stores/events';
import EventItem from './EventItem.vue';

const eventsStore = useEventsStore();

const events = computed(() => eventsStore.filteredEvents);
const loading = computed(() => eventsStore.loading);
</script>

<template>
  <div class="event-timeline">
    <div class="timeline-header">
      <h2>Activity Stream</h2>
      <span class="event-count">{{ events.length }} events</span>
    </div>

    <div v-if="loading" class="loading">
      Loading events...
    </div>

    <div v-else-if="events.length === 0" class="empty">
      No events to display. Try enabling more filters.
    </div>

    <div v-else class="events-list">
      <EventItem
        v-for="event in events"
        :key="event.id"
        :event="event"
      />
    </div>
  </div>
</template>

<style scoped>
.event-timeline {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1e1e1e;
  border-radius: 8px;
  overflow: hidden;
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #252525;
  border-bottom: 1px solid #333;
}

.timeline-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.event-count {
  font-size: 12px;
  color: #888;
}

.loading,
.empty {
  padding: 24px;
  text-align: center;
  color: #888;
}

.events-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
</style>
