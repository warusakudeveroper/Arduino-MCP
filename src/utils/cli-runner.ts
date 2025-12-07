/**
 * Arduino CLI Runner
 * Wrapper for arduino-cli command execution
 */

import { execa, ExecaError } from 'execa';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { CliRunResult, DetectedPortInfo } from '../types.js';
import { createLogger } from './logger.js';
import { PROJECT_ROOT } from '../config/workspace.js';

const logger = createLogger('CLIRunner');

// Vendor directories
const VENDOR_DIR = path.resolve(PROJECT_ROOT, 'vendor');
const VENDOR_ARDUINO_DIR = path.join(VENDOR_DIR, 'arduino-cli');
const VENDOR_ARDUINO_BIN = path.join(
  VENDOR_ARDUINO_DIR,
  process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'
);

// Python paths
const VENV_DIR = path.join(PROJECT_ROOT, '.venv');
const VENV_PYTHON = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

/**
 * Resolve arduino-cli executable path
 */
function resolveArduinoCliExecutable(): string {
  if (process.env.ARDUINO_CLI && fsSync.existsSync(process.env.ARDUINO_CLI)) {
    return process.env.ARDUINO_CLI;
  }
  if (fsSync.existsSync(VENDOR_ARDUINO_BIN)) {
    return VENDOR_ARDUINO_BIN;
  }
  return 'arduino-cli';
}

/**
 * Resolve Python executable path
 */
function resolvePythonExecutable(): string {
  if (process.env.MCP_PYTHON && fsSync.existsSync(process.env.MCP_PYTHON)) {
    return process.env.MCP_PYTHON;
  }
  if (fsSync.existsSync(VENV_PYTHON)) {
    return VENV_PYTHON;
  }
  return 'python3';
}

let ARDUINO_CLI = resolveArduinoCliExecutable();
let PYTHON = resolvePythonExecutable();

/**
 * Arduino CLI Runner class
 */
export class ArduinoCliRunner {
  private cliPath: string;

  constructor() {
    this.cliPath = ARDUINO_CLI;
  }

  /**
   * Get current CLI path
   */
  getPath(): string {
    return this.cliPath;
  }

  /**
   * Set CLI path
   */
  setPath(newPath: string): void {
    this.cliPath = newPath;
    ARDUINO_CLI = newPath;
  }

