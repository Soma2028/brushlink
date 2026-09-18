"""クロスフィルタの中核が動くかを検証するスモークテスト。

panel serve せずに、選択条件を与えて絞り込みと回帰が通ることを確認する。
    python tests/smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import holoviews as hv  # noqa: E402

from src import charts, data, r_bridge  # noqa: E402

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

    # 選択範囲への回帰
    fit = r_bridge.linear_model(sub, "温度", "収率")
    print(f"[4] 回帰 ({r_bridge.backend_name()}):")
    print(fit.to_string(index=False))
    assert "傾き" in fit.columns

    print("\nすべて通りました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
