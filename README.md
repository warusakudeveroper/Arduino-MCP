# MCP Arduino ESP32

Model Context Protocol (MCP) stdio server that automates ESP32 (Arduino core) development workflows on macOS. It wraps `arduino-cli` for compile/upload, and uses Python `pyserial` for robust serial monitoring with auto-baud detection—enabling agents (Cursor, ClaudeCode CLI, Codex CLI, etc.) to operate ESP32 boards without the Arduino IDE.

## 1. アーキテクチャ概要

### 1.1 MCP サーバー構成
| モジュール | 役割 | 主な依存 | 備考 |
| ---------- | ---- | -------- | ---- |
| `src/index.ts` | MCP スタンドアロンサーバー本体 | `@modelcontextprotocol/sdk`, `zod` | Stdio サーバーとしてツールを公開 |
| Arduino CLI ランナー | `arduino-cli` コマンド実行ラッパー | `execa` | `ARDUINO_CLI` 環境変数でパス上書き可 |
| Serial モニタ | Python + `pyserial` | `.venv/bin/python` または `MCP_PYTHON` | オートボーレート/リセット処理込み |

### 1.2 Python 実行の選択順
1. 環境変数 `MCP_PYTHON`（例: `/usr/bin/python3`）
2. プロジェクト直下 `.venv/bin/python`
3. システムの `python3`

> `pyserial` が存在しない場合、モニタ開始時に警告を出した上で fallback を試みる（要事前インストール）。

### 1.3 ボーレート自動判定
1. 候補値 `[現在値, 115200, 74880, 57600, 9600]` を短時間プローブ。
2. 取得文字列をスコアリング（印字可能率・改行数・キーワード）。
3. 最良スコアを採用、DTR/RTS パルスでボードをリセット。
4. Python モニタスクリプトで本番監視（行単位通知 or base64 chunk）。

## 2. インストール & 依存関係

### 2.1 必須ソフト
| ソフト | 用途 | インストール例 |
| ------ | ---- | -------------- |
| `arduino-cli` | コンパイル/アップロード | `brew install arduino-cli` |
| ESP32 Arduino Core | ESP32 ツールチェーン | `arduino-cli config init` → `arduino-cli core update-index` → `arduino-cli core install esp32:esp32` |
| Python3 + `pyserial` | シリアル監視 | `python3 -m venv .venv && .venv/bin/pip install pyserial` |

### 2.2 npm パッケージ
```
npm install -g @warusakudeveroper/mcp-arduino-esp32
```
Local install も可: `npm install @warusakudeveroper/mcp-arduino-esp32`

### 2.3 環境変数
| 変数 | 説明 | デフォルト |
| ---- | ---- | ---------- |
| `ESP32_FQBN` | FQBN を上書き | `esp32:esp32:esp32` |
| `ARDUINO_CLI` | `arduino-cli` コマンド | `arduino-cli` |
| `MCP_PYTHON` | モニタ用 Python | `.venv/bin/python` → `python3` |

## 3. MCP ツール仕様

| ツール | 入力 | 出力 | 備考 |
| ------ | ---- | ---- | ---- |
| `version` | なし | arduino-cli のバージョン | `arduino-cli version --json` を使用 |
| `ensure_core` | なし | esp32 コアが導入されたか | `core install` 実行 |
| `ensure_dependencies` | `install_missing` | 依存関係セットアップレポート | vendor/ に arduino-cli、.venv+pyserial を用意 |
| `board_list` | なし | シリアルポート一覧 (JSON) | `arduino-cli board list --format json` |
| `lib_list` | なし | ライブラリ一覧 (JSON) | `arduino-cli lib list` |
| `lib_install` | `name` | 成否＋標準出力 | `arduino-cli lib install` |
| `compile` | `sketch_path`, `build_path`, `export_bin`, `build_props` etc. | 診断・成果物・コマンド情報 | GCC 形式メッセージをパース、 artifacts 列挙 |
| `upload` | `sketch_path`, `port`, `build_path` | アップロードログ | 成功で exitCode 0 |
| `list_artifacts` | `base_dir`, `build_path` | `.bin/.elf/.map/.hex` | 透過的に再帰探索 |
| `monitor_start` | `port`, `auto_baud`, `max_seconds`, `stop_on` etc. | `token` を返し、シリアル・終了イベント送信 | Python + pyserial、リセット込み |
| `monitor_stop` | `token` または `port` | 停止サマリ | `monitor_start` のセッションを停止 |
| `pdca_cycle` | `sketch_path`, `port`, `monitor_seconds` | コンパイル・アップロード・モニタまとめ | `monitor_seconds` 秒だけ監視 |
| `flash_connected` | `sketch_path`, `max_ports`, `build_props` etc. | 検出ESP32へ並列アップロード | Temp/<timestamp> にビルドし全ESP32へ同時フラッシュ |
| `start_console` | `host`, `port` | SSEコンソール起動 (リアルタイムシリアルログ) | http://host:port で閲覧・ログ取得 |
| `pin_spec` | — | DevKitC のピン仕様テーブル | capabilities/notes を JSON で返却 |
| `pin_check` | `sketch_path`, `include_headers` | `warnings[]`, `usage[]`, `unknownIdentifiers[]` | ピンモード/使用状況と DevKitC 仕様の整合性を検証 |

