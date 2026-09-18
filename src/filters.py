"""サイドバーのフィルタパネル：チャートの選択（マーキング）とは別系統の絞り込み。

役割分担:
    フィルタ   … 母集団そのものを絞る（このモジュール）
    チャート選択 … 絞られた母集団の「中で」ドラッグして選ぶ（charts.py / link_selections）

この 2 つを混ぜると「今何が母集団か」が分からなくなるため、
フィルタ後の DataFrame を単一の source of truth とし、
チャート・統計量・表・回帰はすべてこれを経由させる（app.py 側の責務）。

依存の例外について:
    CLAUDE.md の一般則は「src は Panel に依存させない」だが、
    「フィルタ UI の生成を src に置き、app.py にはロジックを書かない」という
    要件上、ウィジェット生成自体がこのモジュールの責務になる。
    そのため filters.py に限り import panel を許容している
    （charts.py 側の禁止はチャート描画ロジックと UI を混ぜないための規約であり、
    ここでは意図的に UI 生成が本体）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd
import panel as pn

from src.data import DataSource


@dataclass
class FilterPanel:
    """生成済みのフィルタウィジェット一式。app.py はレイアウトに差し込むだけにする。"""

    num_widgets: dict[str, pn.widgets.RangeSlider] = field(default_factory=dict)
    cat_widgets: dict[str, pn.widgets.CheckBoxGroup] = field(default_factory=dict)

    def widgets(self) -> list:
        """サイドバーに並べる順番でウィジェットを返す。"""
        return [*self.num_widgets.values(), *self.cat_widgets.values()]

    def params(self) -> list:
        """pn.depends に渡す param 一覧。値の変化をチャート等に伝播させるために使う。"""
        return [w.param.value for w in (*self.num_widgets.values(), *self.cat_widgets.values())]


def build(ds: DataSource) -> FilterPanel:
    """列のメタ情報からフィルタウィジェットを組み立てる。

    数値列はレンジスライダー、カテゴリ列はチェックボックスグループ。
    初期値は「全件を通す」状態（フル範囲・全選択）にし、
    フィルタパネルを開いた直後に母集団が意図せず絞られないようにする。
    """
    panel = FilterPanel()
    for col in ds.num_cols:
        lo = float(ds.df[col].min())
        hi = float(ds.df[col].max())
        step = (hi - lo) / 100 if hi > lo else 1.0
        panel.num_widgets[col] = pn.widgets.RangeSlider(
            name=col, start=lo, end=hi, value=(lo, hi), step=step
        )
    for col in ds.cat_cols:
        options = sorted(ds.df[col].dropna().unique().tolist())
        panel.cat_widgets[col] = pn.widgets.CheckBoxGroup(
            name=col, options=options, value=list(options), inline=False
        )
    return panel


def apply(df: pd.DataFrame, panel: FilterPanel) -> pd.DataFrame:
    """フィルタウィジェットの現在値で母集団を絞り込む。

    チャートの選択（charts.apply_selection）とは別系統。
    ここでの絞り込み結果が以降のすべての描画・統計・回帰の入力になる。
    カテゴリのチェックを全部外した場合は「該当なし」として 0 件を返す
    （何も選ばれていない＝絞り込み無し、ではなく素直に空集合として扱う）。

    欠測値（NaN）はレンジのどの範囲にも属さず、チェックボックスの選択肢にも
    含まれない（build() で dropna 済み）。そのため between/isin をそのまま
    使うと、フィルタを一切操作していなくても欠測を含む行だけ母集団から
    消えてしまい、「初期状態は全件を通す」という設計が崩れる。
    研究室データでは測定漏れが珍しくないため、欠測は「除外する理由がない」
    として、レンジ・チェックボックスのどちらの条件も欠測なら通す扱いにする。
    """
    mask = pd.Series(True, index=df.index)
    for col, widget in panel.num_widgets.items():
        lo, hi = widget.value
        col_data = df[col]
        mask &= col_data.between(lo, hi) | col_data.isna()
    for col, widget in panel.cat_widgets.items():
        col_data = df[col]
        mask &= col_data.isin(widget.value) | col_data.isna()
    return df[mask]
