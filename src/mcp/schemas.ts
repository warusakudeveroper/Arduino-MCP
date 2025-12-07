/**
 * MCP Tool Schemas
 * Zod schemas for all MCP tool parameters
 */

import { z } from 'zod';

// Build props transformation
export const buildPropsSchema = z
  .union([z.record(z.string()), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (!value) return [] as string[];
    if (Array.isArray(value)) return value;
    return Object.entries(value).map(([key, val]) => `${key}=${val}`);
  });

// Compile schema
export const compileSchema = z.object({
  sketch_path: z.string(),
  export_bin: z.boolean().optional().default(true),
  build_path: z.string().optional(),
  build_props: buildPropsSchema,
  clean: z.boolean().optional().default(false),
  fqbn: z.string().optional(),
});

// Upload schema
export const uploadSchema = z.object({
  sketch_path: z.string(),
  port: z.string(),
  fqbn: z.string().optional(),
  verify: z.boolean().optional().default(false),
  build_path: z.string().optional(),
  profile: z.string().optional(),
});

// Monitor start schema
export const monitorStartSchema = z.object({
  port: z.string(),
  baud: z.number().int().positive().optional().default(115200),
  auto_baud: z.boolean().optional().default(false),
  raw: z.boolean().optional().default(false),
  max_seconds: z.number().nonnegative().optional().default(0),
  max_lines: z.number().int().nonnegative().optional().default(0),
  stop_on: z.string().optional(),
  detect_reboot: z.boolean().optional().default(true),
});

// Monitor stop schema
export const monitorStopSchema = z.object({
  token: z.string().optional(),
  port: z.string().optional(),
});

// List artifacts schema
export const listArtifactsSchema = z.object({
  base_dir: z.string(),
  build_path: z.string().optional(),
});

// Pin check schema
export const pinCheckSchema = z.object({
  sketch_path: z.string(),
  include_headers: z.boolean().optional().default(false),
});

// PDCA cycle schema
export const pdcaSchema = compileSchema.merge(
  z.object({
    port: z.string(),
    monitor_seconds: z.number().positive().optional().default(8),
    baud: z.number().int().positive().optional().default(115200),
  }),
);

// Ensure dependencies schema
export const ensureDependenciesSchema = z.object({
  install_missing: z.boolean().optional().default(true),
});

// Flash connected schema
export const flashConnectedSchema = z.object({
  sketch_path: z.string(),
  fqbn: z.string().optional(),
  build_props: buildPropsSchema,
  max_ports: z.number().int().positive().max(10).optional().default(10),
});

// Start console schema
export const startConsoleSchema = z.object({
  host: z.string().optional().default('127.0.0.1'),
  port: z.number().int().positive().optional().default(4173),
});

// Library install schema
export const libInstallSchema = z.object({
  name: z.string().describe('Name of the Arduino library to install'),
});

// Quickstart schema
export const quickstartSchema = z.object({
  sketch_path: z.string().optional().describe('Path to sketch. If not provided, a blink example will be created.'),
  port: z.string().optional().describe('Serial port. If not provided, will auto-detect ESP32.'),
  monitor_seconds: z.number().positive().optional().default(10).describe('Seconds to monitor after upload'),
});

// Workspace setup schema
export const workspaceSetupSchema = z.object({
  build_dir: z.string().optional().describe('Custom build output directory'),
  sketches_dir: z.string().optional().describe('Custom sketches directory'),
  data_dir: z.string().optional().describe('Custom SPIFFS data directory'),
  additional_build_dirs: z.array(z.string()).optional().describe('Additional directories to scan for .bin'),
});

// Erase flash schema
export const eraseFlashSchema = z.object({
  port: z.string().describe('Serial port of the ESP32 to erase'),
});

// SPIFFS upload schema
export const spiffsUploadSchema = z.object({
  port: z.string().describe('Serial port of the ESP32'),
  data_dir: z.string().describe('Path to the data directory to upload to SPIFFS'),
  partition_name: z.string().optional().default('spiffs').describe('SPIFFS partition name'),
});

// Get logs schema
export const getLogsSchema = z.object({
  port: z.string().optional().describe('Filter logs by port'),
  max_lines: z.number().int().positive().optional().default(100).describe('Maximum log lines to return'),
  pattern: z.string().optional().describe('Filter logs by regex pattern'),
});

// Type exports
export type CompileParams = z.infer<typeof compileSchema>;
export type UploadParams = z.infer<typeof uploadSchema>;
export type MonitorStartParams = z.infer<typeof monitorStartSchema>;
export type MonitorStopParams = z.infer<typeof monitorStopSchema>;
export type ListArtifactsParams = z.infer<typeof listArtifactsSchema>;
export type PinCheckParams = z.infer<typeof pinCheckSchema>;
export type PdcaParams = z.infer<typeof pdcaSchema>;
export type EnsureDependenciesParams = z.infer<typeof ensureDependenciesSchema>;
export type FlashConnectedParams = z.infer<typeof flashConnectedSchema>;
export type StartConsoleParams = z.infer<typeof startConsoleSchema>;
export type LibInstallParams = z.infer<typeof libInstallSchema>;
export type QuickstartParams = z.infer<typeof quickstartSchema>;
export type WorkspaceSetupParams = z.infer<typeof workspaceSetupSchema>;
export type EraseFlashParams = z.infer<typeof eraseFlashSchema>;
export type SpiffsUploadParams = z.infer<typeof spiffsUploadSchema>;
export type GetLogsParams = z.infer<typeof getLogsSchema>;

