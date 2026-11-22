"""Linux-only test gateway. Private upstream is accessible to the authority UID."""
import http.client
import json
import os
import socket
import struct
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn, UnixStreamServer


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(3)
        self.sock.connect(sys.argv[2])


class Gateway(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    address_string = lambda self: "local"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", ""))
            if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding"):
                raise ValueError("Invalid body length")
            data = self.rfile.read(length)
            message = json.loads(data)
            _, uid, _ = struct.unpack("3i", self.connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            policy = json.loads(Path(sys.argv[3]).read_bytes())
            allowed = ((uid == policy["executor"] and message.get("action") in ("open", "validate", "claim"))
                       or (uid == policy["operator"] and message.get("action") == "operator"))
            if self.path != "/authorize" or not allowed:
                return self.reply(403, b'{"error":"OS peer denied"}')
            upstream = UnixHTTP("localhost")
            try:
                upstream.request("POST", "/authorize", body=data)
                result = upstream.getresponse()
                body = result.read(8193)
                if len(body) > 8192:
                    raise ValueError("Invalid upstream response")
                self.reply(result.status, body)
            finally:
                upstream.close()
        except (ValueError, AttributeError, KeyError, TypeError, OSError, http.client.HTTPException):
            self.close_connection = True
            self.reply(503, b'{"error":"Peer identity, policy or authority unavailable"}')

    def reply(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


class Server(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    if not sys.platform.startswith("linux") or not hasattr(socket, "SO_PEERCRED"):
        sys.exit("Linux SO_PEERCRED required")
    with Server(sys.argv[1], Gateway) as server:
        os.chmod(sys.argv[1], 0o660)
        server.serve_forever()
