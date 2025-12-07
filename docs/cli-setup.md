# MCP クライアント導入ガイド（ClaudeCode CLI / Codex CLI / Gemini CLI / Cursor）

このサーバーは標準入出力のMCPサーバーです。以下は各クライアントでの導入例と、リアルタイムシリアルコンソールの利用手順です。

## 前提
- Node.js 18+
- `npm install` 済み
- `ensure_dependencies` で `arduino-cli` の vendor 配置と `.venv` + `pyserial` を整備可能

## 共通: MCP サーバー起動
```bash
npm run build
npx mcp-arduino-esp32
```
（または `npm link` して `mcp-arduino-esp32` を直接起動）

## Cursor
`.cursor/mcp.json`
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

## ClaudeCode CLI / Codex CLI / Gemini CLI
`.mcp.json`
```json
{
  "mcpServers": {
    "mcp-arduino-esp32": { "command": "mcp-arduino-esp32" }
  }
}
```
`PATH` に `arduino-cli`（もしくは vendor 配置先）が含まれるようにしてください。

## ツールのよく使う順序
1. `ensure_dependencies` … vendor 配下に `arduino-cli`、`.venv` に `pyserial` を用意
2. `ensure_core` … ESP32 コアをインストール
3. `flash_connected` … 接続ESP32(最大10)へビルド＆並列アップロード
4. `monitor_start` … 個別ポートでシリアル取得（`auto_baud` 推奨）
5. `start_console` … ローカルSSEコンソール起動（リアルタイム閲覧用）

## リアルタイムシリアルコンソールの使い方
1. `start_console` を呼び出す（例）
   ```json
   { "name": "start_console", "arguments": { "host": "127.0.0.1", "port": 4173 } }
   ```
   → `http://127.0.0.1:4173` にアクセス。
2. 監視したいポートで `monitor_start` を実行（複数可）。
   ```json
   { "name": "monitor_start", "arguments": { "port": "/dev/cu.SLAB_USBtoUART", "auto_baud": true } }
   ```
3. ブラウザ画面でリアルタイムにログが流れます。ポートフィルタとテキストフィルタで絞り込み可。`Clear` で画面をリセット。

### コンソールUIの操作（検索/アラート/停止）
- Global filter: 画面上部の `global text filter (regex optional)` に正規表現または文字列を入力すると全パネルにフィルタがかかります。
- Alert filter: `alert filter (regex)` に一致した行は通常パネルに加え Alerts ペインにも蓄積（最大200行）。アラートのみ確認したいときに利用。
- Start/Stop stream: SSE接続の手動開始/停止。タブを開いたまま停止したいときに `Stop stream` を押し、再開は `Start stream`。
- 行の保持数: 各ポートパネルは最大1000行まで保持（メモリ保護のためこれ以上は増やさない運用を推奨）。
- ポート表示: 取得中のポートはヘッダ下の `Ports:` に列挙。複数ポートを監視するとパネルが自動追加されます（自動グリッドで最大10台分の横並び/折返しを想定）。

### 複数デバイス（最大10台）
- ポートごとに `monitor_start` を呼び出してください。SSEはポート名付きで全行を配信するので、同一画面で同時に閲覧できます。
- 出力量が多い場合はテキストフィルタ/ポートフィルタで負荷を抑制できます。

## 代表的な JSON 呼び出し例
- 依存関係セットアップ
```json
{ "name": "ensure_dependencies", "arguments": { "install_missing": true } }
```
- 複数ESP32への並列フラッシュ
```json
{
  "name": "flash_connected",
  "arguments": {
    "sketch_path": "~/Arduino/myapp",
    "max_ports": 5
  }
}
```
- 単体ポートでの監視
```json
{ "name": "monitor_start", "arguments": { "port": "/dev/cu.SLAB_USBtoUART", "auto_baud": true } }
```
- コンソール停止はブラウザを閉じるだけでOK。モニタ停止は `monitor_stop` を利用。

## トラブルシュート
- シリアルが読めない: `auto_baud: true` で試す／USBケーブル・権限を確認。
- コンソール無反応: `start_console` が起動済みか確認。`http://host:port/health` で `{ ok: true }` が返るか。
- 依存が見つからない: `ensure_dependencies` を実行、もしくは `ARDUINO_CLI` / `MCP_PYTHON` を明示する。
