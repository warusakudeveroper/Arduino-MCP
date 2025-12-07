/**
 * Console Server
 * HTTP server for the serial console UI with SSE support
 */

import * as http from 'http';
import { serialBroadcaster } from '../serial/broadcaster.js';
import { monitorManager } from '../serial/monitor.js';
import { 
  workspaceConfigService, 
  installLogService,
  TEMP_DIR 
} from '../config/workspace.js';
import { arduinoCliRunner } from '../utils/cli-runner.js';
import { createLogger } from '../utils/logger.js';
import { DetectedPortInfo } from '../types.js';
import { getConsoleHtml } from './html.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

const logger = createLogger('ConsoleServer');

// CORS configuration
const CORS_ORIGIN = process.env.MCP_CORS_ORIGIN || '*';

function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function collectArtifacts(dir: string): Promise<string[]> {
  const results: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subResults = await collectArtifacts(fullPath);
        results.push(...subResults);
      } else if (entry.isFile() && entry.name.endsWith('.bin')) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    logger.warn('Failed to collect artifacts', { dir, error: String(e) });
  }
  
  return results;
}

async function detectEsp32Ports(): Promise<DetectedPortInfo[]> {
  const result = await arduinoCliRunner.run(['board', 'list', '--format', 'json']);
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    logger.warn('Failed to parse board list JSON');
    return [];
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
      ?? (entry.port as string | undefined);
    
    if (!address) continue;

    const boardsRaw = [
      ...(Array.isArray(entry.matching_boards) ? entry.matching_boards : []),
      ...(Array.isArray(entry.boards) ? entry.boards : []),
    ] as Array<Record<string, unknown>>;

    const matching = boardsRaw.find((board) => {
      const name = (board.FQBN as string | undefined)
        ?? (board.fqbn as string | undefined)
        ?? (board.name as string | undefined)
        ?? '';
      return name.toLowerCase().includes('esp32');
    });

    const isEsp32ByPort = /SLAB_USBtoUART|usbserial|wchusbserial|CP210|CH340/i.test(address);
    const matchingFqbn = (matching?.FQBN as string | undefined)
      ?? (matching?.fqbn as string | undefined);

    const label = (portObj?.label as string | undefined)
      ?? (entry.label as string | undefined);

    ports.push({
      port: address,
      protocol: (portObj?.protocol as string | undefined) ?? (entry.protocol as string | undefined),
      label,
      matchingFqbn,
      isEsp32: Boolean(matching) || isEsp32ByPort,
      reachable: fsSync.existsSync(address),
      nickname: workspaceConfigService.getPortNickname(address),
    });
  }

  return ports;
}

/**
 * Console Server class
 */
export class ConsoleServer {
  private server?: http.Server;
  private options: { host: string; port: number } | null = null;

  /**
   * Start the console server
   */
  start(options: { host: string; port: number }): { host: string; port: number; url: string } {
    if (this.server && this.options?.host === options.host && this.options?.port === options.port) {
      return { ...options, url: `http://${options.host}:${options.port}` };
    }

    if (this.server) {
      this.server.close();
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(e => {
        logger.error('Request handler error', { error: String(e) });
        res.writeHead(500);
        res.end('Internal Server Error');
      });
    });

    this.server.listen(options.port, options.host);
    this.options = options;
    
    logger.info('Console server started', { host: options.host, port: options.port });
    
    return { ...options, url: `http://${options.host}:${options.port}` };
  }

  /**
   * Stop the console server
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.options = null;
      logger.info('Console server stopped');
    }
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const corsHeaders = getCorsHeaders();

    if (!req.url) {
      res.writeHead(404, corsHeaders);
      res.end();
      return;
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // SSE endpoint
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders,
      });
      serialBroadcaster.addClient(res);
      req.on('close', () => serialBroadcaster.removeClient(res));
      return;
    }

    // Main page
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
      res.end(getConsoleHtml());
      return;
    }

    // API: Workspace setup
    if (req.url.startsWith('/api/workspace/setup') && req.method === 'POST') {
      try {
        const result = await workspaceConfigService.setupWorkspace();
        const config = workspaceConfigService.getSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, ...result, config }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Port nicknames
    if (req.url.startsWith('/api/port-nicknames')) {
      if (req.method === 'GET') {
        const config = workspaceConfigService.getSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, nicknames: config.portNicknames }));
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await this.readBody(req);
          const { port, nickname } = JSON.parse(body);
          await workspaceConfigService.setPortNickname(port, nickname);
          const config = workspaceConfigService.getSnapshot();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, nicknames: config.portNicknames }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
        return;
      }
    }

    // API: Install logs
    if (req.url.startsWith('/api/install-logs')) {
      if (req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const logs = await installLogService.getRecent(limit);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, logs }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await this.readBody(req);
          const { port, entry } = JSON.parse(body);
          const key = await installLogService.addEntry(port, entry);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, key }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
        return;
      }
    }

    // API: Server restart
    if (req.url.startsWith('/api/server/restart') && req.method === 'POST') {
      try {
        await monitorManager.stopAll();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, message: 'Server restarting...' }));
        setTimeout(() => {
          logger.info('Server restart requested');
          process.exit(0);
        }, 500);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Server status
    if (req.url.startsWith('/api/server/status') && req.method === 'GET') {
      const monitors = monitorManager.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        monitors: monitors.length,
        memory: process.memoryUsage(),
        corsOrigin: CORS_ORIGIN,
      }));
      return;
    }

    // API: Get ports
    if (req.url.startsWith('/api/ports')) {
      try {
        const ports = await detectEsp32Ports();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, ports }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Monitor start
    if (req.url.startsWith('/api/monitor/start') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const params = JSON.parse(body);
        const session = await monitorManager.start({
          port: params.port,
          baud: params.baud ?? 115200,
          auto_baud: params.auto_baud ?? true,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, token: session.token, port: session.port }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Monitor stop
    if (req.url.startsWith('/api/monitor/stop') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, token } = JSON.parse(body);
        const session = monitorManager.get(token, port);
        if (session) {
          const summary = await session.stop();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, summary }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Monitor stop all
    if (req.url.startsWith('/api/monitor/stop-all') && req.method === 'POST') {
      try {
        await monitorManager.stopAll();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: List monitors
    if (req.url.startsWith('/api/monitors') && req.method === 'GET') {
      const sessions = monitorManager.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }

    // API: Get logs
    if (req.url.startsWith('/api/logs') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, logs: serialBroadcaster.getBuffer() }));
      return;
    }

    // API: Artifacts
    if (req.url.startsWith('/api/artifacts')) {
      try {
        const config = workspaceConfigService.getSnapshot();
        const artifacts: Array<{ path: string; name: string; size: string; dir: string }> = [];
        const searchDirs = [
          config.buildOutputDir,
          TEMP_DIR,
          ...config.additionalBuildDirs,
        ].filter(Boolean);

        for (const dir of searchDirs) {
          if (await pathExists(dir)) {
            const files = await collectArtifacts(dir);
            for (const file of files) {
              try {
                const stat = await fs.stat(file);
                artifacts.push({
                  path: file,
                  name: path.basename(file),
                  size: (stat.size / 1024).toFixed(1) + ' KB',
                  dir: path.dirname(file),
                });
              } catch (e) {
                logger.warn('Failed to stat artifact', { file, error: String(e) });
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

    // 404
    res.writeHead(404, corsHeaders);
    res.end('Not Found');
  }

  /**
   * Read request body
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}

// Singleton instance
export const consoleServer = new ConsoleServer();

