/**
 * Workspace Configuration Service
 * Handles loading/saving workspace config with immutable snapshots
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkspaceConfig, InstallLogEntry } from '../types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WorkspaceConfig');

// Directory paths
export const PROJECT_ROOT = process.cwd();
export const WORKSPACE_DIRS = {
  builds: path.resolve(PROJECT_ROOT, 'builds'),
  sketches: path.resolve(PROJECT_ROOT, 'sketches'),
  data: path.resolve(PROJECT_ROOT, 'data'),
  temp: path.resolve(PROJECT_ROOT, 'Temp'),
  config: path.resolve(PROJECT_ROOT, '.arduino-mcp'),
};

export const TEMP_DIR = WORKSPACE_DIRS.temp;
export const BUILDS_DIR = WORKSPACE_DIRS.builds;
export const SKETCHES_DIR = WORKSPACE_DIRS.sketches;
export const DATA_DIR = WORKSPACE_DIRS.data;
export const CONFIG_DIR = WORKSPACE_DIRS.config;
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const INSTALL_LOG_FILE = path.join(CONFIG_DIR, 'installlog.json');

const DEFAULT_CONFIG: WorkspaceConfig = {
  buildOutputDir: BUILDS_DIR,
  sketchesDir: SKETCHES_DIR,
  dataDir: DATA_DIR,
  defaultFqbn: 'esp32:esp32:esp32',
  defaultBaud: 115200,
  additionalBuildDirs: [],
  portNicknames: {},
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Workspace Configuration Service
 * Provides immutable snapshots of configuration
 */
export class WorkspaceConfigService {
  private config: WorkspaceConfig = { ...DEFAULT_CONFIG };
  private loaded = false;

  /**
   * Load configuration from file
   */
  async load(): Promise<Readonly<WorkspaceConfig>> {
    try {
      if (await pathExists(CONFIG_FILE)) {
        const content = await fs.readFile(CONFIG_FILE, 'utf-8');
        const loaded = JSON.parse(content);
        this.config = { ...DEFAULT_CONFIG, ...loaded };
        logger.info('Configuration loaded', { file: CONFIG_FILE });
      } else {
        this.config = { ...DEFAULT_CONFIG };
        logger.info('Using default configuration');
      }
      this.loaded = true;
    } catch (e) {
      logger.error('Failed to load config, using defaults', { error: String(e) });
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.getSnapshot();
  }

  /**
   * Get immutable snapshot of current configuration
   */
  getSnapshot(): Readonly<WorkspaceConfig> {
    return Object.freeze({ ...this.config });
  }

  /**
   * Update configuration and save to file
   */
  async update(partial: Partial<WorkspaceConfig>): Promise<Readonly<WorkspaceConfig>> {
    this.config = { ...this.config, ...partial };
    await ensureDirectory(CONFIG_DIR);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    logger.info('Configuration saved', { file: CONFIG_FILE });
    return this.getSnapshot();
  }

  /**
   * Get port nickname
   */
  getPortNickname(port: string): string | undefined {
    return this.config.portNicknames[port];
  }

  /**
   * Set port nickname
   */
  async setPortNickname(port: string, nickname: string): Promise<void> {
    const nicknames = { ...this.config.portNicknames, [port]: nickname };
    await this.update({ portNicknames: nicknames });
  }

  /**
   * Setup workspace directories
   */
  async setupWorkspace(): Promise<{ created: string[]; existing: string[] }> {
    const created: string[] = [];
    const existing: string[] = [];

    for (const [name, dir] of Object.entries(WORKSPACE_DIRS)) {
      if (await pathExists(dir)) {
        existing.push(name);
      } else {
        await ensureDirectory(dir);
        created.push(name);
        logger.info(`Created directory: ${name}`, { path: dir });
      }
    }

    // Create README files
    const readmeContents: Record<string, string> = {
      builds: `# Builds Directory\nビルド済みファームウェア（.bin）をここに配置してください。\n`,
      sketches: `# Sketches Directory\nArduinoスケッチ（.ino）をここに配置してください。\n`,
      data: `# Data Directory\nSPIFFSにアップロードするデータファイルをここに配置してください。\n`,
    };

    for (const [name, content] of Object.entries(readmeContents)) {
      const dir = WORKSPACE_DIRS[name as keyof typeof WORKSPACE_DIRS];
      if (dir) {
        const readmePath = path.join(dir, 'README.md');
        if (!await pathExists(readmePath)) {
          await fs.writeFile(readmePath, content);
        }
      }
    }

    // Ensure config is loaded/created
    if (!this.loaded) {
      await this.load();
    }
    if (!await pathExists(CONFIG_FILE)) {
      await this.update({});
    }

    return { created, existing };
  }
}

/**
 * Install Log Service
 * Manages installation logs for araneaDevice
 */
export class InstallLogService {
  private logs: Record<string, InstallLogEntry> = {};
  private configService: WorkspaceConfigService;

