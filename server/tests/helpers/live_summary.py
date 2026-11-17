"""ライブ要約のテストの共通の部品"""

from remote_whisper.gpu.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.settings import SettingsStore
from remote_whisper.summary.live_summary import LiveSummarizer


class StubWriter:
    id = "20261010-100000"

    def __init__(self):
        self.live_summary = None
        self.title = None

    def save_live_summary(self, text):
        self.live_summary = text

    def set_title(self, title):
        self.title = title


class Harness:
    def __init__(self, home, fake, context=None):
        self.settings = SettingsStore(home)
        # 0.006 分 = 0.36 秒ごと
        self.settings.update({"ollama": {"liveSummaryIntervalMin": 0.006}})
        self.ollama = OllamaClient(Hub(), self.settings, transport=fake.transport())
        self.gpu = GpuQueue()
        self.writer = StubWriter()
        self.sent: list[dict] = []
        self.seconds = 0.0
        self.live = LiveSummarizer(
            self.ollama,
            self.gpu,
            self.settings,
            self.writer,
            self._send,
            lambda: self.seconds,
            context=context,
            check_interval=0.02,
        )

    async def _send(self, message):
        self.sent.append(message)

    def of_type(self, t):
        return [m for m in self.sent if m["type"] == t]

    async def close(self):
        await self.live.close()
        await self.live.wait()
        await self.gpu.stop()
