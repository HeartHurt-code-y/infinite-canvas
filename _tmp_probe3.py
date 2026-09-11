import json
import ssl
import socket
import time

KEY = "sk-RW29ZGbYzfCCmfzZOeTKIFDIQtr6k5kLcNMKX4420WV2bHP0"
HOST = "115.191.2.88"
TASKS = ["task_6MO8ej5Oo60snrfQkN3dQvUCXj7Wl2tx", "task_r9N6ofRkK2snUvLn5rFtB33L9CIysFWD"]


def request(method, path, body=None, port=443):
    ctx = ssl._create_unverified_context()
    raw = socket.create_connection((HOST, port), timeout=25)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    headers = {"Host": HOST, "Authorization": f"Bearer {KEY}", "Accept": "application/json"}
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    lines = [f"{method} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in headers.items()] + ["Connection: close"]
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode() + payload)
    data = b""
    s.settimeout(45)
    while True:
        try:
            chunk = s.recv(65536)
        except Exception as exc:  # noqa: BLE001
            data += f"\n[recv-error {exc}]".encode()
            break
        if not chunk:
            break
        data += chunk
    s.close()
    head, _, rest = data.partition(b"\r\n\r\n")
    return head.decode("utf-8", "replace"), rest.decode("utf-8", "replace")


for round_index in range(3):
    print(f"########## round {round_index} ##########")
    for task in TASKS:
        for path in (f"/v1/video/generations/{task}", f"/v1/videos/{task}"):
            try:
                head, rest = request("GET", path)
                status = head.splitlines()[0] if head else "(no status)"
                print(f"### GET {path}\n{status}\n{rest[:900]}")
            except Exception as exc:  # noqa: BLE001
                print(f"### GET {path}\nERR {type(exc).__name__}: {exc}")
    if round_index < 2:
        time.sleep(20)
