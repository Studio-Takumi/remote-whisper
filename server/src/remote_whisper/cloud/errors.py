"""クラウド版の中間サーバーとのやり取りの失敗（#158）。spec/cloud.md 10.5・10.6"""


class CloudError(Exception):
    """中間サーバーとのやり取りに失敗した。メッセージはそのまま通知に出す"""


class RegistrationGone(CloudError):
    """Worker にこのホストの登録がない・署名が通らない（画面から外したなど）。聞き直さない"""


class CloudRefused(CloudError):
    """聞き直しても変わらない断り（署名が通らない・申請の形が違うなど）。待たずにやめる"""
