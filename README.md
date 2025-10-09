# MCP Arduino ESP32

Model Context Protocol (MCP) stdio server that automates the ESP32 development PDCA cycle on macOS using only the CLI and `arduino-cli`. The server exposes tools for compiling, uploading, monitoring serial logs, and harvesting build artifacts so AI agents (Cursor, ClaudeCode CLI, Codex CLI, etc.) can iterate on sketches without the Arduino IDE.

## Features

- **Tooling parity** with the Arduino CLI: version, core/libraries management, board discovery.
- **Deterministic builds** via `compile` with structured diagnostics and artifact discovery (`.bin`, `.elf`, `.map`, `.hex`).
- **Flash automation** with `upload`, respecting a fixed FQBN (`esp32:esp32:esp32` by default).
- **Long-running serial monitor** through `monitor_start` / `monitor_stop` supporting time/line cut-offs, regex stop conditions, and ESP32 reboot heuristics.
- **One-shot PDCA** (`pdca_cycle`) executing compile → upload → monitor for scripted validation.

## Prerequisites (macOS)

```bash
brew install arduino-cli
arduino-cli config init
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

- Node.js ≥ 18
- `ESP32_FQBN` env var optionally overrides the default `esp32:esp32:esp32`.
- `ARDUINO_CLI` env var can pin a custom CLI path.

## Installation

```bash
npm install
npm run build
npm link              # optional for global CLI
mcp-arduino-esp32     # starts the stdio MCP server
```

During development you can use `npm run dev` to run the TypeScript entry point with hot reload.

## Available MCP Tools

| Tool | Description |
| --- | --- |
| `version` | Returns the `arduino-cli` version in JSON when available. |
| `ensure_core` | Installs `esp32:esp32` if missing. |
| `board_list` | Lists detected serial ports via `arduino-cli board list --format json`. |
| `lib_list` / `lib_install` | Enumerate and install libraries. |
| `compile` | Builds a sketch with fixed `--build-path`, emits diagnostics (`file/line/level/message/raw`) and lists artifacts. |
| `upload` | Flashes the compiled sketch to an ESP32 Dev Module. |
| `list_artifacts` | Enumerates build outputs (`.bin`, `.elf`, `.map`, `.hex`). |
| `monitor_start` / `monitor_stop` | Streams serial lines with stop conditions (`max_seconds`, `max_lines`, regex) and reboot detection. |
| `pdca_cycle` | Runs compile → upload → monitor (N seconds) to support automated PDCA loops. |

All tool responses include structured JSON (`structuredContent`) plus a text summary for human inspection.

## Serial Monitoring

`monitor_start` spawns `arduino-cli monitor --quiet` and emits JSON-RPC notifications:

- `event/serial` – each line with `token`, `port`, `line`, `lineNumber`, `timestamp`, and `raw` flag.
- `event/serial_end` – final summary with elapsed time, termination reason (`time_limit`, `line_limit`, `pattern_match`, `manual`, `completed`, `error`), and whether a reboot was detected.

Parameters:

```jsonc
{
  "port": "/dev/cu.SLAB_USBtoUART",
  "baud": 115200,
  "max_seconds": 120,
  "max_lines": 2000,
  "stop_on": "TEST_COMPLETE|ERROR|ASSERT",
  "detect_reboot": true
}
```

Use `monitor_stop` with either the `token` or `port` to terminate a session early.

## PDCA Workflow Example

```jsonc
compile({
  "sketch_path": "/path/to/sketch",
  "build_path": "/path/to/sketch/.build",
  "export_bin": true
})

upload({
  "sketch_path": "/path/to/sketch",
  "port": "/dev/cu.SLAB_USBtoUART"
})

monitor_start({
  "port": "/dev/cu.SLAB_USBtoUART",
  "baud": 921600,
  "max_seconds": 10,
  "stop_on": "TEST_COMPLETE",
  "detect_reboot": true
})
```

For quick regression loops, invoke `pdca_cycle` which returns compile/upload summaries and the  monitor termination report after `monitor_seconds` (default 8 seconds).

## Client Configuration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "mcp-arduino-esp32": {
      "command": "mcp-arduino-esp32",
      "env": { "PATH": "/opt/homebrew/bin:${PATH}" }
    }
  }
}
```

### ClaudeCode CLI / Codex CLI (`.mcp.json`)

```json
{
  "mcpServers": {
    "mcp-arduino-esp32": { "command": "mcp-arduino-esp32" }
  }
}
```

## Troubleshooting

- Prepend `/opt/homebrew/bin` to `PATH` if `arduino-cli` is not discovered.
- Confirm USB/serial drivers (CP210x/FTDI) when ports are missing.
- On upload failures, ensure no other process holds the port and try pressing BOOT/RESET.
- Keep `build_path` stable (e.g., `<sketch>/.build`) for reproducible artifacts.

## License

MIT
