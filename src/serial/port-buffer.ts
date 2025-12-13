/**
 * Port-specific Ring Buffer for Serial Console
 * Provides per-port log storage with condition-based capture
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('PortBuffer');

export interface BufferedLine {
  timestamp: string;
  line: string;
  lineNumber: number;
}

export interface CaptureCondition {
  id: string;
  port: string;
  pattern: RegExp;
  timeoutMs: number;
  maxLines: number;
  capturedLines: BufferedLine[];
  startTime: number;
  resolved: boolean;
  resolver: (result: CaptureResult) => void;
}

export interface CaptureResult {
  success: boolean;
  matchedLine?: BufferedLine;
  capturedLines: BufferedLine[];
  reason: 'pattern_matched' | 'timeout' | 'max_lines' | 'cancelled';
  elapsedMs: number;
}

export interface PortBufferStats {
  port: string;
  lineCount: number;
  oldestTimestamp?: string;
  newestTimestamp?: string;
  activeCaptures: number;
}

/**
 * Ring buffer for a single port
 */
class PortRingBuffer {
  private buffer: BufferedLine[] = [];
  private maxSize: number;
  private totalLines = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Add a line to the buffer
   */
  push(line: string): BufferedLine {
    this.totalLines++;
    const entry: BufferedLine = {
      timestamp: new Date().toISOString(),
      line,
      lineNumber: this.totalLines,
    };

    this.buffer.push(entry);

    // Remove oldest entries if over limit
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    return entry;
  }

  /**
   * Get all buffered lines
   */
  getAll(): BufferedLine[] {
    return [...this.buffer];
  }

  /**
   * Get recent N lines
   */
  getRecent(count: number): BufferedLine[] {
    return this.buffer.slice(-count);
  }

  /**
   * Get lines since a specific line number
   */
  getSince(lineNumber: number): BufferedLine[] {
    return this.buffer.filter(l => l.lineNumber > lineNumber);
  }

  /**
   * Search lines by pattern
   */
  search(pattern: RegExp): BufferedLine[] {
    return this.buffer.filter(l => pattern.test(l.line));
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get stats
   */
  getStats(): { lineCount: number; oldestTimestamp?: string; newestTimestamp?: string } {
    return {
      lineCount: this.buffer.length,
      oldestTimestamp: this.buffer[0]?.timestamp,
      newestTimestamp: this.buffer[this.buffer.length - 1]?.timestamp,
    };
  }

  /**
   * Set max size
   */
  setMaxSize(size: number): void {
    this.maxSize = size;
    if (this.buffer.length > size) {
      this.buffer.splice(0, this.buffer.length - size);
    }
  }
}

/**
 * Port Buffer Manager - manages buffers for multiple ports
 */
export class PortBufferManager {
  private buffers = new Map<string, PortRingBuffer>();
  private captures = new Map<string, CaptureCondition>();
  private defaultBufferSize: number;
  private captureIdCounter = 0;

  constructor(defaultBufferSize: number = 1000) {
    this.defaultBufferSize = defaultBufferSize;
  }

  /**
   * Get or create buffer for a port
   */
  private getOrCreateBuffer(port: string): PortRingBuffer {
    let buffer = this.buffers.get(port);
    if (!buffer) {
      buffer = new PortRingBuffer(this.defaultBufferSize);
      this.buffers.set(port, buffer);
      logger.info('Created buffer for port', { port });
    }
    return buffer;
  }

  /**
   * Add a line to a port's buffer
   * This is called from MonitorSession when new serial data arrives
   */
  addLine(port: string, line: string): BufferedLine {
    const buffer = this.getOrCreateBuffer(port);
    const entry = buffer.push(line);

    // Check active captures for this port
    for (const capture of this.captures.values()) {
      if (capture.port === port && !capture.resolved) {
        capture.capturedLines.push(entry);

        // Check pattern match
        if (capture.pattern.test(line)) {
          this.resolveCapture(capture.id, {
            success: true,
            matchedLine: entry,
            capturedLines: capture.capturedLines,
            reason: 'pattern_matched',
            elapsedMs: Date.now() - capture.startTime,
          });
        }
        // Check max lines
        else if (capture.maxLines > 0 && capture.capturedLines.length >= capture.maxLines) {
          this.resolveCapture(capture.id, {
            success: false,
            capturedLines: capture.capturedLines,
            reason: 'max_lines',
            elapsedMs: Date.now() - capture.startTime,
          });
        }
      }
    }

    return entry;
  }

  /**
   * Get all buffered lines for a port
   */
  getBuffer(port: string): BufferedLine[] {
    const buffer = this.buffers.get(port);
    return buffer ? buffer.getAll() : [];
  }

  /**
   * Get recent lines for a port
   */
  getRecentLines(port: string, count: number = 100): BufferedLine[] {
    const buffer = this.buffers.get(port);
    return buffer ? buffer.getRecent(count) : [];
  }

  /**
   * Get lines since a specific line number
   */
  getLinesSince(port: string, lineNumber: number): BufferedLine[] {
    const buffer = this.buffers.get(port);
    return buffer ? buffer.getSince(lineNumber) : [];
  }

  /**
   * Search buffer by pattern
   */
  searchBuffer(port: string, pattern: string | RegExp): BufferedLine[] {
    const buffer = this.buffers.get(port);
    if (!buffer) return [];

    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    return buffer.search(regex);
  }

