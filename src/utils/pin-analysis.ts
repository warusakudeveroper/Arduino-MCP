/**
 * Pin Analysis Utilities
 * Analyzes Arduino sketch source files for pin usage patterns
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { PIN_ALIAS, PIN_SPEC_MAP, type PinSpec } from './pins.js';
import type { UnknownIdentifier } from '../types.js';

const logger = createLogger('PinAnalysis');

// Source file extensions
const SOURCE_FILE_EXTS = new Set(['.ino', '.pde', '.cpp', '.cc', '.c', '.cxx', '.s', '.S']);
const HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx']);

// Pin analysis types (different structure from pins.ts types)
export interface AnalysisPinWarning {
  severity: 'error' | 'warning' | 'info';
  pin?: number;
  name?: string;
  message: string;
  file?: string;
  line?: number;
}

export interface AnalysisPinUsageEntry {
  kind: 'PIN_MODE' | 'DIGITAL_WRITE' | 'DIGITAL_READ' | 'ANALOG_READ' | 'ANALOG_WRITE' | 'DAC_WRITE' | 'TOUCH_READ';
  mode?: string;
  identifier: string;
  expression: string;
  file: string;
  line: number;
}

export interface AnalysisPinUsageSummary {
  pin: number;
  name: string;
  available: boolean;
  usage: Array<{
    kind: AnalysisPinUsageEntry['kind'];
    mode?: string;
    file: string;
    line: number;
    identifier: string;
  }>;
  spec?: PinSpec;
}

// Regex patterns for pin usage detection
const PIN_MODE_REGEX = /pinMode\s*\(\s*([^,]+?)\s*,\s*(INPUT_PULLUP|INPUT_PULLDOWN|INPUT|OUTPUT|OUTPUT_OPEN_DRAIN)\s*\)/g;
const DIGITAL_WRITE_REGEX = /digitalWrite\s*\(\s*([^,]+?)\s*,/g;
const DIGITAL_READ_REGEX = /digitalRead\s*\(\s*([^,]+?)\s*\)/g;
const ANALOG_READ_REGEX = /analogRead\s*\(\s*([^,]+?)\s*\)/g;
const ANALOG_WRITE_REGEX = /analogWrite\s*\(\s*([^,]+?)\s*,/g;
const LEDC_ATTACH_REGEX = /ledcAttachPin\s*\(\s*([^,]+?)\s*,/g;
const DAC_WRITE_REGEX = /dacWrite\s*\(\s*([^,]+?)\s*,/g;
const TOUCH_READ_REGEX = /touchRead\s*\(\s*([^,]+?)\s*\)/g;

/**
 * Collect source files from a directory
 */
export async function collectSourceFiles(root: string, includeHeaders: boolean): Promise<string[]> {
  const files: string[] = [];
  
  async function walk(current: string) {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (['node_modules', 'dist', 'build', '.build'].includes(entry.name)) continue;
      
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

/**
 * Compute line number from content and index
 */
function computeLineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Resolve pin identifier to pin number
 */
export function resolvePinIdentifier(expression: string): { pin?: number; identifier: string } {
  const noComments = expression.replace(/\/\*.*?\*\//gs, '').replace(/\/\/.*$/gm, '');
  let cleaned = noComments.replace(/\s+/g, '');
  cleaned = cleaned.replace(/^\(+/, '').replace(/\)+$/, '');
  
  if (!cleaned) {
    return { identifier: expression.trim() };
  }
  
  // Direct number
  if (/^\d+$/.test(cleaned)) {
    return { pin: parseInt(cleaned, 10), identifier: cleaned };
  }
  
  // GPIO_NUM_X format
  let match = cleaned.match(/^GPIO_NUM_(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  
  // GPIOX format
  match = cleaned.match(/^GPIO(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  
  // IOX format
  match = cleaned.match(/^IO(\d+)$/i);
  if (match) {
    return { pin: parseInt(match[1], 10), identifier: cleaned };
  }
  
  // Alias lookup
  const aliasKey = cleaned.toUpperCase();
  if (PIN_ALIAS[aliasKey] !== undefined) {
    return { pin: PIN_ALIAS[aliasKey], identifier: cleaned };
  }
  
  return { identifier: cleaned };
}

/**
 * Analyze pin usage in a sketch
 */
export async function analyzePinUsage(sketchPath: string, includeHeaders: boolean): Promise<{
  warnings: AnalysisPinWarning[];
  usage: AnalysisPinUsageSummary[];
  unknownIdentifiers: UnknownIdentifier[];
}> {
  const files = await collectSourceFiles(sketchPath, includeHeaders);
  const usageByPin = new Map<number, AnalysisPinUsageEntry[]>();
  const unknownIdentifiers = new Map<string, UnknownIdentifier>();

  const recordUsage = (pin: number | undefined, identifier: string, entry: AnalysisPinUsageEntry) => {
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
    } catch {
      logger.warn('Failed to read file', { file });
      continue;
    }

    const processMatches = (regex: RegExp, kind: AnalysisPinUsageEntry['kind'], mode?: string) => {
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

    // Process pinMode with mode
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

    // Process other pin functions
    processMatches(DIGITAL_WRITE_REGEX, 'DIGITAL_WRITE');
    processMatches(DIGITAL_READ_REGEX, 'DIGITAL_READ');
    processMatches(ANALOG_READ_REGEX, 'ANALOG_READ');
    processMatches(ANALOG_WRITE_REGEX, 'ANALOG_WRITE');
    processMatches(LEDC_ATTACH_REGEX, 'ANALOG_WRITE');
    processMatches(DAC_WRITE_REGEX, 'DAC_WRITE');
    processMatches(TOUCH_READ_REGEX, 'TOUCH_READ');
  }

  // Build warnings and usage summary
  const warnings: AnalysisPinWarning[] = [];
  const usageSummary: AnalysisPinUsageSummary[] = [];

  for (const [pin, entries] of usageByPin) {
    const spec = PIN_SPEC_MAP.get(pin);
    const name = spec?.name ?? `GPIO${pin}`;
    const available = spec?.available ?? true;

    // Generate warnings
    if (!available) {
      warnings.push({
        severity: 'error',
        pin,
        name,
        message: `Pin ${name} (GPIO${pin}) is not available for general use: ${spec?.notes ?? 'reserved'}`,
      });
    } else if (spec?.inputOnly) {
      const hasOutput = entries.some(e => e.kind === 'DIGITAL_WRITE' || e.kind === 'ANALOG_WRITE' || e.kind === 'DAC_WRITE');
      if (hasOutput) {
        warnings.push({
          severity: 'error',
          pin,
          name,
          message: `Pin ${name} (GPIO${pin}) is input-only but is used for output`,
        });
      }
    }
    
    if (spec?.strapping) {
      warnings.push({
        severity: 'warning',
        pin,
        name,
        message: `Pin ${name} (GPIO${pin}) is a strapping pin - affects boot behavior`,
      });
    }

    usageSummary.push({
      pin,
      name,
      available,
      usage: entries.map(e => ({
        kind: e.kind,
        mode: e.mode,
        file: e.file,
        line: e.line,
        identifier: e.identifier,
      })),
      spec,
    });
  }

  usageSummary.sort((a, b) => a.pin - b.pin);
  const unknownArr = Array.from(unknownIdentifiers.values());

  return {
    warnings,
    usage: usageSummary,
    unknownIdentifiers: unknownArr,
  };
}

