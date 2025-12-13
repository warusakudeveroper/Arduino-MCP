/**
 * Device Health Monitor
 * Detects reboots, error loops, and tracks device stability
 */

import { createLogger } from '../utils/logger.js';
import { BufferedLine } from './port-buffer.js';

const logger = createLogger('DeviceHealth');

// Reboot/crash detection patterns
const REBOOT_PATTERNS = [
  { pattern: /rst:0x([0-9a-f]+)/i, type: 'reset', extract: 'code' },
  { pattern: /ets [A-Za-z]+ \d+/i, type: 'boot', extract: null },
  { pattern: /boot:0x([0-9a-f]+)/i, type: 'boot', extract: 'mode' },
  { pattern: /Brownout detector/i, type: 'brownout', extract: null },
  { pattern: /Guru Meditation Error/i, type: 'guru_meditation', extract: null },
  { pattern: /Backtrace:/i, type: 'backtrace', extract: null },
  { pattern: /Task watchdog got triggered/i, type: 'wdt_task', extract: null },
  { pattern: /Interrupt watchdog/i, type: 'wdt_interrupt', extract: null },
  { pattern: /panic/i, type: 'panic', extract: null },
  { pattern: /abort\(\)/i, type: 'abort', extract: null },
  { pattern: /LoadProhibited/i, type: 'load_prohibited', extract: null },
  { pattern: /StoreProhibited/i, type: 'store_prohibited', extract: null },
  { pattern: /InstrFetchProhibited/i, type: 'instr_fetch_prohibited', extract: null },
];

// Patterns that indicate normal startup (to distinguish from crash loops)
const STARTUP_MARKERS = [
  /WiFi.*[Cc]onnect/i,
  /::RegisteredInfo::/,
  /setup\(\) complete/i,
  /Ready/i,
  /HTTP server started/i,
];

// Patterns that are normal retry operations (should NOT be treated as error loops)
// These are expected to repeat multiple times before success
const NORMAL_RETRY_PATTERNS = [
  // WiFi connection attempts
  /Attempt \d+\/\d+/i,
  /Trying SSID/i,
  /WiFi\.begin/i,
  /status=\d/i,  // WiFi status codes during connection
  /Connecting to/i,
  /Reconnecting/i,

  // NTP time sync
  /NTP.*sync/i,
  /time.*server/i,
  /Waiting for NTP/i,
  /sntp/i,

  // HTTP/HTTPS retries and redirects
  /HTTP.*redirect/i,
  /30[1237]/,  // HTTP redirect status codes
  /Retry/i,
  /retrying/i,

  // MQTT connection
  /MQTT.*connect/i,
  /broker.*connect/i,

  // mDNS
  /mDNS/i,

  // General network
  /ping/i,
  /DNS.*resolv/i,
  /DNS\d+:/i,  // Network status periodic output (e.g., "DNS0: 192.168.1.1")

  // Network status output (periodic display, not errors)
  /Network Status/i,
  /IP:\s*\d+\.\d+\.\d+\.\d+/i,
  /Gateway:/i,
  /Subnet:/i,
  /RSSI:/i,
  /MAC:/i,

  // ESP32 bootloader messages (normal startup sequence)
  /^load:0x/i,
  /^entry 0x/i,
  /^configsip:/i,
  /^clk_drv:/i,
  /^mode:DIO/i,
  /^ets [A-Za-z]+/i,
];

export interface RebootEvent {
  timestamp: number;
  type: string;
  resetCode?: string;
  bootMode?: string;
  lastLogBeforeCrash?: string[];
  stackTrace?: string[];
}

export interface LoopDetection {
  detected: boolean;
  pattern?: string;
  occurrences: number;
  intervalMs: number;
  confidence: number;  // 0-1
}

