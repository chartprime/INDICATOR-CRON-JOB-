"""Check reservation owners without sending signals on Windows."""

import ctypes
from ctypes import wintypes
import os


def pid_alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        if pid > 0xFFFFFFFF:
            return False
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        wait = kernel.WaitForSingleObject
        wait.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        wait.restype = wintypes.DWORD
        close = kernel.CloseHandle
        close.argtypes = [wintypes.HANDLE]
        close.restype = wintypes.BOOL
        handle = open_process(0x00100000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            outcome = wait(handle, 0)
            if outcome == 0:
                return False
            if outcome == 258:
                return True
            raise ctypes.WinError(ctypes.get_last_error())
        finally:
            close(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
