#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import { execa, type ExecaChildProcess } from 'execa';
import stripAnsi from 'strip-ansi';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../package.json' assert { type: 'json' };

const INSTRUCTIONS = `MCP Arduino ESP32 server for macOS. Tools provided:
- version: show arduino-cli version (JSON when available)
- ensure_core: install esp32:esp32 core if missing
- board_list: list detected serial ports via arduino-cli
- lib_install / lib_list: manage libraries with arduino-cli
- compile: run arduino-cli compile with diagnostics + artifact listing
- upload: flash sketch to board via arduino-cli upload
- list_artifacts: enumerate .bin/.elf/.map/.hex under build path
- monitor_start / monitor_stop: stream serial output with stop conditions + reboot detection
- pdca_cycle: compile -> upload -> monitor in a single run (useful for automated PDCA)

Defaults: FQBN esp32:esp32:esp32 (override with ESP32_FQBN). arduino-cli path can be overridden via ARDUINO_CLI.`;

const DEFAULT_FQBN = process.env.ESP32_FQBN ?? 'esp32:esp32:esp32';
const ARDUINO_CLI = process.env.ARDUINO_CLI ?? 'arduino-cli';
const ARTIFACT_EXTENSIONS = new Set(['.bin', '.elf', '.map', '.hex']);
const REBOOT_PATTERNS = [
  /rst:0x[0-9a-f]+/i,
  /Brownout detector/i,
  /Backtrace:/i,
  /Guru Meditation Error/i,
  /CPU halted/i,
];

const server = new McpServer(
  {
    name: 'mcp-arduino-esp32',
    version: String((pkg as { version?: string }).version ?? '0.0.0'),
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
    instructions: INSTRUCTIONS,
  },
);

interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  level: string;
  message: string;
  raw: string;
}

interface CompileSummary {
  stage: 'compile';
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
  artifacts: string[];
  command: {
    executable: string;
    args: string[];
    cwd: string;
  };
  sketchPath: string;
  buildPath: string;
  durationMs: number;
}

interface UploadSummary {
  stage: 'upload';
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: {
    executable: string;
    args: string[];
    cwd: string;
  };
  sketchPath: string;
  port: string;
  durationMs: number;
}

interface MonitorSummary {
  token: string;
  port: string;
  baud: number;
  startTime: string;
  endTime: string;
  elapsedSeconds: number;
  lines: number;
  reason: string;
  rebootDetected: boolean;
  lastLine?: string;
  exitCode?: number;
  raw?: boolean;
}

interface MonitorOptions {
  port: string;
  baud: number;
  autoBaud: boolean;
  raw: boolean;
  maxSeconds: number;
  maxLines: number;
  stopRegex?: RegExp;
  detectReboot: boolean;
}

class InvalidRegexError extends Error {
  constructor(public readonly pattern: string, detail?: string) {
    super(detail ? `Invalid regular expression: ${detail}` : 'Invalid regular expression');
    this.name = 'InvalidRegexError';
  }
}

class ArduinoCliRunner {
  constructor(private readonly executable: string) {}

  async run(args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {
    const mergedEnv = { ...process.env, ...(options?.env ?? {}) };
    const subprocess = execa(this.executable, args, {
      cwd: options?.cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      timeout: options?.timeoutMs,
    });
    const result = await subprocess;
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
}

const cli = new ArduinoCliRunner(ARDUINO_CLI);

const compileSchema = z.object({
  sketch_path: z.string(),
  export_bin: z.boolean().optional().default(true),
  build_path: z.string().optional(),
  build_props: z
    .union([z.record(z.string()), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (!value) {
        return [] as string[];
      }
      if (Array.isArray(value)) {
        return value;
      }
      return Object.entries(value).map(([key, val]) => `${key}=${val}`);
    }),
  clean: z.boolean().optional().default(false),
  fqbn: z.string().optional(),
});

const uploadSchema = z.object({
  sketch_path: z.string(),
  port: z.string(),
  fqbn: z.string().optional(),
  verify: z.boolean().optional().default(false),
  build_path: z.string().optional(),
  profile: z.string().optional(),
});

const monitorStartSchema = z.object({
  port: z.string(),
  baud: z.number().int().positive().optional().default(115200),
  auto_baud: z.boolean().optional().default(false),
  raw: z.boolean().optional().default(false),
  max_seconds: z.number().nonnegative().optional().default(0),
  max_lines: z.number().int().nonnegative().optional().default(0),
  stop_on: z.string().optional(),
  detect_reboot: z.boolean().optional().default(true),
});

const monitorStopSchema = z.object({
  token: z.string().optional(),
  port: z.string().optional(),
});

const listArtifactsSchema = z.object({
  base_dir: z.string(),
  build_path: z.string().optional(),
});

const pdcaSchema = compileSchema.merge(
  z.object({
    port: z.string(),
    monitor_seconds: z.number().positive().optional().default(8),
    baud: z.number().int().positive().optional().default(115200),
  }),
);

function toToolResult(data: unknown, message?: string): CallToolResult {
  const structured = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  const text = message ??
    (structured ? JSON.stringify(structured, null, 2) : String(data));
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);
  const regex = /^(?<file>[^:]+?):(?<line>\d+):(?<column>\d+):\s*(?<level>fatal error|error|warning|note):\s*(?<message>.*)$/i;
  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const match = regex.exec(line);
    if (!match || !match.groups) {
      continue;
    }
    const key = `${match.groups.file}:${match.groups.line}:${match.groups.column}:${match.groups.level}:${match.groups.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    diagnostics.push({
      file: match.groups.file,
      line: Number(match.groups.line),
      column: Number(match.groups.column),
      level: match.groups.level.toLowerCase(),
      message: match.groups.message.trim(),
      raw: line,
    });
  }
  return diagnostics;
}

async function ensureDirectory(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function collectArtifacts(searchDir: string): Promise<string[]> {
  const artifacts: string[] = [];
  async function walk(current: string) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (ARTIFACT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        artifacts.push(fullPath);
      }
    }
  }
  await walk(searchDir);
  artifacts.sort();
  return artifacts;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function resolveSketchPath(sketchPath: string): Promise<string> {
  const absolute = path.resolve(sketchPath);
  const exists = await pathExists(absolute);
  if (!exists) {
    throw new Error(`Sketch path not found: ${absolute}`);
  }
  return absolute;
}

async function runCompile(args: z.infer<typeof compileSchema>): Promise<CompileSummary> {
  const sketchPath = await resolveSketchPath(args.sketch_path);
  const buildPath = path.resolve(args.build_path ?? path.join(sketchPath, '.build'));
  if (args.clean && (await pathExists(buildPath))) {
    await fs.rm(buildPath, { recursive: true, force: true });
  }
  await ensureDirectory(buildPath);
  const fqbn = args.fqbn ?? DEFAULT_FQBN;
  const cliArgs = ['compile', '--fqbn', fqbn, '--build-path', buildPath];
  if (args.export_bin) {
    cliArgs.push('--export-binaries');
  }
  for (const prop of args.build_props ?? []) {
    cliArgs.push('--build-property', prop);
  }
  cliArgs.push(sketchPath);

  const started = Date.now();
  const result = await cli.run(cliArgs, { cwd: sketchPath });
  const durationMs = Date.now() - started;
  const diagnostics = parseDiagnostics(`${result.stdout}\n${result.stderr}`);
  const artifacts = result.exitCode === 0 ? await collectArtifacts(buildPath) : [];

  return {
    stage: 'compile',
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics,
    artifacts,
    command: {
      executable: ARDUINO_CLI,
      args: cliArgs,
      cwd: sketchPath,
    },
    sketchPath,
    buildPath,
    durationMs,
  };
}

async function runUpload(args: z.infer<typeof uploadSchema>): Promise<UploadSummary> {
  const sketchPath = await resolveSketchPath(args.sketch_path);
  const fqbn = args.fqbn ?? DEFAULT_FQBN;
  const cliArgs = ['upload', '--fqbn', fqbn, '--port', args.port];
  if (args.verify) {
    cliArgs.push('--verify');
  }
  if (args.build_path) {
    cliArgs.push('--input-dir', path.resolve(args.build_path));
  }
  if (args.profile) {
    cliArgs.push('--profile', args.profile);
  }
  cliArgs.push(sketchPath);

  const started = Date.now();
  const result = await cli.run(cliArgs, { cwd: sketchPath });
  const durationMs = Date.now() - started;

  return {
    stage: 'upload',
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    command: {
      executable: ARDUINO_CLI,
      args: cliArgs,
      cwd: sketchPath,
    },
    sketchPath,
    port: args.port,
    durationMs,
  };
}

async function safeNotify(method: string, params: Record<string, unknown>) {
  try {
    await server.server.notification({ method, params });
  } catch (error) {
    // Swallow notification errors to avoid crashing the server.
  }
}

class MonitorSession {
  private child?: ExecaChildProcess;
  private startHr = new Date();
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

  constructor(private readonly options: MonitorOptions, readonly token: string) {
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

  async start() {
    if (this.autoBaudEnabled) {
      const detection = await this.detectBaudRate();
      if (detection && detection.baud !== this.selectedBaud) {
        this.selectedBaud = detection.baud;
        await safeNotify('event/serial', {
          token: this.token,
          port: this.options.port,
          line: `[monitor] auto-baud selected ${detection.baud} (score ${detection.score.toFixed(2)})`,
          preview: detection.preview,
          timestamp: new Date().toISOString(),
          lineNumber: 0,
          raw: false,
          baud: detection.baud,
        });
      } else if (!detection) {
        await safeNotify('event/serial', {
          token: this.token,
          port: this.options.port,
          line: `[monitor] auto-baud fallback to ${this.selectedBaud}`,
          timestamp: new Date().toISOString(),
          lineNumber: 0,
          raw: false,
          baud: this.selectedBaud,
        });
      }
    }

    const cliArgs = ['monitor', '--quiet', '--port', this.options.port, '--config', `baudrate=${this.selectedBaud}`];
    if (this.options.raw) {
      cliArgs.push('--raw');
    }
    const child = execa(ARDUINO_CLI, cliArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });
    this.child = child;
    this.startHr = new Date();

    if (!child.stdout) {
      throw new Error('Failed to attach to monitor stdout.');
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (rawLine) => {
      const line = this.options.raw ? rawLine : stripAnsi(rawLine);
      this.lastLine = line;
      this.lines += 1;
      if (this.options.detectReboot && REBOOT_PATTERNS.some((pattern) => pattern.test(line))) {
        this.rebootDetected = true;
      }
      safeNotify('event/serial', {
        token: this.token,
        port: this.options.port,
        line,
        raw: this.options.raw,
        timestamp: new Date().toISOString(),
        lineNumber: this.lines,
        baud: this.selectedBaud,
      }).catch(() => undefined);

      if (this.options.stopRegex && this.options.stopRegex.test(line)) {
        this.stopReason = 'pattern_match';
        this.stop().catch(() => undefined);
      } else if (this.options.maxLines > 0 && this.lines >= this.options.maxLines) {
        this.stopReason = 'line_limit';
        this.stop().catch(() => undefined);
      }
    });

    if (child.stderr) {
      const errRl = createInterface({ input: child.stderr });
      errRl.on('line', (rawLine) => {
        const line = this.options.raw ? rawLine : stripAnsi(rawLine);
        safeNotify('event/serial', {
          token: this.token,
          port: this.options.port,
          line,
          stream: 'stderr',
          timestamp: new Date().toISOString(),
          baud: this.selectedBaud,
        }).catch(() => undefined);
      });
    }

    child.on('close', (code) => {
      this.exitCode = code === null ? undefined : code;
      if (code !== 0 && this.stopReason === 'completed') {
        this.stopReason = 'error';
      }
      this.finalize();
    });

    child.on('error', () => {
      this.stopReason = 'error';
      this.finalize();
    });

    if (this.options.maxSeconds > 0) {
      this.timer = setTimeout(() => {
        this.stopReason = 'time_limit';
        this.stop().catch(() => undefined);
      }, this.options.maxSeconds * 1000);
    }
  }

  private async detectBaudRate(): Promise<{ baud: number; score: number; preview: string } | null> {
    const candidates: number[] = [];
    const pushCandidate = (value: number) => {
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      if (!candidates.includes(value)) {
        candidates.push(value);
      }
    };

    pushCandidate(this.selectedBaud);
    pushCandidate(115200);
    pushCandidate(74880);
    pushCandidate(57600);
    pushCandidate(9600);

    let bestBaud: number | undefined;
    let bestScore = 0;
    let bestSample = '';

    for (const candidate of candidates) {
      const result = await this.probeBaudRate(candidate);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestBaud = candidate;
        bestSample = result.sample;
      }
      if (bestScore >= 0.8) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (bestBaud === undefined || bestScore < 0.3) {
      return null;
    }

    const preview = this.previewSample(bestSample);
    return { baud: bestBaud, score: bestScore, preview };
  }

  private async probeBaudRate(baud: number): Promise<{ sample: string; score: number }> {
    const args = ['monitor', '--quiet', '--port', this.options.port, '--config', `baudrate=${baud}`];
    let sample = '';
    try {
      const child = execa(ARDUINO_CLI, args, {
        stdout: 'pipe',
        stderr: 'pipe',
        reject: false,
      });

      const onData = (chunk: Buffer) => {
        if (sample.length < 4096) {
          sample += chunk.toString('utf8');
        }
        if (sample.length >= 4096) {
          child.kill('SIGINT', { forceKillAfterTimeout: 200 });
        }
      };

      child.stdout?.on('data', onData);
      const timer = setTimeout(() => child.kill('SIGINT', { forceKillAfterTimeout: 500 }), 1800);
      await child.catch(() => undefined);
      clearTimeout(timer);
      child.stdout?.off('data', onData);
    } catch (error) {
      // ignore errors and treat as no signal
    }

    const score = this.scoreSample(sample);
    return { sample, score };
  }

  private scoreSample(sample: string): number {
    if (!sample) {
      return 0;
    }
    const printable = Array.from(sample)
      .filter((char) => {
        const code = char.charCodeAt(0);
        return code >= 0x20 || char === '\n' || char === '\r' || char === '\t';
      })
      .join('');
    if (!printable.trim()) {
      return 0;
    }
    const ratio = printable.length / sample.length;
    const newlineCount = (printable.match(/\n/g) ?? []).length;
    const keywordMatch = /rst:0x|wifi|rssi|http|webhook|esp32|guru|connecting|ip:/i.test(printable) ? 1 : 0;
    const score = ratio * 0.6 + Math.min(newlineCount, 10) / 10 * 0.25 + keywordMatch * 0.15;
    return Math.max(0, Math.min(1, score));
  }

  private previewSample(sample: string): string {
    if (!sample) {
      return '';
    }
    const sanitized = Array.from(sample)
      .map((char) => {
        const code = char.charCodeAt(0);
        if (char === '\r' || char === '\t') {
          return ' ';
        }
        if (code < 0x20 || code === 0x7f) {
          return '';
        }
        return char;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!sanitized) {
      return '';
    }
    return sanitized.length > 80 ? `${sanitized.slice(0, 80)}…` : sanitized;
  }

  async stop(): Promise<MonitorSummary> {
    if (this.resolved) {
      return this.completionPromise;
    }
    if (this.stopReason === 'completed') {
      this.stopReason = 'manual';
    }
    if (this.child) {
      this.child.kill('SIGINT', { forceKillAfterTimeout: 1_000 });
    }
    return this.completionPromise;
  }

  onComplete(): Promise<MonitorSummary> {
    return this.completionPromise;
  }

  private finalize() {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const end = new Date();
    const summary: MonitorSummary = {
      token: this.token,
      port: this.options.port,
      baud: this.selectedBaud,
      startTime: this.startHr.toISOString(),
      endTime: end.toISOString(),
      elapsedSeconds: Math.max(0, (end.getTime() - this.startHr.getTime()) / 1000),
      lines: this.lines,
      reason: this.stopReason,
      rebootDetected: this.rebootDetected,
      lastLine: this.lastLine,
      exitCode: this.exitCode ?? undefined,
      raw: this.options.raw,
    };
    for (const resolve of this.completionResolvers) {
      resolve(summary);
    }
    const payload: Record<string, unknown> = { ...summary };
    safeNotify('event/serial_end', payload).catch(() => undefined);
  }
}

class MonitorManager {
  private sessions = new Map<string, MonitorSession>();

  async start(options: z.infer<typeof monitorStartSchema>): Promise<MonitorSession> {
    const token = randomUUID();
    let stopRegex: RegExp | undefined;
    if (options.stop_on) {
      try {
        stopRegex = new RegExp(options.stop_on);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new InvalidRegexError(options.stop_on, detail);
      }
    }
    const session = new MonitorSession(
      {
        port: options.port,
        baud: options.baud,
        autoBaud: options.auto_baud,
        raw: options.raw,
        maxSeconds: options.max_seconds,
        maxLines: options.max_lines,
        stopRegex,
        detectReboot: options.detect_reboot,
      },
      token,
    );
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

  listTokens() {
    return Array.from(this.sessions.keys());
  }
}

const monitorManager = new MonitorManager();

async function readVersion() {
  const result = await cli.run(['version', '--json']);
  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      return toToolResult({ ok: true, data: parsed });
    } catch (error) {
      // fall through to plain text
    }
  }
  return toToolResult({ ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr });
}

async function ensureEsp32Core() {
  const list = await cli.run(['core', 'list', '--format', 'json']);
  let alreadyInstalled = false;
  if (list.exitCode === 0) {
    try {
      const parsed = JSON.parse(list.stdout) as { platforms?: Array<{ id?: string; installed_version?: string }>; };
      alreadyInstalled = Boolean(parsed.platforms?.some((platform) => platform.id === 'esp32:esp32' && platform.installed_version));
    } catch (error) {
      // ignored
    }
  }
  if (alreadyInstalled) {
    return toToolResult({ ok: true, alreadyInstalled: true });
  }
  const install = await cli.run(['core', 'install', 'esp32:esp32']);
  return toToolResult({ ok: install.exitCode === 0, exitCode: install.exitCode, stdout: install.stdout, stderr: install.stderr });
}

async function listBoards() {
  const result = await cli.run(['board', 'list', '--format', 'json']);
  if (result.exitCode === 0) {
    try {
      return toToolResult({ ok: true, data: JSON.parse(result.stdout) });
    } catch (error) {
      // fall through
    }
  }
  return toToolResult({ ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr });
}

async function listLibraries() {
  const result = await cli.run(['lib', 'list', '--format', 'json']);
  if (result.exitCode === 0) {
    try {
      return toToolResult({ ok: true, data: JSON.parse(result.stdout) });
    } catch (error) {
      // ignore
    }
  }
  return toToolResult({ ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr });
}

async function installLibrary(name: string) {
  const args = ['lib', 'install', name];
  const result = await cli.run(args);
  return toToolResult({ ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
}

async function runListArtifacts(args: z.infer<typeof listArtifactsSchema>) {
  const baseDir = await resolveSketchPath(args.base_dir);
  const buildDir = path.resolve(args.build_path ?? path.join(baseDir, '.build'));
  if (!(await pathExists(buildDir))) {
    return toToolResult({ ok: true, artifacts: [] }, `No build artifacts found in ${buildDir}`);
  }
  const artifacts = await collectArtifacts(buildDir);
  return toToolResult({ ok: true, artifacts });
}

async function runPdca(args: z.infer<typeof pdcaSchema>) {
  const compileResult = await runCompile(args);
  if (!compileResult.ok) {
    return toToolResult({ ok: false, stage: 'compile', compile: compileResult }, 'Compile failed');
  }
  const uploadResult = await runUpload({
    sketch_path: args.sketch_path,
    port: args.port,
    fqbn: args.fqbn,
    verify: false,
    build_path: compileResult.buildPath,
  });
  if (!uploadResult.ok) {
    return toToolResult({ ok: false, stage: 'upload', compile: compileResult, upload: uploadResult }, 'Upload failed');
  }
  const session = new MonitorSession(
    {
      port: args.port,
      baud: args.baud,
      autoBaud: false,
      raw: false,
      maxSeconds: args.monitor_seconds,
      maxLines: 0,
      stopRegex: undefined,
      detectReboot: true,
    },
    randomUUID(),
  );
  await session.start();
  const summary = await session.onComplete();
  return toToolResult({
    ok: true,
    stage: 'pdca',
    compile: compileResult,
    upload: uploadResult,
    monitor: summary,
  });
}

server.registerTool('version', {
  title: 'arduino-cli version',
  description: 'Show the installed arduino-cli version in JSON when available',
}, async () => readVersion());

server.registerTool('ensure_core', {
  title: 'Ensure ESP32 core',
  description: 'Install esp32:esp32 platform if missing',
}, async () => ensureEsp32Core());

server.registerTool('board_list', {
  title: 'List Boards',
  description: 'List detected serial ports via arduino-cli board list',
}, async () => listBoards());

server.registerTool('lib_list', {
  title: 'List Libraries',
  description: 'List installed Arduino libraries',
}, async () => listLibraries());

server.registerTool('lib_install', {
  title: 'Install Library',
  description: 'Install an Arduino library by name',
  inputSchema: {
    name: z.string(),
  },
}, async ({ name }) => installLibrary(name));

server.registerTool('compile', {
  title: 'Compile Sketch',
  description: 'Compile an Arduino sketch with arduino-cli and return diagnostics and artifacts',
  inputSchema: compileSchema.shape,
}, async (params) => {
  const result = await runCompile(compileSchema.parse(params));
  return toToolResult({ ok: result.ok, result });
});

server.registerTool('upload', {
  title: 'Upload Sketch',
  description: 'Upload a compiled sketch to an ESP32 board',
  inputSchema: uploadSchema.shape,
}, async (params) => {
  const result = await runUpload(uploadSchema.parse(params));
  return toToolResult({ ok: result.ok, result });
});

server.registerTool('list_artifacts', {
  title: 'List Build Artifacts',
  description: 'List .bin/.elf/.map/.hex artifacts under a build directory',
  inputSchema: listArtifactsSchema.shape,
}, async (params) => runListArtifacts(listArtifactsSchema.parse(params)));

server.registerTool('monitor_start', {
  title: 'Start Serial Monitor',
  description: 'Start streaming serial output with stop conditions',
  inputSchema: monitorStartSchema.shape,
}, async (params) => {
  try {
    const parsed = monitorStartSchema.parse(params);
    const session = await monitorManager.start(parsed);
    const summaryPromise = session.onComplete();
    summaryPromise.catch(() => undefined);
    const message = parsed.auto_baud
      ? `Monitor started with token ${session.token} (baud ${session.baud})`
      : `Monitor started with token ${session.token}`;
    return toToolResult(
      {
        ok: true,
        token: session.token,
        port: parsed.port,
        baud: session.baud,
        auto_baud: parsed.auto_baud,
      },
      message,
    );
  } catch (error) {
    if (error instanceof InvalidRegexError) {
      return toToolResult(
        {
          ok: false,
          error: 'invalid_stop_regex',
          pattern: error.pattern,
          message: error.message,
        },
        `Invalid stop_on regex: ${error.pattern}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return toToolResult({ ok: false, error: message }, message);
  }
});

server.registerTool('monitor_stop', {
  title: 'Stop Serial Monitor',
  description: 'Stop an active serial monitor session',
  inputSchema: monitorStopSchema.shape,
}, async (params) => {
  const parsed = monitorStopSchema.parse(params);
  const session = monitorManager.get(parsed.token, parsed.port);
  if (!session) {
    return toToolResult({ ok: false, error: 'No active monitor matching token or port' });
  }
  const summary = await session.stop();
  return toToolResult({ ok: true, summary });
});

server.registerTool('pdca_cycle', {
  title: 'Compile, Upload, Monitor',
  description: 'Run compile -> upload -> short monitor cycle',
  inputSchema: pdcaSchema.shape,
}, async (params) => runPdca(pdcaSchema.parse(params)));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
