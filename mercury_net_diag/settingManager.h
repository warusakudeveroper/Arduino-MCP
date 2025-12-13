/**
 * settingManager.h
 * SPIFFS-based configuration management for aranea device
 */

#ifndef SETTING_MANAGER_H
#define SETTING_MANAGER_H

#include <Arduino.h>
#include <vector>

// Maximum number of custom endpoints
#define MAX_ENDPOINTS 5

struct DeviceSettings {
  String locationName;
  String networkName;
  String mainSSID;
  String mainPass;
  String altSSID;
  String altPass;
  String devSSID;
  String devPass;
  unsigned long checkInterval;
  std::vector<String> endpoints;
};

class SettingManager {
public:
  SettingManager();
  
  // Initialize SPIFFS and load settings
  bool begin();
  
  // Check if this is first boot (no config exists)
  bool isFirstBoot();
  
  // Load settings from SPIFFS
  bool loadSettings();
  
  // Save settings to SPIFFS
  bool saveSettings();
  
  // Reset to default settings
  void resetToDefaults();
  
  // Getters
  const DeviceSettings& getSettings() const { return settings; }
  String getLocationName() const { return settings.locationName; }
  String getNetworkName() const { return settings.networkName; }
  String getMainSSID() const { return settings.mainSSID; }
  String getMainPass() const { return settings.mainPass; }
  String getAltSSID() const { return settings.altSSID; }
  String getAltPass() const { return settings.altPass; }
  String getDevSSID() const { return settings.devSSID; }
  String getDevPass() const { return settings.devPass; }
  unsigned long getCheckInterval() const { return settings.checkInterval; }
  const std::vector<String>& getEndpoints() const { return settings.endpoints; }
  
  // Setters
  void setLocationName(const String& value);
  void setNetworkName(const String& value);
  void setMainSSID(const String& value);
  void setMainPass(const String& value);
  void setAltSSID(const String& value);
  void setAltPass(const String& value);
  void setDevSSID(const String& value);
  void setDevPass(const String& value);
  void setCheckInterval(unsigned long value);
  
  // Endpoint management
  bool addEndpoint(const String& url);
  bool removeEndpoint(int index);
  void clearEndpoints();
  
  // Generate JSON representation
  String toJson() const;
  
  // Parse JSON and update settings
  bool fromJson(const String& json);

private:
  DeviceSettings settings;
  bool initialized;
  
  void setDefaults();
  String escapeJson(const String& str) const;
};

// Global instance
extern SettingManager settingMgr;

#endif // SETTING_MANAGER_H

