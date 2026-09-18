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

# チェックボックス・色分けの対象から外す、カテゴリ列の最大ユニーク値数。
# 根拠: Bokeh の既定カテゴリパレット Category20 が持つ色数（20）。
# これを超えると色分けは色が循環してしまい区別の用をなさず、
# チェックボックスも縦に長くなって一覧性を失う。ID列・日付列のような
# 高カーディナリティ列を自動的にフィルタ・色分けの対象外にするための閾値。
MAX_CATEGORY_CARDINALITY = 20


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
    # カーディナリティが MAX_CATEGORY_CARDINALITY を超えたため cat_cols から
    # 除外した列。フィルタ・色分けの対象外だが、列自体は df に残っている。
    high_card_cols: list[str] = field(default_factory=list)

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
    all_cat_cols = [c for c in df.columns if c not in num_cols]

    if len(num_cols) < 2:
        raise LoadError(
            "散布図を描くには数値列が 2 つ以上必要です。"
            "区切り文字やヘッダ行の指定が正しいか確認してください。"
        )

    # ID列・日付列などはユニーク値が多く、チェックボックスにも色分けにも向かない。
    # cat_cols からは外し、high_card_cols 側に回す（画面には除外した旨を表示する）。
    high_card_cols = [
        c for c in all_cat_cols if df[c].nunique(dropna=True) > MAX_CATEGORY_CARDINALITY
    ]
    cat_cols = [c for c in all_cat_cols if c not in high_card_cols]

    return DataSource(
        con=con, df=df, num_cols=num_cols, cat_cols=cat_cols, high_card_cols=high_card_cols
    )


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


def _check_upload_suffix(filename: str) -> str:
    """拡張子が対応形式かを確認し、小文字化した拡張子を返す。"""
    suffix = Path(filename).suffix.lower()
    if suffix not in UPLOAD_SUFFIXES:
        raise LoadError(
            f"対応していないファイル形式です: {filename}"
            f"（対応形式: {', '.join(UPLOAD_SUFFIXES)}）"
        )
    return suffix


def _upload_buffer(suffix: str, content: bytes | str) -> io.BytesIO | io.StringIO:
    """アップロード内容を pandas に渡せるバッファにする。

    Panel の FileDropper は text 系ファイルを str に自動デコードして渡してくる
    （バイナリの xlsx は bytes のまま）。xlsx 側は必ずバイト列が要るため、
    str で来ていたら utf-8 で符号化し直す。
    """
    if suffix in (".xlsx", ".xls"):
        return io.BytesIO(content) if isinstance(content, bytes) else io.BytesIO(
            content.encode("utf-8")
        )
    return io.StringIO(content) if isinstance(content, str) else io.BytesIO(content)


def _cell_is_numeric(value: object) -> bool:
    """プレビューの 1 セルが「数値っぽいか」を判定する。

    xlsx は openpyxl がセルごとの元の型（int/float/str）を保持したまま
    DataFrame になるが、CSV はヘッダ行をまだ決めていない生読み込みの段階では
    列全体が object 型の文字列になる。数値型ならそのまま数値とみなし、
    文字列は float() を試して数値らしさを判定することで両方に対応する。
    """
    if pd.isna(value):
        return False
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        try:
            float(value.strip())
            return True
        except ValueError:
            return False
    return False


def _row_numeric_ratio(row: pd.Series) -> float:
    """行の中で値がある（NaN でない）セルのうち、数値っぽいセルの割合。"""
    values = [v for v in row.tolist() if pd.notna(v)]
    if not values:
        return 0.0
    return sum(_cell_is_numeric(v) for v in values) / len(values)


def preview_upload(filename: str, content: bytes | str, n_rows: int = 5) -> pd.DataFrame:
    """ヘッダ行を決める前の、加工していない先頭 n_rows 行を返す。

    型解釈（どの行をヘッダとして扱うか）を一切行わない生データで、
    画面のプレビュー表示と guess_header_row() の両方の入力になる。
    実際の読み込みは、ここで選んだ行を header_row として load_from_upload() に渡す。
    """
    suffix = _check_upload_suffix(filename)
    try:
        buf = _upload_buffer(suffix, content)
        if suffix in (".xlsx", ".xls"):
            raw = pd.read_excel(buf, header=None, nrows=n_rows)
        else:
            raw = pd.read_csv(buf, header=None, nrows=n_rows)
    except Exception as e:
        raise LoadError(f"「{filename}」の先頭行を読み取れませんでした: {e}") from e
    return raw


def guess_header_row(raw: pd.DataFrame) -> int:
    """プレビュー行からヘッダ行らしい行を推定する。

    「その行は文字列主体」かつ「次の行は数値主体」を満たす最初の行を採用する。
    タイトル行・単位行を挟むデータでも、実際のヘッダの直後は必ずデータ行に
    なることを利用している。見つからなければ 0 行目を既定にする。
    これはあくまで初期値のヒント。最終判断は画面側でユーザーに委ねてあり、
    推定が外れてもプレビュー表から別の行を選び直せば成立する設計にしてある。
    """
    for i in range(len(raw) - 1):
        this_row_is_text = _row_numeric_ratio(raw.iloc[i]) < 0.5
        next_row_is_data = _row_numeric_ratio(raw.iloc[i + 1]) >= 0.5
        if this_row_is_text and next_row_is_data:
            return i
    return 0


def load_from_upload(
    filename: str, content: bytes | str, header_row: int = 0
) -> DataSource:
    """画面のドロップ領域からアップロードされたファイルをロードする。

    - .csv / .xlsx / .xls に対応。判定はファイル名の拡張子で行う。
    - header_row はヘッダ行の 0 始まりインデックス。呼び出し側（app.py）が
      preview_upload()/guess_header_row() によるプレビューとユーザーの行選択で
      決めた値を渡してくる。
    - 失敗時は LoadError（日本語メッセージ）に正規化する。
      アップロードは形式違反や空ファイルが普通に起こるので、
      ここで拾って呼び出し側がそのまま画面に出せるようにする。
    """
    suffix = _check_upload_suffix(filename)

    try:
        buf = _upload_buffer(suffix, content)
        if suffix in (".xlsx", ".xls"):
            df = pd.read_excel(buf, header=header_row)
        else:
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
