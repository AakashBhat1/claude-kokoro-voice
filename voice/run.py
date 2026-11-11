"""Type something and hear it in the Kokoro af_heart voice. Start with: python run.py"""

import subprocess
import sys
from pathlib import Path

FOLDER = Path(__file__).resolve().parent
VENV_FOLDER = FOLDER / ".venv"
VENV_PYTHON = VENV_FOLDER / "Scripts" / "python.exe"
MODEL_FILE = FOLDER / "models" / "kokoro-v1.0.int8.onnx"
VOICES_FILE = FOLDER / "models" / "voices-v1.0.bin"

VOICE = "af_heart"
LANGUAGE = "en-us"
SPEED = 1.0  # 1.0 is normal; try 1.15 or 1.3 for faster speech.
QUIT_WORDS = {"q", "quit", "exit"}


def running_in_venv() -> bool:
    return Path(sys.prefix).resolve() == VENV_FOLDER.resolve()


def relaunch_in_venv() -> int:
    """Run this script again with the folder's own Python, which has the voice installed."""
    if not VENV_PYTHON.exists():
        print(f"Missing {VENV_PYTHON}. In this folder, run:")
        print("  uv venv --python 3.12")
        print("  uv pip install -r requirements.txt")
        return 1
    return subprocess.run([str(VENV_PYTHON), str(Path(__file__).resolve())]).returncode


def load_voice():
    from kokoro_onnx import Kokoro

    for required in (MODEL_FILE, VOICES_FILE):
        if not required.exists():
            raise FileNotFoundError(f"Missing voice file: {required}")
    print("Loading the voice...")
    return Kokoro(str(MODEL_FILE), str(VOICES_FILE))


def speak(voice, text: str) -> None:
    import sounddevice

    samples, sample_rate = voice.create(text, voice=VOICE, speed=SPEED, lang=LANGUAGE)
    sounddevice.play(samples, sample_rate)
    try:
        sounddevice.wait()
    except KeyboardInterrupt:
        sounddevice.stop()
        print("Stopped.")


def prompt_loop(voice) -> None:
    while True:
        try:
            text = input("Type something (q to quit): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not text:
            continue
        if text.lower() in QUIT_WORDS:
            return
        try:
            speak(voice, text)
        except Exception as error:  # Keep the prompt alive and show what went wrong.
            print(f"Could not say that: {error}")


def main() -> int:
    try:
        if not running_in_venv():
            return relaunch_in_venv()
        prompt_loop(load_voice())
    except KeyboardInterrupt:
        print()
    except FileNotFoundError as error:
        print(error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
