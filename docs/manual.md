# MCP Arduino ESP32 操作マニュアル

ESP32開発を自動化するMCPサーバーの完全操作ガイドです。

---

## 📋 目次

1. [システム要件](#1-システム要件)
2. [インストール](#2-インストール)
3. [MCPクライアント設定](#3-mcpクライアント設定)
4. [クイックスタート](#4-クイックスタート)
5. [シリアルコンソール](#5-シリアルコンソール)
6. [MCPツール一覧](#6-mcpツール一覧)
7. [トラブルシューティング](#7-トラブルシューティング)

---

## 1. システム要件

### 必須
| 項目 | 要件 |
|------|------|
| OS | macOS, Linux, Windows |
| Node.js | 18.0以上 |
| Python | 3.8以上 |

### 自動インストールされるもの
- arduino-cli（vendor/に配置）
- pyserial（.venv/に配置）
- esptool（.venv/に配置）
- ESP32 Arduinoコア

---

## 2. インストール

### 2.1 npmからインストール（推奨）

```bash
npm install -g @warusakudeveroper/mcp-arduino-esp32
```

### 2.2 ソースからインストール

```bash
git clone https://github.com/warusakudeveroper/Arduino-MCP.git
cd Arduino-MCP
npm install
npm run build
```

### 2.3 依存関係の確認

MCPツール `ensure_dependencies` を実行するか、手動で確認：

```bash
# arduino-cli確認
arduino-cli version

# Python確認
python3 --version

# pyserial確認
python3 -c "import serial; print('OK')"
```

---

## 3. MCPクライアント設定

### 3.1 Cursor

`.cursor/mcp.json` を作成：

```json
{
  "mcpServers": {
    "mcp-arduino-esp32": {
      "command": "node",
      "args": ["/path/to/arduino_mcp/dist/index.js"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "MCP_PYTHON": "/path/to/arduino_mcp/.venv/bin/python"
      }
    }
  }
}
```

### 3.2 ClaudeCode CLI / Codex CLI

`.mcp.json` を作成：

```json
{
  "mcpServers": {
    "mcp-arduino-esp32": {
      "command": "mcp-arduino-esp32"
    }
  }
}
```

### 3.3 設定後

MCPクライアント（Cursor等）を再起動してください。

---

## 4. クイックスタート

### 4.1 最速セットアップ（推奨）

ESP32をUSBで接続し、MCPで以下を実行：

```json
{ "name": "quickstart", "arguments": {} }
```

これだけで：
1. ✅ arduino-cli インストール
2. ✅ Python + pyserial セットアップ
3. ✅ ESP32コア インストール
4. ✅ ESP32 自動検出
5. ✅ Blinkサンプル コンパイル＆アップロード
6. ✅ シリアル出力 10秒間モニタリング

### 4.2 既存スケッチで実行

```json
{
  "name": "quickstart",
  "arguments": {
    "sketch_path": "~/Arduino/my-sketch",
    "monitor_seconds": 30
  }
}
```

---

## 5. シリアルコンソール

### 5.1 コンソール起動

```json
{ "name": "start_console", "arguments": { "port": 4173 } }
```

ブラウザで http://127.0.0.1:4173 を開く。

### 5.2 コンソールUI操作

#### ヘッダーツールバー

| 要素 | 説明 |
|------|------|
| Filter | ログをフィルタリング（正規表現対応） |
| Highlight | マッチするテキストをハイライト |
| Alert on | マッチするとAlertsパネルに追加 |
| Clear All | 全ログをクリア |
| Export | ログをテキストファイルでダウンロード |
| Stop/Start | SSEストリームの停止/開始 |

#### Active Portsバー

- 監視中のポート一覧
- クリックで該当パネルにスクロール
- 🔄でモニター再起動

#### ポートパネル

| ボタン | 機能 |
|--------|------|
| 🗑 | ログクリア |
| 🔄 | モニター再起動 |
| ⏹ Stop | モニター停止 |

#### サイドパネル

| パネル | 内容 |
|--------|------|
| Monitor Control | ポートスキャン、モニター開始/停止 |
| Alerts | アラートパターンにマッチしたログ |
| Crashes/Reboots | クラッシュ・リブート検出ログ |
| Device Info | MACアドレス等のデバイス情報 |
| Firmware Upload | ビルド済みファームウェアのアップロード |
| Settings | FQBN、パーティション等の設定 |

### 5.3 モニター開始

1. **Scan Ports** をクリック
2. 対象ポートの **▶ Start** をクリック
3. または **▶ Start All ESP32** で全ESP32を開始

### 5.4 クラッシュ検出

以下のパターンを自動検出：
- `Guru Meditation Error`
- `Backtrace:`
- `rst:0x...` (リセット原因)
- `Brownout detector`
- `panic`
- `assert failed`

### 5.5 アラート設定例

| 用途 | パターン |
|------|----------|
| WiFi接続監視 | `WiFi connected\|WiFi disconnected` |
| エラー検出 | `error\|fail\|exception` |
| HTTP監視 | `HTTP\|response code` |
| メモリ監視 | `heap\|memory` |

---

## 6. MCPツール一覧

### 6.1 セットアップ系

#### `quickstart`
一括セットアップ＆動作確認。

```json
{
  "name": "quickstart",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",  // 省略時はBlinkサンプル
    "port": "/dev/cu.usbserial-0001",   // 省略時は自動検出
    "monitor_seconds": 10               // デフォルト10秒
  }
}
```

#### `ensure_dependencies`
依存関係のインストール。

```json
{ "name": "ensure_dependencies", "arguments": { "install_missing": true } }
```

#### `ensure_core`
ESP32コアのインストール。

```json
{ "name": "ensure_core", "arguments": {} }
```

#### `version`
arduino-cliのバージョン確認。

```json
{ "name": "version", "arguments": {} }
```

### 6.2 ビルド系

#### `compile`
スケッチのコンパイル。

```json
{
  "name": "compile",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",
    "build_path": "~/Arduino/sketch/.build",
    "export_bin": true,
    "clean": false,
    "fqbn": "esp32:esp32:esp32",
    "build_props": {
      "build.partitions": "huge_app"
    }
  }
}
```

#### `upload`
コンパイル済みスケッチのアップロード。

```json
{
  "name": "upload",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",
    "port": "/dev/cu.usbserial-0001",
    "build_path": "~/Arduino/sketch/.build"
  }
}
```

#### `pdca_cycle`
コンパイル→アップロード→モニタを一括実行。

```json
{
  "name": "pdca_cycle",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",
    "port": "/dev/cu.usbserial-0001",
    "monitor_seconds": 15,
    "baud": 115200
  }
}
```

#### `flash_connected`
接続中のESP32全てに一括フラッシュ。

```json
{
  "name": "flash_connected",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",
    "max_ports": 10
  }
}
```

#### `erase_flash`
ESP32のフラッシュ完全消去。

```json
{
  "name": "erase_flash",
  "arguments": {
    "port": "/dev/cu.usbserial-0001"
  }
}
```

#### `spiffs_upload`
SPIFFSパーティションにデータアップロード。

```json
{
  "name": "spiffs_upload",
  "arguments": {
    "port": "/dev/cu.usbserial-0001",
    "data_dir": "~/Arduino/sketch/data"
  }
}
```

#### `list_artifacts`
ビルド成果物の一覧。

```json
{
  "name": "list_artifacts",
  "arguments": {
    "base_dir": "~/Arduino/sketch"
  }
}
```

### 6.3 モニタリング系

#### `monitor_start`
シリアルモニター開始。

```json
{
  "name": "monitor_start",
  "arguments": {
    "port": "/dev/cu.usbserial-0001",
    "baud": 115200,
    "auto_baud": true,
    "max_seconds": 60,
    "max_lines": 1000,
    "stop_on": "WiFi connected",
    "detect_reboot": true
  }
}
```

#### `monitor_stop`
シリアルモニター停止。

```json
{
  "name": "monitor_stop",
  "arguments": {
    "port": "/dev/cu.usbserial-0001"
  }
}
```

#### `start_console`
ブラウザ用コンソールサーバー起動。

```json
{
  "name": "start_console",
  "arguments": {
    "host": "127.0.0.1",
    "port": 4173
  }
}
```

#### `get_logs`
バッファ済みログの取得（AI確認用）。

```json
{
  "name": "get_logs",
  "arguments": {
    "port": "/dev/cu.usbserial-0001",
    "max_lines": 100,
    "pattern": "WiFi"
  }
}
```

### 6.4 ボード・ライブラリ系

#### `board_list`
接続ボード一覧。

```json
{ "name": "board_list", "arguments": {} }
```

#### `lib_list`
インストール済みライブラリ一覧。

```json
{ "name": "lib_list", "arguments": {} }
```

#### `lib_install`
ライブラリインストール。

```json
{
  "name": "lib_install",
  "arguments": {
    "name": "ArduinoJson"
  }
}
```

### 6.5 ピン検証系

#### `pin_spec`
ESP32-DevKitCのピン仕様表。

```json
{ "name": "pin_spec", "arguments": {} }
```

#### `pin_check`
スケッチのピン使用検証。

```json
{
  "name": "pin_check",
  "arguments": {
    "sketch_path": "~/Arduino/sketch",
    "include_headers": true
  }
}
```

---

## 7. トラブルシューティング

### 7.1 ポートが見つからない

**症状**: `board_list` でポートが表示されない

**対処**:
1. USBケーブルがデータ転送対応か確認（充電専用は不可）
2. ドライバをインストール
   - CP210x: https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers
   - CH340: https://www.wch.cn/downloads/CH341SER_MAC_ZIP.html
3. ESP32を抜き差し
4. macOS: システム環境設定 → セキュリティとプライバシー で許可

### 7.2 ポートがビジー

**症状**: `Resource busy` エラー

**対処**:
1. Arduino IDEを閉じる
2. 他のシリアルモニターを閉じる
3. ターミナルで確認:
   ```bash
   lsof | grep usbserial
   ```

### 7.3 コンパイルエラー

**症状**: `compile` が失敗

**対処**:
1. ESP32コアがインストールされているか確認:
   ```json
   { "name": "ensure_core", "arguments": {} }
   ```
2. 必要なライブラリをインストール
3. `diagnostics` フィールドでエラー詳細を確認

### 7.4 アップロード失敗

**症状**: `upload` が失敗

**対処**:
1. ESP32のBOOTボタンを押しながらENボタンを押す（ダウンロードモード）
2. ポートを再確認
3. ボーレートを下げる（921600→460800→115200）

### 7.5 シリアル出力が文字化け

**症状**: ログがバイナリノイズ

**対処**:
1. `auto_baud: true` を使用
2. スケッチの `Serial.begin()` のボーレートを確認
3. 一般的なボーレート: 115200, 74880, 9600

### 7.6 ESP32がダウンロードモードで止まる

**症状**: `waiting for download` が表示される

**対処**:
1. BOOTボタンを押さずにENボタンだけを押してリセット
2. GPIO0が外部回路でLOWに固定されていないか確認

### 7.7 pyserialエラー

**症状**: `No module named 'serial'`

**対処**:
```bash
# 仮想環境を作成
python3 -m venv .venv
.venv/bin/pip install pyserial esptool
```

### 7.8 Windowsでの問題

**症状**: `powershell` エラー

**対処**:
1. PowerShellが利用可能か確認
2. 管理者権限でPowerShellを実行
3. 実行ポリシーを確認:
   ```powershell
   Get-ExecutionPolicy
   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```

---

## 📚 関連ドキュメント

- [README.md](../README.md) - プロジェクト概要
- [cli-setup.md](./cli-setup.md) - CLIセットアップ詳細

---

## 🔗 外部リンク

- [ESP32 Arduino Core](https://github.com/espressif/arduino-esp32)
- [arduino-cli](https://arduino.github.io/arduino-cli/)
- [esptool](https://github.com/espressif/esptool)

---

*Last updated: 2025-12-07*

