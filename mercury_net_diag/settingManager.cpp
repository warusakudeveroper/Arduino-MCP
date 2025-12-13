/**
 * settingManager.cpp
 * SPIFFS-based configuration management for aranea device
 */

#include "settingManager.h"
#include <SPIFFS.h>

#define CONFIG_FILE "/config.json"

// Global instance
SettingManager settingMgr;

SettingManager::SettingManager() : initialized(false) {
  setDefaults();
}

void SettingManager::setDefaults() {
  // Default values from original hardcoded settings
  settings.locationName = "unset";
  settings.networkName = "";
  settings.mainSSID = "cluster1";
  settings.mainPass = "ISMS12345@";
  settings.altSSID = "tomikawa-wifi";
  settings.altPass = "tomikawa153855";
  settings.devSSID = "fgop";
  settings.devPass = "tetrad12345@@@";
  settings.checkInterval = 600000;  // 10 minutes default
  settings.endpoints.clear();
}

bool SettingManager::begin() {
  // Mount SPIFFS (format only if mount fails)
  if (!SPIFFS.begin(true)) {  // true = format if mount fails
    Serial.println("[SettingManager] SPIFFS mount failed!");
    return false;
  }
  
  Serial.println("[SettingManager] SPIFFS mounted successfully");
  
  if (isFirstBoot()) {
    Serial.println("[SettingManager] First boot detected, creating default config...");
    setDefaults();
    if (!saveSettings()) {
      Serial.println("[SettingManager] Failed to save default settings!");
      return false;
    }
    Serial.println("[SettingManager] Default config saved.");
  }
  
  if (!loadSettings()) {
    Serial.println("[SettingManager] Failed to load settings, using defaults");
    setDefaults();
  }
  
  initialized = true;
  return true;
}

bool SettingManager::isFirstBoot() {
  return !SPIFFS.exists(CONFIG_FILE);
}

bool SettingManager::loadSettings() {
  File file = SPIFFS.open(CONFIG_FILE, "r");
  if (!file) {
    Serial.println("[SettingManager] Failed to open config file for reading");
    return false;
  }
  
  String json = file.readString();
  file.close();
  
  Serial.println("[SettingManager] Loaded config: " + json);
  return fromJson(json);
}

bool SettingManager::saveSettings() {
  File file = SPIFFS.open(CONFIG_FILE, "w");
  if (!file) {
    Serial.println("[SettingManager] Failed to open config file for writing");
    return false;
  }
  
  String json = toJson();
  file.print(json);
  file.close();
  
  Serial.println("[SettingManager] Config saved: " + json);
  return true;
}

void SettingManager::resetToDefaults() {
  setDefaults();
  saveSettings();
}

// Setters
void SettingManager::setLocationName(const String& value) { settings.locationName = value; }
void SettingManager::setNetworkName(const String& value) { settings.networkName = value; }
void SettingManager::setMainSSID(const String& value) { settings.mainSSID = value; }
void SettingManager::setMainPass(const String& value) { settings.mainPass = value; }
void SettingManager::setAltSSID(const String& value) { settings.altSSID = value; }
void SettingManager::setAltPass(const String& value) { settings.altPass = value; }
void SettingManager::setDevSSID(const String& value) { settings.devSSID = value; }
void SettingManager::setDevPass(const String& value) { settings.devPass = value; }
void SettingManager::setCheckInterval(unsigned long value) { settings.checkInterval = value; }

bool SettingManager::addEndpoint(const String& url) {
  if (settings.endpoints.size() >= MAX_ENDPOINTS) {
    return false;
  }
  settings.endpoints.push_back(url);
  return true;
}

bool SettingManager::removeEndpoint(int index) {
  if (index < 0 || index >= (int)settings.endpoints.size()) {
    return false;
  }
  settings.endpoints.erase(settings.endpoints.begin() + index);
  return true;
}

void SettingManager::clearEndpoints() {
  settings.endpoints.clear();
}

String SettingManager::escapeJson(const String& str) const {
  String out;
  out.reserve(str.length() + 8);
  for (size_t i = 0; i < str.length(); i++) {
    char c = str.charAt(i);
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c;
    }
  }
  return out;
}

