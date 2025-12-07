/**
 * Serial Monitor Manager and Session
 * Handles serial port monitoring with auto-baud detection
 */

import { execa, ExecaChildProcess } from 'execa';
import { randomUUID } from 'crypto';
import { MonitorOptions, MonitorSummary } from '../types.js';
import { serialBroadcaster } from './broadcaster.js';
import { pythonRunner } from '../utils/cli-runner.js';
import { installLogService } from '../config/workspace.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Monitor');

// Reboot detection patterns
const REBOOT_PATTERNS = [
  /rst:0x[0-9a-f]+/i,
  /Brownout detector/i,
  /Backtrace:/i,
  /Guru Meditation Error/i,
  /CPU halted/i,
];

// Python script for serial monitoring
const MONITOR_SCRIPT = `
import sys, serial, time, json

port = sys.argv[1]
baud = int(sys.argv[2])
auto_baud = sys.argv[3] == 'true'

ser = None
try:
    ser = serial.Serial(port, baud, timeout=0.1)
    ser.dtr = False
    ser.rts = False
    time.sleep(0.1)
    ser.dtr = True
    ser.rts = True
    time.sleep(0.05)
    ser.dtr = False
    ser.rts = False
    time.sleep(0.1)
    
    boot_lines = 0
    while True:
        try:
            line = ser.readline()
            if line:
                text = line.decode('utf-8', errors='replace').rstrip()
                print(text, flush=True)
                boot_lines += 1
                if auto_baud and boot_lines > 5 and baud == 74880:
                    ser.baudrate = 115200
                    auto_baud = False
        except serial.SerialException as e:
            print(f"Serial error: {e}", file=sys.stderr)
            break
        except KeyboardInterrupt:
            break
finally:
    if ser:
        ser.close()
`;

/**
 * Monitor Session - represents a single serial monitoring session
 */
export class MonitorSession {
  private child?: ExecaChildProcess;
  private startTime = new Date();
  private timer?: NodeJS.Timeout;
  private lines = 0;
  private lastLine?: string;
  private resolved = false;
  private readonly completionResolvers: ((value: MonitorSummary) => void)[] = [];
  private readonly completionPromise: Promise<MonitorSummary>;
  private rebootDetected = false;
  private exitCode?: number;
  private stopReason = 'completed';
  private readonly autoBaudEnabled: boolean;
  private selectedBaud: number;

  constructor(
    private readonly options: MonitorOptions,
    readonly token: string
  ) {
    this.completionPromise = new Promise((resolve) => {
      this.completionResolvers.push(resolve);
    });
    this.autoBaudEnabled = options.autoBaud;
    this.selectedBaud = options.baud;
  }

  get port(): string {
    return this.options.port;
  }

  get baud(): number {
    return this.selectedBaud;
  }

  /**
   * Start the monitor session
   */
  async start(): Promise<void> {
    const pythonPath = pythonRunner.getPath();
    
    const child = execa(pythonPath, ['-c', MONITOR_SCRIPT, this.options.port, String(this.options.baud), String(this.options.autoBaud)], {
      reject: false,
      buffer: false,
    });

    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split('\n').filter(l => l.length > 0);
      
      for (const line of lines) {
        this.lines += 1;
        this.lastLine = line;

        // Check for reboot patterns
        if (this.options.detectReboot && REBOOT_PATTERNS.some(p => p.test(line))) {
          this.rebootDetected = true;
        }

        // Check for RegisteredInfo pattern
        const registeredInfo = installLogService.parseRegisteredInfo(line);
        if (registeredInfo) {
          installLogService.addEntry(this.options.port, registeredInfo)
            .then(key => {
              serialBroadcaster.broadcast({
                type: 'install_log',
                port: this.options.port,
                key,
                entry: registeredInfo,
              });
            })
            .catch(e => logger.error('Failed to save install log', { error: String(e) }));
        }

        // Check for stop pattern
        if (this.options.stopRegex?.test(line)) {
          this.stopReason = 'pattern_matched';
          this.stop();
          return;
        }

        // Broadcast event
        serialBroadcaster.broadcast({
          type: 'serial',
          token: this.token,
          port: this.options.port,
          line,
          raw: false,
          lineNumber: this.lines,
          baud: this.selectedBaud,
          timestamp: new Date().toISOString(),
        });

        // Check max lines
        if (this.options.maxLines > 0 && this.lines >= this.options.maxLines) {
          this.stopReason = 'max_lines';
          this.stop();
          return;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8');
      serialBroadcaster.broadcast({
        type: 'serial',
        token: this.token,
        port: this.options.port,
        line,
        raw: false,
        stream: 'stderr',
        timestamp: new Date().toISOString(),
      });
    });

    child.on('exit', (code) => {
      this.exitCode = code ?? undefined;
      this.resolve();
    });

    // Set timeout
    if (this.options.maxSeconds > 0) {
      this.timer = setTimeout(() => {
        this.stopReason = 'timeout';
        this.stop();
      }, this.options.maxSeconds * 1000);
    }

    logger.info('Monitor started', { port: this.options.port, baud: this.options.baud, token: this.token });
  }

