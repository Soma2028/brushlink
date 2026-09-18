"""データ層：DuckDB への読み込みと、列メタ情報の推定。

Spotfire でいう「データテーブル」に相当する部分。
CSV / Parquet / Excel を DuckDB にロードし、アプリ側は SQL 経由で触る。
画面からのアップロード（`load_from_upload`）は pandas でパースしてから
DuckDB に登録する。DuckDB のネイティブリーダーはファイルパス前提で、
アップロードはメモリ上の bytes/str が相手になるため経路を分けている。
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

TABLE = "t"  # アプリ内で扱う論理テーブル名
UPLOAD_SUFFIXES = (".csv", ".xlsx", ".xls")  # 画面からのアップロードで受け付ける拡張子


class LoadError(ValueError):
    """データ読み込みの失敗。メッセージはそのまま画面に出せる日本語にする。

    アップロード操作はユーザーの手元にある任意のファイルが相手なので、
    形式違反・空データなどは「起こり得る」前提で個別に検知し、
    スタックトレースではなく日本語の理由を返す。
    """


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


def _finalize(con: duckdb.DuckDBPyConnection, df: pd.DataFrame) -> DataSource:
    """列の型・カーディナリティを推定し、DataSource を組み立てる。

    読み込み経路（サンプル生成／ファイルパス／アップロード）に依らない共通処理。
    数値列が 2 つ未満だと散布図が描けないため、ここで弾いて理由を返す。
    """
    num_cols = df.select_dtypes("number").columns.tolist()
    cat_cols = [c for c in df.columns if c not in num_cols]

    if len(num_cols) < 2:
        raise LoadError(
            "散布図を描くには数値列が 2 つ以上必要です。"
            "区切り文字やヘッダ行の指定が正しいか確認してください。"
        )

    return DataSource(con=con, df=df, num_cols=num_cols, cat_cols=cat_cols)


def load(path: str | Path | None = None, n_rows: int = 20_000) -> DataSource:
    """CSV / Parquet をロードする。path が None ならサンプルを生成。

    `--args` によるパス指定は開発用の補助（製品方針: ターミナル操作を前提にしない）。
    画面からのアップロードは `load_from_upload()` を使う。
    """
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
    return _finalize(con, df)


def load_from_upload(
    filename: str, content: bytes | str, header_row: int = 0
) -> DataSource:
    """画面のドロップ領域からアップロードされたファイルをロードする。

    - .csv / .xlsx / .xls に対応。判定はファイル名の拡張子で行う。
    - header_row はヘッダ行の 0 始まりインデックス。1 行目がヘッダでない
      実験データ（機器の出力など）があるため、呼び出し側で指定できるようにしてある。
    - Panel の FileDropper は text 系ファイルを str に自動デコードして渡してくる
      （バイナリの xlsx は bytes のまま）。両方を受けられるようにしている。
    - 失敗時は LoadError（日本語メッセージ）に正規化する。
      アップロードは形式違反や空ファイルが普通に起こるので、
      ここで拾って呼び出し側がそのまま画面に出せるようにする。
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in UPLOAD_SUFFIXES:
        raise LoadError(
            f"対応していないファイル形式です: {filename}"
            f"（対応形式: {', '.join(UPLOAD_SUFFIXES)}）"
        )

    try:
        if suffix in (".xlsx", ".xls"):
            buf = io.BytesIO(content) if isinstance(content, bytes) else io.BytesIO(
                content.encode("utf-8")
            )
            df = pd.read_excel(buf, header=header_row)
        else:
            buf = io.StringIO(content) if isinstance(content, str) else io.BytesIO(content)
            df = pd.read_csv(buf, header=header_row)
    except LoadError:
        raise
    except Exception as e:  # ライブラリ側の例外はまとめて日本語メッセージに変換する
        raise LoadError(f"「{filename}」の読み込みに失敗しました: {e}") from e

    if df.shape[1] == 0:
        raise LoadError(
            f"「{filename}」から列を読み取れませんでした。ヘッダ行の指定を確認してください。"
        )
    if df.empty:
        raise LoadError(f"「{filename}」にデータ行がありません。")

    con = duckdb.connect(database=":memory:")
    con.register("_upload", df)
    con.execute(f"CREATE TABLE {TABLE} AS SELECT * FROM _upload")
    return _finalize(con, df)