  /**
   * Run arduino-cli command
   */
  async run(
    args: string[], 
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<CliRunResult> {
    logger.debug('Running arduino-cli', { args, cwd: options.cwd });
    
    try {
      const mergedEnv = { ...process.env, ...(options.env ?? {}) };
      const result = await execa(this.cliPath, args, {
        cwd: options.cwd,
        env: mergedEnv,
        reject: false,
        timeout: options.timeoutMs,
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const execaError = error as ExecaError;
      logger.error('arduino-cli execution failed', { 
        error: execaError.message,
        args 
      });
      
      return {
        exitCode: execaError.exitCode ?? 1,
        stdout: execaError.stdout ?? '',
        stderr: execaError.stderr ?? execaError.message,
      };
    }
  }

  /**
   * Get executable path (alias for getPath)
   */
  getExecutable(): string {
    return this.cliPath;
  }

  /**
   * Set executable path (alias for setPath)
   */
  setExecutable(newPath: string): void {
    this.setPath(newPath);
  }

  /**
   * Get arduino-cli version
   */
  async getVersion(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const result = await this.run(['version', '--format', 'json']);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr };
    }
    
    try {
      const parsed = JSON.parse(result.stdout);
      const version = parsed.VersionString || parsed.Version || 'unknown';
      return { ok: true, version };
    } catch {
      return { ok: true, version: result.stdout.trim() };
    }
  }

  /**
   * Check if CLI is available
   */
  async isAvailable(): Promise<boolean> {
    const result = await this.getVersion();
    return result.ok;
  }

  /**
   * Detect connected ESP32 ports
   */
  async detectPorts(options: { maxPorts?: number; includeNonEsp32?: boolean } = {}): Promise<{
    ok: boolean;
    ports: DetectedPortInfo[];
    allPorts: DetectedPortInfo[];
    raw?: unknown;
    stdout?: string;
    stderr?: string;
  }> {
    const result = await this.run(['board', 'list', '--format', 'json']);
    
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      logger.warn('Failed to parse board list JSON');
      return {
        ok: false,
        ports: [],
        allPorts: [],
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const ports: DetectedPortInfo[] = [];
    const parsedObj = parsed as { ports?: unknown[]; detected_ports?: unknown[] } | undefined;
    const rawEntries = Array.isArray(parsedObj?.detected_ports)
      ? parsedObj.detected_ports
      : Array.isArray(parsedObj?.ports)
        ? parsedObj.ports
        : [];

    for (const entry of rawEntries as Array<Record<string, unknown>>) {
      const portObj = entry.port as Record<string, unknown> | undefined;
      const address = (portObj?.address as string | undefined)
        ?? (entry.address as string | undefined)
        ?? (entry.port as string | undefined)
        ?? (entry.address_label as string | undefined)
        ?? (entry.com_name as string | undefined);

      if (!address) continue;

      const boardsRaw = [
        ...(Array.isArray(entry.matching_boards) ? entry.matching_boards : []),
        ...(Array.isArray(entry.boards) ? entry.boards : []),
      ] as Array<Record<string, unknown>>;

      const matching = boardsRaw.find((board) => {
        const name = (board.FQBN as string | undefined)
          ?? (board.fqbn as string | undefined)
          ?? (board.name as string | undefined)
          ?? (board.boardName as string | undefined)
          ?? '';
        return name.toLowerCase().includes('esp32');
      });

      // Also detect ESP32 by common USB-to-serial chip patterns
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

    const esp32Ports = ports.filter((port) => port.isEsp32);
    const maxPorts = options.maxPorts ?? esp32Ports.length;
    const limitedPorts = esp32Ports.slice(0, Math.max(1, maxPorts));

    return {
      ok: result.exitCode === 0 && limitedPorts.length > 0,
      ports: limitedPorts,
      allPorts: options.includeNonEsp32 ? ports : esp32Ports,
      raw: parsed,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Get download info for arduino-cli based on platform
   */
  getDownloadInfo(): { url: string; archiveName: string; isZip: boolean } {
    const platform = process.platform;
    const arch = process.arch;
    const base = 'https://downloads.arduino.cc/arduino-cli';

    if (platform === 'darwin') {
      const suffix = arch === 'arm64' ? 'macOS_ARM64' : 'macOS_64bit';
      return { url: `${base}/arduino-cli_latest_${suffix}.tar.gz`, archiveName: `arduino-cli_latest_${suffix}.tar.gz`, isZip: false };
    }
    if (platform === 'linux') {
      const suffix = arch === 'arm64' ? 'Linux_ARM64' : 'Linux_64bit';
      return { url: `${base}/arduino-cli_latest_${suffix}.tar.gz`, archiveName: `arduino-cli_latest_${suffix}.tar.gz`, isZip: false };
    }
    if (platform === 'win32') {
      return { url: `${base}/arduino-cli_latest_Windows_64bit.zip`, archiveName: 'arduino-cli_latest_Windows_64bit.zip', isZip: true };
    }
    
    throw new Error(`Unsupported platform: ${platform}/${arch}`);
  }

  /**
   * Install arduino-cli to vendor directory
   */
  async install(): Promise<{ ok: boolean; path?: string; version?: string; error?: string }> {
    try {
      await fs.mkdir(VENDOR_ARDUINO_DIR, { recursive: true });
      
      const { url, archiveName, isZip } = this.getDownloadInfo();
      const archivePath = path.join(VENDOR_ARDUINO_DIR, archiveName);

      logger.info('Downloading arduino-cli', { url });

      // Download
      if (process.platform === 'win32') {
        await execa('powershell.exe', [
          '-Command',
          `Invoke-WebRequest -Uri "${url}" -OutFile "${archivePath}"`,
        ]);
      } else {
        await execa('curl', ['-fsSL', '-o', archivePath, url]);
      }

      // Extract
      if (isZip) {
        await execa('powershell.exe', [
          '-Command',
          `Expand-Archive -Path "${archivePath}" -DestinationPath "${VENDOR_ARDUINO_DIR}" -Force`,
        ]);
      } else {
        await execa('tar', ['-xzf', archivePath, '-C', VENDOR_ARDUINO_DIR]);
      }

      // Cleanup archive
      await fs.unlink(archivePath).catch(() => {});

      // Update path
      this.setPath(VENDOR_ARDUINO_BIN);
      
      const version = await this.getVersion();
      logger.info('arduino-cli installed', { path: VENDOR_ARDUINO_BIN, version: version.version });

      return { ok: true, path: VENDOR_ARDUINO_BIN, version: version.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to install arduino-cli', { error: message });
      return { ok: false, error: message };
    }
  }
}

/**
 * Python Runner class
 */
export class PythonRunner {
  private pythonPath: string;

  constructor() {
    this.pythonPath = PYTHON;
  }

  /**
   * Get current Python path
   */
  getPath(): string {
    return this.pythonPath;
  }

  /**
   * Set Python path
   */
  setPath(newPath: string): void {
    this.pythonPath = newPath;
    PYTHON = newPath;
  }

  /**
   * Run Python command
   */
  async run(args: string[], options: { cwd?: string; input?: string } = {}): Promise<CliRunResult> {
    try {
      const result = await execa(this.pythonPath, args, {
        cwd: options.cwd,
        input: options.input,
        reject: false,
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const execaError = error as ExecaError;
      return {
        exitCode: execaError.exitCode ?? 1,
        stdout: execaError.stdout ?? '',
        stderr: execaError.stderr ?? execaError.message,
      };
    }
  }

  /**
   * Check if Python is available
   */
  async isAvailable(): Promise<boolean> {
    const result = await this.run(['--version']);
    return result.exitCode === 0;
  }

  /**
   * Check if pyserial is installed
   */
  async hasPyserial(): Promise<boolean> {
    const result = await this.run(['-c', 'import serial; print(serial.__version__)']);
    return result.exitCode === 0;
  }

  /**
   * Install pyserial
   */
  async installPyserial(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.run(['-m', 'pip', 'install', 'pyserial']);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr };
    }
    return { ok: true };
  }

  /**
   * Setup virtual environment
   */
  async setupVenv(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      // Create venv
      const venvResult = await execa('python3', ['-m', 'venv', VENV_DIR], { reject: false });
      if (venvResult.exitCode !== 0) {
        return { ok: false, error: venvResult.stderr };
      }

      // Update path to use venv
      this.setPath(VENV_PYTHON);

      // Install pyserial in venv
      const pipResult = await this.run(['-m', 'pip', 'install', 'pyserial']);
      if (pipResult.exitCode !== 0) {
        return { ok: false, error: pipResult.stderr };
      }

      logger.info('Python venv setup complete', { path: VENV_DIR });
      return { ok: true, path: VENV_PYTHON };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
}

// Singleton instances
export const arduinoCliRunner = new ArduinoCliRunner();
export const pythonRunner = new PythonRunner();

