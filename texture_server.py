#!/usr/bin/env python3
"""
Minimal generic static/raw-file server for main.html (M&B Warband .sco/
terrain-code viewer).

This file intentionally contains ZERO Warband-specific interpretation - no
.dds decoding, no .brf chunk parsing, no scene_props.txt/materials.brf
resolution, no sokf_* flag knowledge. All of that now lives client-side in
main.html (see its DDS/BRF/scene-props JS modules), so this server is just:
  1. Static files from its own directory (main.html itself, loaded .sco/.txt
     files the user picks, etc.) - via the stock SimpleHTTPRequestHandler.
  2. GET /list/<relpath>  -> JSON array of filenames directly inside
     WARBAND_ROOT/<relpath> (a plain os.listdir() - generic, works for any
     directory under the root, no per-filetype logic).
  3. GET /raw/<relpath>   -> raw bytes of WARBAND_ROOT/<relpath>, whatever the
     file is (.dds, .brf, .txt, ...) - the client decides how to parse it.
  4. POST /debug-save/<name> -> dev helper: saves a POSTed file to
     .debug_captures/<name>, unchanged from before.

Usage:
    python texture_server.py [port]        (default port 8791)

Then open http://localhost:8791/main.html in a browser.
"""
import http.server
import json
import os
import socketserver
import sys
from urllib.parse import unquote

WARBAND_ROOT = r"C:\Program Files (x86)\Steam\steamapps\common\MountBlade Warband"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEBUG_DIR = os.path.join(SCRIPT_DIR, ".debug_captures")
os.makedirs(DEBUG_DIR, exist_ok=True)

_WARBAND_ROOT_ABS = os.path.abspath(WARBAND_ROOT)


def _resolve_under_root(relpath):
    """Joins relpath onto WARBAND_ROOT and returns the absolute path, or None
    if the result would escape WARBAND_ROOT (e.g. via "../..") - the only
    safety check this server does; it does not otherwise inspect file
    contents or extensions."""
    relpath = relpath.lstrip("/\\")
    candidate = os.path.abspath(os.path.join(_WARBAND_ROOT_ABS, relpath))
    if candidate != _WARBAND_ROOT_ABS and not candidate.startswith(_WARBAND_ROOT_ABS + os.sep):
        return None
    return candidate


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SCRIPT_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        # Dev server - never let the browser cache a response across a restart.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.startswith("/debug-save/"):
            name = os.path.basename(self.path[len("/debug-save/"):].split("?", 1)[0])
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length)
            out_path = os.path.join(DEBUG_DIR, name)
            with open(out_path, "wb") as f:
                f.write(data)
            body = json.dumps({"saved": out_path}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/list/"):
            relpath = unquote(self.path[len("/list/"):].split("?", 1)[0])
            abspath = _resolve_under_root(relpath)
            if abspath is None or not os.path.isdir(abspath):
                self._send_json({"error": "not a directory"}, status=404)
                return
            try:
                names = os.listdir(abspath)
            except OSError as e:
                self._send_json({"error": str(e)}, status=500)
                return
            self._send_json(names)
            return

        if self.path.startswith("/raw/"):
            relpath = unquote(self.path[len("/raw/"):].split("?", 1)[0])
            abspath = _resolve_under_root(relpath)
            if abspath is None or not os.path.isfile(abspath):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            with open(abspath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        return super().do_GET()

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        sys.stderr.write("[texture_server] %s - %s\n" % (self.address_string(), format % args))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    if not os.path.isdir(WARBAND_ROOT):
        print(f"[texture_server] WARNING: WARBAND_ROOT not found: {WARBAND_ROOT}", file=sys.stderr)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[texture_server] serving {SCRIPT_DIR} (static) + {WARBAND_ROOT} (via /list, /raw) "
          f"on http://localhost:{port}/")
    print(f"[texture_server] open http://localhost:{port}/main.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
