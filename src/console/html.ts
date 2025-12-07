/**
 * Console HTML Template
 * Contains the embedded HTML for the serial console UI
 */

export function getConsoleHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ESP32 Serial Console</title>
  <style>
    :root { 
      --bg-dark: #0a0f1a; 
      --bg-panel: #0d1525; 
      --bg-input: #111827;
      --border: #1e3a5f; 
      --text: #e2e8f0; 
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #8b5cf6;
      --highlight-bg: #422006;
      --stacktrace-bg: #1c1917;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-dark); color: var(--text); font-size: 14px; }
    header { background: linear-gradient(180deg, #0f1729 0%, #0d1525 100%); border-bottom: 1px solid var(--border); padding: 12px 20px; position: sticky; top: 0; z-index: 100; }
    .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
    .logo { font-size: 18px; font-weight: 700; background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; }
    .status-badge.connected { background: rgba(34, 197, 94, 0.15); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-badge.disconnected { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }
    .status-badge.connected .status-dot { background: var(--success); }
    .status-badge.disconnected .status-dot { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    
    /* Mode Selector */
    .mode-selector { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: var(--bg-input); border-radius: 8px; border: 1px solid var(--border); }
    .mode-selector label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .mode-selector select { background: var(--bg-dark); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; font-weight: 600; }
    .mode-selector select option { padding: 8px; }
    .mode-help { background: none; border: none; color: var(--accent); font-size: 16px; cursor: pointer; padding: 4px; }
    .mode-help:hover { color: var(--text); }
    
    /* Mode indicator badges */
    .mode-badge { padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .mode-badge.realtime { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.3); }
    .mode-badge.polling { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .mode-badge.installer { background: rgba(139, 92, 246, 0.2); color: var(--purple); border: 1px solid rgba(139, 92, 246, 0.3); }
    
    /* Active/Inactive indicators */
    .port-status { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; }
    .port-status.active { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .port-status.inactive { background: rgba(100, 116, 139, 0.2); color: var(--text-muted); }
    .port-status.polling { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar-group { display: flex; gap: 6px; align-items: center; padding: 4px 8px; background: var(--bg-input); border-radius: 8px; border: 1px solid var(--border); }
    .toolbar-group label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    input, select { background: var(--bg-dark); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; outline: none; transition: border-color 0.2s; }
    input:focus, select:focus { border-color: var(--accent); }
    input::placeholder { color: var(--text-muted); }
    input.error { border-color: var(--danger); }
    .input-wide { min-width: 180px; }
    button { background: var(--accent); color: white; border: none; border-radius: 6px; padding: 6px 14px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    button:hover { background: var(--accent-hover); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #dc2626; }
    button.success { background: var(--success); }
    button.success:hover { background: #16a34a; }
    button.warning { background: var(--warning); color: #000; }
    button.warning:hover { background: #d97706; }
    button.purple { background: var(--purple); }
    button.purple:hover { background: #7c3aed; }
    button.outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    button.outline:hover { background: var(--bg-input); border-color: var(--accent); }
    button.sm { padding: 4px 8px; font-size: 11px; }
    main { display: grid; grid-template-columns: 1fr 360px; gap: 16px; padding: 16px 20px; min-height: calc(100vh - 140px); }
    @media (max-width: 1200px) { main { grid-template-columns: 1fr; } }
    .panel { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .panel-header { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%); }
    .panel-title { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .panel-title .icon { font-size: 16px; }
    .panel-actions { display: flex; gap: 6px; align-items: center; }
    .autoscroll-toggle { display: flex; align-items: center; gap: 2px; cursor: pointer; padding: 2px 6px; border-radius: 4px; background: var(--bg-input); border: 1px solid var(--border); font-size: 12px; }
    .autoscroll-toggle input { width: 14px; height: 14px; margin: 0; cursor: pointer; }
    .autoscroll-toggle span { opacity: 0.7; }
    .autoscroll-toggle:has(input:checked) span { opacity: 1; }
    .panel-body { flex: 1; overflow-y: auto; padding: 8px; font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace; font-size: 12px; line-height: 1.5; }
    .panel-body::-webkit-scrollbar { width: 8px; }
    .panel-body::-webkit-scrollbar-track { background: var(--bg-dark); }
    .panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .serial-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); }
    .port-panel { min-height: 300px; max-height: 500px; }
    .port-panel .panel-body { max-height: 400px; }
    .log-line { padding: 2px 8px; border-radius: 4px; margin-bottom: 1px; white-space: pre-wrap; word-break: break-all; display: flex; gap: 8px; }
    .log-line:hover { background: rgba(255,255,255,0.03); }
    .log-time { color: var(--text-muted); min-width: 75px; flex-shrink: 0; }
    .log-content { flex: 1; }
    .log-line.stderr { color: var(--danger); }
    .log-line.highlight { background: var(--highlight-bg); border-left: 3px solid var(--warning); }
    .log-line.stacktrace { background: var(--stacktrace-bg); color: #fca5a5; border-left: 3px solid var(--danger); }
    .log-line.reboot { background: rgba(139, 92, 246, 0.15); border-left: 3px solid #8b5cf6; color: #c4b5fd; }
    .log-line.error { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border-left: 3px solid var(--danger); }
    .highlight-match { background: var(--warning); color: #000; padding: 0 2px; border-radius: 2px; }
    .sidebar { display: flex; flex-direction: column; gap: 12px; }
    .sidebar .panel { flex-shrink: 0; }
    .alert-panel .panel-body { max-height: 200px; }
    .stacktrace-panel .panel-body { max-height: 180px; }
    .port-control { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; background: var(--bg-input); border-bottom: 1px solid var(--border); }
    .port-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--bg-dark); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .port-item.active { border-color: var(--success); background: rgba(34, 197, 94, 0.1); }
    .port-item .port-name { font-weight: 500; }
    .port-item .baud { color: var(--text-muted); }
    .stats { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); }
    .stat { display: flex; align-items: center; gap: 4px; }
    .stat-value { color: var(--text); font-weight: 600; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge.info { background: rgba(59, 130, 246, 0.2); color: var(--accent); }
    .badge.success { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge.warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    .badge.danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .control-panel { padding: 14px; }
    .control-section { margin-bottom: 16px; }
    .control-section:last-child { margin-bottom: 0; }
    .control-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: block; }
    .control-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .control-row:last-child { margin-bottom: 0; }
    .port-list { max-height: 280px; overflow-y: auto; }
    .port-list-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 6px; margin-bottom: 4px; background: var(--bg-dark); border: 1px solid var(--border); }
    .port-list-item:hover { border-color: var(--accent); }
    .port-list-item.monitoring { border-color: var(--success); background: rgba(34, 197, 94, 0.05); }
    .port-info { display: flex; flex-direction: column; gap: 2px; }
    .port-name { font-weight: 500; font-size: 13px; }
    .port-detail { font-size: 11px; color: var(--text-muted); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; color: var(--text-muted); text-align: center; }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-state p { margin: 0 0 16px 0; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    .toast { box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s; }
    .status-indicator { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; }
    .status-indicator.monitoring { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .status-indicator.stopped { background: rgba(100, 116, 139, 0.15); color: var(--text-muted); }
    @keyframes pulse-green { 0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); } 50% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); } }
    .pulse { animation: pulse-green 2s infinite; }
    
    /* Modal styles */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 2000; }
    .modal { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; max-width: 700px; width: 90%; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; }
    .modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .modal-title { font-size: 18px; font-weight: 600; }
    .modal-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; padding: 0; line-height: 1; }
    .modal-close:hover { color: var(--text); }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
    .mode-card { background: var(--bg-dark); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .mode-card:last-child { margin-bottom: 0; }
    .mode-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .mode-card-icon { font-size: 24px; }
    .mode-card-title { font-size: 16px; font-weight: 600; }
    .mode-card-desc { color: var(--text-muted); font-size: 13px; line-height: 1.6; }
    .mode-card-note { margin-top: 12px; padding: 10px; background: rgba(59, 130, 246, 0.1); border-radius: 6px; font-size: 12px; color: var(--accent); }
    .mode-card-warning { margin-top: 12px; padding: 10px; background: rgba(245, 158, 11, 0.1); border-radius: 6px; font-size: 12px; color: var(--warning); }
    
    /* Installer mode progress */
    .installer-progress { margin-top: 12px; }
    .installer-progress-item { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; margin-bottom: 4px; font-size: 12px; }
    .installer-progress-item.waiting { background: rgba(100, 116, 139, 0.1); color: var(--text-muted); }
    .installer-progress-item.scanning { background: rgba(245, 158, 11, 0.1); color: var(--warning); }
    .installer-progress-item.success { background: rgba(34, 197, 94, 0.1); color: var(--success); }
    .installer-progress-item.timeout { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo">⚡ ESP32 Serial Console</div>
      
      <!-- Mode Selector -->
      <div class="mode-selector">
        <label>Mode</label>
        <select id="modeSelect" title="動作モードを選択">
          <option value="realtime">🟢 Realtime</option>
          <option value="polling">🟡 Polling</option>
          <option value="installer">🟣 aranea_Installer</option>
        </select>
        <button class="mode-help" id="modeHelpBtn" title="モード解説を表示">ℹ️</button>
      </div>
      
      <div id="modeBadge" class="mode-badge realtime">REALTIME</div>
      
      <div class="status-badge disconnected" id="statusBadge" title="SSEサーバー接続状態">
        <span class="status-dot"></span>
        <span id="statusText">SSE Connecting...</span>
      </div>
      <div class="stats">
        <div class="stat">Lines: <span class="stat-value" id="totalLines">0</span></div>
        <div class="stat">Alerts: <span class="stat-value" id="totalAlerts">0</span></div>
        <div class="stat" id="activePortsStat">Active: <span class="stat-value" id="activePortsCount">0</span>/<span id="totalPortsCount">0</span></div>
      </div>
      <button class="outline sm" id="restartServerBtn" title="サーバー再起動" style="margin-left:auto;">🔄 Restart</button>
    </div>
    <div class="toolbar">
      <div class="toolbar-group">
        <label>Filter</label>
        <input type="text" id="textFilter" class="input-wide" placeholder="Filter logs (regex)" title="正規表現でログをフィルタリング" />
      </div>
      <div class="toolbar-group">
        <label>Highlight</label>
        <input type="text" id="highlightFilter" class="input-wide" placeholder="Highlight text (regex)" title="マッチしたテキストをハイライト" />
      </div>
      <div class="toolbar-group">
        <label>Alert on</label>
        <input type="text" id="alertFilter" class="input-wide" placeholder="Alert pattern (regex)" title="マッチしたログをAlertsに表示" />
      </div>
      <button class="outline" id="clearAllBtn" title="全ログをクリア">🗑 Clear All</button>
      <button class="outline" id="exportBtn" title="ログをエクスポート">📥 Export</button>
    </div>
  </header>

  <main>
    <div class="serial-area">
      <div class="panel" style="margin-bottom: 12px;">
        <div class="panel-header">
          <div class="panel-title">🔌 Active Ports <span id="modeIndicator" class="badge success">Realtime</span></div>
          <button class="sm outline" id="refreshPortsBtn">↻ Refresh</button>
        </div>
        <div class="port-control" id="portControl">
          <div class="empty-state" style="padding: 20px; width: 100%;"><p>No active monitors</p></div>
        </div>
      </div>
      <div class="serial-grid" id="serialGrid"></div>
      
      <!-- Installer Mode Progress Panel -->
      <div class="panel" id="installerPanel" style="display:none; margin-top: 12px;">
        <div class="panel-header">
          <div class="panel-title">🟣 aranea_Installer Progress</div>
          <button class="sm purple" id="startInstallerBtn">▶ Start Scan</button>
        </div>
        <div class="panel-body" id="installerProgress" style="max-height: 300px;">
          <div class="empty-state" style="padding: 20px;"><p>Click "Start Scan" to begin RegisteredInfo detection</p></div>
        </div>
      </div>
    </div>

    <div class="sidebar">
      <div class="panel">
        <div class="panel-header"><div class="panel-title">🎛 Monitor Control</div></div>
        <div class="control-panel">
          <div class="control-section">
            <span class="control-label">Available Ports</span>
            <div class="control-row" style="margin-bottom:6px;flex-wrap:wrap;gap:8px;">
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);"><input type="checkbox" id="showOnlyEsp32" checked /> ESP32のみ</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);"><input type="checkbox" id="showUnknownDevices" /> 不明</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);"><input type="checkbox" id="hideErrorPorts" checked /> エラー非表示</label>
            </div>
            <div class="port-list" id="availablePorts"><div class="empty-state" style="padding:20px;"><p>Click Scan Ports</p></div></div>
            <div class="control-row" style="margin-top:8px;">
              <button class="outline" style="flex:1" id="scanPortsBtn">🔍 Scan Ports</button>
            </div>
          </div>
          <div class="control-section" id="realtimeControls">
            <span class="control-label">Quick Start (Realtime)</span>
            <div class="control-row">
              <select id="baudSelect" style="flex:1"><option value="115200" selected>115200</option><option value="74880">74880</option><option value="9600">9600</option></select>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" id="autoBaudCheck" checked /> Auto</label>
            </div>
            <div class="control-row"><button class="success" style="flex:1" id="startAllBtn">▶ Start All ESP32</button></div>
            <div class="control-row"><button class="danger" style="flex:1" id="stopAllBtn">⏹ Stop All</button></div>
          </div>
          <div class="control-section" id="pollingControls" style="display:none;">
            <span class="control-label">Polling Settings</span>
            <div class="control-row">
              <label style="font-size:12px;">Interval (ms):</label>
              <input type="number" id="pollingInterval" value="100" min="50" max="1000" style="width:80px;" />
            </div>
            <div class="control-row"><button class="warning" style="flex:1" id="startPollingBtn">▶ Start Polling</button></div>
            <div class="control-row"><button class="danger" style="flex:1" id="stopPollingBtn">⏹ Stop Polling</button></div>
          </div>
        </div>
      </div>
      <div class="panel alert-panel">
        <div class="panel-header"><div class="panel-title">🔔 Alerts <span class="badge warning" id="alertBadge">0</span></div><button class="sm outline" id="clearAlertsBtn">Clear</button></div>
        <div class="panel-body" id="alertsBody"><div class="empty-state" style="padding:20px;"><p>No alerts</p></div></div>
      </div>
      <div class="panel stacktrace-panel">
        <div class="panel-header"><div class="panel-title">💥 Crashes <span class="badge danger" id="crashBadge">0</span></div><button class="sm outline" id="clearCrashesBtn">Clear</button></div>
        <div class="panel-body" id="crashesBody"><div class="empty-state" style="padding:20px;"><p>No crashes</p></div></div>
      </div>
      <div class="panel">
        <div class="panel-header"><div class="panel-title">📋 Install Log</div><button class="sm outline" id="installLogHistoryBtn">📜 History</button></div>
        <div class="panel-body" id="installLogPanel" style="max-height:250px;"><div class="empty-state" style="padding:20px;"><p>Waiting for ::RegisteredInfo::</p></div></div>
      </div>
    </div>
  </main>

  <script>
    // ========== State ==========
    let es = null;
    let textRegex = null, highlightRegex = null, alertRegex = null;
    let totalLines = 0, totalAlerts = 0, totalCrashes = 0;
    let currentMode = 'realtime';
    let pollingTimer = null;
    let pollingIndex = 0;
    let installerTimer = null;
    let installerQueue = [];
    const portPanels = new Map();
    const monitoringPorts = new Set();
    const errorPorts = new Set(); // Ports that have errors
    const portLastLogTime = new Map(); // Track last log time per port
    const allLogs = [];
    const allPorts = [];
    const MAX_LOGS = 1000;
    const INACTIVE_TIMEOUT_MS = 60000; // 1 minute without logs = inactive
    const CRASH_PATTERNS = [/Guru Meditation/i, /Backtrace:/i, /rst:0x[0-9a-f]+/i, /Brownout/i, /panic/i];
    const ERROR_PATTERNS = [/Resource busy/i, /could not open port/i, /SerialException/i, /Permission denied/i];
    const INSTALLER_TIMEOUT = 90000; // 90 seconds
    
    const $ = id => document.getElementById(id);
    const statusBadge = $('statusBadge'), statusText = $('statusText');
    
    // ========== Utilities ==========
    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    function formatTime(d) { return d.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }
    function setStatus(c, t) { statusBadge.className = 'status-badge ' + (c ? 'connected' : 'disconnected'); statusText.textContent = t; }
    function showToast(m, t = 'info') {
      const toast = document.createElement('div');
      toast.textContent = m;
      toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;animation:slideIn 0.3s;background:' + (t === 'success' ? '#22c55e' : t === 'error' ? '#ef4444' : t === 'warning' ? '#f59e0b' : '#3b82f6');
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
    }
    function updateStats() {
      $('totalLines').textContent = totalLines;
      $('totalAlerts').textContent = totalAlerts;
      $('alertBadge').textContent = totalAlerts;
      $('crashBadge').textContent = totalCrashes;
      $('activePortsCount').textContent = monitoringPorts.size;
      $('totalPortsCount').textContent = allPorts.length;
    }
    
    // ========== Mode Management ==========
    function setMode(mode) {
      currentMode = mode;
      const badge = $('modeBadge');
      const indicator = $('modeIndicator');
      
      // Stop any running processes
      stopPolling();
      stopInstaller();
      
      // Update UI
      if (mode === 'realtime') {
        badge.className = 'mode-badge realtime';
        badge.textContent = 'REALTIME';
        indicator.className = 'badge success';
        indicator.textContent = 'Realtime';
        $('realtimeControls').style.display = '';
        $('pollingControls').style.display = 'none';
        $('installerPanel').style.display = 'none';
      } else if (mode === 'polling') {
        badge.className = 'mode-badge polling';
        badge.textContent = 'POLLING';
        indicator.className = 'badge warning';
        indicator.textContent = 'Polling';
        $('realtimeControls').style.display = 'none';
        $('pollingControls').style.display = '';
        $('installerPanel').style.display = 'none';
        // Stop realtime monitors
        stopAllMonitors();
      } else if (mode === 'installer') {
        badge.className = 'mode-badge installer';
        badge.textContent = 'INSTALLER';
        indicator.className = 'badge info';
        indicator.textContent = 'Installer';
        $('realtimeControls').style.display = 'none';
        $('pollingControls').style.display = 'none';
        $('installerPanel').style.display = '';
        // Stop realtime monitors
        stopAllMonitors();
      }
      
      showToast('Mode: ' + mode.toUpperCase(), 'info');
    }
    
    function showModeHelp() {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      overlay.innerHTML = \`
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">📖 Monitor Modes</span>
            <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
          </div>
          <div class="modal-body">
            <div class="mode-card">
              <div class="mode-card-header">
                <span class="mode-card-icon">🟢</span>
                <span class="mode-card-title">Realtime Mode</span>
              </div>
              <div class="mode-card-desc">
                現在の動作モードです。選択したポートに対してリアルタイムでシリアル出力を取得します。
                <br><br>
                <strong>特徴:</strong><br>
                • 低レイテンシでのシリアル出力監視<br>
                • 複数ポートの同時監視（Active/Inactive表示）<br>
                • 確実にシリアルを取得したい場合に使用
              </div>
              <div class="mode-card-warning">
                ⚠️ <strong>注意:</strong> 同時接続可能なポート数はOS・ハードウェア仕様に依存します。<br>
                macOS Sequoiaでは最大2ポートの制限があります。
              </div>
            </div>
            
            <div class="mode-card">
              <div class="mode-card-header">
                <span class="mode-card-icon">🟡</span>
                <span class="mode-card-title">Polling Mode</span>
              </div>
              <div class="mode-card-desc">
                高速ポーリングモードです。接続された全てのESP32デバイスを短時間で切り替えながらシリアル出力を取得します。
                <br><br>
                <strong>特徴:</strong><br>
                • Realtimeで全数取得ができない場合でも全てのポートを監視<br>
                • 可能な限り多くのデバイスの正常状態をモニタリング
              </div>
              <div class="mode-card-warning">
                ⚠️ <strong>注意:</strong> シリアル出力はバッファされないため、ポーリング間隔の間にあるシリアル出力は無視されます。
              </div>
            </div>
            
            <div class="mode-card">
              <div class="mode-card-header">
                <span class="mode-card-icon">🟣</span>
                <span class="mode-card-title">aranea_Installer Mode</span>
              </div>
              <div class="mode-card-desc">
                araneaDeviceのインストール確認に使用するモードです。インストール後のシリアル出力から<code>::RegisteredInfo::</code>を取得して記録します。
                <br><br>
                <strong>特徴:</strong><br>
                • 各ポートを順番にスキャン<br>
                • RegisteredInfoが取得されるまで監視（タイムアウト90秒）<br>
                • 取得結果をInstall Logに自動記録
              </div>
              <div class="mode-card-note">
                💡 <strong>使い方:</strong> "Start Scan" をクリックすると、全ポートを順番にスキャンしてRegisteredInfoを検出します。
              </div>
            </div>
          </div>
        </div>
      \`;
      document.body.appendChild(overlay);
    }
    
    // ========== Port Panel Management ==========
    const portAutoScroll = new Map(); // Track auto-scroll state per port
    
    function ensurePortPanel(port) {
      if (portPanels.has(port)) return portPanels.get(port);
      monitoringPorts.add(port);
      portAutoScroll.set(port, true); // Default auto-scroll ON
      
      const panel = document.createElement('div');
      panel.className = 'panel port-panel';
      panel.id = 'panel-' + CSS.escape(port);
      
      const statusClass = currentMode === 'realtime' ? 'active' : currentMode === 'polling' ? 'polling' : 'active';
      const statusText = currentMode === 'realtime' ? 'ACTIVE' : currentMode === 'polling' ? 'POLLING' : 'SCANNING';
      const escapedPort = escapeHtml(port).replace(/'/g, "\\'");
      
      panel.innerHTML = '<div class="panel-header"><div class="panel-title"><span class="icon">📟</span><span>' + escapeHtml(port.split('/').pop()) + '</span><span class="port-status ' + statusClass + '">' + statusText + '</span></div><div class="panel-actions"><label class="autoscroll-toggle" title="自動スクロール"><input type="checkbox" checked onchange="toggleAutoScroll(\\'' + escapedPort + '\\', this.checked)" /><span>📜</span></label><button class="sm outline" onclick="clearPortLogs(\\'' + escapedPort + '\\')">🗑</button><button class="sm outline" onclick="restartPortMonitor(\\'' + escapedPort + '\\')">🔄</button><button class="sm danger" onclick="stopPortMonitor(\\'' + escapedPort + '\\')">⏹</button></div></div><div class="panel-body" id="logs-' + CSS.escape(port) + '"></div>';
      $('serialGrid').appendChild(panel);
      const body = panel.querySelector('.panel-body');
      portPanels.set(port, { panel, body, lineCount: 0 });
      updatePortControl();
      return portPanels.get(port);
    }
    
    window.toggleAutoScroll = function(port, enabled) {
      portAutoScroll.set(port, enabled);
    };
    
    function updatePortControl() {
      const ports = Array.from(portPanels.keys());
      $('portControl').innerHTML = ports.length === 0 
        ? '<div class="empty-state" style="padding:20px;width:100%;"><p>No active monitors</p></div>' 
        : ports.map(p => {
            const isActive = monitoringPorts.has(p);
            const statusClass = isActive ? (currentMode === 'polling' ? 'polling' : 'active') : 'inactive';
            const statusText = isActive ? (currentMode === 'polling' ? 'POLLING' : 'ACTIVE') : 'INACTIVE';
            return '<div class="port-item ' + (isActive ? 'active' : '') + '"><span class="port-status ' + statusClass + '">' + statusText + '</span><span class="port-name">' + escapeHtml(p.split('/').pop()) + '</span></div>';
          }).join('');
      updateStats();
    }
    
    function setPortStatus(port, status) {
      const panel = portPanels.get(port);
      if (!panel) return;
      const statusEl = panel.panel.querySelector('.port-status');
      if (statusEl) {
        statusEl.className = 'port-status ' + status;
        statusEl.textContent = status.toUpperCase();
      }
    }
    
    // ========== Logging ==========
    function appendLog(evt) {
      const port = evt.port || 'unknown';
      const portData = ensurePortPanel(port);
      const text = evt.line || '';
      const isCrash = CRASH_PATTERNS.some(p => p.test(text));
      const isReboot = /rst:0x/i.test(text);
      const isError = ERROR_PATTERNS.some(p => p.test(text));
      
      // Track error ports
      if (isError) {
        errorPorts.add(port);
        renderPortList(); // Update port list to hide error ports
      }
      
      // Track last log time for inactive detection
      portLastLogTime.set(port, Date.now());
      
      if (textRegex && !textRegex.test(text)) return;
      
      totalLines++;
      portData.lineCount++;
      
      const div = document.createElement('div');
      let cn = 'log-line';
      if (evt.stream === 'stderr') cn += ' stderr';
      if (isError) cn += ' error';
      if (isCrash) cn += ' stacktrace';
      else if (isReboot) cn += ' reboot';
      else if (highlightRegex && highlightRegex.test(text)) cn += ' highlight';
      div.className = cn;
      
      const sysTime = formatTime(new Date());
      let content = escapeHtml(text);
      if (highlightRegex) content = content.replace(highlightRegex, m => '<span class="highlight-match">' + m + '</span>');
      div.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">' + content + '</span>';
      
      portData.body.appendChild(div);
      while (portData.body.childElementCount > MAX_LOGS) portData.body.removeChild(portData.body.firstChild);
      // Auto-scroll if enabled for this port and user is at bottom
      const autoScrollEnabled = portAutoScroll.get(port) !== false;
      if (autoScrollEnabled) {
        const isAtBottom = portData.body.scrollHeight - portData.body.scrollTop <= portData.body.clientHeight + 50;
        if (isAtBottom) portData.body.scrollTop = portData.body.scrollHeight;
      }
      
      allLogs.push({ time: sysTime, port, text });
      if (allLogs.length > MAX_LOGS * 10) allLogs.splice(0, allLogs.length - MAX_LOGS * 10);
      
      if (alertRegex && alertRegex.test(text)) {
        totalAlerts++;
        const ad = document.createElement('div');
        ad.className = 'log-line';
        ad.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">[' + escapeHtml(port) + '] ' + escapeHtml(text) + '</span>';
        $('alertsBody').querySelector('.empty-state')?.remove();
        $('alertsBody').appendChild(ad);
      }
      
      if (isCrash || isReboot) {
        totalCrashes++;
        const cd = document.createElement('div');
        cd.className = 'log-line ' + (isCrash ? 'stacktrace' : 'reboot');
        cd.innerHTML = '<span class="log-time">' + sysTime + '</span><span class="log-content">[' + escapeHtml(port) + '] ' + escapeHtml(text) + '</span>';
        $('crashesBody').querySelector('.empty-state')?.remove();
        $('crashesBody').appendChild(cd);
      }
      
      updateStats();
    }
    
    function clearPortLogs(port) { const d = portPanels.get(port); if (d) { d.body.innerHTML = ''; d.lineCount = 0; } }
    function clearAllLogs() { for (const [, d] of portPanels) { d.body.innerHTML = ''; d.lineCount = 0; } totalLines = 0; updateStats(); }
    function exportLogs() {
      const text = allLogs.map(l => l.time + ' [' + l.port + '] ' + l.text).join('\\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'esp32-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      a.click();
    }
    
    // ========== Port Nickname ==========
    async function setPortNickname(port, nickname) {
      try {
        await fetch('/api/port-nicknames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, nickname }) });
        showToast('Saved: ' + nickname, 'success');
      } catch (e) { showToast('Save failed', 'error'); }
    }
    
    // ========== Install Log ==========
    let installLogs = [];
    async function loadInstallLogs() {
      try {
        const r = await fetch('/api/install-logs?limit=50');
        const d = await r.json();
        installLogs = d.logs || [];
        renderInstallLogs();
      } catch (e) {}
    }
    function formatInstallLogEntry(key, entry) {
      const ds = key.slice(0, 14);
      const ts = ds.slice(2, 4) + '/' + ds.slice(4, 6) + '/' + ds.slice(6, 8) + ' ' + ds.slice(8, 10) + ':' + ds.slice(10, 12) + ':' + ds.slice(12, 14);
      const id = entry.lacisID || '---', cic = entry.cic || '---', nn = entry.nickname || entry.port?.split('/').pop() || '---';
      let wifi = '';
      if (entry.mainssid) wifi += '1:' + entry.mainssid;
      if (entry.altssid) wifi += (wifi ? ',' : '') + '2:' + entry.altssid;
      if (entry.devssid) wifi += (wifi ? ',' : '') + '3:' + entry.devssid;
      return '<div style="padding:8px;border-bottom:1px solid var(--border);font-size:12px;"><div style="color:var(--text-muted);">' + ts + ' <span style="color:var(--accent);">[' + escapeHtml(nn) + ']</span></div><div style="font-family:monospace;"><span style="color:#22c55e;">' + escapeHtml(id) + '</span> <span style="color:var(--text-muted);">(cic:' + escapeHtml(cic) + ')</span></div>' + (wifi ? '<div style="color:var(--text-muted);font-size:11px;">wifi:' + escapeHtml(wifi) + '</div>' : '') + '</div>';
    }
    function renderInstallLogs() {
      $('installLogPanel').innerHTML = installLogs.length === 0 
        ? '<div class="empty-state" style="padding:20px;"><p>Waiting...</p></div>' 
        : installLogs.slice(0, 5).map(({ key, entry }) => formatInstallLogEntry(key, entry)).join('');
    }
    function showInstallLogHistory() {
      const o = document.createElement('div');
      o.className = 'modal-overlay';
      o.onclick = e => { if (e.target === o) o.remove(); };
      o.innerHTML = '<div class="modal"><div class="modal-header"><span class="modal-title">📋 Install Log (' + installLogs.length + ')</span><button class="modal-close" onclick="this.closest(\\'.modal-overlay\\').remove()">×</button></div><div class="modal-body">' + installLogs.map(({ key, entry }) => formatInstallLogEntry(key, entry)).join('') + '</div></div>';
      document.body.appendChild(o);
    }
    
    // ========== Port Scanning ==========
    function renderPortList() {
      const showOnlyEsp32 = $('showOnlyEsp32')?.checked ?? true;
      const showUnknown = $('showUnknownDevices')?.checked ?? false;
      const hideError = $('hideErrorPorts')?.checked ?? true;
      
      let filteredPorts = allPorts.filter(p => {
        if (showOnlyEsp32 && !p.isEsp32) return false;
        if (!showUnknown && !p.isEsp32) return false;
        if (hideError && errorPorts.has(p.port)) return false;
        return true;
      });
      
      // If both unchecked, show ESP32 only as default
      if (!showOnlyEsp32 && !showUnknown) {
        filteredPorts = allPorts.filter(p => p.isEsp32 && (!hideError || !errorPorts.has(p.port)));
      }
      
      if (filteredPorts.length > 0) {
        $('availablePorts').innerHTML = filteredPorts.map(p => {
          const m = monitoringPorts.has(p.port), nn = p.nickname || '';
          const typeLabel = p.isEsp32 ? '✓ ESP32' : '<span style="color:var(--text-muted);">不明</span>';
          return '<div class="port-list-item ' + (m ? 'monitoring' : '') + '" data-port="' + escapeHtml(p.port) + '"><div class="port-info" style="flex:1"><div class="port-name" style="display:flex;align-items:center;gap:6px;"><span class="port-status-icon">' + (m ? '🟢' : '⚪') + '</span><input type="text" value="' + escapeHtml(nn) + '" placeholder="' + escapeHtml(p.port.split('/').pop()) + '" onchange="setPortNickname(\\'' + escapeHtml(p.port) + '\\',this.value)" style="width:80px;padding:2px 4px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text);"><span style="color:var(--text-muted);font-size:10px;">' + escapeHtml(p.port.split('/').pop()) + '</span></div><div class="port-detail">' + typeLabel + '<span class="port-monitoring-status">' + (m ? ' <span style="color:#22c55e;">● Monitoring</span>' : '') + '</span></div></div><button class="sm port-action-btn ' + (m ? 'danger' : 'success') + '" onclick="' + (m ? 'stopPortMonitor' : 'startPortMonitor') + '(\\'' + escapeHtml(p.port) + '\\')">' + (m ? '⏹' : '▶') + '</button></div>';
        }).join('');
      } else {
        $('availablePorts').innerHTML = '<div class="empty-state" style="padding:20px;"><p>No ports found</p></div>';
      }
    }
    
    // Update single port item without re-rendering the entire list
    function updatePortItemStatus(port, isMonitoring) {
      const item = document.querySelector('.port-list-item[data-port="' + CSS.escape(port) + '"]');
      if (!item) return;
      
      if (isMonitoring) {
        item.classList.add('monitoring');
      } else {
        item.classList.remove('monitoring');
      }
      
      const statusIcon = item.querySelector('.port-status-icon');
      if (statusIcon) statusIcon.textContent = isMonitoring ? '🟢' : '⚪';
      
      const monitorStatus = item.querySelector('.port-monitoring-status');
      if (monitorStatus) monitorStatus.innerHTML = isMonitoring ? ' <span style="color:#22c55e;">● Monitoring</span>' : '';
      
      const btn = item.querySelector('.port-action-btn');
      if (btn) {
        btn.className = 'sm port-action-btn ' + (isMonitoring ? 'danger' : 'success');
        btn.textContent = isMonitoring ? '⏹' : '▶';
        btn.setAttribute('onclick', (isMonitoring ? 'stopPortMonitor' : 'startPortMonitor') + '(\\'' + port.replace(/'/g, "\\\\'") + '\\')');
      }
    }
    
    async function scanPorts() {
      const btn = $('scanPortsBtn');
      btn.disabled = true;
      btn.textContent = '🔄...';
      
      try {
        const r = await fetch('/api/monitors');
        const md = await r.json();
        monitoringPorts.clear();
        if (md.ok && md.sessions) for (const m of md.sessions) if (m.port) monitoringPorts.add(m.port);
      } catch (e) {}
      
      try {
        const r = await fetch('/api/ports');
        const d = await r.json();
        allPorts.length = 0;
        if (d.ports) allPorts.push(...d.ports);
        
        renderPortList();
        const esp32Count = allPorts.filter(p => p.isEsp32).length;
        showToast('Found ' + allPorts.length + ' port(s), ' + esp32Count + ' ESP32', 'info');
      } catch (e) { showToast('Scan failed', 'error'); }
      finally {
        btn.disabled = false;
        btn.textContent = '🔍 Scan Ports';
        updateStats();
      }
    }
    
    // ========== Realtime Mode Functions ==========
    async function startPortMonitor(port) {
      if (currentMode !== 'realtime') {
        showToast('Switch to Realtime mode first', 'warning');
        return;
      }
      const baud = parseInt($('baudSelect').value), auto = $('autoBaudCheck').checked;
      try {
        const r = await fetch('/api/monitor/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, baud, auto_baud: auto }) });
        const d = await r.json();
        if (d.ok) {
          monitoringPorts.add(port);
          updatePortItemStatus(port, true);
          showToast('✓ Started ' + port, 'success');
        } else showToast('✗ ' + d.error, 'error');
      } catch (e) { showToast('✗ ' + e.message, 'error'); }
      finally { updatePortControl(); }
    }
    
    async function stopPortMonitor(port) {
      try {
        await fetch('/api/monitor/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) });
        monitoringPorts.delete(port);
        updatePortItemStatus(port, false);
        showToast('⏹ Stopped ' + port, 'info');
      } catch (e) { showToast('Stop error', 'error'); }
      finally { updatePortControl(); }
    }
    
    async function restartPortMonitor(port) {
      showToast('🔄 Restarting...', 'info');
      await stopPortMonitor(port);
      await new Promise(r => setTimeout(r, 1000));
      await startPortMonitor(port);
    }
    
    async function startAllMonitors() {
      const btn = $('startAllBtn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/ports');
        const d = await r.json();
        const ports = (d.ports || []).filter(p => p.isEsp32);
        for (const p of ports) {
          await startPortMonitor(p.port);
          await new Promise(r => setTimeout(r, 500));
        }
        showToast('✓ Started ' + ports.length + ' monitors', 'success');
      } catch (e) { showToast('Failed', 'error'); }
      finally { btn.disabled = false; }
    }
    
    async function stopAllMonitors() {
      try {
        await fetch('/api/monitor/stop-all', { method: 'POST' });
        monitoringPorts.clear();
        showToast('⏹ All stopped', 'info');
        scanPorts();
      } catch (e) { showToast('Failed', 'error'); }
    }
    
    // ========== Polling Mode Functions ==========
    async function startPolling() {
      if (currentMode !== 'polling') return;
      
      const interval = parseInt($('pollingInterval').value) || 100;
      const esp32Ports = allPorts.filter(p => p.isEsp32).map(p => p.port);
      
      if (esp32Ports.length === 0) {
        showToast('No ESP32 ports found. Scan first.', 'warning');
        return;
      }
      
      showToast('Polling ' + esp32Ports.length + ' port(s) @ ' + interval + 'ms', 'info');
      $('startPollingBtn').disabled = true;
      pollingIndex = 0;
      
      async function pollNext() {
        if (currentMode !== 'polling') return;
        
        const port = esp32Ports[pollingIndex];
        pollingIndex = (pollingIndex + 1) % esp32Ports.length;
        
        try {
          const r = await fetch('/api/poll-port', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port, baud: 115200, timeout: interval - 20 })
          });
          const d = await r.json();
          
          if (d.ok && d.lines && d.lines.length > 0) {
            for (const line of d.lines) {
              appendLog({ port, line, stream: 'stdout' });
            }
          }
          
          // Update port status
          ensurePortPanel(port);
          setPortStatus(port, 'polling');
          
        } catch (e) {
          // Silently continue
        }
        
        pollingTimer = setTimeout(pollNext, interval);
      }
      
      pollNext();
    }
    
    function stopPolling() {
      if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
      }
      $('startPollingBtn').disabled = false;
      showToast('Polling stopped', 'info');
    }
    
    // ========== Installer Mode Functions ==========
    async function startInstaller() {
      if (currentMode !== 'installer') return;
      
      const esp32Ports = allPorts.filter(p => p.isEsp32).map(p => p.port);
      
      if (esp32Ports.length === 0) {
        showToast('No ESP32 ports found. Scan first.', 'warning');
        return;
      }
      
      $('startInstallerBtn').disabled = true;
      installerQueue = [...esp32Ports];
      
      renderInstallerProgress(esp32Ports.map(p => ({ port: p, status: 'waiting' })));
      
      showToast('Starting installer scan for ' + esp32Ports.length + ' port(s)', 'info');
      
      processInstallerQueue();
    }
    
    async function processInstallerQueue() {
      if (installerQueue.length === 0) {
        $('startInstallerBtn').disabled = false;
        showToast('Installer scan complete', 'success');
        return;
      }
      
      const port = installerQueue.shift();
      updateInstallerItemStatus(port, 'scanning');
      
      const startTime = Date.now();
      let found = false;
      
      // Start monitoring this port
      try {
        const r = await fetch('/api/monitor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, baud: 115200, auto_baud: false })
        });
        const d = await r.json();
        
        if (d.ok) {
          ensurePortPanel(port);
          monitoringPorts.add(port);
          
          // Wait for RegisteredInfo or timeout
          await new Promise(resolve => {
            const checkInterval = setInterval(async () => {
              // Check if RegisteredInfo was found
              try {
                const lr = await fetch('/api/install-logs?limit=1');
                const ld = await lr.json();
                if (ld.logs && ld.logs.length > 0) {
                  const latest = ld.logs[0];
                  if (latest.entry && latest.entry.port === port) {
                    found = true;
                    clearInterval(checkInterval);
                    resolve();
                  }
                }
              } catch (e) {}
              
              // Check timeout
              if (Date.now() - startTime > INSTALLER_TIMEOUT) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 1000);
          });
          
          // Stop monitoring
          await fetch('/api/monitor/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port })
          });
          monitoringPorts.delete(port);
        }
      } catch (e) {
        console.error('Installer error:', e);
      }
      
      updateInstallerItemStatus(port, found ? 'success' : 'timeout');
      loadInstallLogs();
      
      // Process next port
      setTimeout(processInstallerQueue, 1000);
    }
    
    function renderInstallerProgress(items) {
      $('installerProgress').innerHTML = items.map(item => {
        const statusClass = item.status;
        const statusIcon = item.status === 'waiting' ? '⏳' : item.status === 'scanning' ? '🔍' : item.status === 'success' ? '✅' : '❌';
        const statusText = item.status === 'waiting' ? 'Waiting' : item.status === 'scanning' ? 'Scanning...' : item.status === 'success' ? 'Found' : 'Timeout';
        return '<div class="installer-progress-item ' + statusClass + '"><span>' + statusIcon + '</span><span style="flex:1;">' + escapeHtml(item.port) + '</span><span>' + statusText + '</span></div>';
      }).join('');
    }
    
    function updateInstallerItemStatus(port, status) {
      const items = Array.from($('installerProgress').querySelectorAll('.installer-progress-item'));
      for (const item of items) {
        if (item.textContent.includes(port.split('/').pop())) {
          item.className = 'installer-progress-item ' + status;
          const statusIcon = status === 'waiting' ? '⏳' : status === 'scanning' ? '🔍' : status === 'success' ? '✅' : '❌';
          const statusText = status === 'waiting' ? 'Waiting' : status === 'scanning' ? 'Scanning...' : status === 'success' ? 'Found' : 'Timeout';
          item.querySelector('span:first-child').textContent = statusIcon;
          item.querySelector('span:last-child').textContent = statusText;
          break;
        }
      }
    }
    
    function stopInstaller() {
      installerQueue = [];
      $('startInstallerBtn').disabled = false;
    }
    
    // ========== SSE Connection ==========
    function connect() {
      if (es) es.close();
      es = new EventSource('/events');
      es.onopen = () => setStatus(true, 'SSE Connected');
      es.onerror = () => setStatus(false, 'SSE Disconnected');
      es.onmessage = ev => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'serial') appendLog(d);
          else if (d.type === 'serial_end') {
            monitoringPorts.delete(d.port);
            setPortStatus(d.port, 'inactive');
            appendLog({ ...d, line: '<Monitor ended: ' + (d.reason || 'unknown') + '>' });
            updatePortControl();
          } else if (d.type === 'install_log') {
            loadInstallLogs();
            showToast('📋 RegisteredInfo detected', 'success');
          }
        } catch (e) {}
      };
    }
    
    function disconnect() {
      if (es) { es.close(); es = null; }
      setStatus(false, 'SSE Stopped');
    }
    
    // ========== Event Listeners ==========
    ['textFilter', 'highlightFilter', 'alertFilter'].forEach(id => {
      $(id).addEventListener('input', () => {
        const v = $(id).value.trim();
        try {
          if (id === 'textFilter') textRegex = v ? new RegExp(v, 'i') : null;
          else if (id === 'highlightFilter') highlightRegex = v ? new RegExp(v, 'gi') : null;
          else alertRegex = v ? new RegExp(v, 'i') : null;
          $(id).classList.remove('error');
        } catch { $(id).classList.add('error'); }
      });
    });
    
    $('modeSelect').onchange = e => setMode(e.target.value);
    $('modeHelpBtn').onclick = showModeHelp;
    $('clearAllBtn').onclick = clearAllLogs;
    $('exportBtn').onclick = exportLogs;
    $('clearAlertsBtn').onclick = () => { $('alertsBody').innerHTML = ''; totalAlerts = 0; updateStats(); };
    $('clearCrashesBtn').onclick = () => { $('crashesBody').innerHTML = ''; totalCrashes = 0; updateStats(); };
    $('scanPortsBtn').onclick = scanPorts;
    $('refreshPortsBtn').onclick = scanPorts;
    $('showOnlyEsp32').onchange = renderPortList;
    $('showUnknownDevices').onchange = renderPortList;
    $('hideErrorPorts').onchange = renderPortList;
    
    // Check for inactive ports every 30 seconds
    setInterval(() => {
      const now = Date.now();
      for (const [port, lastTime] of portLastLogTime.entries()) {
        const portData = portPanels.get(port);
        if (!portData) continue;
        
        const isInactive = (now - lastTime) > INACTIVE_TIMEOUT_MS;
        const badge = portData.panel.querySelector('.port-status');
        if (badge) {
          if (isInactive && monitoringPorts.has(port)) {
            badge.textContent = 'INACTIVE';
            badge.classList.remove('active');
            badge.classList.add('inactive');
          } else if (!isInactive && monitoringPorts.has(port)) {
            badge.textContent = 'ACTIVE';
            badge.classList.remove('inactive');
            badge.classList.add('active');
          }
        }
      }
      updateStats();
    }, 30000);
    $('startAllBtn').onclick = startAllMonitors;
    $('stopAllBtn').onclick = stopAllMonitors;
    $('startPollingBtn').onclick = startPolling;
    $('stopPollingBtn').onclick = stopPolling;
    $('startInstallerBtn').onclick = startInstaller;
    $('installLogHistoryBtn').onclick = showInstallLogHistory;
    $('restartServerBtn').onclick = async () => {
      if (!confirm('Restart server?')) return;
      try {
        await fetch('/api/server/restart', { method: 'POST' });
        showToast('Restarting...', 'info');
        setTimeout(() => location.reload(), 2000);
      } catch (e) { showToast('Failed', 'error'); }
    };
    
    // ========== Initialize ==========
    async function init() {
      connect();
      await scanPorts();
      loadInstallLogs();
      
      // Auto-start disabled - manual start recommended to avoid port conflicts
      // Users should click "Start All ESP32" button when ready
    }
    init();
  </script>
</body>
</html>`;
}
