import json
import ssl
import socket

KEY = "sk-RW29ZGbYzfCCmfzZOeTKIFDIQtr6k5kLcNMKX4420WV2bHP0"
HOST = "115.191.2.88"


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
    s.settimeout(60)
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


TARGETS = [
    ("POST", "/v1/video/generations", {"model": "pan-seedance-2.0", "prompt": "a cat walking on the beach"}),
    ("POST", "/v1/videos", {"model": "pan-seedance-2.0", "prompt": "a cat walking on the beach", "seconds": "4"}),
    ("GET", "/v1/video/generations/task_does_not_exist", None),
    ("GET", "/v1/videos/task_does_not_exist", None),
]

for method, path, body in TARGETS:
    try:
        head, rest = request(method, path, body)
        status = head.splitlines()[0] if head else "(no status)"
        print(f"### {method} {path}\n{status}\n{rest[:1500]}")
    except Exception as exc:  # noqa: BLE001
        print(f"### {method} {path}\nERR {type(exc).__name__}: {exc}")
    print("=" * 60)
