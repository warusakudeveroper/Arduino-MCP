# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run lint         # Run ESLint
npm test             # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run dev          # Development mode with tsx watch
npm start            # Run the compiled MCP server
```

## Architecture Overview

This is an MCP (Model Context Protocol) stdio server that automates ESP32 development workflows. It wraps `arduino-cli` for compile/upload and uses Python `pyserial` for serial monitoring.

### Module Structure

```
src/
├── index.ts              # MCP server entry point, tool registration
├── types.ts              # Shared TypeScript interfaces
├── mcp/
│   ├── schemas.ts        # Zod schemas for all MCP tool inputs
│   └── tools/
│       ├── compile.ts    # Compile tool implementation
│       └── upload.ts     # Upload tool implementation
├── serial/
│   ├── monitor.ts        # Serial monitoring with Python/pyserial
│   ├── broadcaster.ts    # SSE event broadcasting
│   ├── port-buffer.ts    # Circular buffer for serial logs
│   ├── port-state.ts     # Port state management (lock/unlock)
│   └── device-health.ts  # Reboot/crash detection, loop detection
├── console/
│   ├── server.ts         # HTTP server for web console
│   └── html.ts           # Embedded HTML/JS for console UI
├── config/
│   ├── workspace.ts      # Workspace config management
│   └── index.ts          # Config exports
└── utils/
    ├── cli-runner.ts     # arduino-cli command wrapper
    ├── fs.ts             # File system utilities
    ├── pins.ts           # ESP32-DevKitC pin specifications
    ├── pin-analysis.ts   # Pin usage analysis from sketch code
    └── logger.ts         # Logging utility
```

### Key Design Patterns

1. **MCP Tool Registration**: All tools are registered in `src/index.ts` using `server.registerTool()`. Each tool has a Zod schema defined in `src/mcp/schemas.ts`.

2. **Serial Monitoring Architecture**:
   - `MonitorManager` manages monitor sessions by token/port
   - `serialBroadcaster` sends SSE events to connected web clients
   - `PortBuffer` stores recent logs per port (circular buffer)
   - `PortStateManager` tracks port states (idle/monitoring/uploading)
   - `DeviceHealthMonitor` detects crashes, reboots, and error loops

3. **External Dependencies**:
   - `arduino-cli`: Auto-installed to `vendor/` via `ensure_dependencies`
   - Python + pyserial: Auto-setup in `.venv/` for serial monitoring
   - Environment variable `MCP_PYTHON` overrides Python path

4. **Console Server**: HTTP server at configurable port serves embedded HTML UI with real-time SSE updates for serial monitoring, device health, and log capture.

## Testing

Tests use vitest and are located in `tests/`. Run a single test file:

```bash
npx vitest run tests/schemas.test.ts
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ESP32_FQBN` | Override board FQBN (default: `esp32:esp32:esp32`) |
| `ARDUINO_CLI` | Path to arduino-cli binary |
| `MCP_PYTHON` | Path to Python with pyserial |

## MCP Tools Quick Reference

- **quickstart**: One-click setup, compile, upload, and monitor
- **compile/upload**: Standard build workflow
- **monitor_start/stop**: Serial monitoring with auto-baud detection
- **start_console**: Launch web-based serial console
- **get_device_health**: AI-friendly device stability report
- **get_port_states**: Port lock/state information
- **pin_check**: Analyze sketch for ESP32 pin compatibility issues
- **reset_device**: Reset ESP32 via DTR/RTS (equivalent to EN button)
- **spiffs_list/read/write/delete/info**: SPIFFS file explorer for networked devices

## ESP32 Library: ArduinoMCP

ESP32スケッチで使用するArduinoライブラリが `lib/ArduinoMCP/` に含まれています。

### ライブラリ構成

```
lib/ArduinoMCP/
├── library.properties     # Arduino IDE用メタデータ
├── README.md              # 使用方法
├── src/
│   ├── ArduinoMCP.h       # ヘッダーファイル
│   └── ArduinoMCP.cpp     # 実装
└── examples/
    └── SpiffsExplorer/    # サンプルスケッチ
```

### インストール方法

```bash
# シンボリックリンク（開発用）
ln -s /path/to/arduino_mcp/lib/ArduinoMCP ~/Documents/Arduino/libraries/ArduinoMCP

# または arduino-cli でインストール
arduino-cli lib install --git-url file:///path/to/arduino_mcp/lib/ArduinoMCP
```

### 使用方法

```cpp
#include <WiFi.h>
#include <ArduinoMCP.h>

ArduinoMCP mcp;

void setup() {
    WiFi.begin("SSID", "PASS");
    // ...
    mcp.begin();  // HTTPサーバー起動、SPIFFS API有効化
}

void loop() {
    mcp.handle();
}
```

### 提供されるAPIエンドポイント

| エンドポイント | 説明 |
|---------------|------|
| `/api/spiffs/list` | ファイル一覧 |
| `/api/spiffs/read` | ファイル読み込み |
| `/api/spiffs/write` | ファイル書き込み |
| `/api/spiffs/delete` | ファイル削除 |
| `/api/spiffs/info` | ストレージ情報 |
| `/api/device/info` | デバイス情報 |
| `/api/device/restart` | デバイス再起動 |

Console UIの「📁 SPIFFS Explorer」パネルからこれらのAPIを利用してファイル操作が可能です。
