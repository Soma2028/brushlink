"""可視化層：チャート生成と、チャート間の選択連動（マーキング）。

HoloViews の link_selections が連動の中核。
これに渡したチャート同士は、片方でドラッグ選択すると
もう片方も同じ選択状態にハイライトされる。
"""

from __future__ import annotations

import holoviews as hv
import hvplot.pandas  # noqa: F401  (DataFrame に .hvplot を生やす副作用インポート)
import pandas as pd


def new_linker() -> hv.selection.link_selections:
    """選択状態を共有するリンカーを 1 つ作る。アプリ全体で使い回す。"""
    return hv.link_selections.instance(unselected_alpha=0.15)


def scatter(df: pd.DataFrame, x: str, y: str, by: str | None = None):
    """主役の散布図。ここをドラッグして範囲選択する。

    デフォルトツールが pan だとドラッグしてもパンするだけで選択できないため、
    box_select を初期状態からアクティブにしておく（lasso も併用可能にする）。
    """
    return df.hvplot.scatter(
        x=x,
        y=y,
        by=by,
        alpha=0.4,
        size=14,
        height=380,
        responsive=True,
        legend="top_right",
    ).opts(
        tools=["box_select", "lasso_select", "hover"],
        active_tools=["box_select"],
    )


def histogram(df: pd.DataFrame, col: str, bins: int = 40):
    """分布確認用のヒストグラム。散布図の選択に連動する。"""
    return df.hvplot.hist(y=col, bins=bins, height=190, responsive=True)


def build(
    linker: hv.selection.link_selections,
    df: pd.DataFrame,
    x: str,
    y: str,
    by: str | None = None,
):
    """散布図＋ヒストグラム 2 枚を連動させたレイアウトを返す。"""
    layout = scatter(df, x, y, by) + histogram(df, x) + histogram(df, y)
    return linker(layout).cols(1)


def apply_selection(df: pd.DataFrame, expr) -> pd.DataFrame:
    """選択条件（selection_expr）を DataFrame に適用する。

    未選択のときは全件を返す。表・統計量・R 連携はすべてこれを通す。
    """
    if expr is None:
        return df
    return hv.Dataset(df).select(expr).dframe()
