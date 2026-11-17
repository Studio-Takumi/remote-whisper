"""セットアップの案内で、頼まれたことをできないときの例外"""


class SetupError(Exception):
    """頼まれたことをできない（status は HTTP のステータス）"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
