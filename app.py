"""Brushlink — TIBCO Spotfire に着想を得たクロスフィルタ・ダッシュボード。

起動:
    panel serve app.py --show
    panel serve app.py --show --args data/your.csv   # 開発用: 起動時に読ませる CSV/Parquet を指定
"""

from __future__ import annotations

import sys

import panel as pn
import param

from src import charts, data, filters, r_bridge

pn.extension("tabulator", sizing_mode="stretch_width")
charts.hv.extension("bokeh")

# ---------------------------------------------------------------
# データ読み込み（--args にパスがあればそれを、無ければサンプル）
# --args は開発用の補助。製品としての入り口は画面上部のアップロードにする。
# ---------------------------------------------------------------
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else None
ds = data.load(CSV_PATH)


class AppState(param.Parameterized):
    """データ・フィルタの再構築を 1 つの version にまとめる再描画トリガー。

    フィルタパネルはアップロードのたびに列構成が変わり、ウィジェットの
    「個数」自体が変わる。個々のウィジェットに @pn.depends で直接ぶら下がると、
    パネルを作り直した瞬間に依存関係が古いウィジェット群を指したまま固定されて
    しまうため、version という 1 個の param に間接化して回避している。
    """

    version = param.Integer(default=0)

    def bump(self, *_):
        self.version += 1


state = AppState()

# ---------------------------------------------------------------
# ウィジェット
# ---------------------------------------------------------------
x_sel = pn.widgets.Select(name="X 軸", options=ds.num_cols, value=ds.num_cols[0])
y_sel = pn.widgets.Select(name="Y 軸", options=ds.num_cols, value=ds.num_cols[-1])
c_sel = pn.widgets.Select(name="色分け", options=[None] + ds.cat_cols)
fit_btn = pn.widgets.Button(name="選択範囲を回帰", button_type="primary")

linker = charts.new_linker()

# --- データアップロード -------------------------------------------------
upload = pn.widgets.FileDropper(
    accepted_filetypes=[".csv", ".xlsx", ".xls"],
    multiple=False,
    layout="compact",
    max_file_size="200MB",
)
header_row_input = pn.widgets.IntInput(
    name="ヘッダ行（0 始まり）", value=0, start=0, end=1000, step=1, width=180
)
upload_status = pn.pane.Markdown("", margin=(5, 0))
_last_upload: tuple[str, bytes | str] | None = None

# --- フィルタパネル -------------------------------------------------
filter_panel = filters.build(ds)
filter_box = pn.Column(*filter_panel.widgets())


def _watch_filter_panel(panel: filters.FilterPanel) -> None:
    """フィルタウィジェットの変更を state.version に束ねる。"""
    for w in panel.widgets():
        w.param.watch(state.bump, "value")


_watch_filter_panel(filter_panel)


def filtered_df():
    """フィルタパネルの現在値で絞った母集団。以降のすべての表示の入力元。"""
    return filters.apply(ds.df, filter_panel)


def _reload(new_ds) -> None:
    """新しいデータで ds・ウィジェット・フィルタパネルを作り直す。

    列構成が変わるので、軸セレクタの選択肢とフィルタパネルの中身を総入れ替えする。
    進行中のチャート選択がリセットされるのはフィルタ変更時と同じ仕様（README 参照）。
    """
    global ds, filter_panel

    # ds と filter_panel は必ずペアで差し替える。x_sel.value などへの代入は
    # Panel の @pn.depends を同期的に発火させる（chart_view が filtered_df() 経由で
    # ds と filter_panel の両方を読む）ため、先に両方を新しい組で揃えてから
    # ウィジェットの options/value を更新しないと、新 ds ＋旧 filter_panel という
    # 不整合な組み合わせで再描画されて KeyError になる。
    ds = new_ds
    filter_panel = filters.build(ds)
    _watch_filter_panel(filter_panel)
    filter_box[:] = filter_panel.widgets()

    # x_sel/y_sel/c_sel は別々のウィジェット（＝別々の Parameterized インスタンス）
    # なので、1 つずつ .value を更新すると「x だけ新列・y はまだ旧列」という
    # 中間状態で chart_view が同期的に再発火してしまう（旧列は新データに存在せず
    # KeyError になる）。値自体はここで即座に書き換わるが、
    # batch_call_watchers で各ウィジェットの「変更通知」だけを block の終わりまで
    # 遅らせることで、chart_view 側が読みに来た時点では x/y/by が揃った状態になる。
    with (
        param.parameterized.batch_call_watchers(x_sel),
        param.parameterized.batch_call_watchers(y_sel),
        param.parameterized.batch_call_watchers(c_sel),
    ):
        x_sel.options = ds.num_cols
        x_sel.value = ds.num_cols[0]
        y_sel.options = ds.num_cols
        y_sel.value = ds.num_cols[-1]
        c_sel.options = [None] + ds.cat_cols
        c_sel.value = None

    state.bump()


