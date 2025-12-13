/**
 * Console Server
 * HTTP server for the serial console UI with SSE support
 */

import * as http from 'http';
// fsSync no longer needed - detectPorts handles file existence check
import * as path from 'path';
import { execa } from 'execa';
import { serialBroadcaster } from '../serial/broadcaster.js';
import { monitorManager } from '../serial/monitor.js';
import { portBufferManager } from '../serial/port-buffer.js';
import { portStateManager } from '../serial/port-state.js';
import { deviceHealthMonitor } from '../serial/device-health.js';
import { 
  workspaceConfigService, 
  installLogService,
  TEMP_DIR 
} from '../config/workspace.js';
import { arduinoCliRunner } from '../utils/cli-runner.js';
import { createLogger } from '../utils/logger.js';
import { pathExists, collectFiles, ensureDirectory } from '../utils/fs.js';
import { DetectedPortInfo } from '../types.js';
import { getConsoleHtml } from './html.js';
import * as fs from 'fs/promises';
import * as os from 'os';

const logger = createLogger('ConsoleServer');

// CORS configuration
const CORS_ORIGIN = process.env.MCP_CORS_ORIGIN || '*';

// Binary file extensions for artifact collection
const BIN_EXTENSIONS = new Set(['.bin']);

function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function collectArtifacts(dir: string): Promise<string[]> {
  return collectFiles(dir, BIN_EXTENSIONS);
}