String SettingManager::toJson() const {
  String json = "{";
  json += "\"locationName\":\"" + escapeJson(settings.locationName) + "\",";
  json += "\"networkName\":\"" + escapeJson(settings.networkName) + "\",";
  json += "\"mainSSID\":\"" + escapeJson(settings.mainSSID) + "\",";
  json += "\"mainPass\":\"" + escapeJson(settings.mainPass) + "\",";
  json += "\"altSSID\":\"" + escapeJson(settings.altSSID) + "\",";
  json += "\"altPass\":\"" + escapeJson(settings.altPass) + "\",";
  json += "\"devSSID\":\"" + escapeJson(settings.devSSID) + "\",";
  json += "\"devPass\":\"" + escapeJson(settings.devPass) + "\",";
  json += "\"checkInterval\":" + String(settings.checkInterval) + ",";
  json += "\"endpoints\":[";
  for (size_t i = 0; i < settings.endpoints.size(); i++) {
    if (i > 0) json += ",";
    json += "\"" + escapeJson(settings.endpoints[i]) + "\"";
  }
  json += "]}";
  return json;
}

// Simple JSON parser (no external library needed)
bool SettingManager::fromJson(const String& json) {
  // Helper lambda to extract string value
  auto extractString = [&json](const String& key) -> String {
    String searchKey = "\"" + key + "\":\"";
    int start = json.indexOf(searchKey);
    if (start < 0) return "";
    start += searchKey.length();
    int end = start;
    while (end < (int)json.length()) {
      if (json.charAt(end) == '"' && json.charAt(end - 1) != '\\') break;
      end++;
    }
    String value = json.substring(start, end);
    // Unescape
    value.replace("\\\"", "\"");
    value.replace("\\\\", "\\");
    value.replace("\\n", "\n");
    value.replace("\\r", "\r");
    value.replace("\\t", "\t");
    return value;
  };
  
  // Helper lambda to extract number value
  auto extractNumber = [&json](const String& key) -> long {
    String searchKey = "\"" + key + "\":";
    int start = json.indexOf(searchKey);
    if (start < 0) return -1;
    start += searchKey.length();
    int end = start;
    while (end < (int)json.length() && (isdigit(json.charAt(end)) || json.charAt(end) == '-')) {
      end++;
    }
    return json.substring(start, end).toInt();
  };
  
  settings.locationName = extractString("locationName");
  if (settings.locationName.isEmpty()) settings.locationName = "unset";
  
  settings.networkName = extractString("networkName");
  settings.mainSSID = extractString("mainSSID");
  settings.mainPass = extractString("mainPass");
  settings.altSSID = extractString("altSSID");
  settings.altPass = extractString("altPass");
  settings.devSSID = extractString("devSSID");
  settings.devPass = extractString("devPass");
  
  long interval = extractNumber("checkInterval");
  settings.checkInterval = (interval > 0) ? interval : 600000;
  
  // Parse endpoints array
  settings.endpoints.clear();
  int epStart = json.indexOf("\"endpoints\":[");
  if (epStart >= 0) {
    epStart += 13;
    int epEnd = json.indexOf("]", epStart);
    if (epEnd > epStart) {
      String epArray = json.substring(epStart, epEnd);
      int pos = 0;
      while (pos < (int)epArray.length()) {
        int qStart = epArray.indexOf('"', pos);
        if (qStart < 0) break;
        int qEnd = qStart + 1;
        while (qEnd < (int)epArray.length()) {
          if (epArray.charAt(qEnd) == '"' && epArray.charAt(qEnd - 1) != '\\') break;
          qEnd++;
        }
        if (qEnd > qStart + 1) {
          String ep = epArray.substring(qStart + 1, qEnd);
          ep.replace("\\\"", "\"");
          ep.replace("\\\\", "\\");
          if (ep.length() > 0 && settings.endpoints.size() < MAX_ENDPOINTS) {
            settings.endpoints.push_back(ep);
          }
        }
        pos = qEnd + 1;
      }
    }
  }
  
  return true;
}