export interface DeviceHealthStatus {
  port: string;
  status: 'healthy' | 'unstable' | 'crash_loop' | 'unknown';
  rebootCount: number;
  rebootCountLast5Min: number;
  avgUptimeSeconds: number;
  lastReboot?: RebootEvent;
  loopDetection: LoopDetection;
  lastLogsBeforeCrash: string[];
  suspectedPattern?: string;
  suggestion?: string;
  confidence: number;
}

interface PortHealthData {
  port: string;
  reboots: RebootEvent[];
  logHistory: BufferedLine[];
  lastStableTime?: number;
  startupDetected: boolean;
  consecutiveReboots: number;
  recentPatterns: Map<string, number[]>;  // pattern -> timestamps
}

/**
 * Device Health Monitor - tracks device stability per port
 */
export class DeviceHealthMonitor {
  private healthData = new Map<string, PortHealthData>();
  private maxHistorySize: number;
  private loopThresholdMs: number;  // Time window for loop detection
  private loopMinOccurrences: number;  // Minimum occurrences to detect loop

  constructor(options?: {
    maxHistorySize?: number;
    loopThresholdMs?: number;
    loopMinOccurrences?: number;
  }) {
    this.maxHistorySize = options?.maxHistorySize ?? 500;
    this.loopThresholdMs = options?.loopThresholdMs ?? 60000;  // 1 minute
    this.loopMinOccurrences = options?.loopMinOccurrences ?? 3;
  }

  /**
   * Get or create health data for a port
   */
  private getPortData(port: string): PortHealthData {
    let data = this.healthData.get(port);
    if (!data) {
      data = {
        port,
        reboots: [],
        logHistory: [],
        startupDetected: false,
        consecutiveReboots: 0,
        recentPatterns: new Map(),
      };
      this.healthData.set(port, data);
    }
    return data;
  }

  /**
   * Process a log line and detect health issues
   */
  processLine(port: string, line: BufferedLine): {
    isReboot: boolean;
    isCrash: boolean;
    loopDetected: boolean;
    event?: RebootEvent;
  } {
    const data = this.getPortData(port);
    const result = {
      isReboot: false,
      isCrash: false,
      loopDetected: false,
      event: undefined as RebootEvent | undefined,
    };

    // Add to history
    data.logHistory.push(line);
    if (data.logHistory.length > this.maxHistorySize) {
      data.logHistory.shift();
    }

    // Check for reboot patterns
    for (const { pattern, type, extract } of REBOOT_PATTERNS) {
      const match = pattern.exec(line.line);
      if (match) {
        result.isReboot = true;
        result.isCrash = ['guru_meditation', 'backtrace', 'wdt_task', 'wdt_interrupt', 'panic', 'abort', 'brownout'].includes(type);

        const event: RebootEvent = {
          timestamp: Date.now(),
          type,
          lastLogBeforeCrash: this.getLastNLogs(data, 10),
        };

        if (extract === 'code' && match[1]) {
          event.resetCode = match[1];
        }
        if (extract === 'mode' && match[1]) {
          event.bootMode = match[1];
        }

        // Collect stack trace if this is a crash
        if (result.isCrash) {
          event.stackTrace = this.collectStackTrace(data);
        }

        data.reboots.push(event);
        data.consecutiveReboots++;
        data.startupDetected = false;
        result.event = event;

        // Keep only recent reboots
        const cutoff = Date.now() - 300000;  // 5 minutes
        data.reboots = data.reboots.filter(r => r.timestamp > cutoff);

        logger.warn('Reboot detected', {
          port,
          type,
          consecutiveReboots: data.consecutiveReboots,
          rebootsLast5Min: data.reboots.length,
        });

        break;
      }
    }

    // Check for startup markers (device booted successfully)
    if (!data.startupDetected) {
      for (const marker of STARTUP_MARKERS) {
        if (marker.test(line.line)) {
          data.startupDetected = true;
          data.lastStableTime = Date.now();
          data.consecutiveReboots = 0;
          logger.info('Startup detected', { port });
          break;
        }
      }
    }

    // Track patterns for loop detection
    this.trackPattern(data, line.line);

    // Check for loop
    const loop = this.detectLoop(data);
    if (loop.detected) {
      result.loopDetected = true;
      logger.warn('Loop detected', { port, pattern: loop.pattern, occurrences: loop.occurrences });
    }

    return result;
  }

