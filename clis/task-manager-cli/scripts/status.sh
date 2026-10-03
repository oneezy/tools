#!/usr/bin/env bash
# Compatibility shim: the script lives in packages/task-manager/scripts (oneezy/tools#75).
exec bash "$(dirname -- "$0")/../../../packages/task-manager/scripts/status.sh" "$@"
