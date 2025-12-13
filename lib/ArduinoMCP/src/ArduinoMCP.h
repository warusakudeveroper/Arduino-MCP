/**
 * ArduinoMCP - ESP32 Library for Arduino-MCP Integration
 *
 * This library provides HTTP API endpoints for SPIFFS file management
 * and device information, enabling integration with Arduino-MCP tools.
 *
 * Usage:
 *   #include <ArduinoMCP.h>
 *
 *   ArduinoMCP mcp;
 *
 *   void setup() {
 *     // Initialize WiFi first...
 *     mcp.begin();  // Uses existing WebServer on port 80
 *     // or
 *     mcp.begin(8080);  // Creates new WebServer on port 8080
 *   }
 *
 *   void loop() {
 *     mcp.handle();  // Process incoming requests
 *   }
 *
 * API Endpoints provided:
 *   GET  /api/spiffs/list?path=/     - List files in directory
 *   GET  /api/spiffs/read?path=/file - Read file content
 *   POST /api/spiffs/write?path=/file - Write file (body = content)
 *   DELETE /api/spiffs/delete?path=/file - Delete file
 *   GET  /api/spiffs/info            - Get storage info
 *   GET  /api/device/info            - Get device information
 *   POST /api/device/restart         - Restart device
 *
 * @author warusakudeveroper
 * @version 1.0.0
 * @license MIT
 */

#ifndef ARDUINO_MCP_H
#define ARDUINO_MCP_H

#include <Arduino.h>
#include <WebServer.h>
#include <SPIFFS.h>
#include <FS.h>

// Forward declaration
class ArduinoMCP;

/**
 * ArduinoMCP class - Main library class
 *
 * Provides SPIFFS file explorer API and device management endpoints
 * for integration with Arduino-MCP development tools.
 */
class ArduinoMCP {
public:
    /**
     * Constructor
     */
    ArduinoMCP();

    /**
     * Destructor
     */
    ~ArduinoMCP();

    /**
     * Initialize with existing WebServer
     * Call this if you already have a WebServer instance
     *
     * @param server Pointer to existing WebServer
     * @param mountSpiffs Whether to mount SPIFFS (default: true)
     * @return true if initialization successful
     */
    bool begin(WebServer* server, bool mountSpiffs = true);

    /**
     * Initialize with new WebServer on specified port
     * Creates internal WebServer instance
     *
     * @param port HTTP server port (default: 80)
     * @param mountSpiffs Whether to mount SPIFFS (default: true)
     * @return true if initialization successful
     */
    bool begin(uint16_t port = 80, bool mountSpiffs = true);

    /**
     * Handle incoming HTTP requests
     * Call this in loop()
     */
    void handle();

    /**
     * Stop the server and cleanup
     */
    void end();

    /**
     * Check if library is initialized
     * @return true if initialized
     */
    bool isInitialized() const { return _initialized; }

    /**
     * Get pointer to WebServer instance
     * @return WebServer pointer (may be null)
     */
    WebServer* getServer() const { return _server; }

    /**
     * Enable/disable CORS headers
     * @param enabled Whether to add CORS headers (default: true)
     */
    void setCorsEnabled(bool enabled) { _corsEnabled = enabled; }

    /**
     * Set custom device name for /api/device/info
     * @param name Device name string
     */
    void setDeviceName(const char* name) { _deviceName = name; }

    /**
     * Set custom device type for /api/device/info
     * @param type Device type string (e.g., "ESP32-WROOM-32")
     */
    void setDeviceType(const char* type) { _deviceType = type; }

private:
    WebServer* _server;
    bool _ownsServer;      // true if we created the server
    bool _initialized;
    bool _corsEnabled;
    const char* _deviceName;
    const char* _deviceType;

    // Setup all API routes
    void setupRoutes();

    // Add CORS headers to response
    void addCorsHeaders();

    // API Handlers
    void handleSpiffsList();
    void handleSpiffsRead();
    void handleSpiffsWrite();
    void handleSpiffsDelete();
    void handleSpiffsInfo();
    void handleDeviceInfo();
    void handleDeviceRestart();
    void handleOptions();

    // Utility functions
    String getContentType(const String& filename);
    void sendJsonResponse(int code, const String& json);
    void sendJsonError(int code, const String& message);
};

#endif // ARDUINO_MCP_H