async function detectEsp32Ports(): Promise<DetectedPortInfo[]> {
  const result = await arduinoCliRunner.detectPorts({ includeNonEsp32: true });
  
  // Add nicknames to ports
  return result.allPorts.map(port => ({
    ...port,
    nickname: workspaceConfigService.getPortNickname(port.port),
  }));
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
          if (key === null) {
            // Duplicate lacisID
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: true, duplicate: true, lacisID: entry.lacisID }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: true, key }));
          }
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

    // API: Port states - get all port states
    if (req.url.startsWith('/api/port-states') && req.method === 'GET') {
      try {
        const summary = portStateManager.getSummary();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, ...summary }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Device health - get health status for all ports or specific port
    if (req.url.startsWith('/api/device-health') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const port = url.searchParams.get('port');

        if (port) {
          const report = deviceHealthMonitor.getAIReport(port);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, port, ...report }));
        } else {
          const allHealth = deviceHealthMonitor.getAllHealthStatus();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, devices: allHealth }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Clear device health data
    if (req.url.startsWith('/api/device-health/clear') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port } = JSON.parse(body);

        if (port) {
          deviceHealthMonitor.clearPort(port);
        } else {
          deviceHealthMonitor.clearAll();
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
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

    // API: Get logs (legacy - from broadcaster)
    if (req.url.startsWith('/api/logs') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, logs: serialBroadcaster.getBuffer() }));
      return;
    }

    // API: Buffer stats - get stats for all ports or specific port
    if (req.url.startsWith('/api/buffer-stats') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const port = url.searchParams.get('port');

        if (port) {
          const stats = portBufferManager.getPortStats(port);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, stats: stats ? [stats] : [] }));
        } else {
          const stats = portBufferManager.getStats();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, stats, ports: portBufferManager.getPorts() }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Clear buffer for a port
    if (req.url.startsWith('/api/buffer/clear') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port } = JSON.parse(body);

        if (port) {
          portBufferManager.clearBuffer(port);
        } else {
          portBufferManager.clearAllBuffers();
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Port buffer - get buffered lines for a port (use ?port= query param)
    if (req.url.startsWith('/api/buffer') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const port = url.searchParams.get('port');

        if (!port) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'port query parameter is required' }));
          return;
        }

        const count = parseInt(url.searchParams.get('count') || '100');
        const since = parseInt(url.searchParams.get('since') || '0');
        const search = url.searchParams.get('search');

        let lines;
        if (search) {
          lines = portBufferManager.searchBuffer(port, search);
        } else if (since > 0) {
          lines = portBufferManager.getLinesSince(port, since);
        } else {
          lines = portBufferManager.getRecentLines(port, count);
        }

        const stats = portBufferManager.getPortStats(port);

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, port, lines, stats }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Start capture - wait for pattern match
    if (req.url.startsWith('/api/capture/start') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, pattern, timeout_ms = 30000, max_lines = 0 } = JSON.parse(body);

        if (!port || !pattern) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'port and pattern are required' }));
          return;
        }

        const { captureId, promise } = portBufferManager.startCapture({
          port,
          pattern,
          timeoutMs: timeout_ms,
          maxLines: max_lines,
        });

        // Return capture ID immediately, client can poll or wait
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, captureId, port, pattern }));

        // Log when capture completes
        promise.then(result => {
          logger.info('Capture completed', { captureId, reason: result.reason });
        });
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Wait for capture result (blocking)
    if (req.url.startsWith('/api/capture/wait') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, pattern, timeout_ms = 30000, max_lines = 0 } = JSON.parse(body);

        if (!port || !pattern) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'port and pattern are required' }));
          return;
        }

        const { captureId, promise } = portBufferManager.startCapture({
          port,
          pattern,
          timeoutMs: timeout_ms,
          maxLines: max_lines,
        });

        // Wait for result
        const result = await promise;

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: result.success, captureId, ...result }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Cancel capture
    if (req.url.startsWith('/api/capture/cancel') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { captureId } = JSON.parse(body);

        if (!captureId) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'captureId is required' }));
          return;
        }

        const cancelled = portBufferManager.cancelCapture(captureId);

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: cancelled, captureId }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: List active captures
    if (req.url.startsWith('/api/captures') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const port = url.searchParams.get('port') || undefined;
        const captures = portBufferManager.getActiveCaptures(port);

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, captures }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Poll port (for polling mode - quick read and close)
    if (req.url.startsWith('/api/poll-port') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, baud = 115200, timeout = 80 } = JSON.parse(body);
        
        // Quick poll using Python
        const { pythonRunner } = await import('../utils/cli-runner.js');
        const pythonPath = pythonRunner.getPath();
        const { execa } = await import('execa');
        
        const script = `
import serial
import sys
import time

port = sys.argv[1]
baud = int(sys.argv[2])
timeout_ms = int(sys.argv[3])

try:
    ser = serial.Serial(port, baud, timeout=timeout_ms/1000)
    lines = []
    end_time = time.time() + timeout_ms/1000
    while time.time() < end_time:
        if ser.in_waiting:
            line = ser.readline()
            if line:
                lines.append(line.decode('utf-8', errors='replace').rstrip())
    ser.close()
    for line in lines:
        print(line)
except Exception as e:
    print(f"ERROR:{e}", file=sys.stderr)
    sys.exit(1)
`;
        
        const result = await execa(pythonPath, ['-c', script, port, String(baud), String(timeout)], {
          timeout: timeout + 1000,
          reject: false,
        });
        
        const lines = result.stdout ? result.stdout.split('\n').filter(l => l.length > 0) : [];
        
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, lines, port }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error), lines: [] }));
      }
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

    // API: Compile sketch
    if (req.url === '/api/compile' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { sketch_path, fqbn = 'esp32:esp32:esp32' } = JSON.parse(body);
        
        if (!sketch_path) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'sketch_path is required' }));
          return;
        }

        // Handle paths with special characters by copying to temp directory
        const tempBuildDir = path.join(os.tmpdir(), 'arduino_mcp_build');
        const sketchName = path.basename(sketch_path).replace('.ino', '');
        const tempSketchDir = path.join(tempBuildDir, sketchName);
        const buildOutputDir = path.join(tempBuildDir, 'output');
        
        await ensureDirectory(tempSketchDir);
        await ensureDirectory(buildOutputDir);
        
        // Copy sketch files to temp directory
        const sketchDir = path.dirname(sketch_path);
        const files = await fs.readdir(sketchDir);
        for (const file of files) {
          const srcPath = path.join(sketchDir, file);
          const destPath = path.join(tempSketchDir, file === path.basename(sketch_path) ? `${sketchName}.ino` : file);
          const stat = await fs.stat(srcPath);
          if (stat.isFile()) {
            await fs.copyFile(srcPath, destPath);
          }
        }
        
        logger.info('Compiling sketch', { sketch_path, tempSketchDir, fqbn });
        
        const result = await execa(arduinoCliRunner.getPath(), [
          'compile',
          '--fqbn', fqbn,
          '--output-dir', buildOutputDir,
          tempSketchDir
        ], { reject: false });
        
        const ok = result.exitCode === 0;
        
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok,
          sketch_path,
          build_path: buildOutputDir,
          fqbn,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Upload to port
    if (req.url === '/api/upload' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, build_path, fqbn = 'esp32:esp32:esp32' } = JSON.parse(body);
        
        if (!port || !build_path) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'port and build_path are required' }));
          return;
        }

        logger.info('Uploading to port', { port, build_path, fqbn });
        
        const result = await execa(arduinoCliRunner.getPath(), [
          'upload',
          '--fqbn', fqbn,
          '--port', port,
          '--input-dir', build_path
        ], { reject: false });
        
        const ok = result.exitCode === 0;
        
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok,
          port,
          build_path,
          fqbn,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: Reset ESP32 device via DTR/RTS
    if (req.url === '/api/reset-device' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { port, method = 'dtr_rts', delay_ms = 100 } = JSON.parse(body);

        if (!port) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'port is required' }));
          return;
        }

        // Check if port is being monitored
        const portState = portStateManager.getState(port);
        let wasMonitoring = false;
        if (portState.state === 'monitoring') {
          wasMonitoring = true;
          const session = monitorManager.getByPort(port);
          if (session) {
            await session.stop();
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }

        const { pythonRunner } = await import('../utils/cli-runner.js');
        const pythonPath = pythonRunner.getPath();

        if (method === 'esptool') {
          // Use esptool for reset
          const result = await execa(pythonPath, [
            '-m', 'esptool',
            '--chip', 'esp32',
            '--port', port,
            '--before', 'default_reset',
            '--after', 'hard_reset',
            'chip_id',
          ], { reject: false, timeout: 15000 });

          if (result.exitCode === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: true, port, method: 'esptool', wasMonitoring }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: false, port, method: 'esptool', error: result.stderr }));
          }
          return;
        }

        // Default: DTR/RTS reset
        const resetScript = `
import sys
import time
import serial

port = sys.argv[1]
delay_s = float(sys.argv[2]) / 1000.0

try:
    ser = serial.Serial(port, 115200, timeout=0.5)
    ser.dtr = False
    ser.rts = True
    time.sleep(delay_s)
    ser.dtr = True
    ser.rts = False
    time.sleep(0.05)
    ser.dtr = False
    ser.close()
    print("OK")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

        const result = await execa(pythonPath, ['-c', resetScript, port, String(delay_ms)], {
          reject: false,
          timeout: 5000,
        });

        if (result.exitCode === 0) {
          logger.info('Device reset via DTR/RTS', { port });
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, port, method: 'dtr_rts', delay_ms, wasMonitoring }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, port, method: 'dtr_rts', error: result.stderr }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      }
      return;
    }

    // API: SPIFFS file explorer - proxy to ESP32 device
    // These endpoints forward requests to ESP32 devices running firmware with SPIFFS API

    // SPIFFS list files
    if (req.url.startsWith('/api/spiffs/list') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const deviceIp = url.searchParams.get('device_ip');
        const filePath = url.searchParams.get('path') || '/';

        if (!deviceIp) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'device_ip is required' }));
          return;
        }

        const response = await fetch(`http://${deviceIp}/api/spiffs/list?path=${encodeURIComponent(filePath)}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const data = await response.json();
          // Handle both 'ok' and 'success' response formats from ESP32
          const isSuccess = data.ok === true || data.success === true;
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: isSuccess, files: data.files || [], path: filePath }));
        } else {
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: `Device returned ${response.status}` }));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: msg.includes('aborted') ? 'Device timeout' : msg }));
      }
      return;
    }

    // SPIFFS read file
    if (req.url.startsWith('/api/spiffs/read') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const deviceIp = url.searchParams.get('device_ip');
        const filePath = url.searchParams.get('path');

        if (!deviceIp || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'device_ip and path are required' }));
          return;
        }

        const response = await fetch(`http://${deviceIp}/api/spiffs/read?path=${encodeURIComponent(filePath)}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const data = await response.json();
          // Handle both 'ok' and 'success' response formats from ESP32
          // ESP32 returns { success: true, content: "..." }
          const isSuccess = data.ok === true || data.success === true;
          const content = data.content || '';
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: isSuccess, content, path: filePath }));
        } else {
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: `Device returned ${response.status}` }));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: msg.includes('aborted') ? 'Device timeout' : msg }));
      }
      return;
    }

    // SPIFFS write file
    if (req.url.startsWith('/api/spiffs/write') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { device_ip, path: filePath, content } = JSON.parse(body);

        if (!device_ip || !filePath || content === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'device_ip, path, and content are required' }));
          return;
        }

        const response = await fetch(`http://${device_ip}/api/spiffs/write?path=${encodeURIComponent(filePath)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: content,
          signal: AbortSignal.timeout(15000),
        });

        if (response.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, path: filePath, written: content.length }));
        } else {
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: `Device returned ${response.status}` }));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: msg.includes('aborted') ? 'Device timeout' : msg }));
      }
      return;
    }

    // SPIFFS delete file
    if (req.url.startsWith('/api/spiffs/delete') && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { device_ip, path: filePath } = JSON.parse(body);

        if (!device_ip || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'device_ip and path are required' }));
          return;
        }

        const response = await fetch(`http://${device_ip}/api/spiffs/delete?path=${encodeURIComponent(filePath)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, path: filePath }));
        } else {
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: `Device returned ${response.status}` }));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: msg.includes('aborted') ? 'Device timeout' : msg }));
      }
      return;
    }

    // SPIFFS storage info
    if (req.url.startsWith('/api/spiffs/info') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const deviceIp = url.searchParams.get('device_ip');

        if (!deviceIp) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'device_ip is required' }));
          return;
        }

        const response = await fetch(`http://${deviceIp}/api/spiffs/info`, {
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          const data = await response.json();
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, ...data }));
        } else {
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: `Device returned ${response.status}` }));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: msg.includes('aborted') ? 'Device timeout' : msg }));
      }
      return;
    }

    // API: Flash all connected ESP32s
    if (req.url === '/api/flash-all' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const { sketch_path, fqbn = 'esp32:esp32:esp32' } = JSON.parse(body);
        
        if (!sketch_path) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'sketch_path is required' }));
          return;
        }

        // First compile
        const tempBuildDir = path.join(os.tmpdir(), 'arduino_mcp_build');
        const sketchName = path.basename(sketch_path).replace('.ino', '');
        const tempSketchDir = path.join(tempBuildDir, sketchName);
        const buildOutputDir = path.join(tempBuildDir, 'output');
        
        await ensureDirectory(tempSketchDir);
        await ensureDirectory(buildOutputDir);
        
        // Copy sketch files
        const sketchDir = path.dirname(sketch_path);
        const files = await fs.readdir(sketchDir);
        for (const file of files) {
          const srcPath = path.join(sketchDir, file);
          const destPath = path.join(tempSketchDir, file === path.basename(sketch_path) ? `${sketchName}.ino` : file);
          const stat = await fs.stat(srcPath);
          if (stat.isFile()) {
            await fs.copyFile(srcPath, destPath);
          }
        }
        
        logger.info('Compiling for flash-all', { sketch_path, tempSketchDir, fqbn });
        
        const compileResult = await execa(arduinoCliRunner.getPath(), [
          'compile',
          '--fqbn', fqbn,
          '--output-dir', buildOutputDir,
          tempSketchDir
        ], { reject: false });
        
        if (compileResult.exitCode !== 0) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({
            ok: false,
            stage: 'compile',
            error: 'Compilation failed',
            stdout: compileResult.stdout,
            stderr: compileResult.stderr,
          }));
          return;
        }
        
        // Get ESP32 ports
        const ports = await detectEsp32Ports();
        const esp32Ports = ports.filter(p => p.isEsp32);
        
        logger.info('Flash-all: Starting sequential upload', { 
          totalPorts: esp32Ports.length,
          ports: esp32Ports.map(p => p.port)
        });
        
        // Upload to each port SEQUENTIALLY with delays and timeout
        const results: Array<{ port: string; ok: boolean; error?: string; duration?: number }> = [];
        const UPLOAD_TIMEOUT_MS = 120000; // 2 minutes per upload
        const INTER_UPLOAD_DELAY_MS = 2000; // 2 seconds between uploads
        
        for (let i = 0; i < esp32Ports.length; i++) {
          const portInfo = esp32Ports[i];
          const portName = portInfo.port.split('/').pop() || portInfo.port;
          
          logger.info(`Flash-all: [${i + 1}/${esp32Ports.length}] Uploading to ${portName}...`);
          const startTime = Date.now();
          
          try {
            const uploadResult = await execa(arduinoCliRunner.getPath(), [
              'upload',
              '--fqbn', fqbn,
              '--port', portInfo.port,
              '--input-dir', buildOutputDir
            ], { 
              reject: false,
              timeout: UPLOAD_TIMEOUT_MS,
            });
            
            const duration = Date.now() - startTime;
            const ok = uploadResult.exitCode === 0;
            
            results.push({
              port: portInfo.port,
              ok,
              error: ok ? undefined : (uploadResult.stderr || 'Upload failed'),
              duration,
            });
            
            logger.info(`Flash-all: [${i + 1}/${esp32Ports.length}] ${portName} - ${ok ? '✓ OK' : '✗ FAILED'} (${duration}ms)`);
            
          } catch (e: unknown) {
            const duration = Date.now() - startTime;
            const errorMsg = e instanceof Error ? e.message : String(e);
            const isTimeout = errorMsg.includes('timed out');
            
            results.push({
              port: portInfo.port,
              ok: false,
              error: isTimeout ? `Timeout after ${UPLOAD_TIMEOUT_MS}ms` : errorMsg,
              duration,
            });
            
            logger.error(`Flash-all: [${i + 1}/${esp32Ports.length}] ${portName} - ✗ ERROR: ${errorMsg}`);
          }
          
          // Wait between uploads to allow port to stabilize
          if (i < esp32Ports.length - 1) {
            logger.info(`Flash-all: Waiting ${INTER_UPLOAD_DELAY_MS}ms before next upload...`);
            await new Promise(resolve => setTimeout(resolve, INTER_UPLOAD_DELAY_MS));
          }
        }
        
        const successCount = results.filter(r => r.ok).length;
        const failedCount = results.length - successCount;
        const allOk = results.length > 0 && successCount === results.length;
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
        
        logger.info('Flash-all: Complete', {
          total: results.length,
          success: successCount,
          failed: failedCount,
          totalDuration: `${(totalDuration / 1000).toFixed(1)}s`,
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: allOk,
          stage: 'flash-all',
          total: results.length,
          success: successCount,
          failed: failedCount,
          totalDuration,
          results,
          build_path: buildOutputDir,
        }));
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

