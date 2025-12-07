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
      --highlight-bg: #422006;
      --stacktrace-bg: #1c1917;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-dark); color: var(--text); font-size: 14px; }
    header { background: linear-gradient(180deg, #0f1729 0%, #0d1525 100%); border-bottom: 1px solid var(--border); padding: 12px 20px; position: sticky; top: 0; z-index: 100; }
    .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
    .logo { font-size: 18px; font-weight: 700; background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; }
    .status-badge.connected { background: rgba(34, 197, 94, 0.15); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-badge.disconnected { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }
    .status-badge.connected .status-dot { background: var(--success); }
    .status-badge.disconnected .status-dot { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
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
    .port-list { max-height: 150px; overflow-y: auto; }
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
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo">⚡ ESP32 Serial Console</div>
      <div class="status-badge disconnected" id="statusBadge" title="SSEサーバーへの接続状態（ESP32接続とは別）">
        <span class="status-dot"></span>
        <span id="statusText">SSE Connecting...</span>
      </div>
      <div class="stats">
        <div class="stat">Lines: <span class="stat-value" id="totalLines">0</span></div>
        <div class="stat">Alerts: <span class="stat-value" id="totalAlerts">0</span></div>
        <div class="stat">Crashes: <span class="stat-value" id="totalCrashes">0</span></div>
      </div>
      <button class="outline sm" id="restartServerBtn" title="MCPサーバーを再起動" style="margin-left:auto;">🔄 Server Restart</button>
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
      <button class="danger" id="stopStreamBtn" title="SSE停止">⏹ SSE Stop</button>
      <button class="success" id="startStreamBtn" title="SSE開始">▶ SSE Start</button>
    </div>
  </header>

  <main>
    <div class="serial-area">
      <div class="panel" style="margin-bottom: 12px;">
        <div class="panel-header">
          <div class="panel-title">🔌 Active Ports</div>
          <button class="sm outline" id="refreshPortsBtn">↻ Refresh</button>
        </div>
        <div class="port-control" id="portControl">
          <div class="empty-state" style="padding: 20px; width: 100%;"><p>No active monitors</p></div>
        </div>
      </div>
      <div class="serial-grid" id="serialGrid"></div>
    </div>

    <div class="sidebar">
      <div class="panel">
        <div class="panel-header"><div class="panel-title">🎛 Monitor Control</div></div>
        <div class="control-panel">
          <div class="control-section">
            <span class="control-label">Available Ports</span>
            <div class="port-list" id="availablePorts"><div class="empty-state" style="padding:20px;"><p>Click Scan Ports</p></div></div>
            <div class="control-row" style="margin-top:8px;">
              <button class="outline" style="flex:1" id="scanPortsBtn">🔍 Scan Ports</button>
            </div>
          </div>
          <div class="control-section">
            <span class="control-label">Quick Start</span>
            <div class="control-row">
              <select id="baudSelect" style="flex:1"><option value="115200" selected>115200</option><option value="74880">74880</option><option value="9600">9600</option></select>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" id="autoBaudCheck" checked /> Auto</label>
            </div>
            <div class="control-row"><button class="success" style="flex:1" id="startAllBtn">▶ Start All ESP32</button></div>
            <div class="control-row"><button class="danger" style="flex:1" id="stopAllBtn">⏹ Stop All</button></div>
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
    let es=null,textRegex=null,highlightRegex=null,alertRegex=null,totalLines=0,totalAlerts=0,totalCrashes=0;
    const portPanels=new Map(),monitoringPorts=new Set(),allLogs=[],MAX_LOGS=1000;
    const CRASH_PATTERNS=[/Guru Meditation/i,/Backtrace:/i,/rst:0x[0-9a-f]+/i,/Brownout/i,/panic/i];
    const $=id=>document.getElementById(id);
    const statusBadge=$('statusBadge'),statusText=$('statusText');
    
    function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
    function formatTime(d){return d.toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3});}
    function setStatus(c,t){statusBadge.className='status-badge '+(c?'connected':'disconnected');statusText.textContent=t;}
    function showToast(m,t='info'){const toast=document.createElement('div');toast.textContent=m;toast.style.cssText='position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;animation:slideIn 0.3s;background:'+(t==='success'?'#22c55e':t==='error'?'#ef4444':t==='warning'?'#f59e0b':'#3b82f6');document.body.appendChild(toast);setTimeout(()=>{toast.style.opacity='0';setTimeout(()=>toast.remove(),300);},3000);}
    function updateStats(){$('totalLines').textContent=totalLines;$('totalAlerts').textContent=totalAlerts;$('totalCrashes').textContent=totalCrashes;$('alertBadge').textContent=totalAlerts;$('crashBadge').textContent=totalCrashes;}
    
    function ensurePortPanel(port){if(portPanels.has(port))return portPanels.get(port);monitoringPorts.add(port);const panel=document.createElement('div');panel.className='panel port-panel';panel.id='panel-'+CSS.escape(port);panel.innerHTML='<div class="panel-header"><div class="panel-title"><span class="icon">📟</span><span>'+escapeHtml(port)+'</span><span class="badge success pulse">● LIVE</span></div><div class="panel-actions"><button class="sm outline" onclick="clearPortLogs(\\''+escapeHtml(port)+'\\')">🗑</button><button class="sm outline" onclick="restartPortMonitor(\\''+escapeHtml(port)+'\\')">🔄</button><button class="sm danger" onclick="stopPortMonitor(\\''+escapeHtml(port)+'\\')">⏹</button></div></div><div class="panel-body" id="logs-'+CSS.escape(port)+'"></div>';$('serialGrid').appendChild(panel);const body=panel.querySelector('.panel-body');portPanels.set(port,{panel,body,lineCount:0});updatePortControl();return portPanels.get(port);}
    
    function updatePortControl(){const ports=Array.from(portPanels.keys());$('portControl').innerHTML=ports.length===0?'<div class="empty-state" style="padding:20px;width:100%;"><p>No active monitors</p></div>':ports.map(p=>'<div class="port-item active" onclick="document.getElementById(\\'panel-'+CSS.escape(p)+'\\').scrollIntoView({behavior:\\'smooth\\'})"><span style="color:#22c55e;">●</span><span class="port-name">'+escapeHtml(p)+'</span></div>').join('');}
    
    function appendLog(evt){const port=evt.port||'unknown',portData=ensurePortPanel(port),text=evt.line||'',isCrash=CRASH_PATTERNS.some(p=>p.test(text)),isReboot=/rst:0x/i.test(text);if(textRegex&&!textRegex.test(text))return;totalLines++;portData.lineCount++;const div=document.createElement('div');let cn='log-line';if(evt.stream==='stderr')cn+=' stderr';if(isCrash)cn+=' stacktrace';else if(isReboot)cn+=' reboot';else if(highlightRegex&&highlightRegex.test(text))cn+=' highlight';div.className=cn;const sysTime=formatTime(new Date());let content=escapeHtml(text);if(highlightRegex)content=content.replace(highlightRegex,m=>'<span class="highlight-match">'+m+'</span>');div.innerHTML='<span class="log-time">'+sysTime+'</span><span class="log-content">'+content+'</span>';portData.body.appendChild(div);while(portData.body.childElementCount>MAX_LOGS)portData.body.removeChild(portData.body.firstChild);div.scrollIntoView({block:'end'});allLogs.push({time:sysTime,port,text});if(allLogs.length>MAX_LOGS*10)allLogs.splice(0,allLogs.length-MAX_LOGS*10);if(alertRegex&&alertRegex.test(text)){totalAlerts++;const ad=document.createElement('div');ad.className='log-line';ad.innerHTML='<span class="log-time">'+sysTime+'</span><span class="log-content">['+escapeHtml(port)+'] '+escapeHtml(text)+'</span>';$('alertsBody').querySelector('.empty-state')?.remove();$('alertsBody').appendChild(ad);}if(isCrash||isReboot){totalCrashes++;const cd=document.createElement('div');cd.className='log-line '+(isCrash?'stacktrace':'reboot');cd.innerHTML='<span class="log-time">'+sysTime+'</span><span class="log-content">['+escapeHtml(port)+'] '+escapeHtml(text)+'</span>';$('crashesBody').querySelector('.empty-state')?.remove();$('crashesBody').appendChild(cd);}updateStats();}
    
    function clearPortLogs(port){const d=portPanels.get(port);if(d){d.body.innerHTML='';d.lineCount=0;}}
    function clearAllLogs(){for(const[,d]of portPanels){d.body.innerHTML='';d.lineCount=0;}totalLines=0;updateStats();}
    function exportLogs(){const text=allLogs.map(l=>l.time+' ['+l.port+'] '+l.text).join('\\n');const blob=new Blob([text],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='esp32-logs-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt';a.click();}
    
    async function setPortNickname(port,nickname){try{await fetch('/api/port-nicknames',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port,nickname})});showToast('Saved: '+nickname,'success');}catch(e){showToast('Save failed','error');}}
    
    let installLogs=[];
    async function loadInstallLogs(){try{const r=await fetch('/api/install-logs?limit=50');const d=await r.json();installLogs=d.logs||[];renderInstallLogs();}catch(e){}}
    function formatInstallLogEntry(key,entry){const ds=key.slice(0,14),ts=ds.slice(2,4)+'/'+ds.slice(4,6)+'/'+ds.slice(6,8)+' '+ds.slice(8,10)+':'+ds.slice(10,12)+':'+ds.slice(12,14);const id=entry.lacisID||'---',cic=entry.cic||'---',nn=entry.nickname||entry.port?.split('/').pop()||'---';let wifi='';if(entry.mainssid)wifi+='1:'+entry.mainssid;if(entry.altssid)wifi+=(wifi?',':'')+'2:'+entry.altssid;if(entry.devssid)wifi+=(wifi?',':'')+'3:'+entry.devssid;return '<div style="padding:8px;border-bottom:1px solid var(--border);font-size:12px;"><div style="color:var(--text-muted);">'+ts+' <span style="color:var(--accent);">['+escapeHtml(nn)+']</span></div><div style="font-family:monospace;"><span style="color:#22c55e;">'+escapeHtml(id)+'</span> <span style="color:var(--text-muted);">(cic:'+escapeHtml(cic)+')</span></div>'+(wifi?'<div style="color:var(--text-muted);font-size:11px;">wifi:'+escapeHtml(wifi)+'</div>':'')+'</div>';}
    function renderInstallLogs(){$('installLogPanel').innerHTML=installLogs.length===0?'<div class="empty-state" style="padding:20px;"><p>Waiting...</p></div>':installLogs.slice(0,5).map(({key,entry})=>formatInstallLogEntry(key,entry)).join('');}
    function showInstallLogHistory(){const o=document.createElement('div');o.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:2000;';o.onclick=e=>{if(e.target===o)o.remove();};o.innerHTML='<div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;max-width:600px;width:90%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;"><div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;"><span style="font-size:18px;font-weight:600;">📋 Install Log ('+installLogs.length+')</span><button onclick="this.closest(\\'div\\').parentElement.remove()" style="background:none;border:none;color:var(--text-muted);font-size:24px;cursor:pointer;">×</button></div><div style="overflow-y:auto;flex:1;">'+installLogs.map(({key,entry})=>formatInstallLogEntry(key,entry)).join('')+'</div></div>';document.body.appendChild(o);}
    
    async function scanPorts(){const btn=$('scanPortsBtn');btn.disabled=true;btn.textContent='🔄...';try{const r=await fetch('/api/monitors');const md=await r.json();monitoringPorts.clear();if(md.ok&&md.sessions)for(const m of md.sessions)if(m.port)monitoringPorts.add(m.port);}catch(e){}try{const r=await fetch('/api/ports');const d=await r.json();if(d.ports&&d.ports.length>0){$('availablePorts').innerHTML=d.ports.map(p=>{const m=monitoringPorts.has(p.port),nn=p.nickname||'';return '<div class="port-list-item '+(m?'monitoring':'')+'"><div class="port-info" style="flex:1"><div class="port-name" style="display:flex;align-items:center;gap:6px;">'+(m?'🟢':'⚪')+'<input type="text" value="'+escapeHtml(nn)+'" placeholder="'+escapeHtml(p.port.split('/').pop())+'" onchange="setPortNickname(\\''+escapeHtml(p.port)+'\\',this.value)" style="width:80px;padding:2px 4px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text);"><span style="color:var(--text-muted);font-size:10px;">'+escapeHtml(p.port.split('/').pop())+'</span></div><div class="port-detail">'+(p.isEsp32?'✓ ESP32':'')+(m?' <span style="color:#22c55e;">● Monitoring</span>':'')+'</div></div><button class="sm '+(m?'danger':'success')+'" onclick="'+(m?'stopPortMonitor':'startPortMonitor')+'(\\''+escapeHtml(p.port)+'\\')" id="btn-'+CSS.escape(p.port)+'">'+(m?'⏹':'▶')+'</button></div>';}).join('');showToast('Found '+d.ports.length+' port(s)','info');}else{$('availablePorts').innerHTML='<div class="empty-state" style="padding:20px;"><p>No ports found</p></div>';}}catch(e){showToast('Scan failed','error');}finally{btn.disabled=false;btn.textContent='🔍 Scan Ports';}}
    
    async function startPortMonitor(port){const baud=parseInt($('baudSelect').value),auto=$('autoBaudCheck').checked;try{const r=await fetch('/api/monitor/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port,baud,auto_baud:auto})});const d=await r.json();if(d.ok){monitoringPorts.add(port);showToast('✓ Started '+port,'success');}else showToast('✗ '+d.error,'error');}catch(e){showToast('✗ '+e.message,'error');}finally{scanPorts();}}
    async function stopPortMonitor(port){try{await fetch('/api/monitor/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port})});monitoringPorts.delete(port);showToast('⏹ Stopped '+port,'info');}catch(e){showToast('Stop error','error');}finally{scanPorts();}}
    async function restartPortMonitor(port){showToast('🔄 Restarting...','info');await stopPortMonitor(port);await new Promise(r=>setTimeout(r,1000));await startPortMonitor(port);}
    async function startAllMonitors(){const btn=$('startAllBtn');btn.disabled=true;try{const r=await fetch('/api/ports');const d=await r.json();const ports=(d.ports||[]).filter(p=>p.isEsp32);for(const p of ports){await startPortMonitor(p.port);await new Promise(r=>setTimeout(r,500));}showToast('✓ Started '+ports.length+' monitors','success');}catch(e){showToast('Failed','error');}finally{btn.disabled=false;}}
    async function stopAllMonitors(){try{await fetch('/api/monitor/stop-all',{method:'POST'});monitoringPorts.clear();showToast('⏹ All stopped','info');scanPorts();}catch(e){showToast('Failed','error');}}
    
    function connect(){if(es)es.close();es=new EventSource('/events');es.onopen=()=>setStatus(true,'SSE Connected');es.onerror=()=>setStatus(false,'SSE Disconnected');es.onmessage=ev=>{try{const d=JSON.parse(ev.data);if(d.type==='serial')appendLog(d);else if(d.type==='serial_end'){monitoringPorts.delete(d.port);appendLog({...d,line:'<Monitor ended: '+(d.reason||'unknown')+'>'});}else if(d.type==='install_log'){loadInstallLogs();showToast('📋 RegisteredInfo detected','success');}}catch(e){}};}
    function disconnect(){if(es){es.close();es=null;}setStatus(false,'SSE Stopped');}
    
    ['textFilter','highlightFilter','alertFilter'].forEach(id=>{$(id).addEventListener('input',()=>{const v=$(id).value.trim();try{if(id==='textFilter')textRegex=v?new RegExp(v,'i'):null;else if(id==='highlightFilter')highlightRegex=v?new RegExp(v,'gi'):null;else alertRegex=v?new RegExp(v,'i'):null;$(id).classList.remove('error');}catch{$(id).classList.add('error');}});});
    
    $('clearAllBtn').onclick=clearAllLogs;
    $('exportBtn').onclick=exportLogs;
    $('stopStreamBtn').onclick=disconnect;
    $('startStreamBtn').onclick=connect;
    $('clearAlertsBtn').onclick=()=>{$('alertsBody').innerHTML='';totalAlerts=0;updateStats();};
    $('clearCrashesBtn').onclick=()=>{$('crashesBody').innerHTML='';totalCrashes=0;updateStats();};
    $('scanPortsBtn').onclick=scanPorts;
    $('refreshPortsBtn').onclick=scanPorts;
    $('startAllBtn').onclick=startAllMonitors;
    $('stopAllBtn').onclick=stopAllMonitors;
    $('installLogHistoryBtn').onclick=showInstallLogHistory;
    $('restartServerBtn').onclick=async()=>{if(!confirm('Restart server?'))return;try{await fetch('/api/server/restart',{method:'POST'});showToast('Restarting...','info');setTimeout(()=>location.reload(),2000);}catch(e){showToast('Failed','error');}};
    
    connect();scanPorts();loadInstallLogs();
  </script>
</body>
</html>`;
}

