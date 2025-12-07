/**
 * Upload Tool
 * Arduino sketch upload functionality
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { uploadSchema } from '../schemas.js';
import { arduinoCliRunner } from '../../utils/cli-runner.js';
import { createLogger } from '../../utils/logger.js';
import type { UploadSummary } from '../../types.js';

const logger = createLogger('Upload');

const DEFAULT_FQBN = process.env.ESP32_FQBN ?? 'esp32:esp32:esp32';

async function resolveSketchPath(sketchPath: string): Promise<string> {
  const resolved = path.resolve(sketchPath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    return resolved;
  }
  return path.dirname(resolved);
}

type UploadParams = z.infer<typeof uploadSchema>;

/**
 * Run upload to ESP32
 */
export async function runUpload(args: UploadParams): Promise<UploadSummary> {
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

  logger.info('Starting upload', { sketchPath, port: args.port, fqbn });
  const started = Date.now();
  const result = await arduinoCliRunner.run(cliArgs, { cwd: sketchPath });
  const durationMs = Date.now() - started;

  logger.info('Upload finished', { 
    ok: result.exitCode === 0, 
    port: args.port,
    durationMs,
  });

  return {
    stage: 'upload',
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    command: {
      executable: arduinoCliRunner.getPath(),
      args: cliArgs,
      cwd: sketchPath,
    },
    sketchPath,
    port: args.port,
    durationMs,
  };
}