  /**
   * Clear buffer for a port
   */
  clearBuffer(port: string): void {
    const buffer = this.buffers.get(port);
    if (buffer) {
      buffer.clear();
      logger.info('Buffer cleared', { port });
    }
  }

  /**
   * Clear all buffers
   */
  clearAllBuffers(): void {
    for (const [port, buffer] of this.buffers) {
      buffer.clear();
    }
    logger.info('All buffers cleared');
  }

  /**
   * Start a condition-based capture
   * Returns a promise that resolves when the pattern is matched or timeout occurs
   */
  startCapture(options: {
    port: string;
    pattern: string | RegExp;
    timeoutMs?: number;
    maxLines?: number;
  }): { captureId: string; promise: Promise<CaptureResult> } {
    const captureId = `capture_${++this.captureIdCounter}`;
    const regex = typeof options.pattern === 'string'
      ? new RegExp(options.pattern)
      : options.pattern;

    let resolver: (result: CaptureResult) => void;
    const promise = new Promise<CaptureResult>((resolve) => {
      resolver = resolve;
    });

    const capture: CaptureCondition = {
      id: captureId,
      port: options.port,
      pattern: regex,
      timeoutMs: options.timeoutMs ?? 30000,
      maxLines: options.maxLines ?? 0,
      capturedLines: [],
      startTime: Date.now(),
      resolved: false,
      resolver: resolver!,
    };

    this.captures.set(captureId, capture);

    // Set timeout
    if (capture.timeoutMs > 0) {
      setTimeout(() => {
        if (!capture.resolved) {
          this.resolveCapture(captureId, {
            success: false,
            capturedLines: capture.capturedLines,
            reason: 'timeout',
            elapsedMs: Date.now() - capture.startTime,
          });
        }
      }, capture.timeoutMs);
    }

    logger.info('Capture started', {
      captureId,
      port: options.port,
      pattern: regex.source,
      timeoutMs: capture.timeoutMs,
    });

    return { captureId, promise };
  }

  /**
   * Cancel an active capture
   */
  cancelCapture(captureId: string): boolean {
    const capture = this.captures.get(captureId);
    if (!capture || capture.resolved) {
      return false;
    }

    this.resolveCapture(captureId, {
      success: false,
      capturedLines: capture.capturedLines,
      reason: 'cancelled',
      elapsedMs: Date.now() - capture.startTime,
    });

    return true;
  }

  /**
   * Resolve a capture
   */
  private resolveCapture(captureId: string, result: CaptureResult): void {
    const capture = this.captures.get(captureId);
    if (!capture || capture.resolved) return;

    capture.resolved = true;
    capture.resolver(result);
    this.captures.delete(captureId);

    logger.info('Capture resolved', {
      captureId,
      reason: result.reason,
      linesCapture: result.capturedLines.length,
      elapsedMs: result.elapsedMs,
    });
  }

  /**
   * Get active captures for a port
   */
  getActiveCaptures(port?: string): Array<{ id: string; port: string; pattern: string; elapsedMs: number }> {
    const result: Array<{ id: string; port: string; pattern: string; elapsedMs: number }> = [];

    for (const capture of this.captures.values()) {
      if (!capture.resolved && (!port || capture.port === port)) {
        result.push({
          id: capture.id,
          port: capture.port,
          pattern: capture.pattern.source,
          elapsedMs: Date.now() - capture.startTime,
        });
      }
    }

    return result;
  }

  /**
   * Get stats for all ports
   */
  getStats(): PortBufferStats[] {
    const stats: PortBufferStats[] = [];

    for (const [port, buffer] of this.buffers) {
      const bufferStats = buffer.getStats();
      const activeCaptures = Array.from(this.captures.values())
        .filter(c => c.port === port && !c.resolved).length;

      stats.push({
        port,
        lineCount: bufferStats.lineCount,
        oldestTimestamp: bufferStats.oldestTimestamp,
        newestTimestamp: bufferStats.newestTimestamp,
        activeCaptures,
      });
    }

    return stats;
  }

  /**
   * Get stats for a specific port
   */
  getPortStats(port: string): PortBufferStats | null {
    const buffer = this.buffers.get(port);
    if (!buffer) return null;

    const bufferStats = buffer.getStats();
    const activeCaptures = Array.from(this.captures.values())
      .filter(c => c.port === port && !c.resolved).length;

    return {
      port,
      lineCount: bufferStats.lineCount,
      oldestTimestamp: bufferStats.oldestTimestamp,
      newestTimestamp: bufferStats.newestTimestamp,
      activeCaptures,
    };
  }

  /**
   * Set buffer size for a port
   */
  setBufferSize(port: string, size: number): void {
    const buffer = this.getOrCreateBuffer(port);
    buffer.setMaxSize(size);
    logger.info('Buffer size updated', { port, size });
  }

  /**
   * Set default buffer size for new ports
   */
  setDefaultBufferSize(size: number): void {
    this.defaultBufferSize = size;
  }

  /**
   * Get list of ports with buffers
   */
  getPorts(): string[] {
    return Array.from(this.buffers.keys());
  }

  /**
   * Remove buffer for a port
   */
  removeBuffer(port: string): void {
    // Cancel any active captures
    for (const capture of this.captures.values()) {
      if (capture.port === port && !capture.resolved) {
        this.cancelCapture(capture.id);
      }
    }

    this.buffers.delete(port);
    logger.info('Buffer removed', { port });
  }
}

// Singleton instance
export const portBufferManager = new PortBufferManager();
