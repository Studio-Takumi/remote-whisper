"""用語の選び出しのテストの共通の部品"""

import json

from remote_whisper.gpu.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.settings import SettingsStore
from remote_whisper.transcript.term_picker import TermPicker


class StubMeta:
    def __init__(self, picked=(), rejected=()):
        self.picked_terms = list(picked)
        self.rejected_terms = list(rejected)
        self.manual_terms = []


class StubWriter:
    id = "20261012-100000"

    def __init__(self, picked=(), rejected=()):
        self.meta = StubMeta(picked, rejected)
        self.saved = None

    def set_terms(self, picked, rejected):
        self.saved = (list(picked), list(rejected))


def terms_reply(*terms):
    """JSON Schema（terms）付きの頼み方に、この語を返す"""

    def reply(body):
        fmt = body.get("format") or {}
        if "terms" in fmt.get("properties", {}):
            return json.dumps({"terms": list(terms)}, ensure_ascii=False)
        return None

    return reply


async def make(home, fake, writer=None):
    settings = SettingsStore(home)
    changes = []
    sent = []

    async def send(m):
        sent.append(m)

    picker = TermPicker(
        OllamaClient(Hub(), settings, transport=fake.transport()),
        GpuQueue(),
        settings,
        writer or StubWriter(),
        send,
        lambda: 0.0,
        changes.append,
        check_interval=3600,
    )
    return picker, changes, sent


LINES = [
    "フォトンリンクの導入について話します。",
    "フォトンリンクはケルビン同期を使います。",
    "ケルビン同期の設定は鈴木さんが担当です。",
    "リブラ監査は来月です。",
]
