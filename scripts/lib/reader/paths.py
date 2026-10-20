"""工程路径与配置文件加载（读取层共享）。"""
from __future__ import annotations

import json
import pathlib
import tempfile
import os

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CONFIG_PATH = ROOT / "config" / "app.json"
STATE_DIR = ROOT / "state"
TOKENS_DIR = STATE_DIR / "tokens"
LOG_DIR = STATE_DIR / "logs"
KEYS_PATH = STATE_DIR / "keys.json"


def project_path(*parts: str) -> pathlib.Path:
    """拼出工程内绝对路径。"""
    return ROOT.joinpath(*parts)


def load_config() -> dict:
    """读取 config/app.json；不存在或损坏时抛 ConfigError 风格异常。"""
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as error:
        raise RuntimeError(f"CONFIG_MISSING: {CONFIG_PATH}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"CONFIG_PARSE_ERROR: {error}") from error


def save_config_atomic(config: dict) -> None:
    """原子写回配置（保留未知字段由调用方负责）。"""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(prefix=".app.json.", dir=str(CONFIG_PATH.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(tmp, CONFIG_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def reader_token() -> str:
    """读取读取层 Bearer token（state/tokens/reader.txt）。"""
    path = TOKENS_DIR / "reader.txt"
    try:
        token = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as error:
        raise RuntimeError("READER_TOKEN_MISSING: 请先运行 npm run init") from error
    if len(token) != 64:
        raise RuntimeError("READER_TOKEN_INVALID: state/tokens/reader.txt 不是 64-hex")
    return token


def log_file() -> pathlib.Path:
    """读取层日志文件路径。"""
    return LOG_DIR / "reader.log"
