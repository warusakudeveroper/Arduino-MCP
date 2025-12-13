# ArduinoMCP Library

ESP32用ライブラリ。Arduino-MCP開発ツールとの連携機能を提供します。

## 機能

- **SPIFFS ファイルエクスプローラAPI** - ファイルの一覧・読み書き・削除
- **デバイス情報API** - ESP32の状態情報を取得
- **CORS対応** - ブラウザからの直接アクセスをサポート

## インストール

### 方法1: シンボリックリンク（開発用）

```bash
cd ~/Documents/Arduino/libraries
ln -s /path/to/arduino_mcp/lib/ArduinoMCP ArduinoMCP
```

### 方法2: コピー

`lib/ArduinoMCP` フォルダを Arduino の `libraries` ディレクトリにコピー：

```bash
cp -r /path/to/arduino_mcp/lib/ArduinoMCP ~/Documents/Arduino/libraries/
```

## 使い方

### 基本的な使い方

```cpp
#include <WiFi.h>
#include <ArduinoMCP.h>

ArduinoMCP mcp;

void setup() {
    Serial.begin(115200);

    // WiFi接続
    WiFi.begin("SSID", "PASSWORD");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
    }
    Serial.println(WiFi.localIP());

    // ArduinoMCP初期化（ポート80でWebServer起動）
    mcp.begin();

    // オプション: デバイス名設定
    mcp.setDeviceName("My ESP32");
    mcp.setDeviceType("ESP32-WROOM-32");
}

void loop() {
    mcp.handle();  // HTTPリクエスト処理
}
```

### 既存のWebServerと併用

```cpp
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoMCP.h>

WebServer server(80);
ArduinoMCP mcp;

void setup() {
    // WiFi接続...

    // 自分のルート設定
    server.on("/", []() {
        server.send(200, "text/html", "<h1>Hello!</h1>");
    });

    // ArduinoMCPを既存サーバーに追加
    mcp.begin(&server);

    server.begin();
}

void loop() {
    server.handleClient();  // mcp.handle()は不要
}
```

### カスタムポート

```cpp
mcp.begin(8080);  // ポート8080で起動
```

## APIエンドポイント

| メソッド | エンドポイント | 説明 |
|---------|---------------|------|
| GET | `/api/spiffs/list?path=/` | ファイル一覧取得 |
| GET | `/api/spiffs/read?path=/file` | ファイル読み込み |
| POST | `/api/spiffs/write?path=/file` | ファイル書き込み（body=内容） |
| DELETE | `/api/spiffs/delete?path=/file` | ファイル削除 |
| GET | `/api/spiffs/info` | ストレージ情報 |
| GET | `/api/device/info` | デバイス情報 |
| POST | `/api/device/restart` | デバイス再起動 |

## レスポンス形式

### ファイル一覧 (`/api/spiffs/list`)

```json
{
  "ok": true,
  "path": "/",
  "files": [
    {"name": "config.json", "size": 256, "isDir": false},
    {"name": "data.csv", "size": 128, "isDir": false}
  ]
}
```

### ストレージ情報 (`/api/spiffs/info`)

```json
{
  "ok": true,
  "totalBytes": 1441792,
  "usedBytes": 12288,
  "freeBytes": 1429504
}
```

### デバイス情報 (`/api/device/info`)

```json
{
  "ok": true,
  "name": "My ESP32",
  "type": "ESP32-WROOM-32",
  "chipModel": "ESP32-D0WDQ6",
  "cpuFreqMHz": 240,
  "freeHeap": 245632,
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "uptimeMs": 12345678
}
```

## Arduino-MCP Console連携

1. ESP32にこのライブラリを含むスケッチをアップロード
2. シリアルモニタでIPアドレスを確認
3. Arduino-MCP Consoleを開く（`start_console`ツール使用）
4. サイドバーの「📁 SPIFFS Explorer」パネルにIPアドレスを入力
5. 「Connect」をクリック

これでESP32のSPIFFSファイルをブラウザから操作できます！

## 依存ライブラリ

- WebServer（ESP32標準）
- SPIFFS（ESP32標準）

## ライセンス

MIT License
