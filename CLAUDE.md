# CLAUDE.md

このリポジトリで作業するときの前提と規約。

## このプロジェクトは何か

TIBCO Spotfire の中核体験である **クロスフィルタ（マーキング）** を Python / R で再実装した
探索的データ分析ダッシュボード。就職活動用のポートフォリオ。

**機能を増やすことより、クロスフィルタの完成度を上げることを優先する。**
チャートの種類を増やす提案は、連動が完成するまで保留すること。

## 起動と検証

```bash
source .venv/bin/activate          # Mac では venv 必須（externally-managed-environment 対策）
panel serve app.py --show          # 開発サーバ
panel serve app.py --show --args data/your.csv   # 任意の CSV を読ませる場合
python tests/smoke_test.py         # ブラウザ不要の検証。変更後は必ず通す
```

`panel serve` はブラウザが必要なため自動検証できない。
ロジックを変更したら `tests/smoke_test.py` に対応するアサーションを追加すること。

## 構成と責務

```
app.py              ウィジェット定義とレイアウトの組み立てのみ。ロジックは置かない
src/data.py         DuckDB への読み込み、列の型・カーディナリティ推定
src/charts.py       チャート生成と選択連動（link_selections）
src/r_bridge.py     R 連携。R 不在時は numpy にフォールバック
tests/smoke_test.py 連動と回帰の検証
```

### 依存の向き

`app.py` → `src/*` の一方向のみ。`src/` 配下は互いに独立させ、Panel に依存させない。
`src/charts.py` に `import panel` が現れたら設計が壊れている。

### 選択状態の扱い

選択は `charts.new_linker()` が返すリンカー 1 つだけが保持する。
これを複数作ると連動が分断されるので、アプリ全体で使い回すこと。

選択結果を使う側は必ず `charts.apply_selection(df, expr)` を通す。
`expr` が `None`（未選択）のとき全件を返す挙動をここに閉じ込めてあるため、
呼び出し側で `if expr is None` を書かない。

## コード規約

- **コメントと UI 文言は日本語**。変数名・関数名は英語。
- 型ヒントを付ける。各モジュール冒頭に `from __future__ import annotations`。
- 関数には何をするかだけでなく、**なぜそうしたか**を書く。設計判断が読み取れることを優先する。
- 外部ライブラリを増やすときは、既存の依存で代替できないか先に検討する。
  依存を足す場合は `requirements.txt` と README の構成表を同時に更新する。

## 環境上の注意

- **R は未インストール**。`r_bridge.py` は numpy フォールバックで動作中。
  R 判定は起動時に一度だけ行うため、アプリ起動後に R を入れても再起動しないと認識されない。
- データ量は現状 2 万行。pandas で足りているが、増やす場合は集約を DuckDB 側の SQL に寄せる。
- `data/` 配下は `.gitignore` 済み。実データをコミットしない。

## 次にやること

優先度順。上から着手する。

1. **散布図の選択ツールを初期状態で有効にする**
   現状はパンが有効なため、ドラッグしても選択されない。
   `src/charts.py` の `scatter()` に `tools=["box_select", "lasso_select", "hover"]` と
   `active_tools=["box_select"]` を追加する。

2. **サイドバーにフィルタパネルを追加**
   数値列はレンジスライダー、カテゴリ列はチェックボックス。
   チャートの選択とフィルタは別系統なので、両方が同時に効く形にする。
   （フィルタで母集団を絞り、その中で選択する）

3. **SQL コンソールタブ**
   `src/data.py` の `DataSource.sql()` を UI に露出させる。

4. **大規模データ対応**
   100 万行規模で Datashader を導入。`rasterize=True` は `link_selections` と併用可能。

5. **R 側の分析拡張**
   多変量回帰、クラスタリング。`src/r_bridge.py` に関数を追加する形で。

## やらないこと

- Streamlit への移行（再実行モデルが選択状態の保持と相性が悪い）
- Plotly / Dash への移行（連動を自前配線する必要があり、現構成の利点が消える）
- 認証・マルチユーザー対応（ポートフォリオの範囲外）
