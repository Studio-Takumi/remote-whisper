"""モックのサーバーを動かすテストの共通の部品"""

from remote_whisper.mock import MockTiming

# Windows の asyncio は時計の分解能が約 15.6ms なので、それより短い待ち時間は 0 になってしまう
FAST = MockTiming(
    whisper_load=0.05,
    partial=0.02,
    chars_per_partial=8,
    gap=0.02,
    live_summary=0.5,
    stream=0.0,
    resume_timeout=0.3,
)


def receive_until(ws, pred, limit=2000):
    """pred に合うメッセージが来るまで読み、それまでのメッセージ（合ったものを含む）を返す"""
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if pred(msg):
            return seen
    raise AssertionError(f"来なかった: {seen[-5:]}")


def of_type(message_type, **fields):
    return lambda m: m["type"] == message_type and all(m.get(k) == v for k, v in fields.items())


def audio(seq: int, n: int = 320) -> bytes:
    return seq.to_bytes(4, "little") + b"\0" * n


def start(ws, project="D--work-meetings-a1b2c3"):
    ws.send_json({"type": "start", "project": project})
    return receive_until(ws, of_type("started"))[-1]["session"]
