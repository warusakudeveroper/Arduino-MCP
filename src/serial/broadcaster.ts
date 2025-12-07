/**
 * Serial Event Broadcaster
 * Manages SSE clients and broadcasts serial events
 */

import * as http from 'http';
import { SerialEventPayload } from '../types.js';

/**
 * Serial Broadcaster for SSE events
 */
export class SerialBroadcaster {
  private clients = new Set<http.ServerResponse>();
  private keepAliveTimer?: NodeJS.Timeout;
  private buffer: SerialEventPayload[] = [];
  private bufferLimit: number;

  constructor(bufferLimit: number = 500) {
    this.bufferLimit = bufferLimit;
  }

  /**
   * Add SSE client
   */
  addClient(res: http.ServerResponse): void {
    this.clients.add(res);
    this.flushBuffer(res);
    this.ensureKeepAlive();
  }

  /**
   * Remove SSE client
   */
  removeClient(res: http.ServerResponse): void {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  /**
   * Broadcast event to all clients
   */
  broadcast(event: SerialEventPayload): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        // Client disconnected, will be removed on next iteration
      }
    }
    
    // Buffer the event
    this.buffer.push(event);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }
  }

  /**
   * Get buffered events
   */
  getBuffer(): SerialEventPayload[] {
    return [...this.buffer];
  }

  /**
   * Clear buffer
   */
  clearBuffer(): void {
    this.buffer = [];
  }

  /**
   * Set buffer limit
   */
  setBufferLimit(limit: number): void {
    this.bufferLimit = limit;
    if (this.buffer.length > limit) {
      this.buffer.splice(0, this.buffer.length - limit);
    }
  }

  /**
   * Get client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Flush buffer to a single client
   */
  private flushBuffer(res: http.ServerResponse): void {
    for (const event of this.buffer) {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        break;
      }
    }
  }

  /**
   * Ensure keep-alive timer is running
   */
  private ensureKeepAlive(): void {
    if (this.keepAliveTimer) return;
    
    this.keepAliveTimer = setInterval(() => {
      const data = `data: ${JSON.stringify({ type: 'keep-alive' })}\n\n`;
      for (const client of this.clients) {
        try {
          client.write(data);
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15_000);
  }
}

// Singleton instance
export const serialBroadcaster = new SerialBroadcaster();

