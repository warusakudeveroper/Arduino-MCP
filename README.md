# MCP Arduino ESP32

Model Context Protocol (MCP) stdio server that automates ESP32 (ESP-IDF/Arduino core) build, upload, and serial-log PDCA loops on macOS. The server wraps `arduino-cli` and pyserial under one CLI so agents (Cursor, ClaudeCode CLI, Codex CLI, etc.) can operate ESP32 boards without the Arduino IDE.

## Features

- Tool-based interface for `arduino-cli` (core/libraries, compile, upload, artifact discovery).
- Serial monitor with regex stop conditions, auto-baud detection, reboot heuristics, and MCP notifications.
- One-shot PDCA helper (`pdca_cycle`) running compile → upload → serial capture.
- Python/pyserial backend for robust monitoring, detecting first-boot baud rates (74880/115200) and toggling DTR/RTS.

## Prerequisites

| Dependency | Purpose | Install hint |
| ---------- | ------- | ------------ |
| `arduino-cli` | Compiles/uploads ESP32 sketches. | `brew install arduino-cli` (macOS) |
| ESP32 Arduino core | Toolchain for `arduino-cli`. | `arduino-cli config init` → `arduino-cli core update-index` → `arduino-cli core install esp32:esp32` |
| Python 3 + `pyserial` | Serial monitor implementation. | `python3 -m venv .venv && .venv/bin/pip install pyserial` or set `MCP_PYTHON` to a Python that has `pyserial` |

> **Note**: The server looks for Python in this order: `MCP_PYTHON` env var → `.venv/bin/python` → `python3` on PATH.

## Installation

### Global CLI (recommended)

```bash
npm install -g @warusakudeveroper/mcp-arduino-esp32
# or from source checkout
npm install
npm run build
npm link
```

The CLI command `mcp-arduino-esp32` launches the MCP stdio server.

### Project-local usage

```bash
npm install @warusakudeveroper/mcp-arduino-esp32
npx mcp-arduino-esp32
```

If publishing to npm yourself, ensure the TypeScript build has been run (`npm run build`). The package ships with `prepare` → `tsc`, ensuring published tarballs include `dist/`.

## MCP Client Configuration Examples

Cursor (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "mcp-arduino-esp32": {
      "command": "mcp-arduino-esp32",
      "env": {
        "PATH": "/opt/homebrew/bin:${PATH}"
      }
    }
  }
}
```

ClaudeCode / Codex CLI (`.mcp.json`):
```json
{
  "mcpServers": {
    "mcp-arduino-esp32": { "command": "mcp-arduino-esp32" }
  }
}
```

Provide `PATH` so that `arduino-cli` is discoverable.

## Provided Tools

| Tool | Description |
| ---- | ----------- |
| `version` | Returns `arduino-cli version` (JSON if available). |
| `ensure_core` | Installs/ensures `esp32:esp32` platform. |
| `board_list` | Lists detected serial ports. |
| `lib_list` / `lib_install` | Enumerate/install Arduino libraries. |
| `compile` | Compile a sketch with `--build-path`, include diagnostics & artifacts. Optional `build_props` allow board options (e.g., partitions). |
| `upload` | Flash a compiled sketch to an ESP32 dev module. |
| `list_artifacts` | Enumerate `.bin/.elf/.map/.hex` under a build directory. |
| `monitor_start` / `monitor_stop` | Serial monitor with auto-baud, DTR/RTS reset, regex stop, `max_seconds`, `max_lines`. Emits `event/serial` and `event/serial_end`. |
| `pdca_cycle` | Convenience tool: compile → upload → monitor (N seconds). |

## Usage Workflow (Manual CLI)

1. **Compile**
   ```bash
   arduino-cli compile --fqbn esp32:esp32:esp32 --build-path my-sketch/.build --export-binaries my-sketch
   ```
2. **Upload**
   ```bash
   arduino-cli upload --fqbn esp32:esp32:esp32 --port /dev/cu.SLAB_USBtoUART --input-dir my-sketch/.build my-sketch
   ```
3. **Monitor via MCP tool**
   ```json
   {
     "name": "monitor_start",
     "arguments": {
       "port": "/dev/cu.SLAB_USBtoUART",
       "auto_baud": true,
       "max_seconds": 120,
       "stop_on": "Webhook sent successfully"
     }
   }
   ```

## Partition / Board Option Customization

`compile` accepts `build_props`. Example to use the `huge_app` partition:
```json
{
  "name": "compile",
  "arguments": {
    "sketch_path": "~/Arduino/myapp",
    "build_path": "~/Arduino/myapp/.build",
    "build_props": {
      "build.partitions": "huge_app",
      "upload.maximum_size": "3145728"
    }
  }
}
```
You may define custom CSV partitions in the Arduino core and reference them the same way.

## Environment Variables

- `ESP32_FQBN`: Override default FQBN (`esp32:esp32:esp32`).
- `ARDUINO_CLI`: Path to `arduino-cli` binary (defaults to `arduino-cli`).
- `MCP_PYTHON`: Explicit Python interpreter path for serial monitoring (pyserial required).

## Development & Publishing

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install pyserial
npm run build
npm test   # (lint)
npm pack   # verify tarball contents before publish
```

## Serial Log Example (Webhook Test)
```
ets Jul 29 2019 12:21:46
ESP32 Webhook test starting
Connecting to WiFi tetradwifi
WiFi connected, IP: 192.168.3.84
Waiting for NTP time...
Current RSSI: -23 dBm
Webhook payload: {"content":"JST: 2025-10-09 15:48:00\nRSSI: -23 dBm"}
Webhook response code: 204
```
HTTP 204 indicates the Discord webhook accepted the payload.

## Troubleshooting

- **No output / binary noise**: ensure Python has `pyserial`, board is reset-able, and `auto_baud` is `true`.
- **`arduino-cli` not found**: prepend `/opt/homebrew/bin` to `PATH` or set `ARDUINO_CLI`.
- **Slow builds**: keep a persistent build path (`<sketch>/.build`) to reuse compiled objects.
- **Permission issues**: macOS may require granting Terminal access to USB/serial devices.

## License

MIT
