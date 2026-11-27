"""セットアップの案内で、頼まれたことをできないときの例外"""


class SetupError(Exception):
    """頼まれたことをできない（status は HTTP のステータス。code・params は web が文を引く
    コードと値。#494。spec/api.md 7.6）"""

    def __init__(self, status: int, code: str, message: str, params: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.params = params or {}
