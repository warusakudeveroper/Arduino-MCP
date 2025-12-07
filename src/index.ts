#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { execa } from 'execa';
// stripAnsi moved to compile.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

// New modular imports
import { createLogger } from './utils/logger.js';
import { 
  serialBroadcaster,
  monitorManager,
} from './serial/index.js';
import { 
  consoleServer,
} from './console/index.js';
import { 
  runCompile,
  runUpload,
} from './mcp/tools/index.js';
import {
  pathExists,
  ensureDirectory,
  resolveSketchPath,
  collectFiles,
} from './utils/fs.js';
import type {
  WorkspaceConfig,
  DetectedPortInfo,
  UnknownIdentifier,
} from './types.js';
import type {
  PinSpec,
} from './utils/pins.js';

// Local pin analysis types (different from utils/pins.ts types)
interface PinWarning {
  severity: 'error' | 'warning' | 'info';
  pin?: number;
  name?: string;
  message: string;
  file?: string;
  line?: number;
}

interface PinUsageEntry {
  kind: 'PIN_MODE' | 'DIGITAL_WRITE' | 'DIGITAL_READ' | 'ANALOG_READ' | 'ANALOG_WRITE' | 'DAC_WRITE' | 'TOUCH_READ';
  mode?: string;
  identifier: string;
  expression: string;
  file: string;
  line: number;
}

interface PinUsageSummary {
  pin: number;
  name: string;
  available: boolean;
  usage: Array<{
    kind: PinUsageEntry['kind'];
    mode?: string;
    file: string;
    line: number;
    identifier: string;
  }>;
  spec?: PinSpec;
}

// Re-export new modules for external use
export * from './types.js';
export * from './mcp/schemas.js';
export * from './config/index.js';
export * from './serial/index.js';
export * from './console/index.js';
export * from './utils/index.js';

// Logger instance for this module
const logger = createLogger('MCPServer');

const INSTRUCTIONS = `MCP Arduino ESP32 server for macOS/Linux/Windows. Tools provided:

🚀 QUICKSTART (recommended for beginners):
- quickstart: One-click setup that installs everything, detects ESP32, compiles a blink example, uploads it, and shows serial output

📦 SETUP:
- ensure_dependencies: bundle arduino-cli + python(.venv) with pyserial
- ensure_core: install esp32:esp32 core if missing
- version: show arduino-cli version

🔧 BUILD & UPLOAD:
- compile: run arduino-cli compile with diagnostics + artifact listing
- upload: flash sketch to board via arduino-cli upload
- pdca_cycle: compile -> upload -> monitor in a single run
- flash_connected: detect ESP32 boards (<=10), compile and upload in parallel
- erase_flash: completely erase ESP32 flash memory before fresh install
- spiffs_upload: upload data directory to ESP32 SPIFFS partition
- list_artifacts: enumerate .bin/.elf/.map/.hex under build path

📡 SERIAL MONITORING:
- monitor_start / monitor_stop: stream serial output with stop conditions + reboot detection
- start_console: launch local SSE console (http://127.0.0.1:4173) with crash/alert detection
- get_logs: retrieve buffered serial logs for AI-driven verification

🔌 BOARD & LIBRARY:
- board_list: list detected serial ports via arduino-cli
- lib_install / lib_list: manage libraries with arduino-cli

📌 PIN UTILITIES:
- pin_spec: ESP32-DevKitC pin specification reference
- pin_check: validate sketch pin usage against DevKitC constraints

Defaults: FQBN esp32:esp32:esp32 (override with ESP32_FQBN). arduino-cli path can be overridden via ARDUINO_CLI.`;

const PROJECT_ROOT = process.cwd();

// ArduinoMCP Workspace Directory Structure
const WORKSPACE_DIRS = {
  builds: path.resolve(PROJECT_ROOT, 'builds'),       // ビルド済みファームウェア (.bin)
  sketches: path.resolve(PROJECT_ROOT, 'sketches'),   // スケッチファイル
  data: path.resolve(PROJECT_ROOT, 'data'),           // SPIFFSデータ
  temp: path.resolve(PROJECT_ROOT, 'Temp'),           // 一時ファイル
  config: path.resolve(PROJECT_ROOT, '.arduino-mcp'), // 設定ファイル
};

const TEMP_DIR = WORKSPACE_DIRS.temp;
const BUILDS_DIR = WORKSPACE_DIRS.builds;
const SKETCHES_DIR = WORKSPACE_DIRS.sketches;
const DATA_DIR = WORKSPACE_DIRS.data;
const CONFIG_DIR = WORKSPACE_DIRS.config;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const VENDOR_DIR = path.resolve(PROJECT_ROOT, 'vendor');
const VENDOR_ARDUINO_DIR = path.join(VENDOR_DIR, 'arduino-cli');
const VENDOR_ARDUINO_BIN = path.join(
  VENDOR_ARDUINO_DIR,
  process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli',
);
const VENV_DIR = path.join(PROJECT_ROOT, '.venv');

// WorkspaceConfig type imported from ./types.ts
// InstallLogEntry and install log functions moved to ./config/workspace.ts

const DEFAULT_CONFIG: WorkspaceConfig = {
  buildOutputDir: BUILDS_DIR,
  sketchesDir: SKETCHES_DIR,
  dataDir: DATA_DIR,
  defaultFqbn: 'esp32:esp32:esp32',
  defaultBaud: 115200,
  additionalBuildDirs: [],
  portNicknames: {},
};

let workspaceConfig: WorkspaceConfig = { ...DEFAULT_CONFIG };

async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  try {
    if (await pathExists(CONFIG_FILE)) {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      const loaded = JSON.parse(content);
      workspaceConfig = { ...DEFAULT_CONFIG, ...loaded };
    }
  } catch (e) {
    logger.error('Failed to load config', { error: String(e) });
  }
  return workspaceConfig;
}

async function saveWorkspaceConfig(config: Partial<WorkspaceConfig>): Promise<void> {
  workspaceConfig = { ...workspaceConfig, ...config };
  await ensureDirectory(CONFIG_DIR);
  await fs.writeFile(CONFIG_FILE, JSON.stringify(workspaceConfig, null, 2));
}

// Port nickname and install log functions moved to ./config/workspace.ts

async function setupWorkspace(): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  
  for (const [name, dir] of Object.entries(WORKSPACE_DIRS)) {
    if (await pathExists(dir)) {
      existing.push(name);
    } else {
      await ensureDirectory(dir);
      created.push(name);
    }
  }
  
  // Create README files in each directory
  const readmeContents: Record<string, string> = {
    builds: `# Builds Directory
ビルド済みファームウェア（.bin）をここに配置してください。
コンソールUIの「Scan Builds」で検出されます。

例:
- my_project.ino.bin
- firmware_v1.0.bin
`,
    sketches: `# Sketches Directory
Arduinoスケッチ（.ino）をここに配置してください。

例:
- my_project/
  - my_project.ino
  - config.h
`,
    data: `# Data Directory
SPIFFSにアップロードするデータファイルをここに配置してください。

例:
- index.html
- config.json
- images/
`,
  };
  
  for (const [name, content] of Object.entries(readmeContents)) {
    const readmePath = path.join(WORKSPACE_DIRS[name as keyof typeof WORKSPACE_DIRS], 'README.md');
    if (!await pathExists(readmePath)) {
      await fs.writeFile(readmePath, content);
    }
  }
  
  // Load or create config
  await loadWorkspaceConfig();
  if (!await pathExists(CONFIG_FILE)) {
    await saveWorkspaceConfig({});
  }
  
  return { created, existing };
}

const DEFAULT_FQBN = process.env.ESP32_FQBN ?? 'esp32:esp32:esp32';
function resolveArduinoCliExecutable(): string {
  if (process.env.ARDUINO_CLI) {
    return process.env.ARDUINO_CLI;
  }
  if (fsSync.existsSync(VENDOR_ARDUINO_BIN)) {
    return VENDOR_ARDUINO_BIN;
  }
  return 'arduino-cli';
}

