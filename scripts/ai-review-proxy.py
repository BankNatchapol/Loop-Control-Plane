#!/usr/bin/env python3
"""
Minimal OpenAI-compatible proxy for PR Agent headless reviews.

Receives litellm chat-completion requests from PR Agent and routes them to
the configured headless agent CLI — no raw API keys needed.

Supported agents (AGENT_PLUGIN env var):
  claude-code  →  claude -p "<prompt>" --output-format text --model <model>
  codex        →  codex exec -c model="<model>" --sandbox read-only "<prompt>"
  cursor       →  agent --print --trust --model <model> -- "<prompt>"

Usage:
  AGENT_PLUGIN=claude-code AGENT_MODEL=claude-sonnet-4-6 python3 scripts/ai-review-proxy.py [port]
  AGENT_PLUGIN=codex       AGENT_MODEL=gpt-5.5            python3 scripts/ai-review-proxy.py [port]
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

AGENT_PLUGIN = os.environ.get("AGENT_PLUGIN", "claude-code")
AGENT_MODEL = os.environ.get("AGENT_MODEL", "").strip()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 14231

DEFAULT_MODELS: dict[str, str] = {
    "claude-code": "claude-sonnet-4-6",
    "codex": "gpt-5.5",
    "cursor": "composer-2.5",
}


def resolve_model(plugin: str) -> str:
    """Return the UI-selected model, independent of PR Agent's transport model."""
    return AGENT_MODEL or DEFAULT_MODELS.get(plugin, "")


def messages_to_prompt(messages: list[dict]) -> str:
    """Flatten an OpenAI messages array into a single text prompt."""
    parts: list[str] = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                c.get("text", "") for c in content if c.get("type") == "text"
            )
        label = {"system": "System", "user": "User", "assistant": "Assistant"}.get(role, role.title())
        parts.append(f"[{label}]\n{content}")
    return "\n\n".join(parts)


def call_claude(prompt: str, model: str) -> str:
    # Pass prompt via stdin (-p -) to avoid OS arg-length limits on large PR diffs.
    r = subprocess.run(
        ["claude", "-p", "-", "--output-format", "text", "--model", model],
        input=prompt,
        capture_output=True, text=True, timeout=180,
    )
    if r.returncode != 0:
        stderr_hint = r.stderr.strip()[:400] if r.stderr else "(no stderr)"
        stdout_hint = r.stdout.strip()[:400] if r.stdout else "(no stdout)"
        raise RuntimeError(
            f"claude CLI error (exit {r.returncode}): "
            f"stdout={stdout_hint}; stderr={stderr_hint}"
        )
    return r.stdout.strip()


def call_codex(prompt: str, model: str) -> str:
    # "-" tells codex exec to read the prompt from stdin, avoiding argument limits.
    r = subprocess.run(
        [
            "codex", "exec",
            "--model", model,
            "--sandbox", "read-only",
            "--ephemeral",
            "--ignore-rules",
            "-",
        ],
        input=prompt,
        capture_output=True, text=True, timeout=240,
    )
    if r.returncode != 0:
        error_output = (r.stdout + r.stderr).strip()
        raise RuntimeError(
            f"codex CLI error (exit {r.returncode}): "
            f"{error_output[:400] or '(no output)'}"
        )
    out = r.stdout.strip()
    if not out:
        raise RuntimeError("codex CLI returned no output")
    return out


def call_cursor(prompt: str, model: str) -> str:
    """Run cursor agent in headless print mode for PR review analysis."""
    import tempfile, os, shlex

    # Write prompt to a temp file to avoid OS arg-length limits on large PR diffs.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write(prompt)
        prompt_file = f.name

    try:
        # --print runs cursor in headless (non-interactive) mode and outputs to stdout.
        # --trust bypasses workspace trust check, which is required in --print mode.
        # Use shell=True + $(cat ...) to feed the prompt without hitting arg-length limits.
        cmd = (
            f"agent --print --trust --model {shlex.quote(model)}"
            f' -- "$(cat {shlex.quote(prompt_file)})"'
        )
        r = subprocess.run(
            cmd,
            shell=True,
            capture_output=True, text=True, timeout=180,
        )
        if r.returncode != 0:
            stderr_hint = r.stderr.strip()[:400] if r.stderr else "(no stderr)"
            stdout_hint = r.stdout.strip()[:400] if r.stdout else "(no stdout)"
            raise RuntimeError(
                f"cursor agent CLI error (exit {r.returncode}): "
                f"stdout={stdout_hint}; stderr={stderr_hint}"
            )
        out = r.stdout.strip()
        if not out:
            raise RuntimeError("cursor agent returned no output")
        return out
    finally:
        try:
            os.unlink(prompt_file)
        except OSError:
            pass


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[ai-review-proxy] {fmt % args}", file=sys.stderr, flush=True)

    def _send_json(self, code: int, obj: dict) -> None:
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/health", "/v1/models"):
            self._send_json(200, {"status": "ok", "agent": AGENT_PLUGIN})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": "only /v1/chat/completions is supported"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))

        messages = body.get("messages", [])
        requested_model = body.get("model", "")
        model = resolve_model(AGENT_PLUGIN)
        prompt = messages_to_prompt(messages)

        print(
            f"[ai-review-proxy] transport={requested_model} "
            f"agent={AGENT_PLUGIN}/{model} — {len(prompt)} chars",
            file=sys.stderr, flush=True,
        )

        try:
            if AGENT_PLUGIN == "codex":
                text = call_codex(prompt, model)
            elif AGENT_PLUGIN == "cursor":
                text = call_cursor(prompt, model)
            else:
                text = call_claude(prompt, model)
        except subprocess.TimeoutExpired:
            self._send_json(504, {"error": {"message": "Review timed out."}})
            return
        except Exception as exc:
            self._send_json(502, {"error": {"message": f"Proxy error: {exc}"}})
            return

        self._send_json(200, {
            "id": "chatcmpl-headless-001",
            "object": "chat.completion",
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), ProxyHandler)
    actual_port = server.server_address[1]
    # Write ready signal to stdout so the parent process knows we're up.
    print(f"PROXY_READY port={actual_port} agent={AGENT_PLUGIN}", flush=True)
    print(f"[ai-review-proxy] Listening on 127.0.0.1:{actual_port} (agent={AGENT_PLUGIN})", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
