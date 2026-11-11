# claude-kokoro-voice

A Claude Code mod that reads Claude's **final reply** aloud with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a small text-to-speech model that runs on your own computer. It skips thinking, tool calls, code blocks and tables, so you can listen while you do something else.

| Command | What it does |
|---|---|
| `/enable` | Reads each final reply aloud |
| `/enable last` | Reads only the last paragraph of each final reply |
| `/enable--close` (also `/enable --close`, `/disable`) | Stops speech and ends the voice process, freeing its memory |

Typing a new prompt stops the current speech. The voice also exits by itself when the session ends, or 3 minutes after Claude Code stops checking in (for example after a crash).

## Install

### 1. The mod

At the prompt of a Claude Code terminal session:

```
/plugin install kokoro-voice --marketplace AakashBhat1/claude-kokoro-voice
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install kokoro-voice --marketplace AakashBhat1/claude-kokoro-voice
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `AakashBhat1/claude-kokoro-voice`, then **Add plugin**.

### 2. The voice

The voice is a small Python server in this repository's `voice/` folder. Copy that folder anywhere you like. The examples below use `<voice folder>` for wherever you put it. You need [uv](https://docs.astral.sh/uv/).

Download the model files (int8, about 88 MB, plus 27 MB of voices) into `<voice folder>/models/`:

- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

Create the CPU environment (works everywhere). In `<voice folder>`, run:

```
uv venv --python 3.12
uv pip install -r requirements.txt
```

**Optional, Windows only: GPU through DirectML.** About 1.7× faster on an Intel Arc GPU, but it keeps about 600 MB of RAM reserved while the voice is on. The mod tries the GPU first and falls back to the CPU.

```
uv venv --python 3.12 .venv-gpu
uv pip install --python .venv-gpu\Scripts\python.exe -r requirements-gpu.txt
uv pip install --python .venv-gpu\Scripts\python.exe --no-deps kokoro-onnx==0.6.1
.venv-gpu\Scripts\python.exe patch_convtranspose.py models\kokoro-v1.0.int8.onnx models\kokoro-v1.0.int8.dml.onnx
```

The patch rewrites Kokoro's 1-D grouped `ConvTranspose` layers as the identical 2-D layers, because DirectML rejects the 1-D ones. The speech is the same.

### 3. Tell the mod where the voice is

Run `/config`, find **kokoro-voice: Voice folder**, and enter the full path of `<voice folder>` (the folder that holds `speak_server.py`). Nothing is built in: until this is set, `/enable` just asks for it.

Then run `/enable`.

## How it works

- `speak_server.py` loads the model once and listens only on `127.0.0.1:59125`. It accepts `POST /say`, `POST /stop` and `POST /quit`, and answers `GET /health`.
- The mod sends it the final reply when a turn ends. Before sending, it removes code, tables, link addresses and long inline code, and shortens file paths to the file name.
- It builds the next group of sentences while the current one plays, so speech starts within about a second.
- Memory measured on an Intel Core Ultra 9 185H: about 190 MB idle and 390–470 MB while speaking on the CPU; about 620 MB idle and 830 MB while speaking on the GPU. All of it is freed when the voice closes.

`run.py` is a separate prompt: type text and hear it, without Claude Code.

## License

MIT
