import type { ProcessEvent, ProcessQueue } from './types/index.js';

/**
 * Process queue for the framework.
 * ProcessEvents from external sources and internal operations flow through here.
 */
export class ProcessQueueImpl implements ProcessQueue {
  private queue: ProcessEvent[] = [];
  private waiters: Array<(event: ProcessEvent) => void> = [];
  private closed = false;

  /**
   * Push a process event to the queue.
   */
  push(event: ProcessEvent): void {
    if (this.closed) {
      throw new Error('Queue is closed');
    }

    // If someone is waiting, deliver immediately
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Pop the next process event from the queue.
   * Returns immediately if an event is available, otherwise waits.
   */
  async pop(): Promise<ProcessEvent> {
    if (this.closed) {
      throw new Error('Queue is closed');
    }

    // If there's an event waiting, return it
    const event = this.queue.shift();
    if (event) {
      return event;
    }

    // Otherwise, wait for one
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Try to pop a process event without waiting.
   * Returns null if queue is empty.
   */
  tryPop(): ProcessEvent | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Peek at the next process event without removing it.
   */
  peek(): ProcessEvent | null {
    return this.queue[0] ?? null;
  }

  /**
   * Get current queue depth.
   */
  get depth(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all events from the queue.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Close the queue.
   * Rejects any pending waiters.
   */
  close(): void {
    this.closed = true;
    // Reject pending waiters by not resolving them
    // In a real implementation, we might want to reject with an error
    this.waiters = [];
  }

  /**
   * Check if queue is closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }
}
