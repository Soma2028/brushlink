"""Spotfire 風クロスフィルタ・ダッシュボード。

起動:
    panel serve app.py --show
    panel serve app.py --show --args data/your.csv   # 自分の CSV を使う場合
"""

from __future__ import annotations

import sys

import panel as pn

from src import charts, data, filters, r_bridge

pn.extension("tabulator", sizing_mode="stretch_width")
charts.hv.extension("bokeh")

# ---------------------------------------------------------------
# データ読み込み（--args にパスがあればそれを、無ければサンプル）
# ---------------------------------------------------------------
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else None
ds = data.load(CSV_PATH)

# ---------------------------------------------------------------
# ウィジェット
# ---------------------------------------------------------------
x_sel = pn.widgets.Select(name="X 軸", options=ds.num_cols, value=ds.num_cols[0])
y_sel = pn.widgets.Select(name="Y 軸", options=ds.num_cols, value=ds.num_cols[-1])
c_sel = pn.widgets.Select(name="色分け", options=[None] + ds.cat_cols)
fit_btn = pn.widgets.Button(name="選択範囲を回帰", button_type="primary")

filter_panel = filters.build(ds)
linker = charts.new_linker()


def filtered_df():
    """フィルタパネルの現在値で絞った母集団。以降のすべての表示の入力元。"""
    return filters.apply(ds.df, filter_panel)


# ---------------------------------------------------------------
# チャート（選択の発信源）
# フィルタが変わると母集団ごと作り直すため、進行中の選択はリセットされる
# （README 参照。フィルタと選択は別系統という設計上、許容している）。
# ---------------------------------------------------------------
@pn.depends(*filter_panel.params(), x=x_sel, y=y_sel, by=c_sel)
def chart_view(*_filter_values, x, y, by):
    return charts.build(linker, filtered_df(), x, y, by)


# ---------------------------------------------------------------
# 選択の受け手：統計量・データ表
# ---------------------------------------------------------------
@pn.depends(*filter_panel.params(), expr=linker.param.selection_expr)
def stats_view(*_filter_values, expr):
    fdf = filtered_df()
    sub = charts.apply_selection(fdf, expr)
    ratio = len(sub) / len(fdf) * 100 if len(fdf) else 0.0
    summary = sub[ds.num_cols].agg(["mean", "std", "min", "max"]).T.round(2)
    return pn.Column(
        pn.pane.Markdown(
            f"#### 選択中 {len(sub):,} / 母集団 {len(fdf):,} 件 ({ratio:.1f}%) "
            f"— 全体 {ds.n_rows:,} 件"
        ),
        pn.widgets.Tabulator(summary, disabled=True, height=190),
    )


@pn.depends(*filter_panel.params(), expr=linker.param.selection_expr)
def table_view(*_filter_values, expr):
    sub = charts.apply_selection(filtered_df(), expr)
    return pn.widgets.Tabulator(
        sub.head(300),
        disabled=True,
        height=300,
        layout="fit_data_stretch",
        show_index=False,
    )


# ---------------------------------------------------------------
# R 連携：ボタンを押したときだけ、選択範囲にモデルを当てる
# ---------------------------------------------------------------
@pn.depends(fit_btn.param.clicks)
def model_view(_clicks):
    if not _clicks:
        return pn.pane.Markdown("_散布図で範囲を選び、ボタンを押すと回帰します_")
    sub = charts.apply_selection(filtered_df(), linker.selection_expr)
    result = r_bridge.linear_model(sub, x_sel.value, y_sel.value)
    return pn.Column(
        pn.pane.Markdown(
            f"**{y_sel.value} ~ {x_sel.value}** — エンジン: {r_bridge.backend_name()}"
        ),
        pn.widgets.Tabulator(result, disabled=True, height=90, show_index=False),
    )


# ---------------------------------------------------------------
# レイアウト
# ---------------------------------------------------------------
pn.template.FastListTemplate(
    title="Spotfire Lite",
    sidebar=[
        pn.pane.Markdown("### 表示設定"),
        x_sel,
        y_sel,
        c_sel,
        pn.layout.Divider(),
        pn.pane.Markdown(
            "### フィルタ\n"
            "母集団そのものを絞り込みます（チャートの選択とは別系統）。"
        ),
        *filter_panel.widgets(),
        pn.layout.Divider(),
        pn.pane.Markdown("### 分析"),
        fit_btn,
        pn.pane.Markdown(
            "散布図をドラッグして範囲選択すると、"
            "ヒストグラム・統計量・データ表が同時に絞り込まれます。\n\n"
            "※ フィルタを変更すると母集団が作り直されるため、"
            "進行中の選択はリセットされます。"
        ),
    ],
    main=[pn.Row(chart_view, pn.Column(stats_view, model_view, table_view))],
    accent="#2f6f9f",
).servable()