  /**
   * Stop the monitor session
   */
  async stop(): Promise<MonitorSummary> {
    if (this.resolved) {
      return this.completionPromise;
    }
    
    if (this.stopReason === 'completed') {
      this.stopReason = 'manual';
    }
    
    if (this.child) {
      this.child.kill('SIGINT', { forceKillAfterTimeout: 1000 });
    }
    
    return this.completionPromise;
  }

  /**
   * Wait for completion
   */
  onComplete(): Promise<MonitorSummary> {
    return this.completionPromise;
  }

  /**
   * Resolve the session
   */
  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const elapsedSeconds = (Date.now() - this.startTime.getTime()) / 1000;

    const summary: MonitorSummary = {
      ok: true,
      token: this.token,
      port: this.options.port,
      baud: this.selectedBaud,
      lines: this.lines,
      elapsedSeconds,
      rebootDetected: this.rebootDetected,
      lastLine: this.lastLine,
      exitCode: this.exitCode,
      reason: this.stopReason,
    };

    for (const resolver of this.completionResolvers) {
      resolver(summary);
    }

    serialBroadcaster.broadcast({
      type: 'serial_end',
      token: this.token,
      port: this.options.port,
      reason: this.stopReason,
      elapsedSeconds,
      rebootDetected: this.rebootDetected,
      lastLine: this.lastLine,
      exitCode: this.exitCode,
    });

    logger.info('Monitor stopped', { 
      port: this.options.port, 
      reason: this.stopReason, 
      lines: this.lines,
      elapsed: elapsedSeconds.toFixed(1) + 's'
    });
  }
}

/**
 * Monitor Manager - manages multiple monitor sessions
 */
export class MonitorManager {
  private sessions = new Map<string, MonitorSession>();

  /**
   * Start a new monitor session
   */
  async start(options: {
    port: string;
    baud?: number;
    auto_baud?: boolean;
    raw?: boolean;
    max_seconds?: number;
    max_lines?: number;
    stop_on?: string;
    detect_reboot?: boolean;
  }): Promise<MonitorSession> {
    const token = randomUUID();
    
    let stopRegex: RegExp | undefined;
    if (options.stop_on) {
      try {
        stopRegex = new RegExp(options.stop_on);
      } catch (error) {
        throw new Error(`Invalid stop_on regex: ${options.stop_on}`);
      }
    }

    const monitorOptions: MonitorOptions = {
      port: options.port,
      baud: options.baud ?? 115200,
      autoBaud: options.auto_baud ?? true,
      raw: options.raw ?? false,
      maxSeconds: options.max_seconds ?? 0,
      maxLines: options.max_lines ?? 0,
      stopRegex,
      detectReboot: options.detect_reboot ?? true,
    };

    const session = new MonitorSession(monitorOptions, token);
    this.sessions.set(token, session);

    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(token);
      throw error;
    }

    session.onComplete().then(() => {
      this.sessions.delete(token);
    });

    return session;
  }

  /**
   * Get session by token or port
   */
  get(token?: string, port?: string): MonitorSession | undefined {
    if (token) {
      return this.sessions.get(token);
    }
    if (!port) {
      return undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.port === port) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * List all session tokens
   */
  listTokens(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * List all sessions with details
   */
  listSessions(): Array<{ token: string; port: string }> {
    return Array.from(this.sessions.entries()).map(([token, session]) => ({
      token,
      port: session.port,
    }));
  }

  /**
   * Stop all sessions
   */
  async stopAll(): Promise<void> {
    const promises: Promise<MonitorSummary>[] = [];
    for (const session of this.sessions.values()) {
      promises.push(session.stop());
    }
    await Promise.all(promises);
    logger.info('All monitors stopped', { count: promises.length });
  }
}

// Singleton instance
export const monitorManager = new MonitorManager();

