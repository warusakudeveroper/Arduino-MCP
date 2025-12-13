/**
 * ArduinoMCP - ESP32 Library for Arduino-MCP Integration
 * Implementation file
 *
 * @author warusakudeveroper
 * @version 1.0.0
 * @license MIT
 */

#include "ArduinoMCP.h"

// Constructor
ArduinoMCP::ArduinoMCP()
    : _server(nullptr)
    , _ownsServer(false)
    , _initialized(false)
    , _corsEnabled(true)
    , _deviceName("ESP32 Device")
    , _deviceType("ESP32")
{
}

// Destructor
ArduinoMCP::~ArduinoMCP() {
    end();
}

// Initialize with existing WebServer
bool ArduinoMCP::begin(WebServer* server, bool mountSpiffs) {
    if (_initialized) {
        return true;
    }

    if (server == nullptr) {
        Serial.println("[ArduinoMCP] Error: WebServer pointer is null");
        return false;
    }

    _server = server;
    _ownsServer = false;

    // Mount SPIFFS if requested
    if (mountSpiffs) {
        if (!SPIFFS.begin(true)) {
            Serial.println("[ArduinoMCP] Error: Failed to mount SPIFFS");
            return false;
        }
        Serial.println("[ArduinoMCP] SPIFFS mounted");
    }

    setupRoutes();
    _initialized = true;
    Serial.println("[ArduinoMCP] Initialized with external WebServer");
    return true;
}

// Initialize with new WebServer
bool ArduinoMCP::begin(uint16_t port, bool mountSpiffs) {
    if (_initialized) {
        return true;
    }

    // Mount SPIFFS if requested
    if (mountSpiffs) {
        if (!SPIFFS.begin(true)) {
            Serial.println("[ArduinoMCP] Error: Failed to mount SPIFFS");
            return false;
        }
        Serial.println("[ArduinoMCP] SPIFFS mounted");
    }

    // Create new WebServer
    _server = new WebServer(port);
    _ownsServer = true;

    setupRoutes();
    _server->begin();

    _initialized = true;
    Serial.printf("[ArduinoMCP] Initialized on port %d\n", port);
    return true;
}

// Handle incoming requests
void ArduinoMCP::handle() {
    if (_initialized && _server != nullptr) {
        _server->handleClient();
    }
}

// Stop and cleanup
void ArduinoMCP::end() {
    if (_ownsServer && _server != nullptr) {
        _server->stop();
        delete _server;
    }
    _server = nullptr;
    _ownsServer = false;
    _initialized = false;
}

