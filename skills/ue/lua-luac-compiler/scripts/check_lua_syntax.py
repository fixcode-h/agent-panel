#!/usr/bin/env python3
"""Check Lua source syntax with the installed lupa runtime."""

import sys
from pathlib import Path

from lupa import LuaRuntime


def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: {Path(sys.argv[0]).name} <file.lua> [file.lua ...]", file=sys.stderr)
        return 2

    lua = LuaRuntime(unpack_returned_tuples=True)
    load = lua.eval("load")
    failed = False

    for argument in sys.argv[1:]:
        path = Path(argument)
        try:
            source = path.read_text(encoding="utf-8-sig")
            result = load(source, str(path))
        except (OSError, UnicodeError) as error:
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
            continue

        if isinstance(result, tuple):
            chunk = result[0]
            error = result[1] if len(result) > 1 else "syntax error"
        else:
            chunk = result
            error = "syntax error"

        if chunk is None:
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
        else:
            print(f"OK {path}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
