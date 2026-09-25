"""Cross-process exclusive file locks for Windows and Linux. Python standard library only."""
from contextlib import contextmanager
import os
import time


@contextmanager
def file_lock(path, timeout=30, busy='Another launcher action is still running.'):
    """Hold an exclusive lock on a file, waiting up to timeout seconds, else raise RuntimeError(busy).
    The file stays in place so another process cannot lock a different inode."""
    with open(path, 'a+b') as stream:
        stream.seek(0, 2)
        if not stream.tell():
            stream.write(b'\0')
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(busy)
                time.sleep(.1)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)
