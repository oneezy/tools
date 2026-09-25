#!/usr/bin/env sh
# Run with: sh remote-control.sh. No executable bit or Bash dependency required.
exec python3 "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/remote_sessions.py" "$@"
