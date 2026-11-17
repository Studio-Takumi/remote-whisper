"""録音の WebSocket を動かすテストの共通の部品"""

import time

import av


def receive_until(ws, pred, limit=200):
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if pred(msg):
            return seen
    raise AssertionError(f"来なかった: {seen[-5:]}")


def of_type(message_type, **fields):
    return lambda m: m["type"] == message_type and all(m.get(k) == v for k, v in fields.items())


def chunk(seq: int, samples: int = 8000, value: int = 0) -> bytes:
    return seq.to_bytes(4, "little") + value.to_bytes(2, "little", signed=True) * samples


def start(ws, pid):
    ws.send_json({"type": "start", "project": pid})
    return receive_until(ws, of_type("started"))[-1]["session"]


def finished(client, sid):
    """録音を終えたあとの処理（残りの文字起こし・変換）が終わるまで待つ"""
    session = client.app.state.ctx.recorder.sessions[sid]
    client.portal.call(session.wait_finished)


def audio_seconds(path):
    with av.open(str(path)) as f:
        return f.duration / 1e6


def wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < deadline, "時間内に終わらなかった"
        time.sleep(0.05)


def interrupted_session(client, pid, seconds=1.5):
    """seconds 秒話してから接続が切れ、interrupted になったセッションを作る"""
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(int(seconds * 2)):
            ws.send_bytes(chunk(seq, value=3000))
            receive_until(ws, of_type("ack", seq=seq))
    wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
    finished(client, sid)
    return sid
