"""Background voice for the Claude Code `kokoro-voice` mod.

Loads Kokoro once, then speaks text sent to it over localhost:
  POST /say    body = plain text; stops anything playing and speaks this instead
  POST /stop   silences it
  POST /quit   silences it and exits the process
  GET  /health answers "ok cpu" or "ok gpu" once the voice is loaded

With no request for --idle-exit seconds it exits by itself, so a crashed Claude Code
never leaves it holding memory (the mod checks in every minute).

GPU (DirectML, Intel Arc):  .venv-gpu\\Scripts\\python.exe speak_server.py --device gpu
CPU:                        .venv\\Scripts\\python.exe speak_server.py --device cpu
"""

import argparse
import os
import queue
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FOLDER = Path(__file__).resolve().parent
MODEL_FILES = {
    "cpu": FOLDER / "models" / "kokoro-v1.0.int8.onnx",  # the smallest Kokoro build (int8, ~88 MB)
    # The same model with its 1-D ConvTranspose layers rewritten as 2-D (patch_convtranspose.py),
    # which DirectML needs: it rejects the original layers.
    "gpu": FOLDER / "models" / "kokoro-v1.0.int8.dml.onnx",
}
VOICES_FILE = FOLDER / "models" / "voices-v1.0.bin"
DEFAULT_IDLE_EXIT_SECONDS = 180
IDLE_CHECK_SECONDS = 15

VOICE = "af_heart"
LANGUAGE = "en-us"
DEFAULT_PORT = 59125
DEFAULT_SPEED = 1.25  # 1.0 is Kokoro's normal pace
HOST = "127.0.0.1"  # never reachable from other machines
MAX_BODY_BYTES = 200_000
CHUNK_CHARS = 280  # later sentences are grouped up to this size
FIRST_CHUNK_CHARS = 100  # the first piece is short so speech starts within about a second
SENTENCE_END = re.compile(r"(?<=[.!?;:])\s+")


def split_into_chunks(text: str, limit: int = CHUNK_CHARS, first_limit: int = FIRST_CHUNK_CHARS) -> list[str]:
    """Group sentences into chunks: the first up to `first_limit` characters, the rest up to `limit`.

    A lone sentence longer than its limit stays whole.
    """
    chunks: list[str] = []
    current = ""
    for sentence in (part.strip() for part in SENTENCE_END.split(text)):
        if not sentence:
            continue
        joined = f"{current} {sentence}".strip()
        if current and len(joined) > (limit if chunks else first_limit):
            chunks.append(current)
            current = sentence
        else:
            current = joined
    if current:
        chunks.append(current)
    return chunks


class Speaker:
    """Speaks one text at a time; a newer text or a stop cuts the current one short."""

    def __init__(self, voice, speed: float):
        import sounddevice

        self._sd = sounddevice
        self._voice = voice
        self._speed = speed
        self._generation = 0
        self._lock = threading.Lock()
        self._jobs: queue.Queue[tuple[int, str]] = queue.Queue()
        threading.Thread(target=self._work, daemon=True).start()

    def say(self, text: str) -> None:
        generation = self._bump()
        self._jobs.put((generation, text))

    def stop(self) -> None:
        self._bump()

    def _bump(self) -> int:
        with self._lock:
            self._generation += 1
            generation = self._generation
        self._sd.stop()
        return generation

    def _is_current(self, generation: int) -> bool:
        with self._lock:
            return generation == self._generation

    def _work(self) -> None:
        while True:
            generation, text = self._jobs.get()
            try:
                self._speak(generation, text)
            except Exception as error:  # keep the server alive; report on stderr
                print(f"Could not speak: {error}", file=sys.stderr, flush=True)

    def _speak(self, generation: int, text: str) -> None:
        # Synthesize chunk N+1 while chunk N plays, so long replies start quickly.
        for chunk in split_into_chunks(text):
            if not self._is_current(generation):
                return
            samples, rate = self._voice.create(chunk, voice=VOICE, speed=self._speed, lang=LANGUAGE)
            self._sd.wait()
            if not self._is_current(generation):
                return
            self._sd.play(samples, rate)
        self._sd.wait()


