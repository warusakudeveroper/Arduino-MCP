/**
 * Shared type definitions for MCP Arduino ESP32
 */

// Workspace configuration
export interface WorkspaceConfig {
  buildOutputDir: string;
  sketchesDir: string;
  dataDir: string;
  defaultFqbn: string;
  defaultBaud: number;
  additionalBuildDirs: string[];
  portNicknames: Record<string, string>;
}

// Install log entry
export interface InstallLogEntry {
  lacisID: string;
  RegisterStatus: string;
  cic: string;
  mainssid: string;
  mainpass: string;
  altssid: string;
  altpass: string;
  devssid: string;
  devpass: string;
  note: string;
  port: string;
  nickname?: string;
}

// Diagnostic from compiler output
export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  column?: number;
  message: string;
  raw?: string;
}

// Compile result summary
export interface CompileSummary {
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

// Upload result summary
export interface UploadSummary {
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

// Monitor summary
export interface MonitorSummary {
  ok: boolean;
  token: string;
  port: string;
  lines: number;
  elapsedSeconds: number;
  rebootDetected: boolean;
  lastLine?: string;
  exitCode?: number;
  reason: string;
}

// Monitor options
export interface MonitorOptions {
  port: string;
  baud: number;
  autoBaud: boolean;
  raw: boolean;
  maxSeconds: number;
  maxLines: number;
  stopRegex?: RegExp;
  detectReboot: boolean;
}

// Serial event payload
export interface SerialEventPayload {
  type: 'serial' | 'serial_end' | 'install_log';
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
  key?: string;
  entry?: Partial<InstallLogEntry>;
}

// Detected port info
export interface DetectedPortInfo {
  port: string;
  protocol?: string;
  label?: string;
  product?: string;
  vendor?: string;
  matchingFqbn?: string;
  isEsp32: boolean;
  reachable: boolean;
  nickname?: string;
}

// CLI run result
export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