  constructor(configService: WorkspaceConfigService) {
    this.configService = configService;
  }

  /**
   * Load install logs from file
   */
  async load(): Promise<Record<string, InstallLogEntry>> {
    try {
      if (await pathExists(INSTALL_LOG_FILE)) {
        const content = await fs.readFile(INSTALL_LOG_FILE, 'utf-8');
        this.logs = JSON.parse(content);
        logger.info('Install logs loaded', { count: Object.keys(this.logs).length });
      }
    } catch (e) {
      logger.error('Failed to load install logs', { error: String(e) });
      this.logs = {};
    }
    return this.logs;
  }

  /**
   * Save install logs to file
   */
  async save(): Promise<void> {
    await ensureDirectory(CONFIG_DIR);
    await fs.writeFile(INSTALL_LOG_FILE, JSON.stringify(this.logs, null, 2));
    logger.info('Install logs saved', { count: Object.keys(this.logs).length });
  }

  /**
   * Add a new install log entry
   */
  async addEntry(port: string, entry: Partial<InstallLogEntry>): Promise<string> {
    await this.load();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const portId = port.replace(/[^a-zA-Z0-9]/g, '_');
    const key = `${timestamp}_${portId}`;

    this.logs[key] = {
      lacisID: entry.lacisID || '',
      RegisterStatus: entry.RegisterStatus || '',
      cic: entry.cic || '',
      mainssid: entry.mainssid || '',
      mainpass: entry.mainpass || '',
      altssid: entry.altssid || '',
      altpass: entry.altpass || '',
      devssid: entry.devssid || '',
      devpass: entry.devpass || '',
      note: entry.note || '',
      port,
      nickname: this.configService.getPortNickname(port),
    };

    await this.save();
    logger.info('Install log entry added', { key, port });
    return key;
  }

  /**
   * Get recent install logs
   */
  async getRecent(limit: number = 5): Promise<Array<{ key: string; entry: InstallLogEntry }>> {
    await this.load();
    return Object.entries(this.logs)
      .map(([key, entry]) => ({ key, entry }))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, limit);
  }

  /**
   * Parse ::RegisteredInfo:: pattern from serial line
   */
  parseRegisteredInfo(line: string): Partial<InstallLogEntry> | null {
    const match = line.match(/::RegisteredInfo::\s*\[([^\]]*)\]/);
    if (!match) return null;

    const content = match[1];
    const result: Partial<InstallLogEntry> = {};

    const pairs = content.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx > 0) {
        const key = pair.slice(0, colonIdx).toLowerCase();
        const value = pair.slice(colonIdx + 1);

        switch (key) {
          case 'lacisid': result.lacisID = value; break;
          case 'registerstatus': result.RegisterStatus = value; break;
          case 'cic': result.cic = value; break;
          case 'mainssid': result.mainssid = value; break;
          case 'mainpass': result.mainpass = value; break;
          case 'altssid': result.altssid = value; break;
          case 'altpass': result.altpass = value; break;
          case 'devssid': result.devssid = value; break;
          case 'devpass': result.devpass = value; break;
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }
}

// Singleton instances
export const workspaceConfigService = new WorkspaceConfigService();
export const installLogService = new InstallLogService(workspaceConfigService);

