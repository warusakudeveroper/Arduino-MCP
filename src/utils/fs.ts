/**
 * File System Utilities
 * Common file system operations with safety checks
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('FS');

/**
 * Check if a path exists
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Resolve a path safely, preventing path traversal attacks
 * @param basePath The base directory that the result must be within
 * @param userPath The user-provided path to resolve
 * @returns The resolved absolute path
 * @throws Error if the resolved path would escape the base directory
 */
export function resolveSafePath(basePath: string, userPath: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedFull = path.resolve(basePath, userPath);
  
  if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) {
    logger.warn('Path traversal attempt detected', { basePath, userPath, resolved: resolvedFull });
    throw new Error(`Path traversal detected: ${userPath} would escape ${basePath}`);
  }
  
  return resolvedFull;
}

/**
 * Resolve a sketch path (can be file or directory)
 */
export async function resolveSketchPath(sketchPath: string): Promise<string> {
  const resolved = path.resolve(sketchPath);
  
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return resolved;
    }
    return path.dirname(resolved);
  } catch (e) {
    logger.error('Failed to resolve sketch path', { sketchPath, error: String(e) });
    throw new Error(`Sketch path not found: ${sketchPath}`);
  }
}

/**
 * Read JSON file safely
 */
export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    if (await pathExists(filePath)) {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    }
  } catch (e) {
    logger.warn('Failed to read JSON file', { filePath, error: String(e) });
  }
  return defaultValue;
}

/**
 * Write JSON file safely
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDirectory(dir);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Collect files matching extensions recursively
 */
export async function collectFiles(
  searchDir: string,
  extensions: Set<string>,
  maxDepth: number = 10
): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (e) {
      logger.debug('Failed to walk directory', { dir, error: String(e) });
    }
  }

  await walk(searchDir, 0);
  return results;
}

/**
 * Copy file with directory creation
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const destDir = path.dirname(dest);
  await ensureDirectory(destDir);
  await fs.copyFile(src, dest);
}

/**
 * Remove directory recursively if it exists
 */
export async function removeDirectory(dir: string): Promise<boolean> {
  if (await pathExists(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

