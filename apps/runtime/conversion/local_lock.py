"""Process-lifetime local filesystem lock. Never unlink the lock inode.

This is not a distributed lease and is not an S3 locking implementation.
"""
import os


def conversion_guard_path(curated_root, dataset_version):
    from writer import validate_version
    validate_version(dataset_version)
    return os.path.join(os.path.realpath(curated_root), "_locks", f"conversion.{dataset_version}.guard")


class LocalLock:
    def __init__(self, path):
        self.path = os.fspath(path)
        self.file = None

    def acquire(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        fh = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(fh.fileno()).st_size == 0:
                    fh.write(b"0")
                    fh.flush()
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            fh.close()
            raise
        self.file = fh
        return self

    def release(self):
        if self.file is not None:
            self.file.close()
            self.file = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
