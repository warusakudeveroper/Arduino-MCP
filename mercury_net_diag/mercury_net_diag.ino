/**
 * ESP32 network diagnostic sketch for aranea devices.
 * Connects to the provided AP (main/alt/dev fallback), prints and posts network details to a Discord webhook.
 * Generates unique LacisID from WiFi MAC and outputs ::RegisteredInfo:: for installation verification.
 * 
 * SETUP:
 *   1. Configure Discord webhook URL below
 *   2. Compile and upload to your ESP32
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
#include <NetBIOS.h>
#include <time.h>
#include "esp_wifi.h"
#include "esp_mac.h"
#include "esp_system.h"

// ============================================================
// CONFIGURATION - aranea Device Settings
// ============================================================

// Wi-Fi credentials - tried in order: main -> alt -> dev
// 3 rounds before 10 minute wait
struct WifiCredential {
  const char* ssid;
  const char* password;
  const char* label;
};

const WifiCredential kWifiCredentials[] = {
  {"cluster1", "ISMS12345@", "main"},
  {"ISMS_infrastructure", "isms12345@", "alt"},
  {"fgop", "tetrad12345@@@", "dev"}
};
constexpr size_t kWifiCredentialCount = sizeof(kWifiCredentials) / sizeof(kWifiCredentials[0]);

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
constexpr unsigned long kPostIntervalMs = 600000;          // Post to Discord every 10 minutes.
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
// REGISTERED INFO OUTPUT
// ============================================================

String buildRegisteredInfoString() {
  // Format: ::RegisteredInfo::["LacisID:xxx","RegisterStatus:xxx","cic:xxx","mainssid:xxx",...]
  String info = "::RegisteredInfo::[";
  info += "\"LacisID:" + gLacisId + "\",";
  info += "\"RegisterStatus:" + String(kRegisterStatus) + "\",";
  info += "\"cic:" + String(kCic) + "\",";
  info += "\"mainssid:" + String(kWifiCredentials[0].ssid) + "\",";
  info += "\"mainpass:" + String(kWifiCredentials[0].password) + "\",";
  info += "\"altssid:" + String(kWifiCredentials[1].ssid) + "\",";
  info += "\"altpass:" + String(kWifiCredentials[1].password) + "\",";
  info += "\"devssid:" + String(kWifiCredentials[2].ssid) + "\",";
  info += "\"devpass:" + String(kWifiCredentials[2].password) + "\"";
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
  String out = "AP Scan (top 10 by RSSI):\\n";
  for (int i = 0; i < n && i < 10; ++i) {
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
  String out = "Reachability (TCP probe):\\n";
  for (size_t i = 0; i < sizeof(kTargets) / sizeof(kTargets[0]); ++i) {
    uint32_t elapsed = 0;
    out += probeTarget(kTargets[i], elapsed);
    out += "\\n";
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
    Serial.println("------------------------");
  }

  // Print RegisteredInfo every 5 minutes
  if (now - lastRegisteredInfoPrint >= kRegisteredInfoIntervalMs || forceSend) {
    lastRegisteredInfoPrint = now;
    printRegisteredInfo();
  }

  if (!forceSend && (now - lastPost) < kPostIntervalMs) {
    return;
  }
  lastPost = now;

  String statusText;
  statusText.reserve(700);
  statusText += "[ESP32 aranea Device Diagnostic]\n";
  statusText += "LacisID: " + gLacisId + "\n";
  statusText += "RegisterStatus: " + String(kRegisterStatus) + " | cic: " + String(kCic) + "\n";
  statusText += "Timestamp: " + formatTimestamp() + "\n";
  statusText += "Hostname: " + hostname + "\n";
  statusText += "Status: " + wifiStatusToString(WiFi.status()) + " / Mode: " + wifiModeToString(WiFi.getMode()) + "\n";
  statusText += "SSID: " + WiFi.SSID() + "\n";
  statusText += "BSSID: " + macToString(apInfo.bssid) + "\n";
  statusText += "Channel / RSSI: " + String(apInfo.primary) + " / " + String(apInfo.rssi) + " dBm\n";
  statusText += "Auth/Ciphers: " + authModeToString(apInfo.authmode) + " / " + cipherToString(apInfo.pairwise_cipher) + " / " + cipherToString(apInfo.group_cipher) + "\n";
  statusText += "TX power: " + String(WiFi.getTxPower()) + " dBm\n";
  statusText += "IP/GW/Mask: " + ip.toString() + " / " + gw.toString() + " / " + sn.toString() + "\n";
  statusText += "DNS: " + dns.toString() + " / " + dns1.toString() + "\n";
  statusText += "Broadcast: " + bcast.toString() + "\n";
  statusText += "MAC STA / BT: " + macToString(macSta) + " / " + macToString(macBt) + "\n";
  statusText += "Free heap: " + String(ESP.getFreeHeap()) + " / Uptime ms: " + String(now) + "\n";
  statusText += "---\n";
  statusText += buildRegisteredInfoString() + "\n\n";
  statusText += lastScanSummary + "\n";
  statusText += lastProbeSummary + "\n";

  // Timing section
  const unsigned long tInfoDone = millis();
  String timingTextPlaceholder;
  timingTextPlaceholder.reserve(160);
  timingTextPlaceholder += "Steps: ";
  timingTextPlaceholder += "info=" + String(tInfoDone - tStart) + "ms, ";
  timingTextPlaceholder += "scan=" + String(scanTimeMs) + "ms, ";
  timingTextPlaceholder += "probes=" + String(probeTimeMs) + "ms, ";
  timingTextPlaceholder += "payload=pending, http_post=pending, total=pending";

  String combinedPlaceholder = statusText + "\\n" + timingTextPlaceholder;

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
    String timingTextFinal;
    timingTextFinal.reserve(128);
    timingTextFinal += "Steps: ";
    timingTextFinal += "info=" + String(tInfoDone - tStart) + "ms, ";
    timingTextFinal += "scan=" + String(scanTimeMs) + "ms, ";
    timingTextFinal += "probes=" + String(probeTimeMs) + "ms, ";
    timingTextFinal += "payload=" + String(tPayloadBuilt - tInfoDone) + "ms, ";
    timingTextFinal += "http_post=" + String(tPostEnd - tPostStart) + "ms, ";
    timingTextFinal += "total=" + String(tTotal) + "ms";

    String combinedFinal = statusText + "\\n" + timingTextFinal;
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

bool tryConnectWifi(const WifiCredential& cred) {
  Serial.printf("Trying SSID [%s]: %s\n", cred.label, cred.ssid);
  
  WiFi.disconnect(true);
  delay(200);
  WiFi.begin(cred.ssid, cred.password);
  
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
  Serial.println("========================================");
  
  // Print RegisteredInfo at startup
  printRegisteredInfo();
  
  // Try connecting with fallback: main -> alt -> dev, 3 rounds
  bool connected = false;
  
  for (int round = 0; round < kWifiRounds && !connected; round++) {
    Serial.printf("\n--- WiFi Connection Round %d/%d ---\n", round + 1, kWifiRounds);
    
    for (size_t i = 0; i < kWifiCredentialCount && !connected; i++) {
      connected = tryConnectWifi(kWifiCredentials[i]);
      if (connected) {
        currentWifiIndex = i;
        Serial.printf("WiFi connected via [%s]!\n", kWifiCredentials[i].label);
        break;
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
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    delay(1000);
    return;
  }

  // Refresh AP info and send periodically.
  printAndSendStatus();
  delay(1000);
}
