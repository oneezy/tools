#!/usr/bin/env bash
# Compatibility shim: the wizard lives in packages/task-manager (oneezy/tools#75).
exec bash "$(dirname -- "$0")/../../packages/task-manager/setup-secrets.sh" "$@"
