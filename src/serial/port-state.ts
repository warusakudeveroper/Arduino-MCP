/**
 * Port State Manager
 * Tracks port states, handles conflicts, and manages port locking
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('PortState');

export type PortState = 'idle' | 'monitoring' | 'uploading' | 'compiling' | 'error' | 'locked';

export interface PortStateInfo {
  port: string;
  state: PortState;
  lockedBy?: string;  // Process/operation that locked the port
  lockedAt?: number;  // Timestamp when locked
  lastActivity?: number;  // Last activity timestamp
  error?: string;  // Error message if state is 'error'
  metadata?: Record<string, unknown>;  // Additional metadata
}

export interface LockResult {
  success: boolean;
  port: string;
  state: PortState;
  error?: string;
  previousOwner?: string;
}

/**
 * Port State Manager - singleton for managing port states across the application
 */
export class PortStateManager {
  private states = new Map<string, PortStateInfo>();
  private lockTimeoutMs: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(lockTimeoutMs: number = 120000) {  // 2 minutes default lock timeout
    this.lockTimeoutMs = lockTimeoutMs;

    // Cleanup stale locks periodically
    this.cleanupInterval = setInterval(() => this.cleanupStaleLocks(), 30000);
  }

  /**
   * Get current state of a port
   */
  getState(port: string): PortStateInfo {
    const existing = this.states.get(port);
    if (existing) {
      return { ...existing };
    }
    return { port, state: 'idle' };
  }

  /**
   * Get all port states
   */
  getAllStates(): PortStateInfo[] {
    return Array.from(this.states.values()).map(s => ({ ...s }));
  }

  /**
   * Check if port is available for use
   */
  isAvailable(port: string): boolean {
    const state = this.getState(port);
    return state.state === 'idle' || this.isLockExpired(state);
  }

  /**
   * Check if port is in use (monitoring or uploading)
   */
  isInUse(port: string): boolean {
    const state = this.getState(port);
    if (this.isLockExpired(state)) return false;
    return state.state !== 'idle' && state.state !== 'error';
  }

  /**
   * Try to acquire lock for a port
   */
  tryLock(port: string, operation: string, force: boolean = false): LockResult {
    const current = this.getState(port);

    // Check if lock is expired
    if (this.isLockExpired(current)) {
      logger.info('Releasing expired lock', { port, previousOwner: current.lockedBy });
      this.release(port);
    }

    // Check current state
    if (!force && current.state !== 'idle' && current.state !== 'error') {
      logger.warn('Port lock denied', { port, operation, currentState: current.state, lockedBy: current.lockedBy });
      return {
        success: false,
        port,
        state: current.state,
        error: `Port is ${current.state}${current.lockedBy ? ` by ${current.lockedBy}` : ''}`,
        previousOwner: current.lockedBy,
      };
    }

    // Force release if requested
    if (force && current.state !== 'idle') {
      logger.warn('Force releasing port', { port, previousState: current.state, previousOwner: current.lockedBy });
    }

    // Acquire lock
    const newState: PortStateInfo = {
      port,
      state: 'locked',
      lockedBy: operation,
      lockedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.states.set(port, newState);
    logger.info('Port locked', { port, operation });

    return {
      success: true,
      port,
      state: 'locked',
    };
  }

  /**
   * Set port state (must have lock or be setting to idle)
   */
  setState(port: string, state: PortState, metadata?: Record<string, unknown>): boolean {
    const current = this.states.get(port);

    // Allow setting to idle or error without lock
    if (state === 'idle' || state === 'error') {
      if (state === 'error') {
        this.states.set(port, {
          port,
          state: 'error',
          error: metadata?.error as string,
          lastActivity: Date.now(),
          metadata,
        });
      } else {
        this.states.delete(port);
      }
      logger.info('Port state changed', { port, state });
      return true;
    }

    // Update state
    this.states.set(port, {
      ...current,
      port,
      state,
      lastActivity: Date.now(),
      metadata: { ...current?.metadata, ...metadata },
    });

    logger.info('Port state changed', { port, state });
    return true;
  }

  /**
   * Release port lock
   */
  release(port: string): void {
    const current = this.states.get(port);
    if (current) {
      logger.info('Port released', { port, previousState: current.state, owner: current.lockedBy });
    }
    this.states.delete(port);
  }

  /**
   * Update last activity timestamp
   */
  touch(port: string): void {
    const current = this.states.get(port);
    if (current) {
      current.lastActivity = Date.now();
    }
  }

  /**
   * Check if lock is expired
   */
  private isLockExpired(state: PortStateInfo): boolean {
    if (!state.lockedAt) return false;
    return Date.now() - state.lockedAt > this.lockTimeoutMs;
  }

  /**
   * Cleanup stale locks
   */
  private cleanupStaleLocks(): void {
    const now = Date.now();
    for (const [port, state] of this.states) {
      if (state.lockedAt && now - state.lockedAt > this.lockTimeoutMs) {
        logger.warn('Cleaning up stale lock', { port, owner: state.lockedBy, age: now - state.lockedAt });
        this.states.delete(port);
      }
    }
  }

  /**
   * Get summary for AI/MCP
   */
  getSummary(): {
    totalPorts: number;
    idle: number;
    monitoring: number;
    uploading: number;
    error: number;
    locked: number;
    ports: Array<{ port: string; state: PortState; owner?: string }>;
  } {
    const states = this.getAllStates();
    const counts = { idle: 0, monitoring: 0, uploading: 0, error: 0, locked: 0, compiling: 0 };

    for (const s of states) {
      counts[s.state]++;
    }

    return {
      totalPorts: states.length,
      idle: counts.idle,
      monitoring: counts.monitoring,
      uploading: counts.uploading,
      error: counts.error,
      locked: counts.locked,
      ports: states.map(s => ({
        port: s.port,
        state: s.state,
        owner: s.lockedBy,
      })),
    };
  }

  /**
   * Dispose manager
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.states.clear();
  }
}

// Singleton instance
export const portStateManager = new PortStateManager();
