"""クロスフィルタの中核が動くかを検証するスモークテスト。

panel serve せずに、選択条件を与えて絞り込みと回帰が通ることを確認する。
    python tests/smoke_test.py
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import holoviews as hv  # noqa: E402
import pandas as pd  # noqa: E402

from src import charts, data, filters, r_bridge  # noqa: E402

hv.extension("bokeh")


def main() -> int:
    ds = data.load()
    print(f"[1] 読み込み: {ds.n_rows:,} 行 / 数値列 {ds.num_cols} / カテゴリ列 {ds.cat_cols}")

    # 未選択なら全件が返ること
    assert len(charts.apply_selection(ds.df, None)) == ds.n_rows

    # 散布図が初期状態から box_select でドラッグ選択できること
    sc = charts.scatter(ds.df, "温度", "収率")
    plot_opts = hv.Store.lookup_options("bokeh", sc, "plot").kwargs
    print(f"[1.5] 散布図ツール: tools={plot_opts.get('tools')} active_tools={plot_opts.get('active_tools')}")
    assert "box_select" in plot_opts.get("tools", [])
    assert "active_tools" in plot_opts and plot_opts["active_tools"] == ["box_select"]

    # 散布図のドラッグ選択に相当する条件を直接組み立てて適用する
    expr = (hv.dim("温度") > 100) & (hv.dim("収率") > 80)
    sub = charts.apply_selection(ds.df, expr)
    print(f"[2] 絞り込み: {len(sub):,} 行 ({len(sub) / ds.n_rows:.1%})")
    assert 0 < len(sub) < ds.n_rows, "絞り込みが効いていません"

    # チャートが 3 枚組み上がること
    layout = charts.build(charts.new_linker(), ds.df, "温度", "収率", "ロット")
    print(f"[3] チャート構築: {len(layout)} 枚")
    assert len(layout) == 3

    # フィルタパネル：初期値は「全件を通す」（フル範囲・全選択）であること
    fp = filters.build(ds)
    full = filters.apply(ds.df, fp)
    print(f"[3.5] フィルタ初期状態: {len(full):,} / {ds.n_rows:,} 行")
    assert len(full) == ds.n_rows, "初期状態で母集団が絞られてしまっています"

    # 数値レンジスライダーを狭めると母集団が絞られること
    num_col = ds.num_cols[0]
    lo, hi = fp.num_widgets[num_col].start, fp.num_widgets[num_col].end
    fp.num_widgets[num_col].value = (lo, lo + (hi - lo) / 2)
    narrowed = filters.apply(ds.df, fp)
    print(f"[3.6] レンジ絞り込み ({num_col}): {len(narrowed):,} 行")
    assert 0 < len(narrowed) < ds.n_rows, "レンジフィルタが効いていません"
    fp.num_widgets[num_col].value = (lo, hi)  # 元に戻す

    # カテゴリのチェックを一部外すと母集団が絞られ、全部外すと 0 件になること
    cat_col = ds.cat_cols[0]
    all_opts = fp.cat_widgets[cat_col].options
    fp.cat_widgets[cat_col].value = all_opts[:1]
    cat_narrowed = filters.apply(ds.df, fp)
    print(f"[3.7] カテゴリ絞り込み ({cat_col}={all_opts[:1]}): {len(cat_narrowed):,} 行")
    assert 0 < len(cat_narrowed) < ds.n_rows, "カテゴリフィルタが効いていません"
    fp.cat_widgets[cat_col].value = []
    assert len(filters.apply(ds.df, fp)) == 0, "全チェックを外しても 0 件になっていません"

    # フィルタ（母集団の絞り込み）とチャート選択（母集団内の絞り込み）は独立して重ねられること
    fp.cat_widgets[cat_col].value = all_opts
    fdf = filters.apply(ds.df, fp)
    combined = charts.apply_selection(fdf, expr)
    assert len(combined) <= len(sub), "フィルタと選択の重ね掛けがおかしい"

    # 選択範囲への回帰
    fit = r_bridge.linear_model(sub, "温度", "収率")
    print(f"[4] 回帰 ({r_bridge.backend_name()}):")
    print(fit.to_string(index=False))
    assert "傾き" in fit.columns

    # アップロード経路（画面からのドロップに相当）: CSV
    csv_bytes = "身長,体重,グループ\n170,60,X\n180,75,Y\n165,55,X\n190,90,Y\n".encode("utf-8")
    up_ds = data.load_from_upload("probe.csv", csv_bytes, header_row=0)
    print(f"[5] アップロード(CSV): {up_ds.n_rows} 行 / 数値列 {up_ds.num_cols} / カテゴリ列 {up_ds.cat_cols}")
    assert up_ds.num_cols == ["身長", "体重"]
    assert up_ds.cat_cols == ["グループ"]
    assert up_ds.n_rows == 4

    # str（FileDropper がテキスト系ファイルを自動デコードするケース）でも読めること
    up_ds_str = data.load_from_upload("probe.csv", csv_bytes.decode("utf-8"), header_row=0)
    assert up_ds_str.n_rows == 4

    # ヘッダ行の指定: 1 行目がヘッダでない実験データに相当するケース
    offset_bytes = "メモ\n身長,体重\n170,60\n180,75\n".encode("utf-8")
    assert data.load_from_upload("offset.csv", offset_bytes, header_row=1).num_cols == ["身長", "体重"]
    try:
        data.load_from_upload("offset.csv", offset_bytes, header_row=0)
        assert False, "ヘッダ行がずれているのに読み込めてしまっている"
    except data.LoadError:
        pass  # header_row=0 だと「メモ」列だけになり数値列不足で弾かれるはず

    # xlsx: pandas.read_excel 経由（openpyxl 依存）
    xlsx_df = pd.DataFrame({"温度": [10, 20, 30], "湿度": [1, 2, 3], "種別": ["a", "b", "a"]})
    buf = io.BytesIO()
    xlsx_df.to_excel(buf, index=False, engine="openpyxl")
    xlsx_ds = data.load_from_upload("sample.xlsx", buf.getvalue(), header_row=0)
    print(f"[5.5] アップロード(xlsx): {xlsx_ds.n_rows} 行 / 数値列 {xlsx_ds.num_cols}")
    assert xlsx_ds.num_cols == ["温度", "湿度"]

    # 失敗系: 未対応拡張子・数値列不足は LoadError（日本語メッセージ）に正規化されること
    try:
        data.load_from_upload("a.txt", b"x,y\n1,2\n", header_row=0)
        assert False, "未対応拡張子が読み込めてしまっている"
    except data.LoadError as e:
        print(f"[5.6] 未対応拡張子エラー: {e}")

    try:
        data.load_from_upload("bad.csv", b"a,b\nx,y\n", header_row=0)
        assert False, "数値列が無いのに読み込めてしまっている"
    except data.LoadError as e:
        print(f"[5.7] 数値列不足エラー: {e}")

    # --- ヘッダ行のプレビュー・自動推定 -------------------------------------
    # 数字を打たせるのではなく、先頭行をそのまま見せて選ばせる方式の検証。
    # 1) ヘッダが 1 行目にある素直なケース: guess == 0
    plain_bytes = csv_bytes  # 身長,体重,グループ ... （すでに定義済み）
    plain_raw = data.preview_upload("probe.csv", plain_bytes)
    assert list(plain_raw.iloc[0]) == ["身長", "体重", "グループ"], "プレビューが加工されている"
    plain_guess = data.guess_header_row(plain_raw)
    print(f"[5.8] プレビュー(素直なCSV): 推定ヘッダ行={plain_guess}")
    assert plain_guess == 0
    assert data.load_from_upload("probe.csv", plain_bytes, header_row=plain_guess).num_cols == ["身長", "体重"]

    # 2) タイトル行・単位行を挟んで 3 行目がヘッダになる、実験機器の出力に近いケース
    #    （sample_baiyou.xlsx の構造を模した合成データで検証）
    offset3_bytes = (
        "測定結果（2026年度）,,\n"
        "-,degC,%\n"
        "サンプルID,温度,生存率\n"
        "S0001,39.69,79.74\n"
        "S0002,39.39,81.95\n"
    ).encode("utf-8")
    offset3_raw = data.preview_upload("offset3.csv", offset3_bytes)
    offset3_guess = data.guess_header_row(offset3_raw)
    print(f"[5.9] プレビュー(3行目がヘッダ): 推定ヘッダ行={offset3_guess}")
    assert offset3_guess == 2, "タイトル・単位行を挟んだヘッダ推定に失敗しています"
    offset3_ds = data.load_from_upload("offset3.csv", offset3_bytes, header_row=offset3_guess)
    assert offset3_ds.num_cols == ["温度", "生存率"]
    assert offset3_ds.n_rows == 2

    # 3) 推定が外れても（例えば 1 行目を選んでしまっても）、プレビューから
    #    正しい行を選び直せば読み込めること（「推定失敗でも手動で成立する」設計の確認）
    try:
        data.load_from_upload("offset3.csv", offset3_bytes, header_row=1)
        assert False, "単位行をヘッダにしても読み込めてしまっている"
    except data.LoadError:
        pass  # 単位行は数値列にならないので数値列不足で弾かれるはず
    retry_ds = data.load_from_upload("offset3.csv", offset3_bytes, header_row=2)
    assert retry_ds.num_cols == ["温度", "生存率"], "手動での選び直しが機能していません"

    # --- 高カーディナリティ列の除外 -------------------------------------
    # ID 列のような「ほぼ全行ユニーク」な列はチェックボックス・色分けに
    # 向かないので、cat_cols/フィルタ/色分けの対象から外れることを検証する。
    n = data.MAX_CATEGORY_CARDINALITY + 5
    high_card_df = pd.DataFrame(
        {
            "値": range(n),
            "測定値": [float(i % 7) for i in range(n)],
            "ID": [f"S{i:04d}" for i in range(n)],  # 全行ユニーク -> 高カーディナリティ
            "区分": ["A", "B"] * (n // 2) + ["A"] * (n % 2),  # 低カーディナリティ
        }
    )
    hc_ds = data.load_from_upload("high_card.csv", high_card_df.to_csv(index=False), header_row=0)
    print(f"[6] 高カーディナリティ: cat_cols={hc_ds.cat_cols} high_card_cols={hc_ds.high_card_cols}")
    assert "ID" in hc_ds.high_card_cols, "高カーディナリティ列が検出されていません"
    assert "ID" not in hc_ds.cat_cols, "高カーディナリティ列が cat_cols に残っています"
    assert "区分" in hc_ds.cat_cols, "低カーディナリティ列まで除外されています"

    hc_fp = filters.build(hc_ds)
    assert "ID" not in hc_fp.cat_widgets, "高カーディナリティ列のフィルタウィジェットができています"
    assert len(filters.apply(hc_ds.df, hc_fp)) == hc_ds.n_rows

    # --- 欠測の扱い -------------------------------------------------
    # between()/isin() は NaN に対して False を返すため、対策していないと
    # 「フィルタを一切操作していないのに欠測行だけ母集団から消える」バグになる。
    miss_df = pd.DataFrame(
        {
            "x": [1.0, 2.0, None, 4.0, 5.0],
            "y": [10.0, None, 30.0, 40.0, 50.0],
            "区分": ["A", "B", "A", "B", "A"],
        }
    )
    miss_ds = data.load_from_upload("missing.csv", miss_df.to_csv(index=False), header_row=0)
    miss_fp = filters.build(miss_ds)
    miss_full = filters.apply(miss_ds.df, miss_fp)
    print(f"[7] 欠測データ: フィルタ初期状態 {len(miss_full)} / {miss_ds.n_rows} 行")
    assert len(miss_full) == miss_ds.n_rows, "欠測行が初期状態のフィルタで消えています"

    # 数値レンジを狭めても、欠測行は（判定不能として）通ったままであること
    lo, hi = miss_fp.num_widgets["x"].start, miss_fp.num_widgets["x"].end
    miss_fp.num_widgets["x"].value = (lo, lo)  # x==1.0 の行だけに絞る
    narrowed = filters.apply(miss_ds.df, miss_fp)
    print(f"[7.1] x を先頭値だけに絞り込み: {len(narrowed)} 行（x が欠測の行は通る）")
    assert narrowed["x"].isna().sum() == 1, "欠測行がレンジ絞り込みで消えています"
    assert len(narrowed) == 2, "絞り込み結果の件数が想定と違います"  # x==1.0 の1件 + x欠測の1件

    # 統計量の agg は pandas の既定（skipna=True）で欠測を無視して計算されること
    summary = miss_ds.df[["x", "y"]].agg(["mean", "std", "min", "max"])
    assert not summary.isna().any().any(), "mean/std/min/max が欠測で NaN になっています"

    # 回帰は欠測行を落としたうえで、実際に使った件数を正しく報告すること
    miss_fit = r_bridge.linear_model(miss_ds.df, "x", "y")
    print(f"[7.2] 欠測込みデータの回帰: 件数={miss_fit['件数'].iloc[0]}")
    assert miss_fit["件数"].iloc[0] == 3, "回帰の使用件数が欠測除外後の件数と一致しません"

    print("\nすべて通りました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
