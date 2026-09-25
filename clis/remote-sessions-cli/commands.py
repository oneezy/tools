"""How to run a configured executable. Standard library only."""
import sys


def prefix(executable):
    """The command words that run `executable`: a Python script through this interpreter, a PowerShell script through
    pwsh, anything else directly. The script forms let tests stand a fake in for `claude` or `wsl`."""
    if executable.endswith('.py'):
        return [sys.executable, executable]
    if executable.endswith('.ps1'):
        return ['pwsh', '-NoProfile', '-File', executable]
    return [executable]
