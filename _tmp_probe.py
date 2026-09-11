import json
import ssl
import socket

KEY = "sk-RW29ZGbYzfCCmfzZOeTKIFDIQtr6k5kLcNMKX4420WV2bHP0"
HOST = "115.191.2.88"
PORT = 443


def request(method, path, body=None, extra_headers=None):
    ctx = ssl._create_unverified_context()
    raw = socket.create_connection((HOST, PORT), timeout=20)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    headers = {
        "Host": HOST,
        "Authorization": f"Bearer {KEY}",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    lines = [f"{method} {path} HTTP/1.1"]
    for k, v in headers.items():
        lines.append(f"{k}: {v}")
    lines.append("Connection: close")
    req = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + payload
    s.sendall(req)
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
    header_blob, _, rest = data.partition(b"\r\n\r\n")
    return header_blob.decode("utf-8", "replace"), rest.decode("utf-8", "replace")


TARGETS = [
    ("GET", "/v1/models", None),
    ("POST", "/v1/assets/list", {"p": 1, "page_size": 5}),
    ("GET", "/v1/assets/groups", None),
    ("POST", "/v1/assets/list", {}),
    ("POST", "/api/user/self", None),
    ("GET", "/api/status", None),
    ("POST", "/v1/chat/completions", {"model": "pan-seedance-2.0", "messages": [{"role": "user", "content": "hi"}]}),
    ("GET", "/v1/video/tasks?p=1&page_size=5", None),
]

for method, path, body in TARGETS:
    try:
        head, rest = request(method, path, body)
        status = head.splitlines()[0] if head else "(no status)"
        print(f"### {method} {path}\n{status}")
        print(rest[:1200])
    except Exception as exc:  # noqa: BLE001
        print(f"### {method} {path}\nERR {type(exc).__name__}: {exc}")
    print("=" * 60)
