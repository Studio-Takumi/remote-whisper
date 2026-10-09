"""アプリ全体で共有する状態"""

from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

from remote_whisper.settings import SettingsStore


@dataclass
class AppContext:
    home: Path
    settings: SettingsStore
    # 録音中のセッションの数。録音マネージャ（#20）ができるまでは常に 0
    recordings: int = 0

    @property
    def is_recording(self) -> bool:
        return self.recordings > 0

    def ensure_not_recording(self) -> None:
        """録音中は設定や選択を変えられない（spec 5.3・8）"""
        if self.is_recording:
            raise HTTPException(status_code=409, detail="録音中は変更できません")


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx
