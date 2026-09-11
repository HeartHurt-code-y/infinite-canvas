import json
import ssl
import socket

KEY = "sk-RW29ZGbYzfCCmfzZOeTKIFDIQtr6k5kLcNMKX4420WV2bHP0"
HOST = "115.191.2.88"


def request(method, path, body=None, port=443):
    ctx = ssl._create_unverified_context()
    raw = socket.create_connection((HOST, port), timeout=20)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    headers = {"Host": HOST, "Authorization": f"Bearer {KEY}", "Accept": "*/*"}
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    lines = [f"{method} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in headers.items()] + ["Connection: close"]
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode() + payload)
    data = b""
    s.settimeout(30)
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
    status = head.splitlines()[0] if head else "(no status)"
    return status, rest.decode("utf-8", "replace")[:400], head


ASSET_PATHS = [
    ("POST", "/v1/assets/list"),
    ("GET", "/v1/assets/groups"),
    ("GET", "/v1/assets"),
    ("POST", "/v1/asset/list"),
    ("GET", "/v1/files"),
    ("POST", "/v1/files"),
    ("GET", "/v1/uploads"),
    ("POST", "/v1/uploads"),
    ("GET", "/api/assets"),
    ("GET", "/api/asset/groups"),
    ("GET", "/v1/images/generations"),
    ("POST", "/v1/images/generations"),
    ("POST", "/v1/images/edits"),
    ("POST", "/v1/responses"),
    ("GET", "/v1/tasks"),
    ("POST", "/v1/video/generations/estimate"),
]

for method, path in ASSET_PATHS:
    try:
        status, rest, _ = request(method, path, {} if method == "POST" else None)
        print(f"{method:5} {path:42} {status}  {rest[:200].replace(chr(10), ' ')}")
    except Exception as exc:  # noqa: BLE001
        print(f"{method:5} {path:42} ERR {type(exc).__name__}: {exc}")
