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

    print("\nすべて通りました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
