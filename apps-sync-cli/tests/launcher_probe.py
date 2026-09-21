"""Run the desktop shortcut's console command in the caller's terminal."""
import os
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
command = f'{os.environ["COMSPEC"]} /d /c ""{root / "Manage Software.cmd"}""'
sys.exit(subprocess.run(command, cwd=root).returncode)
