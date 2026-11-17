"""コンテキストセットのテストの共通の部品"""

from helpers.recorder import receive_until


def create_and_wait(client, pid, paths):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        res = client.post(f"/api/projects/{pid}/context-sets", json={"materials": paths})
        assert res.status_code == 202, res.text
        body = res.json()
        if body["reused"]:
            return body, []
        seen = receive_until(
            ws, lambda m: m["type"] == "contextSet" and m["status"] in ("ready", "failed")
        )
    return body, [m for m in seen if m["type"] == "contextSet"]
