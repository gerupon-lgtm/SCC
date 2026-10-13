# 開発用のサーバー。python -m http.server と同じだが、ブラウザに「保存した写しを使わない」と伝える
# 標準のままだと、ブラウザが古い JavaScript を使い続け、変更が反映されないことがあるため
# 使い方：python tools/serve.py   （http://localhost:8000）
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=ROOT)
with http.server.ThreadingHTTPServer(("", PORT), handler) as httpd:
    print(f"http://localhost:{PORT}")
    httpd.serve_forever()
