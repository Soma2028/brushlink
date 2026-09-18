"""Brushlink — TIBCO Spotfire に着想を得たクロスフィルタ・ダッシュボード。

起動:
    panel serve app.py --show
    panel serve app.py --show --args data/your.csv   # 開発用: 起動時に読ませる CSV/Parquet を指定
"""

from __future__ import annotations

import sys

import pandas as pd
import panel as pn
import param

from src import charts, data, filters, r_bridge

pn.extension("tabulator", "filedropper", sizing_mode="stretch_width")
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
# ヘッダ行は数値で指定させるのではなく、先頭数行をそのまま表示して
# 「この行をヘッダにする」をクリックで選ばせる。自動推定はあくまで
# 初期選択（当てずっぽうで数字を打たせない）で、最終判断は必ずここで
# 目視・クリックできるようにする。
upload = pn.widgets.FileDropper(
    accepted_filetypes=[".csv", ".xlsx", ".xls"],
    multiple=False,
    layout="compact",
    max_file_size="200MB",
)
preview_table = pn.widgets.Tabulator(
    pd.DataFrame(),
    disabled=True,
    selectable=1,
    show_index=True,
    height=190,
    theme="simple",
)
preview_hint = pn.pane.Markdown("", margin=(0, 0, 5, 0))
upload_status = pn.pane.Markdown("", margin=(5, 0))
_last_upload: tuple[str, bytes | str] | None = None
_syncing_preview_selection = False  # 推定行のセットを「ユーザーのクリック」と混同しないためのガード

# --- フィルタパネル -------------------------------------------------
filter_panel = filters.build(ds)
filter_box = pn.Column(*filter_panel.widgets())
filter_exclusion_note = pn.pane.Markdown("", margin=(0, 0, 5, 0))


def _watch_filter_panel(panel: filters.FilterPanel) -> None:
    """フィルタウィジェットの変更を state.version に束ねる。"""
    for w in panel.widgets():
        w.param.watch(state.bump, "value")


def _update_filter_exclusion_note() -> None:
    """高カーディナリティ列を除外した旨をサイドバーに 1 行出す。

    除外自体は data._finalize() が ds.high_card_cols として既にやっている
    （filters.build/c_sel は ds.cat_cols しか見ないので自動的に対象外になる）。
    ここでは「なぜ選択肢に出てこないのか」が分かるよう、理由を可視化するだけ。
    """
    if not ds.high_card_cols:
        filter_exclusion_note.object = ""
        return
    names = "、".join(f"{c}（{ds.df[c].nunique():,}種）" for c in ds.high_card_cols)
    filter_exclusion_note.object = (
        f"⚠️ 高カーディナリティ列をフィルタ・色分けから除外: {names}"
    )


_watch_filter_panel(filter_panel)
_update_filter_exclusion_note()


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
    _update_filter_exclusion_note()

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
    """ファイルが drop されたら、まず生の先頭行をプレビューに出す。

    この時点ではまだ本読み込みしない（ヘッダ行が決まっていないため）。
    推定したヘッダ行を初期選択にし、それをそのまま最初の読み込みにも使う
    ——「推定に失敗してもプレビューから選び直せる」を成立させるため、
    最終的な読み込みトリガーは常に「プレビュー表の選択」に一本化する。
    """
    global _last_upload, _syncing_preview_selection

    if not upload.value:
        return
    filename, content = next(iter(upload.value.items()))
    _last_upload = (filename, content)

    try:
        raw = data.preview_upload(filename, content)
    except data.LoadError as e:
        upload_status.object = f"⚠️ {e}"
        preview_table.value = pd.DataFrame()
        preview_hint.object = ""
        return

    preview_table.value = raw
    guess = data.guess_header_row(raw)
    preview_hint.object = (
        f"推定ヘッダ行: **{guess} 行目**"
        "（文字列だけの行の次に数値中心の行が続く箇所を推定）。"
        "違う場合は下の表で行をクリックして選び直してください。"
    )
    upload_status.object = ""

    # プログラムでの selection 代入は「ユーザーのクリック」と区別する
    # （_on_preview_select を二重発火させず、下の _try_load 呼び出し1回に絞るため）。
    _syncing_preview_selection = True
    try:
        preview_table.selection = [guess]
    finally:
        _syncing_preview_selection = False

    _try_load(filename, content, guess)


def _on_preview_select(event) -> None:
    """プレビュー表の行クリック＝「この行をヘッダにする」。選ぶたびに読み直す。"""
    if _syncing_preview_selection or _last_upload is None or not preview_table.selection:
        return
    header_row = preview_table.selection[0]
    filename, content = _last_upload
    _try_load(filename, content, header_row)


upload.param.watch(_on_upload, "value")
preview_table.param.watch(_on_preview_select, "selection")


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

    # mean/std/min/max は pandas の既定（skipna=True）で欠測を自動的に無視する
    # ため NaN にはならないが、「無視された件数」自体は見えない。
    # 研究室データでは測定漏れが常態なので、列ごとの欠測件数を明示する。
    summary = sub[ds.num_cols].agg(["mean", "std", "min", "max"]).T.round(2)
    summary["欠測"] = sub[ds.num_cols].isna().sum()

    # 選択の有無に関わらず、母集団全体（数値・カテゴリ問わず）の欠測も出す。
    # ドラッグ選択する前から欠測の多さに気づけるようにするため。
    missing = fdf.isna().sum()
    missing = missing[missing > 0]
    if missing.empty:
        missing_note = "欠測: なし（母集団内）"
    else:
        detail = "、".join(f"{col}: {n:,} 件" for col, n in missing.items())
        missing_note = f"⚠️ 欠測（母集団 {len(fdf):,} 件中）: {detail}"

    return pn.Column(
        pn.pane.Markdown(
            f"#### 選択中 {len(sub):,} / 母集団 {len(fdf):,} 件 ({ratio:.1f}%) "
            f"— 全体 {ds.n_rows:,} 件"
        ),
        pn.widgets.Tabulator(summary, disabled=True, height=190),
        pn.pane.Markdown(missing_note, margin=(5, 0, 0, 0)),
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
        "先頭数行のプレビューが出るので、ヘッダの行をクリックして選んでください。"
    ),
    upload,
    preview_hint,
    preview_table,
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
        filter_exclusion_note,
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
