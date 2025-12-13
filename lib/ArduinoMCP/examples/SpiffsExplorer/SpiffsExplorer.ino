/**
 * ArduinoMCP SPIFFS Explorer Example
 *
 * This example demonstrates how to use the ArduinoMCP library
 * to provide SPIFFS file explorer API endpoints for integration
 * with Arduino-MCP development tools.
 *
 * Features:
 * - WiFi connection
 * - SPIFFS file management API
 * - Device information endpoint
 * - Integration with Arduino-MCP Console UI
 *
 * API Endpoints:
 *   GET  /api/spiffs/list    - List files
 *   GET  /api/spiffs/read    - Read file
 *   POST /api/spiffs/write   - Write file
 *   DELETE /api/spiffs/delete - Delete file
 *   GET  /api/spiffs/info    - Storage info
 *   GET  /api/device/info    - Device info
 *
 * Usage:
 * 1. Update WiFi credentials below
 * 2. Upload sketch to ESP32
 * 3. Open Arduino-MCP Console UI
 * 4. Enter device IP in SPIFFS Explorer panel
 * 5. Browse/edit files on your ESP32!
 */

#include <WiFi.h>
#include <ArduinoMCP.h>

// WiFi credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// ArduinoMCP instance
ArduinoMCP mcp;

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("=================================");
    Serial.println("ArduinoMCP SPIFFS Explorer Example");
    Serial.println("=================================");

    // Connect to WiFi
    Serial.printf("Connecting to %s", ssid);
    WiFi.begin(ssid, password);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(" Connected!");
        Serial.println();
        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());
        Serial.println();
    } else {
        Serial.println(" Failed!");
        Serial.println("WiFi connection failed. Continuing without network...");
    }

    // Initialize ArduinoMCP
    // Option 1: Use default port 80
    if (mcp.begin()) {
        Serial.println("ArduinoMCP initialized successfully!");
    } else {
        Serial.println("ArduinoMCP initialization failed!");
    }

    // Option 2: Use custom port
    // mcp.begin(8080);

    // Option 3: Use existing WebServer
    // WebServer server(80);
    // mcp.begin(&server);
    // server.begin();

    // Optional: Set device name and type
    mcp.setDeviceName("My ESP32 Device");
    mcp.setDeviceType("ESP32-WROOM-32");

    // Create a sample file if SPIFFS is empty
    createSampleFiles();

    Serial.println();
    Serial.println("=================================");
    Serial.println("API Endpoints available:");
    Serial.println("  GET  /api/spiffs/list");
    Serial.println("  GET  /api/spiffs/read?path=/file");
    Serial.println("  POST /api/spiffs/write?path=/file");
    Serial.println("  DELETE /api/spiffs/delete?path=/file");
    Serial.println("  GET  /api/spiffs/info");
    Serial.println("  GET  /api/device/info");
    Serial.println("=================================");
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Open Arduino-MCP Console and enter this IP");
        Serial.println("in the SPIFFS Explorer panel:");
        Serial.println();
        Serial.print("  ");
        Serial.println(WiFi.localIP());
        Serial.println();
    }
}

void loop() {
    // Handle incoming HTTP requests
    mcp.handle();

    // Your other code here...
}

/**
 * Create sample files for demonstration
 */
void createSampleFiles() {
    // Check if sample files exist
    if (SPIFFS.exists("/config.json")) {
        Serial.println("Sample files already exist");
        return;
    }

    Serial.println("Creating sample files...");

    // Create config.json
    File configFile = SPIFFS.open("/config.json", "w");
    if (configFile) {
        configFile.println("{");
        configFile.println("  \"device\": {");
        configFile.println("    \"name\": \"ESP32 Device\",");
        configFile.println("    \"version\": \"1.0.0\"");
        configFile.println("  },");
        configFile.println("  \"wifi\": {");
        configFile.println("    \"ssid\": \"YOUR_SSID\",");
        configFile.println("    \"autoConnect\": true");
        configFile.println("  },");
        configFile.println("  \"mqtt\": {");
        configFile.println("    \"enabled\": false,");
        configFile.println("    \"broker\": \"mqtt.example.com\",");
        configFile.println("    \"port\": 1883");
        configFile.println("  }");
        configFile.println("}");
        configFile.close();
        Serial.println("  Created /config.json");
    }

    // Create readme.txt
    File readmeFile = SPIFFS.open("/readme.txt", "w");
    if (readmeFile) {
        readmeFile.println("ArduinoMCP SPIFFS Explorer");
        readmeFile.println("==========================");
        readmeFile.println();
        readmeFile.println("This file was created by the ArduinoMCP library.");
        readmeFile.println();
        readmeFile.println("You can:");
        readmeFile.println("  - View this file in Arduino-MCP Console");
        readmeFile.println("  - Edit and save changes");
        readmeFile.println("  - Create new files");
        readmeFile.println("  - Delete files");
        readmeFile.println();
        readmeFile.println("Have fun exploring your ESP32 filesystem!");
        readmeFile.close();
        Serial.println("  Created /readme.txt");
    }

    // Create data.csv
    File dataFile = SPIFFS.open("/data.csv", "w");
    if (dataFile) {
        dataFile.println("timestamp,temperature,humidity");
        dataFile.println("1000,25.5,60");
        dataFile.println("2000,26.1,58");
        dataFile.println("3000,25.8,61");
        dataFile.close();
        Serial.println("  Created /data.csv");
    }

    Serial.println("Sample files created successfully!");
}
