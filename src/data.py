"""データ層：DuckDB への読み込みと、列メタ情報の推定。

Spotfire でいう「データテーブル」に相当する部分。
CSV / Parquet を DuckDB にロードし、アプリ側は SQL 経由で触る。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

TABLE = "t"  # アプリ内で扱う論理テーブル名


@dataclass
class DataSource:
    """DuckDB 接続と、その上のテーブルのメタ情報をまとめて持つ。"""

    con: duckdb.DuckDBPyConnection
    df: pd.DataFrame
    num_cols: list[str] = field(default_factory=list)
    cat_cols: list[str] = field(default_factory=list)

    @property
    def n_rows(self) -> int:
        return len(self.df)

    def sql(self, query: str) -> pd.DataFrame:
        """任意の SQL を実行して DataFrame で返す（SQL コンソール用）。"""
        return self.con.execute(query).fetchdf()


def make_sample(n_rows: int = 20_000, seed: int = 42) -> pd.DataFrame:
    """製造プロセスを模したサンプルデータ。

    ロットごとに温度の中心がずれ、温度と収率に相関があるので、
    クロスフィルタの効き目が目で見て分かる。
    """
    rng = np.random.default_rng(seed)
    lot = rng.choice(["A", "B", "C", "D"], n_rows, p=[0.4, 0.3, 0.2, 0.1])
    center = pd.Series(lot).map({"A": 100.0, "B": 104.0, "C": 97.0, "D": 110.0})

    df = pd.DataFrame(
        {
            "温度": rng.normal(center, 6.0),
            "圧力": rng.gamma(9.0, 1.2, n_rows),
            "収率": rng.normal(80.0, 7.0, n_rows),
            "ロット": pd.Series(lot, dtype="string"),
        }
    )
    df["収率"] += (df["温度"] - 100.0) * 0.35
    return df.round(3)


def load(path: str | Path | None = None, n_rows: int = 20_000) -> DataSource:
    """CSV / Parquet をロードする。path が None ならサンプルを生成。"""
    con = duckdb.connect(database=":memory:")

    if path is None:
        sample = make_sample(n_rows)
        con.register("_sample", sample)
        con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM _sample")
    else:
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"データファイルが見つかりません: {p}")
        reader = "read_parquet" if p.suffix.lower() == ".parquet" else "read_csv_auto"
        con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM {reader}('{p.as_posix()}')")

    df = con.execute(f"SELECT * FROM {TABLE}").fetchdf()
    num_cols = df.select_dtypes("number").columns.tolist()
    cat_cols = [c for c in df.columns if c not in num_cols]

    if len(num_cols) < 2:
        raise ValueError("散布図を描くには数値列が 2 つ以上必要です")

    return DataSource(con=con, df=df, num_cols=num_cols, cat_cols=cat_cols)