  /**
   * Check if a line matches normal retry patterns (should not be treated as error loop)
   */
  private isNormalRetryPattern(line: string): boolean {
    return NORMAL_RETRY_PATTERNS.some(pattern => pattern.test(line));
  }

  /**
   * Track pattern occurrences for loop detection
   */
  private trackPattern(data: PortHealthData, line: string): void {
    // Skip normal retry patterns - these are expected to repeat
    if (this.isNormalRetryPattern(line)) {
      return;
    }

    // Normalize line for pattern matching (remove timestamps, numbers that might change)
    const normalized = line
      .replace(/\d{2}:\d{2}:\d{2}/g, 'TIME')
      .replace(/\d+\.\d+\.\d+\.\d+/g, 'IP')
      .replace(/0x[0-9a-f]+/gi, 'HEX')
      .replace(/\d+/g, 'N')
      .substring(0, 100);  // Limit length

    const timestamps = data.recentPatterns.get(normalized) || [];
    timestamps.push(Date.now());

    // Keep only recent timestamps
    const cutoff = Date.now() - this.loopThresholdMs;
    const filtered = timestamps.filter(t => t > cutoff);

    if (filtered.length > 0) {
      data.recentPatterns.set(normalized, filtered);
    } else {
      data.recentPatterns.delete(normalized);
    }

    // Cleanup old patterns
    if (data.recentPatterns.size > 100) {
      const entries = Array.from(data.recentPatterns.entries());
      entries.sort((a, b) => b[1].length - a[1].length);
      data.recentPatterns = new Map(entries.slice(0, 50));
    }
  }

  /**
   * Detect loops in recent patterns
   */
  private detectLoop(data: PortHealthData): LoopDetection {
    let maxOccurrences = 0;
    let loopPattern: string | undefined;
    let intervalMs = 0;

    for (const [pattern, timestamps] of data.recentPatterns) {
      if (timestamps.length >= this.loopMinOccurrences && timestamps.length > maxOccurrences) {
        maxOccurrences = timestamps.length;
        loopPattern = pattern;

        // Calculate average interval
        if (timestamps.length > 1) {
          const intervals: number[] = [];
          for (let i = 1; i < timestamps.length; i++) {
            intervals.push(timestamps[i] - timestamps[i - 1]);
          }
          intervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        }
      }
    }

    const detected = maxOccurrences >= this.loopMinOccurrences;
    const confidence = detected ? Math.min(maxOccurrences / 10, 1) : 0;

    return {
      detected,
      pattern: loopPattern,
      occurrences: maxOccurrences,
      intervalMs,
      confidence,
    };
  }

  /**
   * Get last N log lines
   */
  private getLastNLogs(data: PortHealthData, n: number): string[] {
    return data.logHistory.slice(-n).map(l => l.line);
  }

  /**
   * Collect stack trace from recent logs
   */
  private collectStackTrace(data: PortHealthData): string[] {
    const trace: string[] = [];
    const logs = data.logHistory.slice(-50);

    for (const log of logs) {
      if (/Backtrace:|0x[0-9a-f]+:0x[0-9a-f]+/i.test(log.line)) {
        trace.push(log.line);
      }
    }

    return trace;
  }

