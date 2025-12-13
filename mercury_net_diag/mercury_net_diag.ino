/**
 * ESP32 network diagnostic sketch for aranea devices.
 * Connects to the provided AP (main/alt/dev fallback), prints and posts network details to a Discord webhook.
 * Generates unique LacisID from WiFi MAC and outputs ::RegisteredInfo:: for installation verification.
 * 
 * NEW FEATURES:
 *   - SPIFFS-based settings management
 *   - HTTP server for configuration (smartphone-friendly)
 *   - Enhanced Discord message with ConnectionSummary
 * 
 * SETUP:
 *   1. Configure Discord webhook URL below
 *   2. Compile and upload to your ESP32
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <NetBIOS.h>
#include <SPIFFS.h>
#include <time.h>
#include "esp_wifi.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "settingManager.h"

// ============================================================
// CONFIGURATION - aranea Device Settings
// ============================================================

// aranea Device Registration Info
constexpr char kCic[] = "000000";
constexpr char kRegisterStatus[] = "Registered";

// Discord webhook endpoint.
// Create a webhook in Discord: Server Settings -> Integrations -> Webhooks
constexpr char kWebhookUrl[] = "https://discord.com/api/webhooks/1446680031261622303/6oTaI_D2lBxNVpwFk_p5TfMkPi3SrVXE0l4U7TNWU9FbCNS7DqbG_yBC01ubDGxANlxn";
constexpr char kWebhookUrlWait[] = "https://discord.com/api/webhooks/1446680031261622303/6oTaI_D2lBxNVpwFk_p5TfMkPi3SrVXE0l4U7TNWU9FbCNS7DqbG_yBC01ubDGxANlxn?wait=true";
constexpr char kWebhookId[] = "1446680031261622303";
constexpr char kWebhookToken[] = "6oTaI_D2lBxNVpwFk_p5TfMkPi3SrVXE0l4U7TNWU9FbCNS7DqbG_yBC01ubDGxANlxn";

// Probe targets for reachability testing (customize for your network)
struct ProbeTarget {
  const char *label;
  const char *ip;
};

const ProbeTarget kTargets[] = {
    {"Gateway", "192.168.1.1"},
    {"DNS-Google", "8.8.8.8"},
    {"DNS-Cloudflare", "1.1.1.1"},
};

// ============================================================
// TIMING CONFIGURATION
// ============================================================

constexpr uint8_t kMaxConnectAttempts = 20;
constexpr unsigned long kReconnectDelayMs = 1000;
constexpr unsigned long kRegisteredInfoIntervalMs = 300000; // Print RegisteredInfo every 5 minutes.
constexpr unsigned long kStatusPollMs = 5000;              // Serial print cadence.
constexpr unsigned long kWifiRetryWaitMs = 600000;         // 10 minutes wait after 3 rounds fail.
constexpr uint8_t kWifiRounds = 3;                         // Try each SSID 3 rounds before long wait.

// Ports to scan on probe targets
const int kPortsToScan[] = {80, 443, 22, 53};

// ============================================================
// GLOBAL STATE
// ============================================================

WiFiClientSecure secureClient;
WebServer webServer(80);
unsigned long lastPost = 0;
unsigned long lastStatusPrint = 0;
unsigned long lastRegisteredInfoPrint = 0;
bool timeSynced = false;
String gHostname;
String gLacisId;  // 20-digit unique ID: 0000{MAC(12digit)}0000
String lastScanSummary;
String lastProbeSummary;
int currentWifiIndex = 0;
int wifiRoundCount = 0;
String currentConnectedSSID;
int currentRSSI = 0;

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

String macToHexString(const uint8_t *mac) {
  char buf[13];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

String generateLacisId(const uint8_t *mac) {
  // Format: 0000{MAC(12digit)}0000 = 20 digits total
  char buf[21];
  snprintf(buf, sizeof(buf), "0000%02X%02X%02X%02X%02X%02X0000",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

String makeHostName(const uint8_t *mac) {
  // Use last 3 bytes of MAC to keep hostname short and unique.
  char buf[32];
  snprintf(buf, sizeof(buf), "ESP32NetTest%02X%02X%02X", mac[3], mac[4], mac[5]);
  return String(buf);
}

String jsonEscape(const String &in) {
  String out;
  out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); ++i) {
    char c = in.charAt(i);
    switch (c) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        break;
      default:
        out += c;
    }
  }
  return out;
}

String cipherToString(wifi_cipher_type_t cipher) {
  switch (cipher) {
    case WIFI_CIPHER_TYPE_WEP40:
    case WIFI_CIPHER_TYPE_WEP104:
      return "WEP";
    case WIFI_CIPHER_TYPE_TKIP:
      return "TKIP";
    case WIFI_CIPHER_TYPE_CCMP:
      return "CCMP (AES)";
    case WIFI_CIPHER_TYPE_TKIP_CCMP:
      return "TKIP+CCMP";
    case WIFI_CIPHER_TYPE_AES_CMAC128:
      return "AES-CMAC128";
    case WIFI_CIPHER_TYPE_NONE:
      return "NONE";
    default:
      return "UNKNOWN";
  }
}

String authModeToString(wifi_auth_mode_t auth) {
  switch (auth) {
    case WIFI_AUTH_OPEN:
      return "OPEN";
    case WIFI_AUTH_WEP:
      return "WEP";
    case WIFI_AUTH_WPA_PSK:
      return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK:
      return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK:
      return "WPA/WPA2-PSK";
    case WIFI_AUTH_WPA2_ENTERPRISE:
      return "WPA2-ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK:
      return "WPA3-PSK";
    case WIFI_AUTH_WPA2_WPA3_PSK:
      return "WPA2/WPA3-PSK";
    default:
      return "UNKNOWN";
  }
}

String encTypeToString(uint8_t enc) {
  return authModeToString(static_cast<wifi_auth_mode_t>(enc));
}

String wifiStatusToString(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS:
      return "IDLE";
    case WL_NO_SSID_AVAIL:
      return "NO_SSID";
    case WL_SCAN_COMPLETED:
      return "SCAN_DONE";
    case WL_CONNECTED:
      return "CONNECTED";
    case WL_CONNECT_FAILED:
      return "CONNECT_FAILED";
    case WL_CONNECTION_LOST:
      return "CONNECTION_LOST";
    case WL_DISCONNECTED:
      return "DISCONNECTED";
    default:
      return "UNKNOWN";
  }
}

String wifiModeToString(wifi_mode_t m) {
  switch (m) {
    case WIFI_MODE_NULL:
      return "NULL";
    case WIFI_MODE_STA:
      return "STA";
    case WIFI_MODE_AP:
      return "AP";
    case WIFI_MODE_APSTA:
      return "AP+STA";
    default:
      return "UNKNOWN";
  }
}

bool syncTimeWithNtp() {
  setenv("TZ", "JST-9", 1);  // Japan Standard Time
  tzset();
  configTime(0, 0, "pool.ntp.org", "time.google.com", "ntp.nict.jp");
  for (int i = 0; i < 20; ++i) {
    struct tm timeInfo;
    if (getLocalTime(&timeInfo, 200)) {
      return true;
    }
    delay(200);
  }
  return false;
}

String formatTimestamp() {
  if (!timeSynced) {
    return "not_synced";
  }
  struct tm timeInfo;
  if (!getLocalTime(&timeInfo, 100)) {
    return "not_synced";
  }
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S%z", &timeInfo);
  return String(buf);
}

String extractMessageId(const String &body) {
  int pos = body.indexOf("\"id\":\"");
  if (pos < 0) return "";
  pos += 6;
  int end = body.indexOf('"', pos);
  if (end < 0) return "";
  return body.substring(pos, end);
}

String buildEditUrl(const String &messageId) {
  String url = "https://discord.com/api/webhooks/";
  url += kWebhookId;
  url += "/";
  url += kWebhookToken;
  url += "/messages/";
  url += messageId;
  return url;
}

// ============================================================
// HTTP SERVER - SMARTPHONE-FRIENDLY CONFIGURATION UI
// ============================================================

const char* HTML_HEADER = R"rawliteral(
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>aranea Device Settings</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      min-height: 100vh;
      padding: 16px;
    }
    .container { max-width: 480px; margin: 0 auto; }
    h1 {
      font-size: 1.5rem;
      text-align: center;
      margin-bottom: 20px;
      color: #00d4ff;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .card h2 {
      font-size: 1rem;
      color: #00d4ff;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .form-group { margin-bottom: 12px; }
    label {
      display: block;
      font-size: 0.85rem;
      color: #aaa;
      margin-bottom: 4px;
    }
    input, select {
      width: 100%;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #00d4ff;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: bold;
      cursor: pointer;
      margin-top: 8px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #00d4ff, #0099cc);
      color: #000;
    }
    .btn-danger {
      background: linear-gradient(135deg, #ff4757, #c0392b);
      color: #fff;
    }
    .btn-secondary {
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .status-box {
      background: rgba(0,212,255,0.1);
      border: 1px solid rgba(0,212,255,0.3);
      border-radius: 8px;
      padding: 12px;
      font-size: 0.9rem;
    }
    .status-box p { margin-bottom: 4px; }
    .status-box strong { color: #00d4ff; }
    .endpoint-item {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .endpoint-item input { flex: 1; }
    .endpoint-item button {
      padding: 10px 16px;
      background: #ff4757;
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
    }
    .msg {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 16px;
      text-align: center;
    }
    .msg-success { background: rgba(46,204,113,0.2); border: 1px solid #2ecc71; }
    .msg-error { background: rgba(231,76,60,0.2); border: 1px solid #e74c3c; }
  </style>
</head>
<body>
<div class="container">
)rawliteral";

const char* HTML_FOOTER = R"rawliteral(
</div>
</body>
</html>
)rawliteral";

void handleRoot() {
  wifi_ap_record_t apInfo{};
  esp_wifi_sta_get_ap_info(&apInfo);
  
  String html = HTML_HEADER;
  html += "<h1>🛰️ aranea Device</h1>";
  
  // Status Card
  html += "<div class='card'>";
  html += "<h2>📡 接続状態</h2>";
  html += "<div class='status-box'>";
  html += "<p><strong>Location:</strong> " + settingMgr.getLocationName() + "</p>";
  html += "<p><strong>IP:</strong> " + WiFi.localIP().toString() + "</p>";
  html += "<p><strong>SSID:</strong> " + WiFi.SSID() + "</p>";
  html += "<p><strong>RSSI:</strong> " + String(apInfo.rssi) + " dBm</p>";
  html += "<p><strong>LacisID:</strong> " + gLacisId + "</p>";
  html += "<p><strong>Uptime:</strong> " + String(millis() / 1000) + " sec</p>";
  html += "</div></div>";
  
  // Settings Form
  html += "<form method='POST' action='/save'>";
  
  // Basic Settings
  html += "<div class='card'>";
  html += "<h2>⚙️ 基本設定</h2>";
  html += "<div class='form-group'><label>Location Name</label>";
  html += "<input type='text' name='locationName' value='" + settingMgr.getLocationName() + "'></div>";
  html += "<div class='form-group'><label>Network Name (Omada等)</label>";
  html += "<input type='text' name='networkName' value='" + settingMgr.getNetworkName() + "'></div>";
  html += "<div class='form-group'><label>Check Interval (ms)</label>";
  html += "<input type='number' name='checkInterval' value='" + String(settingMgr.getCheckInterval()) + "'></div>";
  html += "</div>";
  
  // WiFi Settings
  html += "<div class='card'>";
  html += "<h2>📶 WiFi設定</h2>";
  html += "<div class='form-group'><label>Main SSID</label>";
  html += "<input type='text' name='mainSSID' value='" + settingMgr.getMainSSID() + "'></div>";
  html += "<div class='form-group'><label>Main Password</label>";
  html += "<input type='password' name='mainPass' value='" + settingMgr.getMainPass() + "'></div>";
  html += "<div class='form-group'><label>Alt SSID</label>";
  html += "<input type='text' name='altSSID' value='" + settingMgr.getAltSSID() + "'></div>";
  html += "<div class='form-group'><label>Alt Password</label>";
  html += "<input type='password' name='altPass' value='" + settingMgr.getAltPass() + "'></div>";
  html += "<div class='form-group'><label>Dev SSID</label>";
  html += "<input type='text' name='devSSID' value='" + settingMgr.getDevSSID() + "'></div>";
  html += "<div class='form-group'><label>Dev Password</label>";
  html += "<input type='password' name='devPass' value='" + settingMgr.getDevPass() + "'></div>";
  html += "</div>";
  
  // Endpoints
  html += "<div class='card'>";
  html += "<h2>🔗 Endpoints</h2>";
  const auto& endpoints = settingMgr.getEndpoints();
  for (size_t i = 0; i < endpoints.size(); i++) {
    html += "<div class='endpoint-item'>";
    html += "<input type='text' name='endpoint" + String(i) + "' value='" + endpoints[i] + "'>";
    html += "</div>";
  }
  if (endpoints.size() < MAX_ENDPOINTS) {
    html += "<div class='form-group'><label>New Endpoint</label>";
    html += "<input type='text' name='newEndpoint' placeholder='https://example.com'></div>";
  }
  html += "</div>";
  
  // Submit
  html += "<button type='submit' class='btn btn-primary'>💾 設定を保存</button>";
  html += "</form>";
  
  // Reboot button
  html += "<form method='POST' action='/reboot'>";
  html += "<button type='submit' class='btn btn-danger' style='margin-top:16px'>🔄 再起動</button>";
  html += "</form>";
  
  // Reset button
  html += "<form method='POST' action='/reset' onsubmit=\"return confirm('設定をリセットしますか？');\">";
  html += "<button type='submit' class='btn btn-secondary' style='margin-top:8px'>⚠️ 設定リセット</button>";
  html += "</form>";
  
  html += HTML_FOOTER;
  webServer.send(200, "text/html", html);
}

void handleSave() {
  Serial.println("[WebServer] Save request received");

  if (webServer.hasArg("locationName")) settingMgr.setLocationName(webServer.arg("locationName"));
  if (webServer.hasArg("networkName")) settingMgr.setNetworkName(webServer.arg("networkName"));
  if (webServer.hasArg("mainSSID")) settingMgr.setMainSSID(webServer.arg("mainSSID"));
  if (webServer.hasArg("mainPass")) settingMgr.setMainPass(webServer.arg("mainPass"));
  if (webServer.hasArg("altSSID")) settingMgr.setAltSSID(webServer.arg("altSSID"));
  if (webServer.hasArg("altPass")) settingMgr.setAltPass(webServer.arg("altPass"));
  if (webServer.hasArg("devSSID")) settingMgr.setDevSSID(webServer.arg("devSSID"));
  if (webServer.hasArg("devPass")) settingMgr.setDevPass(webServer.arg("devPass"));
  if (webServer.hasArg("checkInterval")) {
    settingMgr.setCheckInterval(webServer.arg("checkInterval").toInt());
  }

  // Update existing endpoints
  settingMgr.clearEndpoints();
  for (int i = 0; i < MAX_ENDPOINTS; i++) {
    String key = "endpoint" + String(i);
    if (webServer.hasArg(key) && webServer.arg(key).length() > 0) {
      settingMgr.addEndpoint(webServer.arg(key));
    }
  }

  // Add new endpoint
  if (webServer.hasArg("newEndpoint") && webServer.arg("newEndpoint").length() > 0) {
    settingMgr.addEndpoint(webServer.arg("newEndpoint"));
  }

  bool saveSuccess = settingMgr.saveSettings();
  Serial.printf("[WebServer] Save result: %s\n", saveSuccess ? "SUCCESS" : "FAILED");

  String html = HTML_HEADER;
  html += "<h1>aranea Device</h1>";
  if (saveSuccess) {
    html += "<div class='msg msg-success'>設定を保存しました</div>";
    html += "<p style='text-align:center;color:#aaa;margin:12px 0;'>Location: " + settingMgr.getLocationName() + "</p>";
  } else {
    html += "<div class='msg msg-error'>保存に失敗しました</div>";
    html += "<p style='text-align:center;color:#e74c3c;'>SPIFFSへの書き込みエラー</p>";
  }
  html += "<a href='/' class='btn btn-primary' style='margin-top:16px'>戻る</a>";
  html += "<script>setTimeout(function(){window.location='/';},3000);</script>";
  html += HTML_FOOTER;
  webServer.send(200, "text/html", html);
}

void handleReboot() {
  Serial.println("[WebServer] Reboot request received");

  String html = HTML_HEADER;
  html += "<h1>aranea Device</h1>";
  html += "<div class='msg msg-success'>再起動中...</div>";
  html += "<p id='countdown' style='text-align:center;margin-top:20px;font-size:1.2rem;'>10秒後に自動リダイレクト</p>";
  html += "<div style='text-align:center;margin-top:16px;'>";
  html += "<div style='width:200px;height:8px;background:#333;border-radius:4px;margin:0 auto;overflow:hidden;'>";
  html += "<div id='progress' style='width:0%;height:100%;background:linear-gradient(90deg,#00d4ff,#0099cc);transition:width 0.5s;'></div>";
  html += "</div></div>";
  html += "<script>";
  html += "var t=10;var p=document.getElementById('progress');var c=document.getElementById('countdown');";
  html += "setInterval(function(){t--;p.style.width=((10-t)*10)+'%';";
  html += "c.textContent=t+'秒後に自動リダイレクト';";
  html += "if(t<=0){window.location='/';}},1000);";
  html += "</script>";
  html += HTML_FOOTER;
  webServer.send(200, "text/html", html);
  delay(500);
  Serial.println("[WebServer] Rebooting now...");
  ESP.restart();
}

void handleReset() {
  Serial.println("[WebServer] Reset request received");

  settingMgr.resetToDefaults();
  bool resetSuccess = settingMgr.saveSettings();
  Serial.printf("[WebServer] Reset result: %s\n", resetSuccess ? "SUCCESS" : "FAILED");

  String html = HTML_HEADER;
  html += "<h1>aranea Device</h1>";
  if (resetSuccess) {
    html += "<div class='msg msg-success'>設定をリセットしました</div>";
    html += "<p style='text-align:center;color:#aaa;margin:12px 0;'>デフォルト設定に戻りました</p>";
  } else {
    html += "<div class='msg msg-error'>リセットに失敗しました</div>";
    html += "<p style='text-align:center;color:#e74c3c;'>SPIFFSへの書き込みエラー</p>";
  }
  html += "<a href='/' class='btn btn-primary' style='margin-top:16px'>戻る</a>";
  html += "<script>setTimeout(function(){window.location='/';},3000);</script>";
  html += HTML_FOOTER;
  webServer.send(200, "text/html", html);
}

void handleApi() {
  webServer.send(200, "application/json", settingMgr.toJson());
}

// ============================================================
// SPIFFS FILE API
// ============================================================

void handleSpiffsList() {
  Serial.println("[SPIFFS API] List request");

  String json = "{\"success\":true,\"files\":[";
  File root = SPIFFS.open("/");
  if (!root || !root.isDirectory()) {
    webServer.send(500, "application/json", "{\"success\":false,\"error\":\"Failed to open root\"}");
    return;
  }

  bool first = true;
  File file = root.openNextFile();
  while (file) {
    if (!first) json += ",";
    json += "{\"name\":\"" + String(file.name()) + "\",";
    json += "\"size\":" + String(file.size()) + ",";
    json += "\"isDir\":" + String(file.isDirectory() ? "true" : "false") + "}";
    first = false;
    file = root.openNextFile();
  }
  json += "]}";

  webServer.send(200, "application/json", json);
}

void handleSpiffsRead() {
  if (!webServer.hasArg("path")) {
    webServer.send(400, "application/json", "{\"success\":false,\"error\":\"Missing path parameter\"}");
    return;
  }

  String path = webServer.arg("path");
  if (!path.startsWith("/")) path = "/" + path;

  Serial.printf("[SPIFFS API] Read request: %s\n", path.c_str());

  if (!SPIFFS.exists(path)) {
    webServer.send(404, "application/json", "{\"success\":false,\"error\":\"File not found\"}");
    return;
  }

  File file = SPIFFS.open(path, "r");
  if (!file) {
    webServer.send(500, "application/json", "{\"success\":false,\"error\":\"Failed to open file\"}");
    return;
  }

  String content = file.readString();
  file.close();

  // Return as JSON with base64 or raw text
  String json = "{\"success\":true,\"path\":\"" + path + "\",";
  json += "\"size\":" + String(content.length()) + ",";
  json += "\"content\":\"" + jsonEscape(content) + "\"}";

  webServer.send(200, "application/json", json);
}

void handleSpiffsWrite() {
  if (!webServer.hasArg("path") || !webServer.hasArg("content")) {
    webServer.send(400, "application/json", "{\"success\":false,\"error\":\"Missing path or content parameter\"}");
    return;
  }

  String path = webServer.arg("path");
  String content = webServer.arg("content");
  if (!path.startsWith("/")) path = "/" + path;

  Serial.printf("[SPIFFS API] Write request: %s (%d bytes)\n", path.c_str(), content.length());

  File file = SPIFFS.open(path, "w");
  if (!file) {
    webServer.send(500, "application/json", "{\"success\":false,\"error\":\"Failed to create file\"}");
    return;
  }

  size_t written = file.print(content);
  file.close();

  String json = "{\"success\":true,\"path\":\"" + path + "\",\"written\":" + String(written) + "}";
  webServer.send(200, "application/json", json);
  Serial.printf("[SPIFFS API] Write complete: %d bytes\n", written);
}

void handleSpiffsDelete() {
  if (!webServer.hasArg("path")) {
    webServer.send(400, "application/json", "{\"success\":false,\"error\":\"Missing path parameter\"}");
    return;
  }

  String path = webServer.arg("path");
  if (!path.startsWith("/")) path = "/" + path;

  Serial.printf("[SPIFFS API] Delete request: %s\n", path.c_str());

  if (!SPIFFS.exists(path)) {
    webServer.send(404, "application/json", "{\"success\":false,\"error\":\"File not found\"}");
    return;
  }

  bool success = SPIFFS.remove(path);
  if (success) {
    webServer.send(200, "application/json", "{\"success\":true,\"deleted\":\"" + path + "\"}");
    Serial.printf("[SPIFFS API] Deleted: %s\n", path.c_str());
  } else {
    webServer.send(500, "application/json", "{\"success\":false,\"error\":\"Failed to delete file\"}");
  }
}

void handleSpiffsInfo() {
  Serial.println("[SPIFFS API] Info request");

  size_t totalBytes = SPIFFS.totalBytes();
  size_t usedBytes = SPIFFS.usedBytes();
  size_t freeBytes = totalBytes - usedBytes;

  String json = "{\"success\":true,";
  json += "\"totalBytes\":" + String(totalBytes) + ",";
  json += "\"usedBytes\":" + String(usedBytes) + ",";
  json += "\"freeBytes\":" + String(freeBytes) + ",";
  json += "\"usedPercent\":" + String((float)usedBytes / totalBytes * 100, 1) + "}";

  webServer.send(200, "application/json", json);
}

void handleSpiffsFormat() {
  // Require confirmation parameter for safety
  if (!webServer.hasArg("confirm") || webServer.arg("confirm") != "yes") {
    webServer.send(400, "application/json", "{\"success\":false,\"error\":\"Add confirm=yes parameter to format\"}");
    return;
  }

  Serial.println("[SPIFFS API] Format request - FORMATTING...");

  bool success = SPIFFS.format();
  if (success) {
    // Recreate default config after format
    settingMgr.resetToDefaults();
    webServer.send(200, "application/json", "{\"success\":true,\"message\":\"SPIFFS formatted, defaults restored\"}");
    Serial.println("[SPIFFS API] Format complete, defaults restored");
  } else {
    webServer.send(500, "application/json", "{\"success\":false,\"error\":\"Format failed\"}");
  }
}

void setupWebServer() {
  webServer.on("/", HTTP_GET, handleRoot);
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.on("/reboot", HTTP_POST, handleReboot);
  webServer.on("/reset", HTTP_POST, handleReset);
  webServer.on("/api/settings", HTTP_GET, handleApi);

  // SPIFFS File API
  webServer.on("/api/spiffs/list", HTTP_GET, handleSpiffsList);
  webServer.on("/api/spiffs/read", HTTP_GET, handleSpiffsRead);
  webServer.on("/api/spiffs/write", HTTP_POST, handleSpiffsWrite);
  webServer.on("/api/spiffs/delete", HTTP_POST, handleSpiffsDelete);
  webServer.on("/api/spiffs/info", HTTP_GET, handleSpiffsInfo);
  webServer.on("/api/spiffs/format", HTTP_POST, handleSpiffsFormat);

  webServer.begin();
  Serial.println("[WebServer] HTTP server started on port 80");
  Serial.println("[WebServer] SPIFFS API endpoints registered");
}

// ============================================================
// REGISTERED INFO OUTPUT
// ============================================================

String buildRegisteredInfoString() {
  // Format: ::RegisteredInfo::["LacisID:xxx","RegisterStatus:xxx","cic:xxx","mainssid:xxx",...]
  String info = "::RegisteredInfo::[";
  info += "\"LacisID:" + gLacisId + "\",";
  info += "\"RegisterStatus:" + String(kRegisterStatus) + "\",";
  info += "\"cic:" + String(kCic) + "\",";
  info += "\"mainssid:" + settingMgr.getMainSSID() + "\",";
  info += "\"mainpass:" + settingMgr.getMainPass() + "\",";
  info += "\"altssid:" + settingMgr.getAltSSID() + "\",";
  info += "\"altpass:" + settingMgr.getAltPass() + "\",";
  info += "\"devssid:" + settingMgr.getDevSSID() + "\",";
  info += "\"devpass:" + settingMgr.getDevPass() + "\"";
  info += "]";
  return info;
}

void printRegisteredInfo() {
  Serial.println(buildRegisteredInfoString());
}

// ============================================================
// NETWORK DIAGNOSTICS
// ============================================================

String buildScanSummary(const String &currentSsid, const uint8_t *currentBssid, uint32_t &scanTimeMs) {
  const unsigned long tScanStart = millis();
  int16_t n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);
  const unsigned long tScanEnd = millis();
  scanTimeMs = tScanEnd - tScanStart;
  if (n <= 0) {
    return "AP Scan: no networks found";
  }

  // WiFi.scanNetworks returns sorted by RSSI desc on ESP32.
  String out = "AP Scan (top 5):\n";
  for (int i = 0; i < n && i < 5; ++i) {
    String ssid = WiFi.SSID(i);
    String bssidStr = macToString(WiFi.BSSID(i));
    bool isCurrent = (ssid == currentSsid) && (bssidStr == macToString(currentBssid));
    int32_t rssi = WiFi.RSSI(i);
    uint8_t enc = WiFi.encryptionType(i);
    int32_t chan = WiFi.channel(i);
    out += "- ";
    if (isCurrent) out += "[CONNECTED] ";
    out += ssid;
    out += " (ch";
    out += chan;
    out += ", ";
    out += rssi;
    out += " dBm, ";
    out += encTypeToString(enc);
    out += ")\n";
  }
  return out;
}

String probeTarget(const ProbeTarget &t, uint32_t &elapsedMs) {
  const unsigned long tStart = millis();
  // "Ping" via TCP connect to port 80 to approximate reachability.
  WiFiClient client;
  bool pingOk = false;
  unsigned long pingTime = 0;
  const unsigned long tPingStart = millis();
  if (client.connect(t.ip, 80, 800)) {
    pingOk = true;
    pingTime = millis() - tPingStart;
    client.stop();
  } else {
    pingTime = millis() - tPingStart;
  }

  String result = "- ";
  result += t.label;
  result += " (";
  result += t.ip;
  result += "): ";
  result += pingOk ? "ping ok " : "ping fail ";
  result += String(pingTime);
  result += "ms; ports: ";

  bool first = true;
  for (int port : kPortsToScan) {
    WiFiClient pc;
    bool open = pc.connect(t.ip, port, 500);
    pc.stop();
    if (!first) result += ", ";
    result += String(port);
    result += open ? "=open" : "=closed";
    first = false;
  }

  elapsedMs = millis() - tStart;
  result += " (elapsed ";
  result += elapsedMs;
  result += "ms)";
  return result;
}

String buildProbeSummary(uint32_t &probeTimeMs) {
  const unsigned long tStart = millis();
  String out = "Reachability (TCP probe):\n";
  for (size_t i = 0; i < sizeof(kTargets) / sizeof(kTargets[0]); ++i) {
    uint32_t elapsed = 0;
    out += probeTarget(kTargets[i], elapsed);
    out += "\n";
  }
  probeTimeMs = millis() - tStart;
  return out;
}

void printAndSendStatus(bool forceSend = false) {
  const unsigned long tStart = millis();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected; skipping status post.");
    return;
  }

  wifi_ap_record_t apInfo{};
  esp_wifi_sta_get_ap_info(&apInfo);
  currentConnectedSSID = WiFi.SSID();
  currentRSSI = apInfo.rssi;

  uint8_t macSta[6];
  esp_efuse_mac_get_default(macSta);  // Wi-Fi/Bluetooth base MAC.
  uint8_t macBt[6];
  esp_read_mac(macBt, ESP_MAC_BT);

  IPAddress ip = WiFi.localIP();
  IPAddress gw = WiFi.gatewayIP();
  IPAddress sn = WiFi.subnetMask();
  IPAddress dns = WiFi.dnsIP();
  IPAddress bcast = WiFi.broadcastIP();
  IPAddress dns1 = WiFi.dnsIP(1);
  String hostname = WiFi.getHostname() ? WiFi.getHostname() : "";

  // AP scan + probe targets (timed)
  uint32_t scanTimeMs = 0;
  uint32_t probeTimeMs = 0;
  lastScanSummary = buildScanSummary(WiFi.SSID(), apInfo.bssid, scanTimeMs);
  lastProbeSummary = buildProbeSummary(probeTimeMs);

  unsigned long now = millis();
  if (now - lastStatusPrint >= kStatusPollMs || forceSend) {
    lastStatusPrint = now;
    Serial.println("---- Network Status ----");
    Serial.printf("Timestamp: %s\n", formatTimestamp().c_str());
    Serial.printf("LacisID: %s\n", gLacisId.c_str());
    Serial.printf("Location: %s\n", settingMgr.getLocationName().c_str());
    Serial.printf("Hostname: %s\n", hostname.c_str());
    Serial.printf("Status: %s\n", wifiStatusToString(WiFi.status()).c_str());
    Serial.printf("Mode: %s\n", wifiModeToString(WiFi.getMode()).c_str());
    Serial.printf("SSID: %s\n", WiFi.SSID().c_str());
    Serial.printf("BSSID: %s\n", macToString(apInfo.bssid).c_str());
    Serial.printf("Channel: %d\n", apInfo.primary);
    Serial.printf("RSSI: %d dBm\n", apInfo.rssi);
    Serial.printf("Auth: %s\n", authModeToString(apInfo.authmode).c_str());
    Serial.printf("Pairwise cipher: %s\n", cipherToString(apInfo.pairwise_cipher).c_str());
    Serial.printf("Group cipher: %s\n", cipherToString(apInfo.group_cipher).c_str());
    Serial.printf("TX power: %d dBm\n", WiFi.getTxPower());
    Serial.printf("IP: %s\n", ip.toString().c_str());
    Serial.printf("Gateway: %s\n", gw.toString().c_str());
    Serial.printf("Subnet: %s\n", sn.toString().c_str());
    Serial.printf("DNS0: %s\n", dns.toString().c_str());
    Serial.printf("DNS1: %s\n", dns1.toString().c_str());
    Serial.printf("Broadcast: %s\n", bcast.toString().c_str());
    Serial.printf("MAC (WiFi STA): %s\n", macToString(macSta).c_str());
    Serial.printf("MAC (BT): %s\n", macToString(macBt).c_str());
    Serial.printf("Free heap: %u\n", ESP.getFreeHeap());
    Serial.printf("Uptime ms: %lu\n", now);
    Serial.printf("SettingURL: http://%s/\n", ip.toString().c_str());
    Serial.println("------------------------");
  }

  // Print RegisteredInfo every 5 minutes
  if (now - lastRegisteredInfoPrint >= kRegisteredInfoIntervalMs || forceSend) {
    lastRegisteredInfoPrint = now;
    printRegisteredInfo();
  }

  // Use checkInterval from settings
  unsigned long postInterval = settingMgr.getCheckInterval();
  if (!forceSend && (now - lastPost) < postInterval) {
    return;
  }
  lastPost = now;

  // Build status text with ConnectionSummary at the top
  // 仕様書通りのフォーマット (Discord 2000文字制限に注意)
  String statusText;
  statusText.reserve(2000);
  
  // ConnectionSummary (ぱっと見でわかるサマリー)
  statusText += "# ConnectionSummary\n";
  statusText += "**Location:" + settingMgr.getLocationName() + "**\n";
  statusText += "**IP:" + ip.toString() + "**\n";
  statusText += "**" + WiFi.SSID() + "/rssi:" + String(apInfo.rssi) + "**\n";
  statusText += "SettingURL: http://" + ip.toString() + "/\n\n";
  
  // Detail (詳細情報)
  statusText += "# Detail\n---\n";
  statusText += "LacisID: " + gLacisId + "\n";
  statusText += "Timestamp: " + formatTimestamp() + "\n";
  statusText += "Hostname: " + hostname + "\n";
  statusText += "BSSID: " + macToString(apInfo.bssid) + " / Ch:" + String(apInfo.primary) + "\n";
  statusText += "Auth: " + authModeToString(apInfo.authmode) + "\n";
  statusText += "IP/GW: " + ip.toString() + " / " + gw.toString() + "\n";
  statusText += "Subnet: " + sn.toString() + " / DNS: " + dns.toString() + "\n";
  statusText += "MAC: " + macToString(macSta) + "\n";
  statusText += "Heap: " + String(ESP.getFreeHeap()) + " / Up: " + String(now/1000) + "s\n";
  statusText += "\n";
  
  // AP Scan Summary (トップ5に制限)
  statusText += lastScanSummary + "\n";
  
  // Reachability Probe Summary
  statusText += lastProbeSummary;

  // Timing section
  const unsigned long tInfoDone = millis();
  statusText += "--- Timing ---\n";
  statusText += "Scan:" + String(scanTimeMs) + "ms Probe:" + String(probeTimeMs) + "ms\n";
  
  String combinedPlaceholder = statusText;

  String payload = "{";
  payload += "\"username\":\"ESP32 aranea Device\",";
  payload += "\"content\":\"" + jsonEscape(combinedPlaceholder) + "\",";
  payload += "\"allowed_mentions\":{\"parse\":[]}";
  payload += "}";
  const unsigned long tPayloadBuilt = millis();

  secureClient.setInsecure();  // Discord uses valid certs; skip validation for brevity.

  HTTPClient http;
  if (http.begin(secureClient, kWebhookUrlWait)) {
    http.addHeader("Content-Type", "application/json");
    const unsigned long tPostStart = millis();
    int code = http.POST(payload);
    const unsigned long tPostEnd = millis();
    const unsigned long tTotal = tPostEnd - tStart;

    String resp = http.getString();
    Serial.printf("Webhook POST response code: %d\n", code);
    Serial.printf("Webhook response body: %s\n", resp.c_str());
    String messageId = extractMessageId(resp);
    http.end();

    // Build final message with real timings.
    String combinedFinal = statusText + "---\nPost: " + String(tTotal) + "ms";
    String finalPayload = "{";
    finalPayload += "\"username\":\"ESP32 aranea Device\",";
    finalPayload += "\"content\":\"" + jsonEscape(combinedFinal) + "\",";
    finalPayload += "\"allowed_mentions\":{\"parse\":[]}";
    finalPayload += "}";

    if (messageId.length() > 0 && http.begin(secureClient, buildEditUrl(messageId))) {
      http.addHeader("Content-Type", "application/json");
      code = http.PATCH(finalPayload);
      String resp2 = http.getString();
      Serial.printf("Webhook PATCH response code: %d\n", code);
      Serial.printf("Webhook PATCH body: %s\n", resp2.c_str());
      http.end();
    } else {
      // Fallback: post a second message with final timings.
      if (http.begin(secureClient, kWebhookUrl)) {
        http.addHeader("Content-Type", "application/json");
        code = http.POST(finalPayload);
        String resp2 = http.getString();
        Serial.printf("Webhook POST (fallback) code: %d\n", code);
        Serial.printf("Webhook POST (fallback) body: %s\n", resp2.c_str());
        http.end();
      }
    }
  } else {
    Serial.println("Failed to begin HTTP connection to webhook.");
  }
}

// ============================================================
// WIFI CONNECTION WITH FALLBACK
// ============================================================

bool tryConnectWifi(const String& ssid, const String& password, const String& label) {
  Serial.printf("Trying SSID [%s]: %s\n", label.c_str(), ssid.c_str());
  
  WiFi.disconnect(true);
  delay(200);
  WiFi.begin(ssid.c_str(), password.c_str());
  
  uint8_t attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < kMaxConnectAttempts) {
    attempts++;
    Serial.printf("  Attempt %u/%u; status=%d\n", attempts, kMaxConnectAttempts, WiFi.status());
    delay(kReconnectDelayMs);
  }
  
  return WiFi.status() == WL_CONNECTED;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(200);

  // Generate LacisID from MAC
  uint8_t macSta[6];
  esp_efuse_mac_get_default(macSta);
  gLacisId = generateLacisId(macSta);
  gHostname = makeHostName(macSta);
  WiFi.setHostname(gHostname.c_str());
  
  Serial.println("========================================");
  Serial.println("ESP32 aranea Device starting...");
  Serial.printf("LacisID: %s\n", gLacisId.c_str());
  Serial.printf("Hostname: %s\n", gHostname.c_str());
  Serial.printf("Location: %s\n", settingMgr.getLocationName().c_str());
  Serial.println("========================================");
  
  // Print RegisteredInfo at startup
  printRegisteredInfo();
  
  // WiFi credentials from settings
  struct WifiCred {
    String ssid;
    String pass;
    String label;
  };
  
  WifiCred creds[3] = {
    {settingMgr.getMainSSID(), settingMgr.getMainPass(), "main"},
    {settingMgr.getAltSSID(), settingMgr.getAltPass(), "alt"},
    {settingMgr.getDevSSID(), settingMgr.getDevPass(), "dev"}
  };
  
  // Try connecting with fallback: main -> alt -> dev, 3 rounds
  bool connected = false;
  
  for (int round = 0; round < kWifiRounds && !connected; round++) {
    Serial.printf("\n--- WiFi Connection Round %d/%d ---\n", round + 1, kWifiRounds);
    
    for (int i = 0; i < 3 && !connected; i++) {
      if (creds[i].ssid.length() > 0) {
        connected = tryConnectWifi(creds[i].ssid, creds[i].pass, creds[i].label);
        if (connected) {
          currentWifiIndex = i;
          Serial.printf("WiFi connected via [%s]!\n", creds[i].label.c_str());
          break;
        }
      }
    }
  }
  
  if (!connected) {
    Serial.println("All WiFi attempts failed. Waiting 10 minutes before retry...");
    // Print RegisteredInfo even on failure
    printRegisteredInfo();
    delay(kWifiRetryWaitMs);
    return;
  }

  // Successfully connected
  if (!MDNS.begin(gHostname.c_str())) {
    Serial.println("mDNS start failed");
  } else {
    MDNS.addService("http", "tcp", 80);
  }
  NBNS.begin(gHostname.c_str());

  // Start HTTP server
  setupWebServer();

  // NTP sync once per connect.
  timeSynced = syncTimeWithNtp();

  // Print RegisteredInfo and send status
  printRegisteredInfo();
  printAndSendStatus(true);
}

// ============================================================
// SETUP AND LOOP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);
  
  // Initialize SPIFFS and load settings
  if (!settingMgr.begin()) {
    Serial.println("Settings initialization failed!");
    // Continue anyway with defaults
  }
  
  connectWifi();
}

void loop() {
  // Handle HTTP requests
  webServer.handleClient();
  
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    delay(1000);
    return;
  }

  // Refresh AP info and send periodically.
  printAndSendStatus();
  delay(1000);
}
