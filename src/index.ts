#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import { execa, type ExecaChildProcess } from 'execa';
import stripAnsi from 'strip-ansi';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

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

// Workspace configuration
interface WorkspaceConfig {
  buildOutputDir: string;
  sketchesDir: string;
  dataDir: string;
  defaultFqbn: string;
  defaultBaud: number;
  additionalBuildDirs: string[];
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  buildOutputDir: BUILDS_DIR,
  sketchesDir: SKETCHES_DIR,
  dataDir: DATA_DIR,
  defaultFqbn: 'esp32:esp32:esp32',
  defaultBaud: 115200,
  additionalBuildDirs: [],
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
    console.error('Failed to load config:', e);
  }
  return workspaceConfig;
}

async function saveWorkspaceConfig(config: Partial<WorkspaceConfig>): Promise<void> {
  workspaceConfig = { ...workspaceConfig, ...config };
  await ensureDirectory(CONFIG_DIR);
  await fs.writeFile(CONFIG_FILE, JSON.stringify(workspaceConfig, null, 2));
}

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
const REBOOT_PATTERNS = [
  /rst:0x[0-9a-f]+/i,
  /Brownout detector/i,
  /Backtrace:/i,
  /Guru Meditation Error/i,
  /CPU halted/i,
];

let PYTHON = resolvePythonExecutable();

const SERIAL_PROBE_SCRIPT = `import sys, time
try:
    import serial
except ImportError:
    sys.exit(0)

port = sys.argv[1]
baud = int(sys.argv[2])
duration = float(sys.argv[3])

try:
    ser = serial.Serial(port, baudrate=baud, timeout=0.05)
except Exception:
    sys.exit(0)

try:
    try:
        ser.dtr = False
        ser.rts = False
        time.sleep(0.05)
        ser.dtr = True
        ser.rts = True
    except Exception:
        pass
    time.sleep(0.05)
    end_time = time.time() + duration
    buf = bytearray()
    while time.time() < end_time:
        data = ser.read(256)
        if data:
            buf.extend(data)
    sys.stdout.buffer.write(buf)
finally:
    ser.close()
`;

const SERIAL_MONITOR_SCRIPT = `import sys, time
try:
    import serial
except ImportError:
    sys.exit(1)

port = sys.argv[1]
baud = int(sys.argv[2])
raw = sys.argv[3] == '1'

try:
    ser = serial.Serial(port, baudrate=baud, timeout=0.05)
except Exception as exc:
    sys.stderr.write(str(exc))
    sys.exit(1)

try:
    try:
        ser.dtr = False
        ser.rts = False
        time.sleep(0.05)
        ser.dtr = True
        ser.rts = True
    except Exception:
        pass
    time.sleep(0.05)
    if raw:
        while True:
            data = ser.read(256)
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.flush()
    else:
        while True:
            line = ser.readline()
            if line:
                try:
                    sys.stdout.write(line.decode('utf-8', errors='replace'))
                except Exception:
                    sys.stdout.write(line.decode('latin-1', errors='replace'))
                sys.stdout.flush()
finally:
    ser.close()
`;

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
  copiedToBuildDir?: string[];
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

interface DetectedPortInfo {
  port: string;
  protocol?: string;
  label?: string;
  product?: string;
  vendor?: string;
  matchingFqbn?: string;
  isEsp32: boolean;
  reachable: boolean;
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

interface PinSpec {
  number: number;
  name: string;
  altNames?: string[];
  available: boolean;
  digitalIn: boolean;
  digitalOut: boolean;
  analogIn: boolean;
  dac: boolean;
  touch: boolean;
  pwm: boolean;
  inputOnly: boolean;
  strapping?: boolean;
  notes?: string;
}

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

interface UnknownIdentifier {
  identifier: string;
  file: string;
  line: number;
}

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

interface SerialEventPayload {
  type: 'serial' | 'serial_end';
  token?: string;
  port?: string;
  line?: string;
  raw?: boolean;
  encoding?: string;
  timestamp?: string;
  lineNumber?: number;
  baud?: number;
  stream?: 'stderr';
  reason?: string;
  elapsedSeconds?: number;
  rebootDetected?: boolean;
  lastLine?: string;
  exitCode?: number;
}

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

class SerialBroadcaster {
  private clients = new Set<http.ServerResponse>();
  private keepAliveTimer?: NodeJS.Timeout;
  private buffer: SerialEventPayload[] = [];
  private bufferLimit = 500;

  addClient(res: http.ServerResponse) {
    this.clients.add(res);
    this.flushBuffer(res);
    this.ensureKeepAlive();
  }

  removeClient(res: http.ServerResponse) {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  broadcast(event: SerialEventPayload) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.write(data);
    }
    this.buffer.push(event);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }
  }

  getBuffer(): SerialEventPayload[] {
    return [...this.buffer];
  }

  clearBuffer() {
    this.buffer = [];
  }

  private flushBuffer(res: http.ServerResponse) {
    for (const event of this.buffer) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  private ensureKeepAlive() {
    if (this.keepAliveTimer) {
      return;
    }
    this.keepAliveTimer = setInterval(() => {
      const heartbeat = `: keep-alive ${Date.now()}\n\n`;
      for (const client of this.clients) {
        client.write(heartbeat);
      }
    }, 15000);
  }
}