  /**
   * Get health status for a port
   */
  getHealthStatus(port: string): DeviceHealthStatus {
    const data = this.getPortData(port);
    const now = Date.now();
    const fiveMinAgo = now - 300000;

    const rebootsLast5Min = data.reboots.filter(r => r.timestamp > fiveMinAgo);
    const loop = this.detectLoop(data);

    // Calculate average uptime
    let avgUptime = 0;
    if (data.reboots.length > 1) {
      const intervals: number[] = [];
      for (let i = 1; i < data.reboots.length; i++) {
        intervals.push(data.reboots[i].timestamp - data.reboots[i - 1].timestamp);
      }
      avgUptime = intervals.reduce((a, b) => a + b, 0) / intervals.length / 1000;
    }

    // Determine status
    let status: DeviceHealthStatus['status'] = 'unknown';
    let suggestion: string | undefined;
    let suspectedPattern: string | undefined;

    if (data.startupDetected && rebootsLast5Min.length === 0) {
      status = 'healthy';
    } else if (rebootsLast5Min.length >= 5 || loop.detected) {
      status = 'crash_loop';
      suspectedPattern = loop.pattern;

      // Generate suggestion based on patterns
      const lastReboot = data.reboots[data.reboots.length - 1];
      if (lastReboot?.type === 'wdt_task') {
        suggestion = 'Task Watchdog triggered. Check for blocking operations, add yield()/delay() in loops.';
      } else if (lastReboot?.type === 'brownout') {
        suggestion = 'Brownout detected. Check power supply, reduce WiFi TX power, or add capacitors.';
      } else if (lastReboot?.type === 'guru_meditation') {
        suggestion = 'Memory access violation. Check pointer operations and array bounds.';
      } else if (loop.detected) {
        suggestion = `Loop detected (${loop.occurrences}x in ${Math.round(loop.intervalMs)}ms). Check for race conditions or async timing issues.`;
      }
    } else if (rebootsLast5Min.length > 0) {
      status = 'unstable';
      suggestion = 'Device rebooted recently. Monitor for stability.';
    }

    return {
      port,
      status,
      rebootCount: data.reboots.length,
      rebootCountLast5Min: rebootsLast5Min.length,
      avgUptimeSeconds: avgUptime,
      lastReboot: data.reboots[data.reboots.length - 1],
      loopDetection: loop,
      lastLogsBeforeCrash: this.getLastNLogs(data, 20),
      suspectedPattern,
      suggestion,
      confidence: loop.confidence,
    };
  }

  /**
   * Get health summary for all ports (for MCP/AI)
   */
  getAllHealthStatus(): DeviceHealthStatus[] {
    return Array.from(this.healthData.keys()).map(port => this.getHealthStatus(port));
  }

  /**
   * Get AI-friendly report
   */
  getAIReport(port: string): {
    status: string;
    summary: string;
    details: DeviceHealthStatus;
    actionRequired: boolean;
  } {
    const health = this.getHealthStatus(port);

    let summary = '';
    let actionRequired = false;

    switch (health.status) {
      case 'healthy':
        summary = `Device on ${port} is running normally.`;
        break;
      case 'unstable':
        summary = `Device on ${port} has rebooted ${health.rebootCountLast5Min} time(s) in the last 5 minutes.`;
        actionRequired = true;
        break;
      case 'crash_loop':
        summary = `CRITICAL: Device on ${port} is in a crash loop. ${health.rebootCountLast5Min} reboots in 5 minutes. `;
        if (health.suspectedPattern) {
          summary += `Suspected issue: ${health.suspectedPattern}. `;
        }
        if (health.suggestion) {
          summary += health.suggestion;
        }
        actionRequired = true;
        break;
      default:
        summary = `Device on ${port} status unknown. Start monitoring to collect data.`;
    }

    return {
      status: health.status,
      summary,
      details: health,
      actionRequired,
    };
  }

  /**
   * Clear health data for a port
   */
  clearPort(port: string): void {
    this.healthData.delete(port);
    logger.info('Health data cleared', { port });
  }

  /**
   * Clear all health data
   */
  clearAll(): void {
    this.healthData.clear();
    logger.info('All health data cleared');
  }
}

// Singleton instance
export const deviceHealthMonitor = new DeviceHealthMonitor();