function resolvePythonExecutable(): string {
  const userSpecified = process.env.MCP_PYTHON;
  if (userSpecified) {
    return userSpecified;
  }
  const venvPython = path.resolve(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fsSync.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

let ARDUINO_CLI = resolveArduinoCliExecutable();
const ARTIFACT_EXTENSIONS = new Set(['.bin', '.elf', '.map', '.hex']);

// Serial monitor scripts moved to ./serial/monitor.ts

let PYTHON = resolvePythonExecutable();

const DEVKITC_PIN_SPEC: PinSpec[] = [
  { number: 0, name: 'IO0', altNames: ['GPIO0', 'BOOT', 'ADC2_CH1', 'TOUCH1'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'Boot strapping pin (keep HIGH for normal boot). Also supports touch sensing and ADC2.' },
  { number: 1, name: 'IO1', altNames: ['GPIO1', 'TX0'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'UART0 TX (USB serial). Avoid repurposing if console is required.' },
  { number: 2, name: 'IO2', altNames: ['GPIO2', 'ADC2_CH2', 'TOUCH2', 'LED_BUILTIN'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'On-board LED, boot strapping pin.' },
  { number: 3, name: 'IO3', altNames: ['GPIO3', 'RX0'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'UART0 RX (USB serial).' },
  { number: 4, name: 'IO4', altNames: ['GPIO4', 'ADC2_CH0', 'TOUCH0'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 5, name: 'IO5', altNames: ['GPIO5', 'VSPI_CS'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: false, pwm: true, inputOnly: false, strapping: true, notes: 'Default VSPI CS, boot strapping pin.' },
  { number: 6, name: 'IO6', altNames: ['GPIO6'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 7, name: 'IO7', altNames: ['GPIO7'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 8, name: 'IO8', altNames: ['GPIO8'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 9, name: 'IO9', altNames: ['GPIO9'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 10, name: 'IO10', altNames: ['GPIO10'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 11, name: 'IO11', altNames: ['GPIO11'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 12, name: 'IO12', altNames: ['GPIO12', 'ADC2_CH5', 'TOUCH5'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'MTDI strapping pin (LOW to enter download mode). Avoid pulling HIGH on reset.' },
  { number: 13, name: 'IO13', altNames: ['GPIO13', 'ADC2_CH4', 'TOUCH4'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 14, name: 'IO14', altNames: ['GPIO14', 'ADC2_CH6', 'TOUCH6'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 15, name: 'IO15', altNames: ['GPIO15', 'ADC2_CH3', 'TOUCH3'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'MTDO strapping pin (LOW forces download mode).' },
  { number: 16, name: 'IO16', altNames: ['GPIO16', 'U2RXD'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 17, name: 'IO17', altNames: ['GPIO17', 'U2TXD'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 18, name: 'IO18', altNames: ['GPIO18', 'VSPI_CLK'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 19, name: 'IO19', altNames: ['GPIO19', 'VSPI_MISO'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 21, name: 'IO21', altNames: ['GPIO21', 'SDA'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'Default I2C SDA.' },
  { number: 22, name: 'IO22', altNames: ['GPIO22', 'SCL'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'Default I2C SCL.' },
  { number: 23, name: 'IO23', altNames: ['GPIO23', 'VSPI_MOSI'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 25, name: 'IO25', altNames: ['GPIO25', 'DAC1', 'ADC2_CH8'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: true, touch: false, pwm: true, inputOnly: false, notes: 'DAC channel 1.' },
  { number: 26, name: 'IO26', altNames: ['GPIO26', 'DAC2', 'ADC2_CH9'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: true, touch: false, pwm: true, inputOnly: false, notes: 'DAC channel 2.' },
  { number: 27, name: 'IO27', altNames: ['GPIO27', 'ADC2_CH7', 'TOUCH7'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 32, name: 'IO32', altNames: ['GPIO32', 'ADC1_CH4', 'TOUCH9'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 33, name: 'IO33', altNames: ['GPIO33', 'ADC1_CH5', 'TOUCH8'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 34, name: 'IO34', altNames: ['GPIO34', 'ADC1_CH6'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Input-only (no output driver).' },
  { number: 35, name: 'IO35', altNames: ['GPIO35', 'ADC1_CH7'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Input-only (no output driver).' },
  { number: 36, name: 'IO36', altNames: ['GPIO36', 'SVP', 'ADC1_CH0'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Sensor VP, input-only.' },
  { number: 39, name: 'IO39', altNames: ['GPIO39', 'SVN', 'ADC1_CH3'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Sensor VN, input-only.' },
];

const PIN_ALIAS: Record<string, number> = {};

const BASE_PIN_ALIAS: Record<string, number> = {
  LED_BUILTIN: 2,
  LED0: 2,
  TX: 1,
  TX0: 1,
  RX: 3,
  RX0: 3,
  SDA: 21,
  SCL: 22,
  MISO: 19,
  MOSI: 23,
  SCK: 18,
  SS: 5,
  SPI_CLK: 18,
  SPI_MISO: 19,
  SPI_MOSI: 23,
  SPI_CS: 5,
};

for (const [key, value] of Object.entries(BASE_PIN_ALIAS)) {
  PIN_ALIAS[key.toUpperCase()] = value;
}

for (const spec of DEVKITC_PIN_SPEC) {
  const baseKey = `GPIO${spec.number}`;
  PIN_ALIAS[baseKey.toUpperCase()] = spec.number;
  PIN_ALIAS[`IO${spec.number}`.toUpperCase()] = spec.number;
  if (spec.altNames) {
    for (const alt of spec.altNames) {
      PIN_ALIAS[alt.toUpperCase()] = spec.number;
    }
  }
}

const PIN_SPEC_MAP = new Map<number, PinSpec>(DEVKITC_PIN_SPEC.map((pin) => [pin.number, pin] as const));

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

// Diagnostic, CompileSummary, UploadSummary types are now in ./types.ts

// DetectedPortInfo type imported from ./types.ts
// MonitorSummary, MonitorOptions types are now in ./types.ts
// PinSpec, PinWarning, PinUsageEntry, PinUsageSummary, UnknownIdentifier imported from ./types.ts

class InvalidRegexError extends Error {
  constructor(public readonly pattern: string, detail?: string) {
    super(detail ? `Invalid regular expression: ${detail}` : 'Invalid regular expression');
    this.name = 'InvalidRegexError';
  }
}

class ArduinoCliRunner {
  constructor(private executable: string) {}

  setExecutable(executable: string) {
    this.executable = executable;
  }

  getExecutable() {
    return this.executable;
  }

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

function updateArduinoCliPath(executable: string) {
  ARDUINO_CLI = executable;
  cli.setExecutable(executable);
}

function updatePythonExecutable(pythonPath: string) {
  PYTHON = pythonPath;
}

const buildPropsSchema = z
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
  });

const compileSchema = z.object({
  sketch_path: z.string(),
  export_bin: z.boolean().optional().default(true),
  build_path: z.string().optional(),
  build_props: buildPropsSchema,
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

const pinCheckSchema = z.object({
  sketch_path: z.string(),
  include_headers: z.boolean().optional().default(false),
});

const pdcaSchema = compileSchema.merge(
  z.object({
    port: z.string(),
    monitor_seconds: z.number().positive().optional().default(8),
    baud: z.number().int().positive().optional().default(115200),
  }),
);

const ensureDependenciesSchema = z.object({
  install_missing: z.boolean().optional().default(true),
});

const flashConnectedSchema = z.object({
  sketch_path: z.string(),
  fqbn: z.string().optional(),
  build_props: buildPropsSchema,
  max_ports: z.number().int().positive().max(10).optional().default(10),
});

const startConsoleSchema = z.object({
  host: z.string().optional().default('127.0.0.1'),
  port: z.number().int().positive().optional().default(4173),
});

const libInstallSchema = z.object({
  name: z.string().describe('Name of the Arduino library to install (e.g., "ArduinoJson" or "Adafruit NeoPixel")'),
});

const quickstartSchema = z.object({
  sketch_path: z.string().optional().describe('Path to an existing sketch to compile and upload. If not provided, a blink example will be created.'),
  port: z.string().optional().describe('Serial port to upload to. If not provided, will auto-detect ESP32.'),
  monitor_seconds: z.number().positive().optional().default(10).describe('Seconds to monitor serial output after upload'),
});

const workspaceSetupSchema = z.object({
  build_dir: z.string().optional().describe('Custom build output directory path'),
  sketches_dir: z.string().optional().describe('Custom sketches directory path'),
  data_dir: z.string().optional().describe('Custom SPIFFS data directory path'),
  additional_build_dirs: z.array(z.string()).optional().describe('Additional directories to scan for .bin files'),
});

const eraseFlashSchema = z.object({
  port: z.string().describe('Serial port of the ESP32 to erase'),
});

const spiffsUploadSchema = z.object({
  port: z.string().describe('Serial port of the ESP32'),
  data_dir: z.string().describe('Path to the data directory to upload to SPIFFS'),
  partition_name: z.string().optional().default('spiffs').describe('SPIFFS partition name'),
});

const getLogsSchema = z.object({
  port: z.string().optional().describe('Filter logs by port'),
  max_lines: z.number().int().positive().optional().default(100).describe('Maximum number of log lines to return'),
  pattern: z.string().optional().describe('Filter logs by regex pattern'),
});

function toToolResult(data: unknown, message?: string): CallToolResult {
  const structured = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  const text = message ??
    (structured ? JSON.stringify(structured, null, 2) : String(data));
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

// parseDiagnostics moved to ./mcp/tools/compile.ts
// pathExists, ensureDirectory, resolveSketchPath imported from ./utils/fs.js

async function collectArtifacts(searchDir: string): Promise<string[]> {
  const artifacts = await collectFiles(searchDir, ARTIFACT_EXTENSIONS);
  artifacts.sort();
  return artifacts;
}

interface ArduinoCliStatus {
  ok: boolean;
  path?: string;
  version?: string;
  source: 'env' | 'vendor' | 'system';
  installed: boolean;
  installedNow?: boolean;
  message?: string;
}

interface PythonStatus {
  ok: boolean;
  path?: string;
  version?: string;
  pyserialInstalled: boolean;
  installedPyserial?: boolean;
  createdVenv?: boolean;
  message?: string;
}

interface DependencyReport {
  ok: boolean;
  arduinoCli: ArduinoCliStatus;
  python: PythonStatus;
}

// SerialEventPayload type is now in ./types.ts

function timestampSlug(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

class DependencyManager {
  async ensureArduinoCli(options: { installMissing: boolean }): Promise<ArduinoCliStatus> {
    const installMissing = options.installMissing;
    let source: ArduinoCliStatus['source'] = process.env.ARDUINO_CLI
      ? 'env'
      : fsSync.existsSync(VENDOR_ARDUINO_BIN)
        ? 'vendor'
        : 'system';
    let candidate = resolveArduinoCliExecutable();
    let available = await this.isExecutableAvailable(candidate);
    let installedNow = false;
    let message: string | undefined;

    if (!available && installMissing) {
      const install = await this.installArduinoCli();
      if (install.ok && install.path) {
        candidate = install.path;
        source = 'vendor';
        available = true;
        installedNow = true;
      } else if (install.message) {
        message = install.message;
      } else {
        message = 'Failed to install arduino-cli into vendor directory.';
      }
    } else if (!available) {
      message = 'arduino-cli not found. Set ARDUINO_CLI or allow installation via ensure_dependencies.';
    }

    if (available) {
      updateArduinoCliPath(candidate);
    }

    const version = available ? await this.readArduinoCliVersion(candidate) : undefined;
    return {
      ok: available,
      path: available ? candidate : undefined,
      version,
      source,
      installed: available,
      installedNow,
      message,
    };
  }

  private getArduinoCliDownloadInfo(): { url: string; archiveName: string; isZip: boolean } {
    const base = 'https://downloads.arduino.cc/arduino-cli';
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'darwin' && arch === 'arm64') {
      return { url: `${base}/arduino-cli_latest_macOS_arm64.tar.gz`, archiveName: 'arduino-cli_latest_macOS_arm64.tar.gz', isZip: false };
    }
    if (platform === 'darwin') {
      return { url: `${base}/arduino-cli_latest_macOS_64bit.tar.gz`, archiveName: 'arduino-cli_latest_macOS_64bit.tar.gz', isZip: false };
    }
    if (platform === 'linux' && arch === 'arm64') {
      return { url: `${base}/arduino-cli_latest_Linux_ARM64.tar.gz`, archiveName: 'arduino-cli_latest_Linux_ARM64.tar.gz', isZip: false };
    }
    if (platform === 'linux') {
      return { url: `${base}/arduino-cli_latest_Linux_64bit.tar.gz`, archiveName: 'arduino-cli_latest_Linux_64bit.tar.gz', isZip: false };
    }
    if (platform === 'win32') {
      return { url: `${base}/arduino-cli_latest_Windows_64bit.zip`, archiveName: 'arduino-cli_latest_Windows_64bit.zip', isZip: true };
    }
    throw new Error(`Unsupported platform for automatic arduino-cli install: ${platform}/${arch}`);
  }

  private async installArduinoCli(): Promise<{ ok: boolean; path?: string; version?: string; message?: string }> {
    try {
      const { url, archiveName, isZip } = this.getArduinoCliDownloadInfo();
      await ensureDirectory(VENDOR_ARDUINO_DIR);
      const archivePath = path.join(VENDOR_ARDUINO_DIR, archiveName);

      // Download using platform-appropriate method
      if (process.platform === 'win32') {
        // Use PowerShell on Windows
        const psDownload = `Invoke-WebRequest -Uri '${url}' -OutFile '${archivePath}'`;
        const download = await execa('powershell', ['-Command', psDownload], { reject: false });
        if (download.exitCode !== 0) {
          return { ok: false, message: `Download failed (${download.exitCode}): ${download.stderr || download.stdout}` };
        }
      } else {
      const download = await execa('curl', ['-L', url, '-o', archivePath], { reject: false });
      if (download.exitCode !== 0) {
        return { ok: false, message: `Download failed (${download.exitCode}): ${download.stderr || download.stdout}` };
      }
      }

      // Extract using platform-appropriate method
      if (isZip) {
        // Use PowerShell Expand-Archive on Windows
        const psExtract = `Expand-Archive -Path '${archivePath}' -DestinationPath '${VENDOR_ARDUINO_DIR}' -Force`;
        const extract = await execa('powershell', ['-Command', psExtract], { reject: false });
        await fs.rm(archivePath, { force: true });
        if (extract.exitCode !== 0) {
          return { ok: false, message: `Extract failed (${extract.exitCode}): ${extract.stderr || extract.stdout}` };
        }
      } else {
      const extract = await execa('tar', ['-xzf', archivePath, '-C', VENDOR_ARDUINO_DIR], { reject: false });
      await fs.rm(archivePath, { force: true });
      if (extract.exitCode !== 0) {
        return { ok: false, message: `Extract failed (${extract.exitCode}): ${extract.stderr || extract.stdout}` };
      }
      }

      const binPath = VENDOR_ARDUINO_BIN;
      if (!(await pathExists(binPath))) {
        return { ok: false, message: `arduino-cli binary not found at ${binPath} after extraction` };
      }
      if (process.platform !== 'win32') {
      await fs.chmod(binPath, 0o755);
      }
      const version = await this.readArduinoCliVersion(binPath);
      return { ok: true, path: binPath, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
  }

  private async isExecutableAvailable(executable: string): Promise<boolean> {
    if (!executable) {
      return false;
    }
    if (executable.includes(path.sep)) {
      try {
        await fs.access(executable, fsSync.constants.X_OK);
        return true;
      } catch (error) {
        return false;
      }
    }
    const which = await execa('which', [executable], { reject: false });
    return which.exitCode === 0 && Boolean(which.stdout.trim());
  }

  private async readArduinoCliVersion(executable: string): Promise<string | undefined> {
    const result = await execa(executable, ['version', '--json'], { reject: false });
    if (result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        return parsed.VersionString ?? parsed.version ?? undefined;
      } catch (error) {
        // ignore JSON parse failure
      }
    }
    const fallback = await execa(executable, ['version'], { reject: false });
    return fallback.stdout?.trim() || fallback.stderr?.trim() || undefined;
  }

  async ensurePython(options: { installMissing: boolean }): Promise<PythonStatus> {
    const installMissing = options.installMissing;
    const defaultPython = resolvePythonExecutable();
    let pythonPath = defaultPython;
    let available = await this.isExecutableAvailable(pythonPath);
    let createdVenv = false;
    let message: string | undefined;

    if (!available && installMissing) {
      const basePython = process.env.MCP_PYTHON ?? 'python3';
      await ensureDirectory(VENV_DIR);
      const create = await execa(basePython, ['-m', 'venv', VENV_DIR], { reject: false });
      if (create.exitCode === 0) {
        pythonPath = path.resolve(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        available = await this.isExecutableAvailable(pythonPath);
        createdVenv = true;
        updatePythonExecutable(pythonPath);
      } else {
        message = `Failed to create venv with ${basePython}: ${create.stderr || create.stdout}`.trim();
      }
    }

    if (!available) {
      return {
        ok: false,
        path: pythonPath,
        version: undefined,
        pyserialInstalled: false,
        installedPyserial: false,
        createdVenv,
        message: message ?? 'Python executable not found. Set MCP_PYTHON or allow virtualenv creation.',
      };
    }

    const version = await this.readPythonVersion(pythonPath);
    const pyserialCheck = await execa(pythonPath, ['-m', 'pip', 'show', 'pyserial'], { reject: false });
    let pyserialInstalled = pyserialCheck.exitCode === 0;
    let installedPyserial = false;
    if (!pyserialInstalled && installMissing) {
      const install = await execa(pythonPath, ['-m', 'pip', 'install', 'pyserial'], { reject: false });
      pyserialInstalled = install.exitCode === 0;
      installedPyserial = install.exitCode === 0;
      if (!pyserialInstalled && !message) {
        message = `Failed to install pyserial: ${install.stderr || install.stdout}`.trim();
      }
    }

    return {
      ok: available && pyserialInstalled,
      path: pythonPath,
      version,
      pyserialInstalled,
      installedPyserial,
      createdVenv,
      message,
    };
  }

  private async readPythonVersion(pythonPath: string): Promise<string | undefined> {
    const result = await execa(pythonPath, ['--version'], { reject: false });
    if (result.exitCode === 0) {
      return result.stdout?.trim() || result.stderr?.trim() || undefined;
    }
    return undefined;
  }

  async ensureAll(options: { installMissing: boolean }): Promise<DependencyReport> {
    const installMissing = options.installMissing;
    const arduinoCli = await this.ensureArduinoCli({ installMissing });
    const python = await this.ensurePython({ installMissing });
    return {
      ok: arduinoCli.ok && python.ok,
      arduinoCli,
      python,
    };
  }
}

const dependencyManager = new DependencyManager();

// SerialBroadcaster is imported from ./serial/index.js

// CONSOLE_HTML has been moved to ./console/html.ts
// ConsoleServer has been moved to ./console/server.ts

// ====== BEGIN REMOVED SECTION (console HTML and server) ======
// The following ~1600 lines of CONSOLE_HTML and ConsoleServer class
// have been moved to separate modules. See:
// - src/console/html.ts for the HTML template
// - src/console/server.ts for the ConsoleServer class
// ====== END MARKER FOR DELETION ======


// ConsoleServer is imported from ./console/index.js


const SOURCE_FILE_EXTS = new Set(['.ino', '.pde', '.cpp', '.cc', '.c', '.cxx', '.s', '.S']);
const HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx']);

async function collectSourceFiles(root: string, includeHeaders: boolean): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string) {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (['node_modules', 'dist', 'build', '.build'].includes(entry.name)) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_FILE_EXTS.has(ext) || (includeHeaders && HEADER_EXTS.has(ext))) {
          files.push(full);
        }
      }
    }
  }
  await walk(root);
  files.sort();
  return files;
}

const PIN_MODE_REGEX = /pinMode\s*\(\s*([^,]+?)\s*,\s*(INPUT_PULLUP|INPUT_PULLDOWN|INPUT|OUTPUT|OUTPUT_OPEN_DRAIN)\s*\)/g;
const DIGITAL_WRITE_REGEX = /digitalWrite\s*\(\s*([^,]+?)\s*,/g;
const DIGITAL_READ_REGEX = /digitalRead\s*\(\s*([^,]+?)\s*\)/g;
const ANALOG_READ_REGEX = /analogRead\s*\(\s*([^,]+?)\s*\)/g;
const ANALOG_WRITE_REGEX = /analogWrite\s*\(\s*([^,]+?)\s*,/g;
const LEDC_ATTACH_REGEX = /ledcAttachPin\s*\(\s*([^,]+?)\s*,/g;
const DAC_WRITE_REGEX = /dacWrite\s*\(\s*([^,]+?)\s*,/g;
const TOUCH_READ_REGEX = /touchRead\s*\(\s*([^,]+?)\s*\)/g;

function computeLineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function resolvePinIdentifier(expression: string): { pin?: number; identifier: string } {
  const noComments = expression.replace(/\/\*.*?\*\//gs, '').replace(/\/\/.*$/gm, '');
  let cleaned = noComments.replace(/\s+/g, '');
  cleaned = cleaned.replace(/^\(+/, '').replace(/\)+$/, '');
  if (!cleaned) {
    return { identifier: expression.trim() };
  }
  if (/^\d+$/.test(cleaned)) {
    return { pin: parseInt(cleaned, 10), identifier: cleaned };
  }
  let match = cleaned.match(/^GPIO_NUM_(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  match = cleaned.match(/^GPIO(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  match = cleaned.match(/^IO(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  const aliasKey = cleaned.toUpperCase();
  if (PIN_ALIAS[aliasKey] !== undefined) {
    return { pin: PIN_ALIAS[aliasKey], identifier: cleaned };
  }
  return { identifier: cleaned };
}

async function analyzePinUsage(sketchPath: string, includeHeaders: boolean) {
  const files = await collectSourceFiles(sketchPath, includeHeaders);
  const usageByPin = new Map<number, PinUsageEntry[]>();
  const unknownIdentifiers = new Map<string, UnknownIdentifier>();

  const recordUsage = (pin: number | undefined, identifier: string, entry: PinUsageEntry) => {
    if (pin === undefined) {
      const key = `${identifier}:${entry.file}:${entry.line}`;
      if (!unknownIdentifiers.has(key)) {
        unknownIdentifiers.set(key, { identifier, file: entry.file, line: entry.line });
      }
      return;
    }
    if (!usageByPin.has(pin)) {
      usageByPin.set(pin, []);
    }
    usageByPin.get(pin)!.push(entry);
  };

  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (error) {
      continue;
    }

    const processMatches = (regex: RegExp, kind: PinUsageEntry['kind'], mode?: string) => {
      regex.lastIndex = 0;
      for (const match of content.matchAll(regex)) {
        const expr = match[1];
        const { pin, identifier } = resolvePinIdentifier(expr);
        const line = computeLineNumber(content, match.index ?? 0);
        recordUsage(pin, identifier, {
          kind,
          mode,
          identifier,
          expression: expr,
          file,
          line,
        });
      }
    };

    {
      PIN_MODE_REGEX.lastIndex = 0;
      for (const match of content.matchAll(PIN_MODE_REGEX)) {
        const expr = match[1];
        const mode = match[2];
        const { pin, identifier } = resolvePinIdentifier(expr);
        const line = computeLineNumber(content, match.index ?? 0);
        recordUsage(pin, identifier, {
          kind: 'PIN_MODE',
          mode,
          identifier,
          expression: expr,
          file,
          line,
        });
      }
    }

    processMatches(DIGITAL_WRITE_REGEX, 'DIGITAL_WRITE');
    processMatches(DIGITAL_READ_REGEX, 'DIGITAL_READ');
    processMatches(ANALOG_READ_REGEX, 'ANALOG_READ');
    processMatches(ANALOG_WRITE_REGEX, 'ANALOG_WRITE');
    processMatches(LEDC_ATTACH_REGEX, 'ANALOG_WRITE');
    processMatches(DAC_WRITE_REGEX, 'DAC_WRITE');
    processMatches(TOUCH_READ_REGEX, 'TOUCH_READ');
  }

  const warnings: PinWarning[] = [];
  const usageSummary: PinUsageSummary[] = [];

  const addWarning = (warning: PinWarning) => {
    warnings.push(warning);
  };

  for (const [pin, entries] of usageByPin.entries()) {
    const spec = PIN_SPEC_MAP.get(pin);
    const summary: PinUsageSummary = {
      pin,
      name: spec?.name ?? `GPIO${pin}`,
      available: spec?.available ?? true,
      usage: entries.map((entry) => ({
        kind: entry.kind,
        mode: entry.mode,
        file: entry.file,
        line: entry.line,
        identifier: entry.identifier,
      })),
      spec,
    };
    usageSummary.push(summary);

    if (!spec) {
      const example = entries[0];
      addWarning({
        severity: 'warning',
        pin,
        name: `GPIO${pin}`,
        message: `GPIO${pin} is not defined for ESP32-DevKitC (check pin numbering).`,
        file: example.file,
        line: example.line,
      });
      continue;
    }

    if (!spec.available) {
      const example = entries[0];
      addWarning({
        severity: 'warning',
        pin,
        name: spec.name,
        message: `${spec.name} is reserved (SPI flash). Do not use on ESP32-DevKitC.`,
        file: example.file,
        line: example.line,
      });
    }

    const hasOutput = entries.some((entry) => {
      if (entry.kind === 'PIN_MODE') {
        return entry.mode === 'OUTPUT' || entry.mode === 'OUTPUT_OPEN_DRAIN';
      }
      return entry.kind === 'DIGITAL_WRITE' || entry.kind === 'ANALOG_WRITE' || entry.kind === 'DAC_WRITE';
    });
    const hasInput = entries.some((entry) => {
      if (entry.kind === 'PIN_MODE') {
        return entry.mode?.startsWith('INPUT');
      }
      return entry.kind === 'DIGITAL_READ' || entry.kind === 'ANALOG_READ' || entry.kind === 'TOUCH_READ';
    });
    const hasAnalogRead = entries.some((entry) => entry.kind === 'ANALOG_READ');
    const hasTouch = entries.some((entry) => entry.kind === 'TOUCH_READ');
    const hasDac = entries.some((entry) => entry.kind === 'DAC_WRITE');

    if (hasOutput && (!spec.digitalOut || spec.inputOnly)) {
      const example = entries.find((entry) => entry.kind === 'DIGITAL_WRITE' || entry.kind === 'ANALOG_WRITE' || entry.kind === 'DAC_WRITE' || (entry.kind === 'PIN_MODE' && entry.mode?.startsWith('OUTPUT')))!;
      addWarning({
        severity: 'error',
        pin,
        name: spec.name,
        message: `${spec.name} is input-only; using it as OUTPUT may damage the pin.`,
        file: example.file,
        line: example.line,
      });
    } else if (hasOutput && !spec.digitalOut) {
      const example = entries.find((entry) => entry.kind === 'DIGITAL_WRITE' || entry.kind === 'ANALOG_WRITE' || entry.kind === 'DAC_WRITE' || (entry.kind === 'PIN_MODE' && entry.mode?.startsWith('OUTPUT')))!;
      addWarning({
        severity: 'error',
        pin,
        name: spec.name,
        message: `${spec.name} does not support digital output.`,
        file: example.file,
        line: example.line,
      });
    }

    if (hasInput && !spec.digitalIn) {
      const example = entries.find((entry) => entry.kind === 'DIGITAL_READ' || (entry.kind === 'PIN_MODE' && entry.mode?.startsWith('INPUT')))!;
      addWarning({
        severity: 'warning',
        pin,
        name: spec.name,
        message: `${spec.name} is not intended for digital input.`,
        file: example.file,
        line: example.line,
      });
    }

    if (hasAnalogRead && !spec.analogIn) {
      const example = entries.find((entry) => entry.kind === 'ANALOG_READ')!;
      addWarning({
        severity: 'error',
        pin,
        name: spec.name,
        message: `${spec.name} does not support ADC input.`,
        file: example.file,
        line: example.line,
      });
    }

    if (hasTouch && !spec.touch) {
      const example = entries.find((entry) => entry.kind === 'TOUCH_READ')!;
      addWarning({
        severity: 'warning',
        pin,
        name: spec.name,
        message: `${spec.name} does not support capacitive touch sensing.`,
        file: example.file,
        line: example.line,
      });
    }

    if (hasDac && !spec.dac) {
      const example = entries.find((entry) => entry.kind === 'DAC_WRITE')!;
      addWarning({
        severity: 'error',
        pin,
        name: spec.name,
        message: `${spec.name} does not provide a DAC output.`,
        file: example.file,
        line: example.line,
      });
    }

    if (spec.strapping && hasOutput) {
      const example = entries.find((entry) => entry.kind === 'DIGITAL_WRITE' || entry.kind === 'ANALOG_WRITE' || entry.kind === 'DAC_WRITE' || (entry.kind === 'PIN_MODE' && entry.mode?.startsWith('OUTPUT')))!;
      addWarning({
        severity: 'warning',
        pin,
        name: spec.name,
        message: `${spec.name} is a boot strapping pin. Driving it as OUTPUT may affect boot behaviour.`,
        file: example.file,
        line: example.line,
      });
    }
  }

  usageSummary.sort((a, b) => a.pin - b.pin);
  const warningSummary = warnings.map((warning) => ({ ...warning }));
  const unknownSummary = Array.from(unknownIdentifiers.values());

  const ok = warnings.every((warning) => warning.severity !== 'error');

  return {
    ok,
    warnings: warningSummary,
    usage: usageSummary,
    unknownIdentifiers: unknownSummary,
  };
}

// runCompile and runUpload are imported from ./mcp/tools/index.js

async function detectEsp32Ports(maxPorts: number): Promise<{
  ok: boolean;
  ports: DetectedPortInfo[];
  raw?: unknown;
  stdout?: string;
  stderr?: string;
}> {
  const result = await cli.run(['board', 'list', '--format', 'json']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    parsed = undefined;
  }

  const ports: DetectedPortInfo[] = [];
  
  // Support both old format (ports) and new format (detected_ports)
  const parsedObj = parsed as { ports?: unknown[]; detected_ports?: unknown[] } | undefined;
  const rawEntries = Array.isArray(parsedObj?.detected_ports)
    ? parsedObj.detected_ports
    : Array.isArray(parsedObj?.ports)
      ? parsedObj.ports
      : [];
  const entries = rawEntries as Array<Record<string, unknown>>;

  for (const entry of entries) {
    // New format: { port: { address: "..." }, matching_boards: [...] }
    // Old format: { address: "...", matching_boards: [...] }
    const portObj = entry.port as Record<string, unknown> | undefined;
    const address = (portObj?.address as string | undefined)
      ?? (entry.address as string | undefined)
      ?? (entry.port as string | undefined)
      ?? (entry.address_label as string | undefined)
      ?? (entry.com_name as string | undefined);
    if (!address) {
      continue;
    }
    
    const boardsRaw = [
      ...(Array.isArray(entry.matching_boards) ? entry.matching_boards : []),
      ...(Array.isArray(entry.boards) ? entry.boards : []),
    ] as Array<Record<string, unknown>>;
    
    // Check if it's an ESP32 by matching_boards or by port name pattern
    const matching = boardsRaw.find((board) => {
      const name = (board.FQBN as string | undefined)
        ?? (board.fqbn as string | undefined)
        ?? (board.name as string | undefined)
        ?? (board.boardName as string | undefined)
        ?? '';
      return name.toLowerCase().includes('esp32');
    });
    
    // Also detect ESP32 by common USB-to-serial chip patterns (CP210x, CH340, etc)
    const isEsp32ByPort = /SLAB_USBtoUART|usbserial|wchusbserial|CP210|CH340/i.test(address);
    
    const matchingFqbn = (matching?.FQBN as string | undefined)
      ?? (matching?.fqbn as string | undefined)
      ?? (matching?.name as string | undefined)
      ?? (matching?.boardName as string | undefined);

    const label = (portObj?.label as string | undefined)
      ?? (entry.label as string | undefined)
      ?? (entry.address_label as string | undefined)
      ?? (entry.identification as string | undefined)
      ?? (entry.port_label as string | undefined);
      
    const props = (portObj?.properties ?? entry.properties) as { product?: string; vendor?: string } | undefined;

    ports.push({
      port: address,
      protocol: (portObj?.protocol as string | undefined) ?? (entry.protocol as string | undefined) ?? (entry.protocol_label as string | undefined),
      label,
      product: props?.product,
      vendor: props?.vendor,
      matchingFqbn,
      isEsp32: Boolean(matching) || isEsp32ByPort,
      reachable: fsSync.existsSync(address),
    });
  }

  const esp32Ports = ports.filter((port) => port.isEsp32).slice(0, Math.max(1, maxPorts));
  return {
    ok: result.exitCode === 0 && esp32Ports.length > 0,
    ports: esp32Ports,
    raw: parsed,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// MonitorManager is imported from ./serial/index.js


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
  const session = await monitorManager.start({
    port: args.port,
    baud: args.baud,
    auto_baud: false,
    raw: false,
    max_seconds: args.monitor_seconds,
    max_lines: 0,
    detect_reboot: true,
  });
  const summary = await session.onComplete();
  return toToolResult({
    ok: true,
    stage: 'pdca',
    compile: compileResult,
    upload: uploadResult,
    monitor: summary,
  });
}

async function runEnsureDependencies(args: z.infer<typeof ensureDependenciesSchema>) {
  const report = await dependencyManager.ensureAll({ installMissing: args.install_missing });
  const message = report.ok ? 'Dependencies are ready.' : 'Dependency verification failed.';
  return toToolResult({ ok: report.ok, report }, message);
}

async function runFlashConnected(args: z.infer<typeof flashConnectedSchema>) {
  const dependencies = await dependencyManager.ensureAll({ installMissing: true });
  if (!dependencies.ok) {
    return toToolResult({ ok: false, stage: 'dependencies', dependencies }, 'Dependency setup failed. See report.');
  }

  const detection = await detectEsp32Ports(args.max_ports);
  if (detection.ports.length === 0) {
    const message = detection.ok ? 'No ESP32 devices detected on USB ports.' : 'Board detection failed. See stdout/stderr.';
    return toToolResult({ ok: false, stage: 'detect', detection }, message);
  }

  await ensureDirectory(TEMP_DIR);
  const buildPath = path.join(TEMP_DIR, timestampSlug());
  const compileResult = await runCompile({
    sketch_path: args.sketch_path,
    export_bin: true,
    build_props: args.build_props,
    build_path: buildPath,
    clean: true,
    fqbn: args.fqbn,
  });
  if (!compileResult.ok) {
    return toToolResult({ ok: false, stage: 'compile', detection, compile: compileResult, build_path: buildPath }, 'Compile failed');
  }

  const uploads = await Promise.all(
    detection.ports.map(async (port) => {
      const uploadResult = await runUpload({
        sketch_path: args.sketch_path,
        port: port.port,
        fqbn: args.fqbn,
        verify: false,
        build_path: compileResult.buildPath,
      });
      return { port: port.port, ok: uploadResult.ok, upload: uploadResult };
    }),
  );

  const successCount = uploads.filter((entry) => entry.ok).length;
  const allOk = uploads.length > 0 && successCount === uploads.length;
  const message = allOk
    ? `Uploaded firmware to ${uploads.length} ESP32 board(s).`
    : `Uploaded to ${successCount}/${uploads.length} board(s); check upload results.`;

  return toToolResult(
    {
      ok: allOk,
      stage: 'flash_connected',
      build_path: compileResult.buildPath,
      temp_dir: TEMP_DIR,
      detection,
      compile: compileResult,
      uploads,
      dependencies,
    },
    message,
  );
}

async function runWorkspaceSetup(args: z.infer<typeof workspaceSetupSchema>) {
  // Setup workspace directories
  const setupResult = await setupWorkspace();
  
  // Apply custom config if provided
  const configUpdates: Partial<WorkspaceConfig> = {};
  if (args.build_dir) configUpdates.buildOutputDir = path.resolve(args.build_dir);
  if (args.sketches_dir) configUpdates.sketchesDir = path.resolve(args.sketches_dir);
  if (args.data_dir) configUpdates.dataDir = path.resolve(args.data_dir);
  if (args.additional_build_dirs) configUpdates.additionalBuildDirs = args.additional_build_dirs.map(d => path.resolve(d));
  
  if (Object.keys(configUpdates).length > 0) {
    await saveWorkspaceConfig(configUpdates);
  }
  
  const result = {
    created: setupResult.created,
    existing: setupResult.existing,
    config: workspaceConfig,
    directories: {
      builds: workspaceConfig.buildOutputDir,
      sketches: workspaceConfig.sketchesDir,
      data: workspaceConfig.dataDir,
      temp: TEMP_DIR,
      config: CONFIG_DIR,
    },
  };
  
  const message = setupResult.created.length > 0
    ? `Workspace setup complete. Created: ${setupResult.created.join(', ')}`
    : 'Workspace already configured.';
  
  return toToolResult(result, message);
}

async function runStartConsole(args: z.infer<typeof startConsoleSchema>) {
  try {
    const result = consoleServer.start({ host: args.host, port: args.port });
    return toToolResult({ ok: true, server: result }, `Console server listening on http://${result.host}:${result.port}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toToolResult({ ok: false, error: message }, message);
  }
}

async function runEraseFlash(args: z.infer<typeof eraseFlashSchema>) {
  try {
    // Use esptool.py to erase flash (bundled with ESP32 Arduino core)
    const result = await cli.run(['burn-bootloader', '--fqbn', DEFAULT_FQBN, '--port', args.port], { timeoutMs: 120000 });
    if (result.exitCode !== 0) {
      // Fallback: try using esptool.py directly if available
      const esptoolResult = await execa(PYTHON, ['-m', 'esptool', '--port', args.port, 'erase_flash'], { reject: false });
      if (esptoolResult.exitCode === 0) {
        return toToolResult({ ok: true, stdout: esptoolResult.stdout }, 'Flash erased successfully');
      }
      return toToolResult({ ok: false, exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }, 'Flash erase failed');
    }
    return toToolResult({ ok: true, stdout: result.stdout }, 'Flash erased successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toToolResult({ ok: false, error: message }, message);
  }
}

async function runSpiffsUpload(args: z.infer<typeof spiffsUploadSchema>) {
  try {
    const dataDir = path.resolve(args.data_dir);
    if (!(await pathExists(dataDir))) {
      return toToolResult({ ok: false, error: `Data directory not found: ${dataDir}` }, 'Data directory not found');
    }

    // Check if mkspiffs is available
    const mkspiffsResult = await execa('which', ['mkspiffs'], { reject: false });
    if (mkspiffsResult.exitCode !== 0) {
      return toToolResult(
        { ok: false, error: 'mkspiffs not found. Install it via: brew install mkspiffs (macOS) or your package manager.' },
        'mkspiffs tool not found. Please install it first.',
      );
    }

    // Create SPIFFS image
    const spiffsImage = path.join(TEMP_DIR, `spiffs_${Date.now()}.bin`);
    await ensureDirectory(TEMP_DIR);

    // Default SPIFFS parameters for ESP32 (1.5MB SPIFFS partition)
    const mkResult = await execa('mkspiffs', [
      '-c', dataDir,
      '-b', '4096',
      '-p', '256',
      '-s', '1507328', // 0x170000 = 1507328 bytes for default spiffs partition
      spiffsImage,
    ], { reject: false });

    if (mkResult.exitCode !== 0) {
      return toToolResult({ ok: false, error: 'Failed to create SPIFFS image', stderr: mkResult.stderr }, 'Failed to create SPIFFS image');
    }

    // Upload using esptool.py
    // Default SPIFFS partition starts at 0x290000 for ESP32
    const uploadResult = await execa(PYTHON, [
      '-m', 'esptool',
      '--chip', 'esp32',
      '--port', args.port,
      '--baud', '921600',
      'write_flash',
      '0x290000', // Default SPIFFS partition offset
      spiffsImage,
    ], { reject: false });

    // Clean up
    await fs.rm(spiffsImage, { force: true });

    if (uploadResult.exitCode !== 0) {
      return toToolResult({ ok: false, error: 'Failed to upload SPIFFS', stderr: uploadResult.stderr }, 'Failed to upload SPIFFS image');
    }

    return toToolResult({ ok: true, stdout: uploadResult.stdout }, 'SPIFFS data uploaded successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toToolResult({ ok: false, error: message }, message);
  }
}

function runGetLogs(args: z.infer<typeof getLogsSchema>) {
  const buffer = serialBroadcaster.getBuffer();
  let logs = buffer.filter((evt) => evt.type === 'serial');

  // Filter by port
  if (args.port) {
    logs = logs.filter((evt) => evt.port === args.port);
  }

  // Filter by pattern
  if (args.pattern) {
    try {
      const regex = new RegExp(args.pattern, 'i');
      logs = logs.filter((evt) => evt.line && regex.test(evt.line));
    } catch (error) {
      return toToolResult({ ok: false, error: 'Invalid regex pattern' }, 'Invalid regex pattern');
    }
  }

  // Limit lines
  const limitedLogs = logs.slice(-args.max_lines);

  // Format output
  const formattedLogs = limitedLogs.map((evt) => ({
    timestamp: evt.timestamp,
    port: evt.port,
    line: evt.line,
    baud: evt.baud,
  }));

  const summary = `Retrieved ${formattedLogs.length} log lines` + (args.port ? ` from ${args.port}` : '');
  return toToolResult({ ok: true, logs: formattedLogs, count: formattedLogs.length }, summary);
}

const BLINK_SKETCH = `// ESP32 Blink Example - Generated by MCP Arduino ESP32
// This sketch blinks the built-in LED to verify your setup is working.

#define LED_BUILTIN 2  // ESP32 DevKitC built-in LED

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32 Blink Example Starting...");
  Serial.println("If you see this message, serial communication is working!");
  
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("LED initialized on GPIO 2");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED ON");
  delay(1000);
  
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED OFF");
  delay(1000);
}
`;

async function runQuickstart(args: z.infer<typeof quickstartSchema>) {
  const steps: Array<{ step: string; ok: boolean; message: string; detail?: unknown }> = [];

  // Step 1: Ensure dependencies
  steps.push({ step: 'check_dependencies', ok: true, message: 'Checking dependencies...' });
  const depsReport = await dependencyManager.ensureAll({ installMissing: true });
  if (!depsReport.ok) {
    steps[steps.length - 1] = {
      step: 'check_dependencies',
      ok: false,
      message: 'Dependency setup failed',
      detail: depsReport,
    };
    return toToolResult(
      { ok: false, stage: 'dependencies', steps, report: depsReport },
      'Quickstart failed: Could not set up dependencies. Check that Python3 is installed.',
    );
  }
  steps[steps.length - 1] = {
    step: 'check_dependencies',
    ok: true,
    message: 'Dependencies ready',
    detail: {
      arduinoCli: depsReport.arduinoCli.version,
      python: depsReport.python.version,
      pyserial: depsReport.python.pyserialInstalled,
    },
  };

  // Step 2: Ensure ESP32 core
  steps.push({ step: 'ensure_core', ok: true, message: 'Installing ESP32 core...' });
  const coreResult = await ensureEsp32Core();
  const coreData = coreResult.structuredContent as { ok?: boolean; alreadyInstalled?: boolean } | undefined;
  if (!coreData?.ok) {
    steps[steps.length - 1] = {
      step: 'ensure_core',
      ok: false,
      message: 'Failed to install ESP32 core',
      detail: coreResult,
    };
    return toToolResult(
      { ok: false, stage: 'ensure_core', steps },
      'Quickstart failed: Could not install ESP32 core.',
    );
  }
  steps[steps.length - 1] = {
    step: 'ensure_core',
    ok: true,
    message: coreData.alreadyInstalled ? 'ESP32 core already installed' : 'ESP32 core installed',
  };

  // Step 3: Detect ESP32 boards
  steps.push({ step: 'detect_boards', ok: true, message: 'Detecting ESP32 boards...' });
  const detection = await detectEsp32Ports(10);
  let targetPort = args.port;
  if (!targetPort && detection.ports.length > 0) {
    targetPort = detection.ports[0].port;
  }
  if (!targetPort) {
    steps[steps.length - 1] = {
      step: 'detect_boards',
      ok: false,
      message: 'No ESP32 boards detected. Connect a board via USB and try again.',
      detail: detection,
    };
    return toToolResult(
      { ok: false, stage: 'detect_boards', steps, detection },
      'Quickstart failed: No ESP32 boards detected. Connect an ESP32 via USB.',
    );
  }
  steps[steps.length - 1] = {
    step: 'detect_boards',
    ok: true,
    message: `Found ESP32 on ${targetPort}`,
    detail: { port: targetPort, allPorts: detection.ports.map((p) => p.port) },
  };

  // Step 4: Prepare sketch
  let sketchPath = args.sketch_path;
  let createdSketch = false;
  if (!sketchPath) {
    // Create blink example
    const blinkDir = path.join(TEMP_DIR, 'blink_example');
    await ensureDirectory(blinkDir);
    const blinkPath = path.join(blinkDir, 'blink_example.ino');
    await fs.writeFile(blinkPath, BLINK_SKETCH, 'utf8');
    sketchPath = blinkDir;
    createdSketch = true;
    steps.push({
      step: 'prepare_sketch',
      ok: true,
      message: 'Created blink example sketch',
      detail: { path: sketchPath },
    });
  } else {
    steps.push({
      step: 'prepare_sketch',
      ok: true,
      message: `Using existing sketch: ${sketchPath}`,
    });
  }

  // Step 5: Compile
  steps.push({ step: 'compile', ok: true, message: 'Compiling sketch...' });
  const compileResult = await runCompile({
    sketch_path: sketchPath,
    export_bin: true,
    clean: false,
    build_props: [],
  });
  if (!compileResult.ok) {
    steps[steps.length - 1] = {
      step: 'compile',
      ok: false,
      message: 'Compilation failed',
      detail: {
        errors: compileResult.diagnostics.filter((d) => d.level === 'error'),
        exitCode: compileResult.exitCode,
      },
    };
    return toToolResult(
      { ok: false, stage: 'compile', steps, compile: compileResult },
      `Quickstart failed: Compilation error. ${compileResult.diagnostics.filter((d) => d.level === 'error').map((d) => d.message).join('; ')}`,
    );
  }
  steps[steps.length - 1] = {
    step: 'compile',
    ok: true,
    message: `Compiled successfully (${compileResult.durationMs}ms)`,
    detail: { artifacts: compileResult.artifacts.length },
  };

  // Step 6: Upload
  steps.push({ step: 'upload', ok: true, message: `Uploading to ${targetPort}...` });
  const uploadResult = await runUpload({
    sketch_path: sketchPath,
    port: targetPort,
    build_path: compileResult.buildPath,
    verify: false,
  });
  if (!uploadResult.ok) {
    steps[steps.length - 1] = {
      step: 'upload',
      ok: false,
      message: 'Upload failed',
      detail: { stderr: uploadResult.stderr, exitCode: uploadResult.exitCode },
    };
    return toToolResult(
      { ok: false, stage: 'upload', steps, upload: uploadResult },
      'Quickstart failed: Upload error. Check USB connection and port permissions.',
    );
  }
  steps[steps.length - 1] = {
    step: 'upload',
    ok: true,
    message: `Uploaded successfully (${uploadResult.durationMs}ms)`,
  };

  // Step 7: Monitor
  steps.push({ step: 'monitor', ok: true, message: `Monitoring serial output for ${args.monitor_seconds}s...` });
  const session = await monitorManager.start({
    port: targetPort,
    baud: 115200,
    auto_baud: true,
    raw: false,
    max_seconds: args.monitor_seconds,
    max_lines: 0,
    detect_reboot: true,
  });
  const monitorSummary = await session.onComplete();
  steps[steps.length - 1] = {
    step: 'monitor',
    ok: true,
    message: `Captured ${monitorSummary.lines} lines in ${monitorSummary.elapsedSeconds.toFixed(1)}s`,
    detail: {
      baud: monitorSummary.baud,
      lastLine: monitorSummary.lastLine,
      rebootDetected: monitorSummary.rebootDetected,
    },
  };

  const successMessage = createdSketch
    ? `Quickstart complete! Blink example is running on ${targetPort}. The LED on GPIO 2 should be blinking.`
    : `Quickstart complete! Your sketch is running on ${targetPort}.`;

  return toToolResult(
    {
      ok: true,
      stage: 'complete',
      steps,
      port: targetPort,
      sketchPath,
      createdSketch,
      compile: {
        durationMs: compileResult.durationMs,
        artifacts: compileResult.artifacts.length,
      },
      upload: {
        durationMs: uploadResult.durationMs,
      },
      monitor: monitorSummary,
    },
    successMessage,
  );
}

server.registerTool('version', {
  title: 'arduino-cli version',
  description: 'Show the installed arduino-cli version in JSON when available',
}, async () => readVersion());

server.registerTool('ensure_core', {
  title: 'Ensure ESP32 core',
  description: 'Install esp32:esp32 platform if missing',
}, async () => ensureEsp32Core());

server.registerTool('ensure_dependencies', {
  title: 'Ensure Arduino Dependencies',
  description: 'Bundle arduino-cli into vendor/, ensure .venv with pyserial, and report versions',
  inputSchema: ensureDependenciesSchema.shape,
}, async (params) => runEnsureDependencies(ensureDependenciesSchema.parse(params)));

server.registerTool('quickstart', {
  title: 'Quickstart ESP32 Development',
  description: 'One-click setup: installs dependencies, detects ESP32, compiles & uploads a blink example, and shows serial output. Perfect for beginners or verifying a new board.',
  inputSchema: quickstartSchema.shape,
}, async (params) => runQuickstart(quickstartSchema.parse(params)));

server.registerTool('workspace_setup', {
  title: 'Setup ArduinoMCP Workspace',
  description: 'Initialize workspace directory structure (builds/, sketches/, data/, Temp/) and configure build output paths. Run this first to set up your project.',
  inputSchema: workspaceSetupSchema.shape,
}, async (params) => runWorkspaceSetup(workspaceSetupSchema.parse(params)));

server.registerTool('start_console', {
  title: 'Start Serial Console (SSE)',
  description: 'Launch a local SSE console at http://<host>:<port> for real-time serial logs',
  inputSchema: startConsoleSchema.shape,
}, async (params) => runStartConsole(startConsoleSchema.parse(params)));

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
  description: 'Install an Arduino library by name (e.g., "ArduinoJson", "Adafruit NeoPixel")',
  inputSchema: libInstallSchema.shape,
}, async (params) => {
  const { name } = libInstallSchema.parse(params);
  return installLibrary(name);
});

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

server.registerTool('pin_spec', {
  title: 'ESP32-DevKitC Pin Specification',
  description: 'Return pin capabilities and notes for the ESP32-DevKitC board',
}, async () => {
  return toToolResult({ pins: DEVKITC_PIN_SPEC }, 'Loaded ESP32-DevKitC pin specification');
});

server.registerTool('pin_check', {
  title: 'Validate Pin Usage',
  description: 'Analyze a sketch for invalid ESP32-DevKitC pin usage (input-only, strapping, etc.)',
  inputSchema: pinCheckSchema.shape,
}, async (params) => {
  const parsed = pinCheckSchema.parse(params);
  const sketchPath = await resolveSketchPath(parsed.sketch_path);
  const analysis = await analyzePinUsage(sketchPath, parsed.include_headers);
  const message = analysis.ok ? 'No pin conflicts detected.' : 'Pin conflicts or cautions detected. See warnings.';
  return toToolResult(analysis, message);
});

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

server.registerTool('flash_connected', {
  title: 'Auto Flash Connected ESP32 Boards',
  description: 'Detect connected ESP32 USB serial ports (<=10), compile into Temp/<timestamp>, and upload in parallel',
  inputSchema: flashConnectedSchema.shape,
}, async (params) => runFlashConnected(flashConnectedSchema.parse(params)));

server.registerTool('erase_flash', {
  title: 'Erase ESP32 Flash',
  description: 'Completely erase the flash memory of an ESP32 board. Useful before fresh install.',
  inputSchema: eraseFlashSchema.shape,
}, async (params) => runEraseFlash(eraseFlashSchema.parse(params)));

server.registerTool('spiffs_upload', {
  title: 'Upload SPIFFS Data',
  description: 'Upload a data directory to ESP32 SPIFFS partition. Requires mkspiffs and esptool.',
  inputSchema: spiffsUploadSchema.shape,
}, async (params) => runSpiffsUpload(spiffsUploadSchema.parse(params)));

server.registerTool('get_logs', {
  title: 'Get Serial Logs',
  description: 'Retrieve buffered serial logs from active monitors. Useful for AI-driven verification.',
  inputSchema: getLogsSchema.shape,
}, async (params) => runGetLogs(getLogsSchema.parse(params)));

async function main() {
  // Initialize workspace on startup
  await loadWorkspaceConfig();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (!process.env.MCP_SKIP_MAIN) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function startConsoleStandalone(options?: { host?: string; port?: number }) {
  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 4173;
  return consoleServer.start({ host, port });
}

export async function startMonitorStandalone(options: Partial<z.infer<typeof monitorStartSchema>> & { port: string }) {
  const parsed = monitorStartSchema.parse({
    ...options,
    port: options.port,
  });
  const session = await monitorManager.start(parsed);
  const summary = await session.onComplete();
  return summary;
}