### 3.1 重要仕様
- すべてのツールは MCP `CallToolResult` として `structuredContent` / テキスト要約を返す。
- `monitor_start` が `auto_baud: true` の場合、候補ボーレートでのスコアリング後に選択した値を通知。
- シリアル通知イベント
  - `event/serial` … `line`, `raw`, `lineNumber`, `baud` など
  - `event/serial_end` … `reason`, `elapsedSeconds`, `rebootDetected`, `lastLine`
- 停止条件 `stop_on` は正規表現（コンパイル前に検証）。
- パーティション変更などのカスタマイズは `build_props` (例: `build.partitions`) で対応。

### 3.2 ESP32-DevKitC ピン仕様 (`pin_spec`)

`pin_spec` ツールは公式ドキュメントの概要に基づき、DevKitC の各 GPIO の機能を返します（主なフィールド例）。

| フィールド | 説明 |
| ---------- | ---- |
| `number` / `name` | GPIO 番号とラベル（例: `IO0`） |
| `available` | SPI フラッシュへ接続されるなど、利用不可の場合は `false` |
| `digitalIn` / `digitalOut` | デジタル入出力が可能か |
| `analogIn` | ADC 入力として利用できるか |
| `dac` | DAC 出力 (IO25/IO26) |
| `touch` | タッチセンサ対応ピン (T0〜T9) |
| `pwm` | LEDC/PWM として利用可能か |
| `inputOnly` | 出力不可の入力専用ピン (IO34–IO39) |
| `strapping` | ブートストラップピン（起動モードへ影響） |
| `notes` | UART/I2C/VSPI などの注意点 |

### 3.3 ピン整合性チェック (`pin_check`)

- `.ino/.cpp`（必要に応じ `.h`）を走査し、`pinMode` / `digitalWrite` / `analogRead` / `touchRead` などを解析。
- 代表的な検出内容:
  - 入力専用ピン (IO34–IO39) に対する `pinMode(..., OUTPUT)` や `digitalWrite()` を **Error** として報告。
  - ブートストラップピン (IO0/2/4/5/12/15) を出力駆動している場合は **Warning**（起動モードへの影響を説明）。
  - ADC 非対応ピンでの `analogRead()`、タッチ非対応ピンでの `touchRead()`、DAC 非対応ピンの `dacWrite()` などを検出。
  - SPI フラッシュ専用ピン (GPIO6〜11) を使用していれば警告。
  - マクロ等で解析できなかった識別子は `unknownIdentifiers` として列挙。

戻り値は `ok`（致命的エラー有無）、`warnings[]`（severity=error/warning/info）、`usage[]`（各ピンの使用状況）、`unknownIdentifiers[]` を含む JSON。エージェントが機能整合性を判断しやすい構造です。

## 4. MCP クライアント設定例

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
※ `PATH` に `arduino-cli` が含まれるよう設定。

より詳しい設定例（ClaudeCode CLI / Codex CLI / Gemini CLI / Cursor）とシリアルコンソール利用手順は `docs/cli-setup.md` を参照してください。

## 5. 典型ワークフロー

1. **コンパイル**
   ```bash
   arduino-cli compile --fqbn esp32:esp32:esp32 \
     --build-path my-sketch/.build --export-binaries my-sketch
   ```
2. **アップロード**
   ```bash
   arduino-cli upload --fqbn esp32:esp32:esp32 \
     --port /dev/cu.SLAB_USBtoUART --input-dir my-sketch/.build my-sketch
   ```
3. **シリアル取得 (MCP)**
   ```json
   {
     "name": "monitor_start",
     "arguments": {
       "port": "/dev/cu.SLAB_USBtoUART",
       "auto_baud": true,
       "max_seconds": 90,
       "stop_on": "Webhook response code"
     }
   }
   ```

## 6. パーティション変更例

`compile` の `build_props` を利用:
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
カスタム CSV を用意する場合は、ESP32 コアに `boards.txt` を追加／上書きして `build.partitions` を参照させる。

## 7. シリアルログ例（Webhook テスト）
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
HTTP 204 は Discord Webhook への送信成功を示す。

## 8. よくある質問

- **パーティションの編集は可能？** 直接エディタは無いが、`--build-property build.partitions=xxx` などでボードオプションを指定できる。カスタム CSV を用いる場合は Arduino core の設定を変更。
- **デバイス検出は？** `arduino-cli board list --format json` をラップした `board_list` で取得可能。
- **モニタがバイナリノイズになる**: `auto_baud` を有効にし、pyserial + DTR/RTS リセットが効くか確認。`MCP_PYTHON` で pyserial の入った Python を指定する。

## 9. 開発・テスト

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install pyserial
npm run build
npm run lint
```

## 10. ライセンス

MIT
