# gmail-cleaner

Gmail を TypeSafe Jev で判定して、不要なメールを TUI で確認・削除するツール。

## セットアップ

```bash
bun install
```

`credential.json`（Google OAuth クライアント）と `token.json`（アクセストークン）を用意し、
`.env` に `TYPESAFE_API_KEY` を設定します。初回認証は次のコマンドで行います。

```bash
bun run auth-gmail.ts
```

## 起動

```bash
bun run index.ts
# または
bun run start
```

オプション:

```bash
bun run index.ts --limit=100 --query="in:inbox older_than:1y"
```

- `--limit` 1回の取得件数（既定 50）。`r` で再取得すると、既知のメールは飛ばして**続きから同じ件数**を追加します（保持メールが増えても先へ進めます）
- `--query` Gmail 検索クエリ（既定 `in:inbox`）
  - 例: `older_than:1y`, `category:promotions OR category:updates`, `is:unread`

`category:` 系はアカウントによってはほとんど一致しません。件数が少ないときは `--query` を見直してください。

## TUI の操作

| キー | 動作 |
| --- | --- |
| `↑` `↓` / `k` `j` | カーソル移動 |
| `PgUp` `PgDn` | ページ移動 |
| `g` / `G` | 先頭 / 末尾へ |
| `Enter` / `a` | 未判定のメールを Jev で判定（再取得後の新着も対象） |
| `x` / `Space` | 選択行の「残す / 消す」を手動で切替（Jev判定より優先、`*` 付きで表示。`decisions.json` に保存され次回起動でも保持） |
| `r` | メールを再取得（判定・手動マークは保持し、新着だけ先頭に追加） |
| `d` | 削除予定（Jev判定＋手動マーク）をゴミ箱へ移動（`y` で確定、進捗表示・成功分はリストから除去） |
| `q` / `Ctrl+C` | 終了 |

各行は `判定アイコン (不要度%) | 件名 | 送信者 / 経過日数` を表示します。
判定は決定的なルール（`time_sensitivity` と経過日数）で行い、`%` は参考値です。
