# ESP32 Serial Console クイックガイド

ブラウザベースのシリアルコンソールの使い方です。

---

## 🚀 起動方法

### MCPから起動

```json
{ "name": "start_console", "arguments": { "port": 4173 } }
```

### コマンドラインから起動

```bash
cd arduino_mcp
MCP_PYTHON=".venv/bin/python" node -e "
process.env.MCP_SKIP_MAIN = '1';
require('./dist/index.js').startConsoleStandalone({ port: 4173 });
setInterval(() => {}, 1000);
"
```

### ブラウザでアクセス

http://127.0.0.1:4173

---

## 🖥 画面構成

```
┌─────────────────────────────────────────────────────────────┐
│ ⚡ ESP32 Serial Console    ● Connected    Lines: 123       │
├─────────────────────────────────────────────────────────────┤
│ Filter [________] Highlight [________] Alert on [________] │
│ [Clear All] [Export] [Stop] [Start]                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Active Ports ─────────────────────────────────────┐    │
│  │ ● /dev/cu.SLAB_USBtoUART  115200  [🔄]             │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ 📟 /dev/cu.SLAB_USBtoUART ── ● LIVE ── 115200 ───┐    │
│  │ 11:53:25 ESP32 starting...                         │    │
│  │ 11:53:26 WiFi connected                            │    │
│  │ 11:53:27 IP: 192.168.1.100                        │    │
│  │                                      [🗑][🔄][⏹]  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  ┌─ 🎛 Monitor Control ─┐  ┌─ 🔔 Alerts (3) ──────────┐   │
│  │ Available Ports      │  │ 11:53:26 WiFi connected   │   │
│  │ ● /dev/cu.SLAB...    │  │ 11:53:30 HTTP 200         │   │
│  │   [▶ Start]          │  └──────────────────────────┘   │
│  │                      │                                  │
│  │ [🔍 Scan Ports]      │  ┌─ 💥 Crashes (0) ─────────┐   │
│  │ [▶ Start All ESP32]  │  │ No crashes detected       │   │
│  │ [⏹ Stop All]         │  └──────────────────────────┘   │
│  └──────────────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## ⌨ 操作方法

### モニター操作

| 操作 | 方法 |
|------|------|
| ポートスキャン | 「🔍 Scan Ports」クリック |
| モニター開始 | ポート横の「▶ Start」クリック |
| モニター停止 | パネルの「⏹ Stop」クリック |
| モニター再起動 | パネルの「🔄」クリック |
| 全ESP32開始 | 「▶ Start All ESP32」クリック |
| 全停止 | 「⏹ Stop All」クリック |

### ログ操作

| 操作 | 方法 |
|------|------|
| ログクリア（個別） | パネルの「🗑」クリック |
| ログクリア（全体） | ヘッダーの「Clear All」クリック |
| ログエクスポート | 「Export」クリック |
| パネルにスクロール | Active Portsのポート名クリック |

### フィルタリング

| フィールド | 説明 | 例 |
|-----------|------|-----|
| Filter | 表示するログをフィルタ | `WiFi\|HTTP` |
| Highlight | マッチをハイライト | `error\|warning` |
| Alert on | Alertsパネルに追加 | `connected\|success` |

---

## 🎨 ログの色分け

| 色 | 意味 |
|----|------|
| 白 | 通常ログ |
| 赤 | stderr / エラー |
| 黄色背景 | ハイライトマッチ |
| 赤背景 | クラッシュ/スタックトレース |
| 紫背景 | リブート検出 |

---

## 🔍 自動検出パターン

### クラッシュ検出
```
Guru Meditation Error
Backtrace:
assert failed
panic
LoadProhibited
StoreProhibited
IllegalInstruction
```

### リブート検出
```
rst:0x1 (POWERON_RESET)
rst:0x10 (RTCWDT_RTC_RESET)
ets Jul 29 2019 12:21:46
```

---

## 📱 デバイス情報

シリアルログから自動抽出される情報：

- **WiFi MAC**: `MAC (WiFi STA): XX:XX:XX:XX:XX:XX`
- **BT MAC**: `MAC (BT): XX:XX:XX:XX:XX:XX`
- **Free Heap**: `Free heap: XXXXX`
- **Chip ID**: `Chip ID: XXXX`

---

## ⚙ 設定パネル

### FQBN（ボード種別）
| 値 | ボード |
|----|--------|
| esp32:esp32:esp32 | ESP32 Dev Module |
| esp32:esp32:esp32wrover | ESP32 Wrover Module |
| esp32:esp32:esp32s2 | ESP32-S2 |
| esp32:esp32:esp32s3 | ESP32-S3 |
| esp32:esp32:esp32c3 | ESP32-C3 |

### パーティション
| 値 | 説明 |
|----|------|
| default | デフォルト 4MB |
| huge_app | アプリ大容量 3MB |
| min_spiffs | SPIFFS最小 |
| no_ota | OTAなし |

---

## 🔧 APIエンドポイント

コンソールサーバーは以下のAPIを提供：

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/` | GET | コンソールHTML |
| `/events` | GET | SSEイベントストリーム |
| `/health` | GET | ヘルスチェック |
| `/api/ports` | GET | ポート一覧 |
| `/api/monitors` | GET | アクティブモニター |
| `/api/monitor/start` | POST | モニター開始 |
| `/api/monitor/stop` | POST | モニター停止 |
| `/api/monitor/stop-all` | POST | 全モニター停止 |
| `/api/logs` | GET | ログバッファ取得 |
| `/api/artifacts` | GET | ビルド成果物一覧 |
| `/api/upload` | POST | ファームウェアアップロード |
| `/api/erase` | POST | フラッシュ消去 |
| `/api/device-info` | GET | デバイス情報 |

### 使用例

```bash
# ポート一覧
curl http://127.0.0.1:4173/api/ports

# モニター開始
curl -X POST http://127.0.0.1:4173/api/monitor/start \
  -H "Content-Type: application/json" \
  -d '{"port": "/dev/cu.SLAB_USBtoUART", "baud": 115200}'

# ログ取得
curl http://127.0.0.1:4173/api/logs
```

---

## ❓ よくある質問

### Q: ポートが見つからない
**A**: 
1. 「🔍 Scan Ports」を再度クリック
2. USBケーブルを確認（データ転送対応か）
3. ドライバをインストール

### Q: モニターが切断された
**A**: 
1. 「🔄」で再起動
2. ESP32のENボタンを押してリセット

### Q: 文字化けする
**A**: 
1. ボーレートを確認
2. スケッチの `Serial.begin()` と一致させる
3. Auto Baudを有効にする

### Q: ESP32が反応しない
**A**: 
1. BOOTボタンを押さずにENボタンだけ押す
2. ダウンロードモードから復帰

---

## 🔗 関連ドキュメント

- [操作マニュアル](./manual.md)
- [CLIセットアップ](./cli-setup.md)
- [README](../README.md)

---

*Last updated: 2025-12-07*

