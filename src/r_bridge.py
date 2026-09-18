"""R 連携層：選択範囲に対して R の統計モデルを走らせる。

本家 Spotfire の TERR（埋め込み R エンジン）に相当する部分。
rpy2 と R が入っていない環境では numpy による代替実装に自動フォールバックし、
アプリ自体は動き続ける。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:  # rpy2 と R 本体が揃っているかを起動時に一度だけ判定
    import rpy2.robjects as ro
    from rpy2.robjects import pandas2ri

    _CONVERTER = ro.default_converter + pandas2ri.converter
    R_AVAILABLE = True
except Exception:  # ImportError / R 未インストール など
    R_AVAILABLE = False


def backend_name() -> str:
    """UI に表示する、いま動いている計算エンジンの名前。"""
    return "R (rpy2)" if R_AVAILABLE else "numpy (R 未検出のため代替)"


def _lm_with_r(df: pd.DataFrame, x: str, y: str) -> dict[str, float]:
    """R の lm() で単回帰を実行する。"""
    with _CONVERTER.context():
        ro.globalenv["d"] = df[[x, y]].rename(columns={x: "x", y: "y"})
    ro.r("fit <- lm(y ~ x, data = d)")
    coef = np.asarray(ro.r("as.numeric(coef(fit))"))
    r2 = float(np.asarray(ro.r("summary(fit)$r.squared"))[0])
    pval = float(np.asarray(ro.r("summary(fit)$coefficients[2, 4]"))[0])
    return {"切片": float(coef[0]), "傾き": float(coef[1]), "R^2": r2, "p 値": pval}


def _lm_with_numpy(df: pd.DataFrame, x: str, y: str) -> dict[str, float]:
    """R が無い環境用の代替。傾き・切片・R^2 のみ（p 値は算出しない）。"""
    xs = df[x].to_numpy(dtype=float)
    ys = df[y].to_numpy(dtype=float)
    slope, intercept = np.polyfit(xs, ys, 1)
    pred = slope * xs + intercept
    ss_res = float(((ys - pred) ** 2).sum())
    ss_tot = float(((ys - ys.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot else float("nan")
    return {"切片": float(intercept), "傾き": float(slope), "R^2": r2, "p 値": float("nan")}


def linear_model(df: pd.DataFrame, x: str, y: str) -> pd.DataFrame:
    """選択範囲に対して y ~ x の単回帰をかけ、結果を 1 行の表で返す。"""
    sub = df[[x, y]].dropna()
    if len(sub) < 3:
        return pd.DataFrame({"メッセージ": ["データが少なすぎます（3 件以上必要）"]})

    result = _lm_with_r(sub, x, y) if R_AVAILABLE else _lm_with_numpy(sub, x, y)
    result = {"件数": float(len(sub)), **result}
    return pd.DataFrame([result]).round(4)