const serialBroadcaster = new SerialBroadcaster();

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ESP32 Serial Console</title>
  <style>
    :root { 
      --bg-dark: #0a0f1a; 
      --bg-panel: #0d1525; 
      --bg-input: #111827;
      --border: #1e3a5f; 
      --text: #e2e8f0; 
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --highlight-bg: #422006;
      --stacktrace-bg: #1c1917;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-dark); color: var(--text); font-size: 14px; }
    
    /* Header */
    header { background: linear-gradient(180deg, #0f1729 0%, #0d1525 100%); border-bottom: 1px solid var(--border); padding: 12px 20px; position: sticky; top: 0; z-index: 100; }
    .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
    .logo { font-size: 18px; font-weight: 700; background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; }
    .status-badge.connected { background: rgba(34, 197, 94, 0.15); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-badge.disconnected { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }
    .status-badge.connected .status-dot { background: var(--success); }
    .status-badge.disconnected .status-dot { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    
    /* Toolbar */
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar-group { display: flex; gap: 6px; align-items: center; padding: 4px 8px; background: var(--bg-input); border-radius: 8px; border: 1px solid var(--border); }
    .toolbar-group label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    input, select { background: var(--bg-dark); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; outline: none; transition: border-color 0.2s; }
    input:focus, select:focus { border-color: var(--accent); }
    input::placeholder { color: var(--text-muted); }
    input.error { border-color: var(--danger); }
    .input-wide { min-width: 180px; }
    
    /* Buttons */
    button { background: var(--accent); color: white; border: none; border-radius: 6px; padding: 6px 14px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    button:hover { background: var(--accent-hover); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #dc2626; }
    button.success { background: var(--success); }
    button.success:hover { background: #16a34a; }
    button.outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    button.outline:hover { background: var(--bg-input); border-color: var(--accent); }
    button.sm { padding: 4px 8px; font-size: 11px; }
    
    /* Main Layout */
    main { display: grid; grid-template-columns: 1fr 360px; gap: 16px; padding: 16px 20px; min-height: calc(100vh - 140px); }
    @media (max-width: 1200px) { main { grid-template-columns: 1fr; } }
    
    /* Panels */
    .panel { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .panel-header { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%); }
    .panel-title { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .panel-title .icon { font-size: 16px; }
    .panel-actions { display: flex; gap: 6px; align-items: center; }
    .panel-body { flex: 1; overflow-y: auto; padding: 8px; font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace; font-size: 12px; line-height: 1.5; }
    .panel-body::-webkit-scrollbar { width: 8px; }
    .panel-body::-webkit-scrollbar-track { background: var(--bg-dark); }
    .panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    
    /* Serial Grid */
    .serial-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); }
    .port-panel { min-height: 300px; max-height: 500px; }
    .port-panel .panel-body { max-height: 400px; }
    
    /* Log Lines */
    .log-line { padding: 2px 8px; border-radius: 4px; margin-bottom: 1px; white-space: pre-wrap; word-break: break-all; display: flex; gap: 8px; }
    .log-line:hover { background: rgba(255,255,255,0.03); }
    .log-time { color: var(--text-muted); min-width: 75px; flex-shrink: 0; }
    .log-content { flex: 1; }
    .log-line.stderr { color: var(--danger); }
    .log-line.highlight { background: var(--highlight-bg); border-left: 3px solid var(--warning); }
    .log-line.stacktrace { background: var(--stacktrace-bg); color: #fca5a5; border-left: 3px solid var(--danger); }
    .log-line.reboot { background: rgba(139, 92, 246, 0.15); border-left: 3px solid #8b5cf6; color: #c4b5fd; }
    .highlight-match { background: var(--warning); color: #000; padding: 0 2px; border-radius: 2px; }
    
    /* Sidebar Panels */
    .sidebar { display: flex; flex-direction: column; gap: 12px; }
    .sidebar .panel { flex-shrink: 0; }
    .alert-panel .panel-body { max-height: 200px; }
    .stacktrace-panel .panel-body { max-height: 180px; }
    
    /* Port Control */
    .port-control { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; background: var(--bg-input); border-bottom: 1px solid var(--border); }
    .port-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--bg-dark); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .port-item.active { border-color: var(--success); background: rgba(34, 197, 94, 0.1); }
    .port-item .port-name { font-weight: 500; }
    .port-item .baud { color: var(--text-muted); }
    
    /* Stats */
    .stats { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); }
    .stat { display: flex; align-items: center; gap: 4px; }
    .stat-value { color: var(--text); font-weight: 600; }
    
    /* Badge/Pill */
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge.info { background: rgba(59, 130, 246, 0.2); color: var(--accent); }
    .badge.success { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge.warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    .badge.danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    
    /* Control Panel */
    .control-panel { padding: 14px; }
    .control-section { margin-bottom: 16px; }
    .control-section:last-child { margin-bottom: 0; }
    .control-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: block; }
    .control-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .control-row:last-child { margin-bottom: 0; }
    
    /* Port List */
    .port-list { max-height: 150px; overflow-y: auto; }
    .port-list-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 6px; margin-bottom: 4px; background: var(--bg-dark); border: 1px solid var(--border); }
    .port-list-item:hover { border-color: var(--accent); }
    .port-list-item.monitoring { border-color: var(--success); background: rgba(34, 197, 94, 0.05); }
    .port-info { display: flex; flex-direction: column; gap: 2px; }
    .port-name { font-weight: 500; font-size: 13px; }
    .port-detail { font-size: 11px; color: var(--text-muted); }
    
    /* Empty State */
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; color: var(--text-muted); text-align: center; }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-state p { margin: 0 0 16px 0; }
    
    /* Toast notifications */
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    .toast { box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s; }
    
    /* Status indicators */
    .status-indicator { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; }
    .status-indicator.monitoring { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .status-indicator.stopped { background: rgba(100, 116, 139, 0.15); color: var(--text-muted); }
    
    /* Pulse animation for active indicators */
    @keyframes pulse-green {
      0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
      50% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
    }
    .pulse { animation: pulse-green 2s infinite; }
    
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo">⚡ ESP32 Serial Console</div>
      <div class="status-badge disconnected" id="statusBadge">
        <span class="status-dot"></span>
        <span id="statusText">Connecting...</span>
      </div>
      <div class="stats">
        <div class="stat">Lines: <span class="stat-value" id="totalLines">0</span></div>
        <div class="stat">Alerts: <span class="stat-value" id="totalAlerts">0</span></div>
        <div class="stat">Crashes: <span class="stat-value" id="totalCrashes">0</span></div>
      </div>
    </div>
    <div class="toolbar">
      <div class="toolbar-group">
        <label>Filter</label>
        <input type="text" id="textFilter" class="input-wide" placeholder="Filter logs (regex)" title="正規表現でログをフィルタリング。例: WiFi|HTTP" />
      </div>
      <div class="toolbar-group">
        <label>Highlight</label>
        <input type="text" id="highlightFilter" class="input-wide" placeholder="Highlight text (regex)" title="マッチしたテキストを黄色でハイライト表示" />
      </div>
      <div class="toolbar-group">
        <label>Alert on</label>
        <input type="text" id="alertFilter" class="input-wide" placeholder="Alert pattern (regex)" title="マッチしたログをAlertsパネルにも表示" />
      </div>
      <button class="outline" id="clearAllBtn" title="全ポートのログをクリア">🗑 Clear All</button>
      <button class="outline" id="exportBtn" title="ログをテキストファイルでダウンロード">📥 Export</button>
      <button class="danger" id="stopStreamBtn" title="SSEストリームを停止（モニターは継続）">⏹ Stop</button>
      <button class="success" id="startStreamBtn" title="SSEストリームを再開">▶ Start</button>
    </div>
  </header>

  <main>
    <div class="serial-area">
      <div class="panel" style="margin-bottom: 12px;">
      <div class="panel-header">
          <div class="panel-title">🔌 Active Ports</div>
          <button class="sm outline" id="refreshPortsBtn">↻ Refresh</button>
      </div>
        <div class="port-control" id="portControl">
          <div class="empty-state" style="padding: 20px; width: 100%;">
            <p>No active monitors. Start monitoring from the control panel →</p>
          </div>
        </div>
      </div>
      <div class="serial-grid" id="serialGrid">
        <!-- Port panels will be added dynamically -->
      </div>
    </div>

    <div class="sidebar">
      <!-- Monitor Control Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">🎛 Monitor Control</div>
        </div>
        <div class="control-panel">
          <div class="control-section">
            <span class="control-label">Available Ports</span>
            <div class="port-list" id="availablePorts">
              <div class="empty-state" style="padding: 20px;">
                <p>Click refresh to scan ports</p>
              </div>
            </div>
            <div class="control-row" style="margin-top: 8px;">
              <button class="outline" style="flex:1" id="scanPortsBtn" title="USBシリアルポートをスキャンして一覧表示">🔍 Scan Ports</button>
            </div>
          </div>
          <div class="control-section">
            <span class="control-label">Quick Start</span>
            <div class="control-row">
              <select id="baudSelect" style="flex:1" title="シリアル通信のボーレート（ESP32は通常115200）">
                <option value="115200" selected>115200</option>
                <option value="74880">74880</option>
                <option value="57600">57600</option>
                <option value="38400">38400</option>
                <option value="19200">19200</option>
                <option value="9600">9600</option>
              </select>
              <label style="display:flex; align-items:center; gap:4px; font-size:12px;" title="ESP32起動時のボーレート自動検出（74880→115200）">
                <input type="checkbox" id="autoBaudCheck" checked /> Auto
              </label>
            </div>
            <div class="control-row">
              <button class="success" style="flex:1" id="startAllBtn" title="ESP32ポート（cu.SLAB_USBtoUART, cu.usbserial等）を一括で監視開始">▶ Start All ESP32</button>
            </div>
            <div class="control-row">
              <button class="danger" style="flex:1" id="stopAllBtn" title="すべてのシリアル監視を停止">⏹ Stop All</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Alerts Panel -->
      <div class="panel alert-panel">
        <div class="panel-header">
          <div class="panel-title">
            🔔 Alerts
            <span class="badge warning" id="alertBadge">0</span>
          </div>
          <button class="sm outline" id="clearAlertsBtn">Clear</button>
        </div>
        <div class="panel-body" id="alertsBody">
          <div class="empty-state" style="padding: 20px;">
            <p>No alerts yet</p>
          </div>
        </div>
      </div>

      <!-- Stack Traces Panel -->
      <div class="panel stacktrace-panel">
        <div class="panel-header">
          <div class="panel-title">
            💥 Crashes / Reboots
            <span class="badge danger" id="crashBadge">0</span>
          </div>
          <button class="sm outline" id="clearCrashesBtn">Clear</button>
        </div>
        <div class="panel-body" id="crashesBody">
          <div class="empty-state" style="padding: 20px;">
            <p>No crashes detected</p>
          </div>
        </div>
      </div>

      <!-- Device Info Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">📱 Device Info</div>
          <button class="sm outline" id="refreshDeviceInfoBtn" title="esptool.pyでチップ情報を再取得">↻ Refresh</button>
        </div>
        <div class="control-panel" id="deviceInfoPanel">
          <div class="empty-state" style="padding: 20px;">
            <p>Select a port to view device info</p>
          </div>
        </div>
      </div>

      <!-- Firmware Upload Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">📦 Firmware Upload</div>
        </div>
        <div class="control-panel">
          <div class="control-section">
            <span class="control-label">Build Artifacts</span>
            <select id="artifactSelect" style="width:100%; margin-bottom:8px;" title="ビルド済みバイナリ(.bin)を選択">
              <option value="">-- Select firmware --</option>
            </select>
            <div class="control-row">
              <button class="outline" style="flex:1" id="scanArtifactsBtn" title="ビルドディレクトリからファームウェアを検索">🔍 Scan Builds</button>
            </div>
          </div>
          <div class="control-section">
            <span class="control-label">Upload Options</span>
            <div class="control-row">
              <label style="display:flex; align-items:center; gap:4px; font-size:12px;" title="アップロード前にFlashメモリを完全消去（工場出荷時状態に）">
                <input type="checkbox" id="eraseBeforeFlash" /> Erase before flash
              </label>
            </div>
            <div class="control-row">
              <button class="success" style="flex:1" id="uploadFirmwareBtn" title="Available Portsで選択中のポートにアップロード">⬆ Upload to Selected</button>
            </div>
            <div class="control-row">
              <button class="success" style="flex:1" id="uploadAllBtn" title="接続中のすべてのESP32に同じファームウェアを一括アップロード">⬆ Upload to All ESP32</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Arduino CLI Settings Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">⚙ Settings</div>
        </div>
        <div class="control-panel">
          <div class="control-section">
            <span class="control-label">FQBN (Board)</span>
            <select id="fqbnSelect" style="width:100%;" title="Fully Qualified Board Name：ボードの種類を指定">
              <option value="esp32:esp32:esp32" selected>ESP32 Dev Module</option>
              <option value="esp32:esp32:esp32wrover">ESP32 Wrover Module</option>
              <option value="esp32:esp32:esp32s2">ESP32-S2</option>
              <option value="esp32:esp32:esp32s3">ESP32-S3</option>
              <option value="esp32:esp32:esp32c3">ESP32-C3</option>
            </select>
          </div>
          <div class="control-section">
            <span class="control-label">Partition Scheme</span>
            <select id="partitionSelect" style="width:100%;" title="Flashメモリのパーティション配分を指定">
              <option value="default" selected>Default 4MB</option>
              <option value="huge_app">Huge APP (3MB)</option>
              <option value="min_spiffs">Minimal SPIFFS</option>
              <option value="no_ota">No OTA</option>
            </select>
          </div>
          <div class="control-section">
            <span class="control-label">Flash Mode</span>
            <select id="flashModeSelect" style="width:100%;" title="Flashアクセスモード（通常QIO、互換性問題時DIO）">
              <option value="qio" selected>QIO</option>
              <option value="dio">DIO</option>
              <option value="qout">QOUT</option>
              <option value="dout">DOUT</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </main>

  <script>
    // State
    let es = null;
    let textRegex = null;
    let highlightRegex = null;
    let alertRegex = null;
    let totalLines = 0;
    let totalAlerts = 0;
    let totalCrashes = 0;
    const portPanels = new Map();
    const monitoringPorts = new Set();
    const allLogs = [];
    const MAX_LOGS = 1000;
    
    // Crash/Reboot patterns
    const CRASH_PATTERNS = [
      /Guru Meditation Error/i,
      /Backtrace:/i,
      /rst:0x[0-9a-f]+/i,
      /Brownout detector/i,
      /CPU halted/i,
      /assert failed/i,
      /panic/i,
      /LoadProhibited/i,
      /StoreProhibited/i,
      /InstrFetchProhibited/i,
      /IllegalInstruction/i,
    ];
    
    // DOM elements
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const totalLinesEl = document.getElementById('totalLines');
    const totalAlertsEl = document.getElementById('totalAlerts');
    const totalCrashesEl = document.getElementById('totalCrashes');
    const textFilterEl = document.getElementById('textFilter');
    const highlightFilterEl = document.getElementById('highlightFilter');
    const alertFilterEl = document.getElementById('alertFilter');
    const serialGrid = document.getElementById('serialGrid');
    const portControl = document.getElementById('portControl');
    const alertsBody = document.getElementById('alertsBody');
    const crashesBody = document.getElementById('crashesBody');
    const alertBadge = document.getElementById('alertBadge');
    const crashBadge = document.getElementById('crashBadge');
    const availablePorts = document.getElementById('availablePorts');
    const baudSelect = document.getElementById('baudSelect');
    const autoBaudCheck = document.getElementById('autoBaudCheck');
    
    // Filter handlers
    textFilterEl.addEventListener('input', () => {
      const val = textFilterEl.value.trim();
      try { 
        textRegex = val ? new RegExp(val, 'i') : null; 
        textFilterEl.classList.remove('error');
      } catch { 
        textRegex = null; 
        textFilterEl.classList.add('error');
      }
    });
    
    highlightFilterEl.addEventListener('input', () => {
      const val = highlightFilterEl.value.trim();
      try { 
        highlightRegex = val ? new RegExp(val, 'gi') : null; 
        highlightFilterEl.classList.remove('error');
      } catch { 
        highlightRegex = null; 
        highlightFilterEl.classList.add('error');
      }
    });
    
    alertFilterEl.addEventListener('input', () => {
      const val = alertFilterEl.value.trim();
      try { 
        alertRegex = val ? new RegExp(val, 'i') : null; 
        alertFilterEl.classList.remove('error');
      } catch { 
        alertRegex = null; 
        alertFilterEl.classList.add('error');
      }
    });
    
    // Button handlers
    document.getElementById('clearAllBtn').onclick = () => clearAllLogs();
    document.getElementById('exportBtn').onclick = () => exportLogs();
    document.getElementById('stopStreamBtn').onclick = () => disconnect();
    document.getElementById('startStreamBtn').onclick = () => connect();
    document.getElementById('clearAlertsBtn').onclick = () => { alertsBody.innerHTML = ''; totalAlerts = 0; updateStats(); };
    document.getElementById('clearCrashesBtn').onclick = () => { crashesBody.innerHTML = ''; totalCrashes = 0; updateStats(); };
    document.getElementById('scanPortsBtn').onclick = () => scanPorts();
    document.getElementById('refreshPortsBtn').onclick = () => scanPorts();
    document.getElementById('startAllBtn').onclick = () => startAllMonitors();
    document.getElementById('stopAllBtn').onclick = () => stopAllMonitors();
    
    function updateStats() {
      totalLinesEl.textContent = totalLines;
      totalAlertsEl.textContent = totalAlerts;
      totalCrashesEl.textContent = totalCrashes;
      alertBadge.textContent = totalAlerts;
      crashBadge.textContent = totalCrashes;
    }
    
    function setStatus(connected, text) {
      statusBadge.className = 'status-badge ' + (connected ? 'connected' : 'disconnected');
      statusText.textContent = text;
    }
    
    function formatTime(date) {
      return date.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function applyHighlight(text) {
      if (!highlightRegex) return escapeHtml(text);
      return escapeHtml(text).replace(highlightRegex, match => '<span class="highlight-match">' + match + '</span>');
    }
    
    function isCrashLine(text) {
      return CRASH_PATTERNS.some(p => p.test(text));
    }
    
    function ensurePortPanel(port) {
      if (portPanels.has(port)) return portPanels.get(port);
      
      // Add to monitoring set when panel is created
      monitoringPorts.add(port);
      
      const panel = document.createElement('div');
      panel.className = 'panel port-panel';
      panel.id = 'panel-' + CSS.escape(port);
      panel.innerHTML = \`
        <div class="panel-header">
          <div class="panel-title">
            <span class="icon">📟</span>
            <span>\${escapeHtml(port)}</span>
            <span class="badge success pulse" id="status-\${CSS.escape(port)}">● LIVE</span>
            <span class="badge info" id="baud-\${CSS.escape(port)}" title="現在のボーレート">--</span>
          </div>
          <div class="panel-actions">
            <button class="sm outline" onclick="clearPortLogs('\${escapeHtml(port)}')" title="このポートのログをクリア">🗑</button>
            <button class="sm outline" onclick="restartPortMonitor('\${escapeHtml(port)}')" title="モニターを再起動（ポートを閉じて再接続）">🔄</button>
            <button class="sm danger" onclick="stopPortMonitor('\${escapeHtml(port)}')" title="このポートの監視を停止">⏹ Stop</button>
          </div>
        </div>
        <div class="panel-body" id="logs-\${CSS.escape(port)}"></div>
      \`;
      serialGrid.appendChild(panel);
      
      const body = panel.querySelector('.panel-body');
      portPanels.set(port, { panel, body, lineCount: 0 });
      updatePortControl();
      return portPanels.get(port);
    }
    
    function updatePortControl() {
      const ports = Array.from(portPanels.keys());
      if (ports.length === 0) {
        portControl.innerHTML = '<div class="empty-state" style="padding: 20px; width: 100%;"><p>No active monitors. Click "Scan Ports" and start a monitor.</p></div>';
        return;
      }
      portControl.innerHTML = ports.map(port => \`
        <div class="port-item active" style="cursor:pointer" onclick="document.getElementById('panel-' + CSS.escape('\${escapeHtml(port)}')).scrollIntoView({behavior:'smooth'})">
          <span style="color:#22c55e;font-size:10px;">●</span>
          <span class="port-name">\${escapeHtml(port)}</span>
          <span class="baud" id="ctrl-baud-\${CSS.escape(port)}" style="background:#22c55e22;padding:2px 6px;border-radius:4px;"></span>
          <button class="sm outline" onclick="event.stopPropagation();restartPortMonitor('\${escapeHtml(port)}')" title="Restart" style="padding:2px 6px;">🔄</button>
        </div>
      \`).join('');
    }
    
    function appendLog(evt) {
        const port = evt.port || 'unknown';
      const portData = ensurePortPanel(port);
      const text = evt.line ?? '';
      const isCrash = isCrashLine(text);
      const isReboot = /rst:0x|ets [A-Z][a-z]+ \\d+ \\d{4}/i.test(text);
      
      // Update baud display
      if (evt.baud) {
        const baudEl = document.getElementById('baud-' + CSS.escape(port));
        const ctrlBaudEl = document.getElementById('ctrl-baud-' + CSS.escape(port));
        if (baudEl) baudEl.textContent = evt.baud + ' baud';
        if (ctrlBaudEl) ctrlBaudEl.textContent = evt.baud;
      }
      
      // Check filter
      if (textRegex && !textRegex.test(text)) return;
      
      totalLines++;
      portData.lineCount++;
      
      // Create log line
        const div = document.createElement('div');
      let className = 'log-line';
      if (evt.stream === 'stderr') className += ' stderr';
      if (isCrash) className += ' stacktrace';
      else if (isReboot) className += ' reboot';
      else if (highlightRegex && highlightRegex.test(text)) className += ' highlight';
      div.className = className;
      
      const sysTime = formatTime(new Date());
      div.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">' + applyHighlight(text) + '</span>';
      
      portData.body.appendChild(div);
      
      // Limit lines
      while (portData.body.childElementCount > MAX_LOGS) {
        portData.body.removeChild(portData.body.firstChild);
      }
      
      div.scrollIntoView({ block: 'end', behavior: 'auto' });
      
      // Store log
      allLogs.push({ time: sysTime, port, text, isCrash, isReboot });
      if (allLogs.length > MAX_LOGS * 10) allLogs.splice(0, allLogs.length - MAX_LOGS * 10);
      
      // Alert check
        if (alertRegex && alertRegex.test(text)) {
        totalAlerts++;
          const alertDiv = document.createElement('div');
        alertDiv.className = 'log-line' + (isCrash ? ' stacktrace' : '');
        alertDiv.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">[' + escapeHtml(port) + '] ' + applyHighlight(text) + '</span>';
        alertsBody.querySelector('.empty-state')?.remove();
          alertsBody.appendChild(alertDiv);
        while (alertsBody.childElementCount > 200) alertsBody.removeChild(alertsBody.firstChild);
          alertDiv.scrollIntoView({ block: 'end' });
        }
      
      // Crash detection
      if (isCrash || isReboot) {
        totalCrashes++;
        const crashDiv = document.createElement('div');
        crashDiv.className = 'log-line' + (isCrash ? ' stacktrace' : ' reboot');
        crashDiv.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">[' + escapeHtml(port) + '] ' + escapeHtml(text) + '</span>';
        crashesBody.querySelector('.empty-state')?.remove();
        crashesBody.appendChild(crashDiv);
        while (crashesBody.childElementCount > 100) crashesBody.removeChild(crashesBody.firstChild);
        crashDiv.scrollIntoView({ block: 'end' });
      }
      
      updateStats();
    }
    
    function clearPortLogs(port) {
      const portData = portPanels.get(port);
      if (portData) {
        portData.body.innerHTML = '';
        portData.lineCount = 0;
      }
    }
    
    function clearAllLogs() {
      for (const [port, data] of portPanels) {
        data.body.innerHTML = '';
        data.lineCount = 0;
      }
      totalLines = 0;
      updateStats();
    }
    
    function exportLogs() {
      const text = allLogs.map(l => l.time + ' [' + l.port + '] ' + l.text).join('\\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'esp32-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      a.click();
      URL.revokeObjectURL(url);
    }
    
    // Toast notification
    function showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;animation:slideIn 0.3s ease;';
      if (type === 'success') toast.style.background = '#22c55e';
      else if (type === 'error') toast.style.background = '#ef4444';
      else if (type === 'warning') toast.style.background = '#f59e0b';
      else toast.style.background = '#3b82f6';
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
    }
    
    // Fetch active monitors from server
    async function fetchActiveMonitors() {
      try {
        const resp = await fetch('/api/monitors');
        const data = await resp.json();
        if (data.ok && data.monitors) {
          monitoringPorts.clear();
          for (const m of data.monitors) {
            if (m && m.port) monitoringPorts.add(m.port);
          }
        }
      } catch (err) {
        console.error('Failed to fetch monitors:', err);
      }
    }
    
    async function scanPorts() {
      const btn = document.getElementById('scanPortsBtn');
      btn.disabled = true;
      btn.textContent = '🔄 Scanning...';
      
      // First, fetch active monitors
      await fetchActiveMonitors();
      
      try {
        const resp = await fetch('/api/ports');
        const data = await resp.json();
        if (data.ports && data.ports.length > 0) {
          availablePorts.innerHTML = data.ports.map(p => {
            const isMonitoring = monitoringPorts.has(p.port);
            return \`
            <div class="port-list-item \${isMonitoring ? 'monitoring' : ''}">
              <div class="port-info">
                <div class="port-name">
                  \${isMonitoring ? '🟢' : '⚪'} \${escapeHtml(p.port)}
                </div>
                <div class="port-detail">
                  \${p.isEsp32 ? '✓ ESP32' : ''} 
                  \${p.label || ''} 
                  \${isMonitoring ? '<span style="color:#22c55e;">● Monitoring</span>' : ''}
                </div>
              </div>
              <button class="sm \${isMonitoring ? 'danger' : 'success'}" 
                      onclick="\${isMonitoring ? 'stopPortMonitor' : 'startPortMonitor'}('\${escapeHtml(p.port)}')"
                      id="btn-\${CSS.escape(p.port)}">
                \${isMonitoring ? '⏹ Stop' : '▶ Start'}
              </button>
            </div>
          \`}).join('');
          showToast('Found ' + data.ports.length + ' port(s), ' + monitoringPorts.size + ' monitoring', 'info');
        } else {
          // If no ports from API, try to list serial ports directly
          availablePorts.innerHTML = '<div class="empty-state" style="padding:20px;"><p>No ports found. Connect ESP32 via USB.</p></div>';
          showToast('No ports found', 'warning');
        }
      } catch (err) {
        availablePorts.innerHTML = '<div class="empty-state" style="padding:20px;"><p>Failed to scan ports</p></div>';
        showToast('Scan failed: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Scan Ports';
      }
    }
    
    async function startPortMonitor(port) {
      const btn = document.getElementById('btn-' + CSS.escape(port));
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }
      
      const baud = parseInt(baudSelect.value);
      const autoBaud = autoBaudCheck.checked;
      try {
        const resp = await fetch('/api/monitor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, baud, auto_baud: autoBaud })
        });
        const data = await resp.json();
        if (data.ok) {
          monitoringPorts.add(port);
          showToast('✓ Started monitoring ' + port + ' @ ' + (data.baud || baud) + ' baud', 'success');
          await scanPorts();
        } else {
          showToast('✗ Failed to start: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        console.error('Failed to start monitor:', err);
        showToast('✗ Start failed: ' + err.message, 'error');
      } finally {
        const btn = document.getElementById('btn-' + CSS.escape(port));
        if (btn) { btn.disabled = false; }
        await scanPorts();
      }
    }
    
    async function stopPortMonitor(port) {
      const btn = document.getElementById('btn-' + CSS.escape(port));
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Stopping...'; }
      
      try {
        const resp = await fetch('/api/monitor/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port })
        });
        const data = await resp.json();
        monitoringPorts.delete(port);
        if (data.ok) {
          showToast('⏹ Stopped monitoring ' + port, 'info');
        } else {
          showToast('Stop completed (port may have disconnected)', 'warning');
        }
      } catch (err) {
        console.error('Failed to stop monitor:', err);
        showToast('Stop error: ' + err.message, 'error');
      } finally {
        await scanPorts();
      }
    }
    
    async function restartPortMonitor(port) {
      showToast('🔄 Restarting monitor for ' + port + '...', 'info');
      await stopPortMonitor(port);
      await new Promise(r => setTimeout(r, 1000));
      await startPortMonitor(port);
    }
    
    async function startAllMonitors() {
      const btn = document.getElementById('startAllBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Starting...';
      
      try {
        const resp = await fetch('/api/ports');
        const data = await resp.json();
        const esp32Ports = (data.ports || []).filter(p => p.isEsp32);
        
        if (esp32Ports.length === 0) {
          showToast('No ESP32 devices found', 'warning');
          return;
        }
        
        showToast('Starting ' + esp32Ports.length + ' monitor(s)...', 'info');
        
        for (const p of esp32Ports) {
          await startPortMonitor(p.port);
          await new Promise(r => setTimeout(r, 500)); // Small delay between starts
        }
        
        showToast('✓ All ' + esp32Ports.length + ' monitors started', 'success');
      } catch (err) {
        console.error('Failed to start all:', err);
        showToast('Failed to start monitors: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Start All ESP32';
      }
    }
    
    async function stopAllMonitors() {
      const btn = document.getElementById('stopAllBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Stopping...';
      
      try {
        const count = monitoringPorts.size;
        const resp = await fetch('/api/monitor/stop-all', { method: 'POST' });
        const data = await resp.json();
        monitoringPorts.clear();
        showToast('⏹ Stopped ' + (data.stopped || count) + ' monitor(s)', 'info');
        await scanPorts();
      } catch (err) {
        console.error('Failed to stop all:', err);
        showToast('Failed to stop monitors: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '⏹ Stop All';
      }
    }

    function connect() {
      if (es) es.close();
      es = new EventSource('/events');
      es.onopen = () => setStatus(true, 'Connected');
      es.onerror = () => setStatus(false, 'Disconnected (retrying...)');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'serial') {
            appendLog(data);
          } else if (data.type === 'serial_end') {
            const port = data.port;
            monitoringPorts.delete(port);
            appendLog({ ...data, line: '<Monitor ended: ' + (data.reason || 'unknown') + '>' });
          }
        } catch (e) { /* ignore */ }
      };
    }
    
    function disconnect() {
      if (es) { es.close(); es = null; }
      setStatus(false, 'Stopped');
    }
    
    // Device info and MAC extraction
    const macPatterns = [
      /MAC[:\\s]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/gi,
      /WiFi[:\\s]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/gi,
      /BT[:\\s]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/gi,
      /efuse[:\\s]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/gi,
    ];
    const deviceInfo = new Map(); // port -> { wifiMac, btMac, chipId, ... }
    
    function extractMacFromLogs(port) {
      const portData = portPanels.get(port);
      if (!portData) return null;
      
      const info = { wifiMac: null, btMac: null, chipId: null, freeHeap: null };
      const logText = Array.from(portData.body.querySelectorAll('.log-content')).map(el => el.textContent).join('\\n');
      
      // Extract WiFi MAC
      const wifiMatch = logText.match(/(?:WiFi|STA)[^0-9A-Fa-f]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/i);
      if (wifiMatch) info.wifiMac = wifiMatch[0].match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/i)?.[0];
      
      // Extract BT MAC
      const btMatch = logText.match(/(?:BT|Bluetooth)[^0-9A-Fa-f]*([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/i);
      if (btMatch) info.btMac = btMatch[0].match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/i)?.[0];
      
      // Extract Chip ID
      const chipMatch = logText.match(/Chip\\s*(?:ID|Rev)[^:]*:\\s*([0-9A-Fa-fx]+)/i);
      if (chipMatch) info.chipId = chipMatch[1];
      
      // Extract Free Heap
      const heapMatch = logText.match(/(?:Free\\s*)?[Hh]eap[^:]*:\\s*(\\d+)/i);
      if (heapMatch) info.freeHeap = parseInt(heapMatch[1]);
      
      deviceInfo.set(port, info);
      return info;
    }
    
    function updateDeviceInfoPanel() {
      const panel = document.getElementById('deviceInfoPanel');
      const ports = Array.from(portPanels.keys());
      
      if (ports.length === 0) {
        panel.innerHTML = '<div class="empty-state" style="padding: 20px;"><p>No active ports</p></div>';
        return;
      }
      
      let html = '';
      for (const port of ports) {
        const info = extractMacFromLogs(port) || {};
        html += '<div class="control-section" style="border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 10px;">';
        html += '<span class="control-label">' + escapeHtml(port) + '</span>';
        html += '<div style="font-size: 12px; font-family: monospace;">';
        html += '<div>WiFi MAC: <span style="color: var(--accent);">' + (info.wifiMac || 'Scanning...') + '</span></div>';
        html += '<div>BT MAC: <span style="color: var(--accent);">' + (info.btMac || 'Scanning...') + '</span></div>';
        if (info.chipId) html += '<div>Chip: ' + info.chipId + '</div>';
        if (info.freeHeap) html += '<div>Heap: ' + info.freeHeap.toLocaleString() + ' bytes</div>';
        html += '</div></div>';
      }
      panel.innerHTML = html || '<div class="empty-state"><p>No device info available</p></div>';
    }
    
    document.getElementById('refreshDeviceInfoBtn').onclick = updateDeviceInfoPanel;
    
    // Firmware upload functionality
    let availableArtifacts = [];
    
    async function scanArtifacts() {
      try {
        const resp = await fetch('/api/artifacts');
        const data = await resp.json();
        availableArtifacts = data.artifacts || [];
        const select = document.getElementById('artifactSelect');
        select.innerHTML = '<option value="">-- Select firmware (' + availableArtifacts.length + ' found) --</option>';
        for (const art of availableArtifacts) {
          const opt = document.createElement('option');
          opt.value = art.path;
          opt.textContent = art.name + ' (' + art.size + ')';
          select.appendChild(opt);
        }
      } catch (err) {
        console.error('Failed to scan artifacts:', err);
      }
    }
    
    async function uploadFirmware(ports, firmwarePath, eraseFirst) {
      if (!firmwarePath) {
        alert('Please select a firmware file first');
        return;
      }
      if (ports.length === 0) {
        alert('No ports selected');
        return;
      }
      
      for (const port of ports) {
        try {
          if (eraseFirst) {
            const eraseResp = await fetch('/api/erase', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ port })
            });
            const eraseData = await eraseResp.json();
            if (!eraseData.ok) {
              console.error('Erase failed for ' + port + ':', eraseData.error);
            }
          }
          
          const uploadResp = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port, firmware_path: firmwarePath })
          });
          const uploadData = await uploadResp.json();
          if (uploadData.ok) {
            console.log('Upload successful for ' + port);
          } else {
            console.error('Upload failed for ' + port + ':', uploadData.error);
          }
        } catch (err) {
          console.error('Upload error for ' + port + ':', err);
        }
      }
      alert('Upload complete! Check console for details.');
    }
    
    document.getElementById('scanArtifactsBtn').onclick = scanArtifacts;
    
    document.getElementById('uploadFirmwareBtn').onclick = () => {
      const firmware = document.getElementById('artifactSelect').value;
      const eraseFirst = document.getElementById('eraseBeforeFlash').checked;
      const activePorts = Array.from(monitoringPorts);
      if (activePorts.length === 0) {
        alert('No active monitors. Please start monitoring first.');
        return;
      }
      uploadFirmware(activePorts, firmware, eraseFirst);
    };
    
    document.getElementById('uploadAllBtn').onclick = async () => {
      const firmware = document.getElementById('artifactSelect').value;
      const eraseFirst = document.getElementById('eraseBeforeFlash').checked;
      try {
        const resp = await fetch('/api/ports');
        const data = await resp.json();
        const esp32Ports = (data.ports || []).filter(p => p.isEsp32).map(p => p.port);
        if (esp32Ports.length === 0) {
          alert('No ESP32 devices found');
          return;
        }
        uploadFirmware(esp32Ports, firmware, eraseFirst);
      } catch (err) {
        console.error('Failed to get ports:', err);
      }
    };
    
    // Settings
    function getSettings() {
      return {
        fqbn: document.getElementById('fqbnSelect').value,
        partition: document.getElementById('partitionSelect').value,
        flashMode: document.getElementById('flashModeSelect').value,
      };
    }
    
    // Periodic device info update
    setInterval(() => {
      if (portPanels.size > 0) {
        updateDeviceInfoPanel();
      }
    }, 5000);
    
    // Initial load
    connect();
    scanPorts();
    scanArtifacts();
  </script>
</body>
</html>`;

class ConsoleServer {
  private server?: http.Server;
  private options: { host: string; port: number } | null = null;

  start(options: { host: string; port: number }) {
    if (this.server && this.options && this.options.host === options.host && this.options.port === options.port) {
      return { ok: true, alreadyRunning: true, ...options };
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.options = options;
    this.server.listen(options.port, options.host);
    return { ok: true, host: options.host, port: options.port };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (!req.url) {
      res.writeHead(404, corsHeaders);
      res.end();
      return;
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, corsHeaders);
      res.end();
      return;
    }

    // SSE events endpoint
    if (req.url.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      });
      res.write(': connected\n\n');
      serialBroadcaster.addClient(res);
      req.on('close', () => serialBroadcaster.removeClient(res));
      return;
    }

    // Health check
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // API: Setup workspace
    if (req.url.startsWith('/api/workspace/setup') && req.method === 'POST') {
      try {
        const result = await setupWorkspace();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, ...result, config: workspaceConfig }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Get workspace config
    if (req.url.startsWith('/api/workspace/config') && req.method === 'GET') {
      try {
        await loadWorkspaceConfig();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, config: workspaceConfig, dirs: WORKSPACE_DIRS }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Update workspace config
    if (req.url.startsWith('/api/workspace/config') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const updates = JSON.parse(body);
        await saveWorkspaceConfig(updates);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, config: workspaceConfig }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Get available ports
    if (req.url.startsWith('/api/ports')) {
      try {
        const detection = await detectEsp32Ports(10);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, ports: detection.ports }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Start monitor
    if (req.url.startsWith('/api/monitor/start') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const params = JSON.parse(body);
        const session = await monitorManager.start({
          port: params.port,
          baud: params.baud ?? 115200,
          auto_baud: params.auto_baud ?? true,
          raw: false,
          max_seconds: params.max_seconds ?? 0,
          max_lines: 0,
          stop_on: params.stop_on,
          detect_reboot: true,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, token: session.token, port: session.port, baud: session.baud }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Stop monitor
    if (req.url.startsWith('/api/monitor/stop') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const params = JSON.parse(body);
        const session = monitorManager.get(params.token, params.port);
        if (session) {
          await session.stop();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'Monitor not found' }));
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Stop all monitors
    if (req.url.startsWith('/api/monitor/stop-all') && req.method === 'POST') {
      try {
        const tokens = monitorManager.listTokens();
        for (const token of tokens) {
          const session = monitorManager.get(token);
          if (session) {
            await session.stop();
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, stopped: tokens.length }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Get active monitors
    if (req.url.startsWith('/api/monitors')) {
      const tokens = monitorManager.listTokens();
      const monitors = tokens.map((token) => {
        const session = monitorManager.get(token);
        return session ? { token, port: session.port, baud: session.baud } : null;
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, monitors }));
      return;
    }

    // API: Get logs (for MCP to read)
    if (req.url.startsWith('/api/logs')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, logs: serialBroadcaster.getBuffer() }));
      return;
    }

    // API: Scan for build artifacts
    if (req.url.startsWith('/api/artifacts')) {
      try {
        const artifacts: Array<{ path: string; name: string; size: string; dir: string }> = [];
        // Use workspace config for search directories
        const searchDirs = [
          workspaceConfig.buildOutputDir,
          TEMP_DIR,
          ...workspaceConfig.additionalBuildDirs,
        ].filter(Boolean);
        
        for (const dir of searchDirs) {
          if (await pathExists(dir)) {
            const files = await collectArtifacts(dir);
            for (const file of files) {
              if (file.endsWith('.bin')) {
                try {
                  const stat = await fs.stat(file);
                  artifacts.push({
                    path: file,
                    name: path.basename(file),
                    size: (stat.size / 1024).toFixed(1) + ' KB',
                    dir: path.dirname(file),
                  });
                } catch (e) {
                  // ignore
                }
              }
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, artifacts, searchDirs }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Erase flash
    if (req.url.startsWith('/api/erase') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const params = JSON.parse(body);
        const result = await execa(PYTHON, ['-m', 'esptool', '--port', params.port, 'erase_flash'], { reject: false });
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Upload firmware
    if (req.url.startsWith('/api/upload') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const params = JSON.parse(body);
        
        if (!params.firmware_path || !params.port) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'Missing firmware_path or port' }));
          return;
        }
        
        // Upload using esptool.py
        const result = await execa(PYTHON, [
          '-m', 'esptool',
          '--chip', 'esp32',
          '--port', params.port,
          '--baud', '921600',
          'write_flash',
          '0x10000', // App partition offset
          params.firmware_path,
        ], { reject: false, timeout: 120000 });
        
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Get device info by querying serial
    if (req.url.startsWith('/api/device-info')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const port = url.searchParams.get('port');
        
        if (!port) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'Missing port parameter' }));
          return;
        }
        
        // Try to get MAC from esptool
        const result = await execa(PYTHON, ['-m', 'esptool', '--port', port, 'read_mac'], { reject: false, timeout: 10000 });
        
        let mac = null;
        const macMatch = result.stdout.match(/MAC:\\s*([0-9a-fA-F:]+)/);
        if (macMatch) {
          mac = macMatch[1];
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, mac, stdout: result.stdout }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // Serve HTML console
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
    res.end(CONSOLE_HTML);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}

const consoleServer = new ConsoleServer();

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
  
  // Copy .bin files to builds directory for easier access
  let copiedToBuildDir: string[] = [];
  if (result.exitCode === 0 && args.export_bin) {
    try {
      await ensureDirectory(workspaceConfig.buildOutputDir);
      for (const artifact of artifacts) {
        if (artifact.endsWith('.bin')) {
          const destPath = path.join(workspaceConfig.buildOutputDir, path.basename(artifact));
          await fs.copyFile(artifact, destPath);
          copiedToBuildDir.push(destPath);
        }
      }
    } catch (e) {
      // Ignore copy errors - the build still succeeded
    }
  }

  return {
    stage: 'compile',
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics,
    artifacts,
    copiedToBuildDir,
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
    await this.pulseReset();
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

    await this.pulseReset();
    const child = execa(PYTHON, ['-', this.options.port, String(this.selectedBaud), this.options.raw ? '1' : '0'], {
      input: SERIAL_MONITOR_SCRIPT,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });
    this.child = child;
    this.startHr = new Date();

    if (!child.stdout) {
      throw new Error('Failed to attach to monitor stdout.');
    }

    if (this.options.raw) {
      child.stdout.on('data', (chunk: Buffer) => {
        const line = chunk.toString('base64');
        this.lastLine = line;
        this.lines += 1;
        serialBroadcaster.broadcast({
          type: 'serial',
          token: this.token,
          port: this.options.port,
          line,
          raw: true,
          encoding: 'base64',
          timestamp: new Date().toISOString(),
          lineNumber: this.lines,
          baud: this.selectedBaud,
        });
        safeNotify('event/serial', {
          token: this.token,
          port: this.options.port,
          line,
          raw: true,
          encoding: 'base64',
          timestamp: new Date().toISOString(),
          lineNumber: this.lines,
          baud: this.selectedBaud,
        }).catch(() => undefined);
      });
    } else {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (rawLine) => {
        const line = stripAnsi(rawLine);
        this.lastLine = line;
        this.lines += 1;
        if (this.options.detectReboot && REBOOT_PATTERNS.some((pattern) => pattern.test(line))) {
          this.rebootDetected = true;
        }
        serialBroadcaster.broadcast({
          type: 'serial',
          token: this.token,
          port: this.options.port,
          line,
          raw: false,
          timestamp: new Date().toISOString(),
          lineNumber: this.lines,
          baud: this.selectedBaud,
        });
        safeNotify('event/serial', {
          token: this.token,
          port: this.options.port,
          line,
          raw: false,
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
    }

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
        baud: this.selectedBaud,
      });
      safeNotify('event/serial', {
        token: this.token,
        port: this.options.port,
        line,
        stream: 'stderr',
        timestamp: new Date().toISOString(),
        baud: this.selectedBaud,
      }).catch(() => undefined);
    });

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
    let sample = '';
    try {
      const { stdout } = await execa(PYTHON, ['-', this.options.port, String(baud), '1.8'], {
        input: SERIAL_PROBE_SCRIPT,
        encoding: 'buffer',
        stdout: 'pipe',
        stderr: 'ignore',
        reject: false,
      });
      sample = stdout ? stdout.toString('utf8') : '';
    } catch (error) {
      if (error && typeof error === 'object' && 'stdout' in error && error.stdout) {
        sample = (error as { stdout: Buffer }).stdout.toString('utf8');
      }
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

  private async pulseReset() {
    const resetScript = `import serial, time\ntry:\n    ser = serial.Serial(r"${this.options.port}", baudrate=${this.selectedBaud}, timeout=0.1)\n    ser.dtr = False\n    ser.rts = False\n    time.sleep(0.05)\n    ser.dtr = True\n    ser.rts = True\n    time.sleep(0.05)\n    ser.close()\nexcept Exception:\n    pass\n`;
    try {
      await execa(PYTHON, ['-'], {
        input: resetScript,
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } catch (error) {
      // ignore reset failures and proceed
    }
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
    serialBroadcaster.broadcast({
      type: 'serial_end',
      token: this.token,
      port: this.options.port,
      reason: this.stopReason,
      elapsedSeconds: summary.elapsedSeconds,
      rebootDetected: summary.rebootDetected,
      lastLine: summary.lastLine,
      exitCode: summary.exitCode,
    });
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
  const session = new MonitorSession(
    {
      port: targetPort,
      baud: 115200,
      autoBaud: true,
      raw: false,
      maxSeconds: args.monitor_seconds,
      maxLines: 0,
      stopRegex: undefined,
      detectReboot: true,
    },
    randomUUID(),
  );
  await session.start();
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