class IdleWatch:
    """Exits the process once nobody has called for `limit` seconds."""

    def __init__(self, limit: float):
        self._limit = limit
        self._last_seen = time.monotonic()
        threading.Thread(target=self._watch, daemon=True).start()

    def seen(self) -> None:
        self._last_seen = time.monotonic()

    def _watch(self) -> None:
        while True:
            time.sleep(IDLE_CHECK_SECONDS)
            if time.monotonic() - self._last_seen > self._limit:
                print(f"No check-in for {self._limit:.0f} s; exiting to free memory.", file=sys.stderr, flush=True)
                os._exit(0)


def make_handler(speaker: Speaker, device: str, idle: IdleWatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            idle.seen()
            if self.path == "/health":
                self._answer(200, f"ok {device}")
            else:
                self._answer(404, "not found")

        def do_POST(self):
            idle.seen()
            if self.path == "/quit":
                speaker.stop()
                self._answer(200, "quitting")
                # Exit the whole process (and free all its memory) once the answer is sent.
                threading.Timer(0.2, lambda: os._exit(0)).start()
                return
            if self.path == "/stop":
                speaker.stop()
                self._answer(200, "stopped")
                return
            if self.path != "/say":
                self._answer(404, "not found")
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._answer(400, f"body must be 1..{MAX_BODY_BYTES} bytes")
                return
            text = self.rfile.read(length).decode("utf-8", errors="replace").strip()
            if not text:
                self._answer(400, "empty text")
                return
            speaker.say(text)
            self._answer(202, "speaking")

        def _answer(self, status: int, message: str) -> None:
            body = message.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep stdout quiet
            pass

    return Handler


def session_options(device: str):
    import onnxruntime

    onnxruntime.set_default_logger_severity(3)  # errors only; skip "nodes not assigned" notices
    options = onnxruntime.SessionOptions()
    if device == "gpu":
        # DirectML requires both of these.
        options.enable_mem_pattern = False
        options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
    else:
        # Give memory back after each sentence instead of keeping a growing arena
        # (measured: ~390 MB peak instead of ~500 MB, at ~3.0 s per 10 s of speech
        # instead of ~2.3 s). Memory patterns stay on: turning them off doubles the time.
        options.enable_cpu_mem_arena = False
    return options


def load_voice(device: str):
    import onnxruntime
    from kokoro_onnx import Kokoro

    model_file = MODEL_FILES[device]
    for required in (model_file, VOICES_FILE):
        if not required.exists():
            raise FileNotFoundError(f"Missing voice file: {required}")
    providers = ["DmlExecutionProvider"] if device == "gpu" else ["CPUExecutionProvider"]
    if not set(providers) <= set(onnxruntime.get_available_providers()):
        raise RuntimeError(f"{providers[0]} is not available in this Python environment")
    session = onnxruntime.InferenceSession(str(model_file), sess_options=session_options(device), providers=providers)
    voice = Kokoro.from_session(session, str(VOICES_FILE))
    # Warm up now (the GPU compiles its shaders on the first run) so the first reply
    # is not delayed, and so a device that cannot run the model fails here, not mid-reply.
    voice.create("Ready.", voice=VOICE, lang=LANGUAGE)
    return voice


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--speed", type=float, default=DEFAULT_SPEED)
    parser.add_argument("--device", choices=sorted(MODEL_FILES), default="cpu")
    parser.add_argument("--idle-exit", type=float, default=DEFAULT_IDLE_EXIT_SECONDS)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or not 0.5 <= args.speed <= 2.0 or not 30 <= args.idle_exit <= 86400:
        print("port must be 1024..65535, speed 0.5..2.0 and idle-exit 30..86400", file=sys.stderr)
        return 2
    try:
        speaker = Speaker(load_voice(args.device), args.speed)
        idle = IdleWatch(args.idle_exit)
        server = ThreadingHTTPServer((HOST, args.port), make_handler(speaker, args.device, idle))
    except Exception as error:  # report any load failure (missing files, device, port) and exit
        print(f"Could not start on {args.device}: {error}", file=sys.stderr, flush=True)
        return 1
    print(f"ready on http://{HOST}:{args.port} ({args.device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
