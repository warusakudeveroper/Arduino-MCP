/**
 * Compile Tool
 * Arduino sketch compilation functionality
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { compileSchema } from '../schemas.js';
import { arduinoCliRunner } from '../../utils/cli-runner.js';
import { workspaceConfigService } from '../../config/workspace.js';
import { createLogger } from '../../utils/logger.js';
import type { CompileSummary, Diagnostic } from '../../types.js';

const logger = createLogger('Compile');

const DEFAULT_FQBN = process.env.ESP32_FQBN ?? 'esp32:esp32:esp32';
const ARTIFACT_EXTENSIONS = new Set(['.bin', '.elf', '.map', '.hex']);

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function resolveSketchPath(sketchPath: string): Promise<string> {
  const resolved = path.resolve(sketchPath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    return resolved;
  }
  return path.dirname(resolved);
}

function parseDiagnostics(output: string): Diagnostic[] {
  const lines = output.split('\n');
  const diagnostics: Diagnostic[] = [];
  const pattern = /^([^:]+):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/;

  for (const line of lines) {
    const m = pattern.exec(line);
    if (m) {
      diagnostics.push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        level: m[4] as 'error' | 'warning' | 'info',
        message: m[5],
        raw: line,
      });
    }
  }
  return diagnostics;
}

async function collectArtifacts(searchDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ARTIFACT_EXTENSIONS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (e) {
      logger.warn('Failed to walk directory', { dir, error: String(e) });
    }
  }

  await walk(searchDir);
  return results;
}

type CompileParams = z.infer<typeof compileSchema>;

/**
 * Run compilation
 */
export async function runCompile(args: CompileParams): Promise<CompileSummary> {
  const sketchPath = await resolveSketchPath(args.sketch_path);
  const buildPath = path.resolve(args.build_path ?? path.join(sketchPath, '.build'));
  
  if (args.clean && (await pathExists(buildPath))) {
    await fs.rm(buildPath, { recursive: true, force: true });
    logger.info('Cleaned build directory', { buildPath });
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

  logger.info('Starting compilation', { sketchPath, fqbn });
  const started = Date.now();
  const result = await arduinoCliRunner.run(cliArgs, { cwd: sketchPath });
  const durationMs = Date.now() - started;
  
  const diagnostics = parseDiagnostics(`${result.stdout}\n${result.stderr}`);
  const artifacts = result.exitCode === 0 ? await collectArtifacts(buildPath) : [];
  
  // Copy .bin files to builds directory for easier access
  const copiedToBuildDir: string[] = [];
  if (result.exitCode === 0 && args.export_bin) {
    try {
      const config = workspaceConfigService.getSnapshot();
      await ensureDirectory(config.buildOutputDir);
      for (const artifact of artifacts) {
        if (artifact.endsWith('.bin')) {
          const destPath = path.join(config.buildOutputDir, path.basename(artifact));
          await fs.copyFile(artifact, destPath);
          copiedToBuildDir.push(destPath);
        }
      }
      logger.info('Copied artifacts to build directory', { count: copiedToBuildDir.length });
    } catch (e) {
      logger.warn('Failed to copy artifacts', { error: String(e) });
    }
  }

  logger.info('Compilation finished', { 
    ok: result.exitCode === 0, 
    durationMs,
    artifacts: artifacts.length,
  });

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
      executable: arduinoCliRunner.getPath(),
      args: cliArgs,
      cwd: sketchPath,
    },
    sketchPath,
    buildPath,
    durationMs,
  };
}