// Setup API routes
void ArduinoMCP::setupRoutes() {
    if (_server == nullptr) return;

    // SPIFFS API endpoints
    _server->on("/api/spiffs/list", HTTP_GET, [this]() { handleSpiffsList(); });
    _server->on("/api/spiffs/read", HTTP_GET, [this]() { handleSpiffsRead(); });
    _server->on("/api/spiffs/write", HTTP_POST, [this]() { handleSpiffsWrite(); });
    _server->on("/api/spiffs/delete", HTTP_DELETE, [this]() { handleSpiffsDelete(); });
    _server->on("/api/spiffs/info", HTTP_GET, [this]() { handleSpiffsInfo(); });

    // Device API endpoints
    _server->on("/api/device/info", HTTP_GET, [this]() { handleDeviceInfo(); });
    _server->on("/api/device/restart", HTTP_POST, [this]() { handleDeviceRestart(); });

    // CORS preflight
    _server->on("/api/spiffs/list", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/spiffs/read", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/spiffs/write", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/spiffs/delete", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/spiffs/info", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/device/info", HTTP_OPTIONS, [this]() { handleOptions(); });
    _server->on("/api/device/restart", HTTP_OPTIONS, [this]() { handleOptions(); });

    Serial.println("[ArduinoMCP] API routes registered");
}

// Add CORS headers
void ArduinoMCP::addCorsHeaders() {
    if (_corsEnabled && _server != nullptr) {
        _server->sendHeader("Access-Control-Allow-Origin", "*");
        _server->sendHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        _server->sendHeader("Access-Control-Allow-Headers", "Content-Type");
    }
}

// Handle OPTIONS request (CORS preflight)
void ArduinoMCP::handleOptions() {
    addCorsHeaders();
    _server->send(204, "text/plain", "");
}

// Send JSON response
void ArduinoMCP::sendJsonResponse(int code, const String& json) {
    addCorsHeaders();
    _server->send(code, "application/json", json);
}

// Send JSON error response
void ArduinoMCP::sendJsonError(int code, const String& message) {
    String json = "{\"ok\":false,\"error\":\"" + message + "\"}";
    sendJsonResponse(code, json);
}

// Handle /api/spiffs/list
void ArduinoMCP::handleSpiffsList() {
    String path = "/";
    if (_server->hasArg("path")) {
        path = _server->arg("path");
    }

    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    File root = SPIFFS.open(path);
    if (!root) {
        sendJsonError(404, "Path not found");
        return;
    }

    String json = "{\"ok\":true,\"path\":\"" + path + "\",\"files\":[";
    bool first = true;

    // SPIFFS doesn't have real directories, list all files
    File file = root.openNextFile();
    while (file) {
        if (!first) json += ",";
        first = false;

        String fileName = file.name();
        // Remove leading slash for display
        if (fileName.startsWith("/")) {
            fileName = fileName.substring(1);
        }

        json += "{\"name\":\"" + fileName + "\"";
        json += ",\"size\":" + String(file.size());
        json += ",\"isDir\":" + String(file.isDirectory() ? "true" : "false");
        json += "}";

        file = file.openNextFile();
    }
    root.close();

    json += "]}";
    sendJsonResponse(200, json);
}

// Handle /api/spiffs/read
void ArduinoMCP::handleSpiffsRead() {
    if (!_server->hasArg("path")) {
        sendJsonError(400, "path parameter required");
        return;
    }

    String path = _server->arg("path");
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    if (!SPIFFS.exists(path)) {
        sendJsonError(404, "File not found");
        return;
    }

    File file = SPIFFS.open(path, "r");
    if (!file) {
        sendJsonError(500, "Failed to open file");
        return;
    }

    String content = file.readString();
    file.close();

    // Determine content type
    String contentType = getContentType(path);

    addCorsHeaders();

    if (contentType == "application/json") {
        // Return as JSON wrapped response
        // Escape special characters in content
        String escapedContent = "";
        for (size_t i = 0; i < content.length(); i++) {
            char c = content.charAt(i);
            if (c == '"') escapedContent += "\\\"";
            else if (c == '\\') escapedContent += "\\\\";
            else if (c == '\n') escapedContent += "\\n";
            else if (c == '\r') escapedContent += "\\r";
            else if (c == '\t') escapedContent += "\\t";
            else escapedContent += c;
        }
        String json = "{\"ok\":true,\"path\":\"" + path + "\",\"content\":\"" + escapedContent + "\"}";
        _server->send(200, "application/json", json);
    } else {
        // Return raw content
        _server->send(200, contentType, content);
    }
}

// Handle /api/spiffs/write
void ArduinoMCP::handleSpiffsWrite() {
    if (!_server->hasArg("path")) {
        sendJsonError(400, "path parameter required");
        return;
    }

    String path = _server->arg("path");
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    String content = _server->arg("plain");
    if (content.length() == 0 && _server->hasArg("content")) {
        content = _server->arg("content");
    }

    File file = SPIFFS.open(path, "w");
    if (!file) {
        sendJsonError(500, "Failed to create file");
        return;
    }

    size_t written = file.print(content);
    file.close();

    String json = "{\"ok\":true,\"path\":\"" + path + "\",\"written\":" + String(written) + "}";
    sendJsonResponse(200, json);
}

// Handle /api/spiffs/delete
void ArduinoMCP::handleSpiffsDelete() {
    if (!_server->hasArg("path")) {
        sendJsonError(400, "path parameter required");
        return;
    }

    String path = _server->arg("path");
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    if (!SPIFFS.exists(path)) {
        sendJsonError(404, "File not found");
        return;
    }

    if (SPIFFS.remove(path)) {
        String json = "{\"ok\":true,\"path\":\"" + path + "\"}";
        sendJsonResponse(200, json);
    } else {
        sendJsonError(500, "Failed to delete file");
    }
}

// Handle /api/spiffs/info
void ArduinoMCP::handleSpiffsInfo() {
    size_t totalBytes = SPIFFS.totalBytes();
    size_t usedBytes = SPIFFS.usedBytes();
    size_t freeBytes = totalBytes - usedBytes;

    String json = "{\"ok\":true";
    json += ",\"totalBytes\":" + String(totalBytes);
    json += ",\"usedBytes\":" + String(usedBytes);
    json += ",\"freeBytes\":" + String(freeBytes);
    json += "}";

    sendJsonResponse(200, json);
}

// Handle /api/device/info
void ArduinoMCP::handleDeviceInfo() {
    String json = "{\"ok\":true";
    json += ",\"name\":\"" + String(_deviceName) + "\"";
    json += ",\"type\":\"" + String(_deviceType) + "\"";
    json += ",\"chipModel\":\"" + String(ESP.getChipModel()) + "\"";
    json += ",\"chipRevision\":" + String(ESP.getChipRevision());
    json += ",\"cpuFreqMHz\":" + String(ESP.getCpuFreqMHz());
    json += ",\"heapSize\":" + String(ESP.getHeapSize());
    json += ",\"freeHeap\":" + String(ESP.getFreeHeap());
    json += ",\"minFreeHeap\":" + String(ESP.getMinFreeHeap());
    json += ",\"sdkVersion\":\"" + String(ESP.getSdkVersion()) + "\"";
    json += ",\"flashChipSize\":" + String(ESP.getFlashChipSize());
    json += ",\"sketchSize\":" + String(ESP.getSketchSize());
    json += ",\"freeSketchSpace\":" + String(ESP.getFreeSketchSpace());

    // MAC address
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    json += ",\"macAddress\":\"" + String(macStr) + "\"";

    // Uptime
    json += ",\"uptimeMs\":" + String(millis());

    json += "}";
    sendJsonResponse(200, json);
}

// Handle /api/device/restart
void ArduinoMCP::handleDeviceRestart() {
    String json = "{\"ok\":true,\"message\":\"Restarting in 1 second...\"}";
    sendJsonResponse(200, json);

    delay(1000);
    ESP.restart();
}

// Get content type from filename
String ArduinoMCP::getContentType(const String& filename) {
    if (filename.endsWith(".json")) return "application/json";
    if (filename.endsWith(".html") || filename.endsWith(".htm")) return "text/html";
    if (filename.endsWith(".css")) return "text/css";
    if (filename.endsWith(".js")) return "application/javascript";
    if (filename.endsWith(".txt")) return "text/plain";
    if (filename.endsWith(".xml")) return "text/xml";
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
    if (filename.endsWith(".gif")) return "image/gif";
    if (filename.endsWith(".ico")) return "image/x-icon";
    return "text/plain";
}
