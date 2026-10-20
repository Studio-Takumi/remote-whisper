"""日時と ID。spec/files.md 5.2・5.5"""

from datetime import datetime


def now() -> datetime:
    """タイムゾーン付きの今の時刻（サーバーのローカル時刻）"""
    return datetime.now().astimezone()


def iso(dt: datetime) -> str:
    """フロントマターや project.json に書く日時。例: 2026-10-09T14:30:12+09:00"""
    return dt.isoformat(timespec="seconds")


def make_id(dt: datetime) -> str:
    """セッション・参考資料セット・要約の生成の ID。例: 20261009-143012"""
    return dt.strftime("%Y%m%d-%H%M%S")