def _try_load(filename: str, content, header_row: int) -> None:
    """アップロード内容を読み込み、成功なら反映・失敗なら画面にエラーを出す。

    黙って落とさないのが要件なので、想定内（LoadError）・想定外の例外を
    どちらもここで拾い、日本語メッセージに揃えて upload_status に出す。
    """
    try:
        new_ds = data.load_from_upload(filename, content, header_row=header_row)
    except data.LoadError as e:
        upload_status.object = f"⚠️ {e}"
        return
    except Exception as e:  # 想定外の例外もアプリを落とさず画面に出す
        upload_status.object = f"⚠️ 予期しないエラーが発生しました: {e}"
        return

    _reload(new_ds)
    upload_status.object = f"✅ 「{filename}」を読み込みました（{new_ds.n_rows:,} 行）"


def _on_upload(event) -> None:
    global _last_upload
    if not upload.value:
        return
    filename, content = next(iter(upload.value.items()))
    _last_upload = (filename, content)
    _try_load(filename, content, header_row_input.value)


def _on_header_row_change(event) -> None:
    # ヘッダ行だけ変えて読み直したいケース（1 行目がヘッダでない実験データ）に対応。
    if _last_upload is None:
        return
    filename, content = _last_upload
    _try_load(filename, content, header_row_input.value)


upload.param.watch(_on_upload, "value")
header_row_input.param.watch(_on_header_row_change, "value")


# ---------------------------------------------------------------
# チャート（選択の発信源）
# フィルタ・データが変わると母集団ごと作り直すため、進行中の選択はリセットされる
# （README 参照。フィルタと選択は別系統という設計上、許容している）。
# ---------------------------------------------------------------
@pn.depends(state.param.version, x=x_sel, y=y_sel, by=c_sel)
def chart_view(_version, x, y, by):
    return charts.build(linker, filtered_df(), x, y, by)


# ---------------------------------------------------------------
# 選択の受け手：統計量・データ表
# ---------------------------------------------------------------
@pn.depends(state.param.version, expr=linker.param.selection_expr)
def stats_view(_version, expr):
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


@pn.depends(state.param.version, expr=linker.param.selection_expr)
def table_view(_version, expr):
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
upload_section = pn.Column(
    pn.pane.Markdown(
        "### データ読み込み\n"
        "CSV / Excel(.xlsx) をドラッグ＆ドロップ。"
        "1 行目がヘッダでない場合はヘッダ行を指定してください。"
    ),
    pn.Row(upload, header_row_input),
    upload_status,
)

pn.template.FastListTemplate(
    title="Brushlink",
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
        filter_box,
        pn.layout.Divider(),
        pn.pane.Markdown("### 分析"),
        fit_btn,
        pn.pane.Markdown(
            "散布図をドラッグして範囲選択すると、"
            "ヒストグラム・統計量・データ表が同時に絞り込まれます。\n\n"
            "※ フィルタ変更・データの再読み込み時は母集団が作り直されるため、"
            "進行中の選択はリセットされます。"
        ),
    ],
    main=[
        upload_section,
        pn.layout.Divider(),
        pn.Row(chart_view, pn.Column(stats_view, model_view, table_view)),
    ],
    accent="#2f6f9f",
).servable()
