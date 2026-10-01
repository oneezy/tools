#!/usr/bin/env sh
# Compatibility shim: the tool lives in packages/remote-sessions (oneezy/tools#75).
exec sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../../packages/remote-sessions/remote-control.sh" "$@"
