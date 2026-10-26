from __future__ import annotations

import collections
import contextlib
import copy
from collections import Counter
import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import archive_query as _archive_query
from archive_admission import STUDY_CLIENT_SUFFIX
import coverage_report as _coverage_report
from local_lock import LocalLock
from process_liveness import pid_alive

MANIFEST_CACHE_ENTRIES = 4096

MAX_CACHE_BYTES = 274_877_906_944
MIN_FREE_DISK_BYTES = 214_748_364_800

SNAPSHOT_TTL_SECONDS = 900
FETCH_CONCURRENCY = 8
_CHUNK = 1024 * 1024
_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_CAPACITY_LOCK_TIMEOUT_SECONDS = 30
_ARTIFACT_LOCK_TIMEOUT_SECONDS = 60
_RESERVATION_STALE_SECONDS = 900
MAX_SNAPSHOT_ENTRIES = 256
MAX_SNAPSHOT_ENTRIES_PER_CLIENT = 16

CACHE_CAPACITY_EXCEEDED = "CACHE_CAPACITY_EXCEEDED"
PARTITION_VERIFICATION_FAILED = "PARTITION_VERIFICATION_FAILED"
POINTER_TOKEN_INVALID = "POINTER_TOKEN_INVALID"


def pointer_owner(client):
    """The identity a pointer token belongs to.

    The gateway's `.study` suffix is a budget class (see archive_admission), never
    an identity: only the holder of the service secret can set the client header,
    and it adds the suffix to the viewer it authenticated. A study the gateway runs
    for a viewer may therefore read the snapshot that viewer's chart pinned, while
    its pages still spend the separate study budget and reader slot."""
    if client.endswith(STUDY_CLIENT_SUFFIX) and len(client) > len(STUDY_CLIENT_SUFFIX):
        return client[:-len(STUDY_CLIENT_SUFFIX)]
    return client
RANGE_TOO_LARGE = _archive_query.RANGE_TOO_LARGE
CATALOG_INTEGRITY_FAILURE = _archive_query.CATALOG_INTEGRITY_FAILURE

ArchiveQueryError = _archive_query.ArchiveQueryError

_SHA_RE = re.compile(r"[0-9a-f]{64}")
_STORE_READ_LOCK = threading.Lock()
_CAPACITY_THREAD_LOCKS = {}
_CAPACITY_THREAD_LOCKS_LOCK = threading.Lock()


def _capacity_thread_lock(root):
    key = os.path.normcase(os.path.realpath(root))
    with _CAPACITY_THREAD_LOCKS_LOCK:
        return _CAPACITY_THREAD_LOCKS.setdefault(key, threading.Lock())


def _sha_or_fail(value, what, **detail):
    if not isinstance(value, str) or not _SHA_RE.fullmatch(value):
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason=what, **detail)
    return value


def _record_read(store, size):
    """Store metrics are shared by parallel cache fetches; keep their update exact."""
    with _STORE_READ_LOCK:
        store.read_bytes += size


def _safe_relative(value, what, **detail):
    if (not isinstance(value, str) or not value or value.startswith("/") or "\\" in value
            or "\x00" in value
            or any(not part or part in (".", "..") for part in value.split("/"))):
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason=what, **detail)
    return value


def _nonnegative_int(value, what, **detail):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason=what, **detail)
    return value


class SnapshotRegistry:
    """Resolves `CURRENT` once and hands back an opaque capability for it.

    The contract requires a caller to pin one catalog snapshot for a whole
    operation, but a caller may never name a snapshot: `catalog_key` is a path
    and `catalog_sha256` could be paired with any file, so honouring a
    client-supplied pointer would let the caller choose what the server reads.
    A token is therefore server-issued, random, and meaningless outside this
    registry -- it carries no path and cannot be constructed by a caller.

    Discovery re-reads and re-verifies the catalog on every call, measured at
    3.0 ms against the production snapshot. That is correct but cannot be paid
    per page: a day of quotes is roughly 941 pages. Later pages present their
    token and reuse the snapshot this registry already verified.

    An unknown or expired token fails. It never falls back to resolving
    `CURRENT`, because silently serving a newer snapshot is exactly the
    mid-operation change the pin exists to prevent.

    A token is bound to the client it was issued to. Being unguessable is not
    the same as being unusable by someone else: a token that leaks through a
    log, a shared browser session or a copied request would otherwise be a
    working capability for any authenticated caller, which is the cross-user
    access the ticket requires to be rejected rather than merely improbable."""

    def __init__(self, catalog_root, *, ttl_seconds=SNAPSHOT_TTL_SECONDS,
                 max_entries=MAX_SNAPSHOT_ENTRIES,
                 max_entries_per_client=MAX_SNAPSHOT_ENTRIES_PER_CLIENT, clock=time.monotonic):
        if (not isinstance(ttl_seconds, (int, float)) or isinstance(ttl_seconds, bool)
                or ttl_seconds <= 0):
            raise ValueError("ttl_seconds must be positive")
        if not isinstance(max_entries, int) or isinstance(max_entries, bool) or max_entries < 1:
            raise ValueError("max_entries must be positive")
        if (not isinstance(max_entries_per_client, int) or isinstance(max_entries_per_client, bool)
                or max_entries_per_client < 1):
            raise ValueError("max_entries_per_client must be positive")
        if max_entries_per_client > max_entries:
            raise ValueError("max_entries_per_client cannot exceed max_entries")
        self._catalog_root = catalog_root
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._max_per_client = max_entries_per_client
        self._clock = clock
        self._lock = threading.Lock()
        self._entries = {}
        self._sequence = 0

    def _evict_expired(self):
        now = self._clock()
        for token, entry in list(self._entries.items()):
            if now - entry[1] > self._ttl:
                del self._entries[token]

    def _evict_own_oldest(self, client):
        """Keep one caller inside its own share of the registry.

        Nothing releases a pin early -- a query issues one and it lives out its
        TTL -- so at the permitted request rate a single client would otherwise
        fill the whole registry and every other client's next query would be
        refused. Capacity is shared; the blast radius must not be. A client that
        exceeds its own share loses its own oldest pin, which the contract
        already handles as a restart, rather than taking the service from
        everyone else.

        Order comes from an issue counter rather than the clock: two pins minted
        inside one clock tick carry the same timestamp, and sorting those by
        token would evict whichever token happened to sort lowest instead of the
        one actually issued first."""
        owned = sorted((entry[3], token) for token, entry in self._entries.items()
                       if entry[2] == client)
        for _sequence, token in owned[:max(0, len(owned) - self._max_per_client + 1)]:
            del self._entries[token]

    def _check_capacity(self):
        if len(self._entries) >= self._max_entries:
            raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED,
                                    reason="SNAPSHOT_REGISTRY_CAPACITY_EXCEEDED",
                                    maxEntries=self._max_entries)

    def _check_capacity_after_own_replacement(self, client):
        """Refuse only when a completed replacement could not fit.

        A caller at its own quota replaces its oldest pin when a new snapshot
        is committed. The preliminary capacity check must model that future
        replacement without performing it: catalog verification can fail, and
        a failed request must not invalidate a page chain that was already
        usable.
        """
        owned = sum(entry[2] == client for entry in self._entries.values())
        released = max(0, owned - self._max_per_client + 1)
        if len(self._entries) - released >= self._max_entries:
            raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED,
                                    reason="SNAPSHOT_REGISTRY_CAPACITY_EXCEEDED",
                                    maxEntries=self._max_entries)

    def issue(self, client):
        if not isinstance(client, str) or not client:
            raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="CLIENT_IDENTITY_ABSENT")
        with self._lock:
            self._evict_expired()
            self._check_capacity_after_own_replacement(client)
        try:
            snapshot = _coverage_report.read_catalog(self._catalog_root)
        except _coverage_report.CoverageReportError as error:
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE, reason=str(error)) from error
        with self._lock:
            self._evict_expired()
            self._evict_own_oldest(client)
            self._check_capacity()
            token = secrets.token_urlsafe(32)
            self._sequence += 1
            self._entries[token] = (snapshot, self._clock(), client, self._sequence)
        return token, snapshot

    def resolve(self, token, client):
        if not isinstance(token, str) or not token:
            raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="MALFORMED")
        if not isinstance(client, str) or not client:
            raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="CLIENT_IDENTITY_ABSENT")
        with self._lock:
            entry = self._entries.get(token)
            if entry is None:
                raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="UNKNOWN")
            snapshot, issued_at, owner = entry[0], entry[1], entry[2]
            if self._clock() - issued_at > self._ttl:
                del self._entries[token]
                raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="EXPIRED")
            if not hmac.compare_digest(pointer_owner(owner).encode(), pointer_owner(client).encode()):
                raise ArchiveQueryError(POINTER_TOKEN_INVALID, reason="CLIENT_MISMATCH")
        return snapshot

    def discard(self, token):
        with self._lock:
            self._entries.pop(token, None)


def discover(registry, *, client, pointer_token=None, instrument_id, family, from_ns, to_ns,
             curated_prefix, max_scan_bytes=None):
    """Discover through an opaque, server-owned catalog pin.

    A request without a token is the sole path that resolves CURRENT. Later
    pages use the stored verified snapshot and therefore cannot move to a new
    catalog midway through a cursor chain.

    `client` is required rather than defaulted: a pin belongs to the caller it
    was issued to, and a default would silently reintroduce a shared one.
    """
    _archive_query._validate_request_shape(
        instrument_id, family, from_ns, to_ns, max_scan_bytes)
    if pointer_token is None:
        pointer_token, snapshot = registry.issue(client)
    else:
        snapshot = registry.resolve(pointer_token, client)
    result = _archive_query._discover_verified_snapshot(
        snapshot, instrument_id=instrument_id, family=family, from_ns=from_ns, to_ns=to_ns,
        curated_prefix=curated_prefix, max_scan_bytes=max_scan_bytes)
    result["pointerToken"] = pointer_token
    return result


class _Reservation:
    def __init__(self, cache, identifier):
        self._cache = cache
        self._identifier = identifier

    def release(self):
        if self._identifier is not None:
            self._cache._release_reservation(self._identifier)
            self._identifier = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release()


class _ManifestCache:
    """Manifests already verified against their catalogued hash.

    Measured against the production archive, a warm read still cost 115 ms
    because every call fetched `_manifest.json` from S3 again -- a network round
    trip sitting on the one path whose whole purpose is to avoid them. A
    manifest is content-addressed exactly as a part is: once its bytes hash to
    the digest the catalog recorded, those bytes are that digest forever.

    Entries are handed out as copies. The cache outlives any one request, and a
    caller that mutated a shared manifest would corrupt every later reader of
    the same partition -- a fault that would surface far from its cause."""

    def __init__(self, max_entries=MANIFEST_CACHE_ENTRIES):
        self._lock = threading.Lock()
        self._entries = collections.OrderedDict()
        self._max_entries = max_entries

    def get(self, sha):
        with self._lock:
            entry = self._entries.get(sha)
            if entry is None:
                return None
            self._entries.move_to_end(sha)
        return copy.deepcopy(entry)

    def remember(self, sha, manifest):
        with self._lock:
            self._entries[sha] = copy.deepcopy(manifest)
            self._entries.move_to_end(sha)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def __len__(self):
        with self._lock:
            return len(self._entries)


class PartCache:
    """Local store of verified Parquet parts, addressed by content.

    A part is named by its own SHA-256, so the same bytes published under two
    dataset versions occupy one file and a name can never disagree with its
    contents. Admission is the only place a hash is computed: the bytes are
    streamed once, hashed while being written, checked against the size and
    digest the verified manifest declares, fsync'd, and only then renamed into
    place. A partial or failed fetch is never reachable under its final name.

    Warm reads do not re-hash. Re-hashing measured 13.2 ms for 6 MB and 47.8 ms
    for 46 MB against a 100 ms warm budget whose whole path measures 10.7 ms, so
    verifying on every read would cost more than the cache saves. A warm hit
    checks that the entry is a regular file of the expected size; anything else
    is evicted and re-fetched rather than served."""

    def __init__(self, root, *, max_bytes=MAX_CACHE_BYTES, min_free_disk_bytes=MIN_FREE_DISK_BYTES):
        if (not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes < 1):
            raise ValueError("max_bytes must be a positive integer")
        if (not isinstance(min_free_disk_bytes, int) or isinstance(min_free_disk_bytes, bool)
                or min_free_disk_bytes < 0):
            raise ValueError("min_free_disk_bytes must be a non-negative integer")
        self.root = os.fspath(root)
        self.max_bytes = max_bytes
        self.min_free_disk_bytes = min_free_disk_bytes
        os.makedirs(os.path.join(self.root, "_locks"), exist_ok=True)
        self.manifests = _ManifestCache()
        self._index_path = os.path.join(self.root, "index.sqlite")
        self._index_lock = threading.Lock()
        self._capacity_lock_path = os.path.join(self.root, "_locks", "capacity.guard")
        self._capacity_thread_lock = _capacity_thread_lock(self.root)
        self._owner = f"{os.getpid()}:{uuid.uuid4().hex}"
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS entries ("
                "sha TEXT PRIMARY KEY, bytes INTEGER NOT NULL, last_used REAL NOT NULL)")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS pins ("
                "sha TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, count INTEGER NOT NULL, "
                "PRIMARY KEY(sha, owner))")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS reservations ("
                "identifier TEXT PRIMARY KEY, bytes INTEGER NOT NULL, pid INTEGER NOT NULL, "
                "created_at REAL NOT NULL)")
        self._reconcile_index()
        self._reclaim_abandoned_partials()

    @contextlib.contextmanager
    def _connect(self):
        """`with sqlite3.connect(...)` commits but never closes, so a long-lived
        server leaks one descriptor per index write. Close it explicitly."""
        connection = sqlite3.connect(self._index_path, timeout=30)
        try:
            connection.execute("PRAGMA busy_timeout=30000")
            with connection:
                yield connection
        finally:
            connection.close()

    def path_for(self, sha):
        _sha_or_fail(sha, "INVALID_CACHE_KEY")
        return os.path.join(self.root, sha[:2], sha)

    def _lock_for(self, sha):
        _sha_or_fail(sha, "INVALID_CACHE_KEY")
        return LocalLock(os.path.join(self.root, "_locks", sha + ".guard"))

    def _reclaim_abandoned_partials(self):
        """Reclaim crash leftovers without racing an active download.

        A normal exception runs ``admit``'s finally block. A killed process
        cannot, so startup takes each artifact's existing lock before removing
        its temporary files. A busy lock means another process owns an active
        transfer and is left alone.
        """
        pattern = os.path.join(self.root, "[0-9a-f][0-9a-f]", "[0-9a-f]" * 64 + ".partial.*")
        for temporary in glob.iglob(pattern):
            sha = os.path.basename(temporary).split(".partial.", 1)[0]
            if not _SHA_RE.fullmatch(sha):
                continue
            try:
                with self._lock_for(sha):
                    try:
                        os.remove(temporary)
                    except FileNotFoundError:
                        pass
            except OSError:
                continue

    def _reconcile_index(self):
        """Make the capacity ledger conservative again after an interrupted write.

        ``os.replace`` makes a verified file visible before SQLite can record it.
        If power fails in that tiny interval, the next process must account for
        the final file before making any admission decision. This intentionally
        uses names and ``stat`` only: final cache files got their digest check
        before rename, and re-hashing every survivor would make startup scale
        with the cache size.
        """
        pattern = os.path.join(self.root, "[0-9a-f][0-9a-f]", "[0-9a-f]" * 64)
        on_disk = {}
        for path in glob.iglob(pattern):
            sha = os.path.basename(path)
            if not _SHA_RE.fullmatch(sha) or os.path.basename(os.path.dirname(path)) != sha[:2]:
                continue
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                on_disk[sha] = (info.st_size, info.st_mtime)
        with self._capacity_guard(), self._connect() as connection:
            indexed = {
                sha: size for sha, size in connection.execute("SELECT sha, bytes FROM entries")
            }
            for sha, size in indexed.items():
                actual = on_disk.pop(sha, None)
                if actual is None:
                    self._forget_locked(connection, sha)
                elif actual[0] != size:
                    self._touch_locked(connection, sha, actual[0])
            for sha, (size, mtime) in on_disk.items():
                connection.execute(
                    "INSERT INTO entries(sha, bytes, last_used) VALUES(?, ?, ?)",
                    (sha, size, mtime))

    @contextlib.contextmanager
    def _artifact_guard(self, sha):
        """Wait for whoever is already fetching this part, rather than failing.

        `LocalLock` is non-blocking, so taking it directly makes a second
        concurrent request for the same part raise `PermissionError` -- a raw OS
        error that escapes the contract's taxonomy entirely. Reproduced: two
        threads admitting one cold part, the loser got errno 13.

        Content addressing makes this common rather than exotic. Two callers
        scrolling the same region want the same bytes, which is the case the
        cache exists to serve. Waiting lets the second find the first one's
        result warm; the deadline keeps a stuck holder from blocking forever."""
        deadline = time.monotonic() + _ARTIFACT_LOCK_TIMEOUT_SECONDS
        lock = self._lock_for(sha)
        while True:
            try:
                lock.acquire()
                break
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED,
                                            reason="ARTIFACT_LOCK_TIMEOUT", sha256=sha) from error
                time.sleep(0.01)
        try:
            yield
        finally:
            lock.release()

    @contextlib.contextmanager
    def _capacity_guard(self):
        if not self._capacity_thread_lock.acquire(timeout=_CAPACITY_LOCK_TIMEOUT_SECONDS):
            raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED, reason="CACHE_LOCK_TIMEOUT")
        lock = None
        try:
            deadline = time.monotonic() + _CAPACITY_LOCK_TIMEOUT_SECONDS
            candidate = LocalLock(self._capacity_lock_path)
            while True:
                try:
                    candidate.acquire()
                    lock = candidate
                    break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED,
                                                reason="CACHE_LOCK_TIMEOUT") from error
                    time.sleep(0.01)
            yield
        finally:
            if lock is not None:
                lock.release()
            self._capacity_thread_lock.release()

    _pid_alive = staticmethod(pid_alive)

    def _prune_dead_leases(self, connection):
        now = time.time()
        owners = connection.execute("SELECT DISTINCT owner, pid FROM pins").fetchall()
        for owner, pid in owners:
            if not self._pid_alive(pid):
                connection.execute("DELETE FROM pins WHERE owner=?", (owner,))
        reservations = connection.execute(
            "SELECT identifier, pid, created_at FROM reservations").fetchall()
        for identifier, pid, created_at in reservations:
            if not self._pid_alive(pid) or now - created_at > _RESERVATION_STALE_SECONDS:
                connection.execute("DELETE FROM reservations WHERE identifier=?", (identifier,))

    @staticmethod
    def _total_bytes_locked(connection):
        return int(connection.execute("SELECT COALESCE(SUM(bytes), 0) FROM entries").fetchone()[0])

    @staticmethod
    def _reserved_bytes_locked(connection):
        return int(connection.execute("SELECT COALESCE(SUM(bytes), 0) FROM reservations").fetchone()[0])

    @staticmethod
    def _pinned_locked(connection):
        return {row[0] for row in connection.execute("SELECT DISTINCT sha FROM pins")}

    @staticmethod
    def _touch_locked(connection, sha, size):
        connection.execute(
            "INSERT INTO entries(sha, bytes, last_used) VALUES(?, ?, ?) "
            "ON CONFLICT(sha) DO UPDATE SET last_used=excluded.last_used, bytes=excluded.bytes",
            (sha, size, time.time()))

    @staticmethod
    def _forget_locked(connection, sha):
        connection.execute("DELETE FROM entries WHERE sha=?", (sha,))

    def total_bytes(self):
        with self._index_lock, self._connect() as connection:
            return self._total_bytes_locked(connection)

    def pin(self, sha):
        self._pin_many(Counter({sha: 1}))

    def _pin_many(self, counts):
        counts = Counter({sha: count for sha, count in counts.items() if count > 0})
        if not counts:
            return
        for sha in counts:
            _sha_or_fail(sha, "INVALID_CACHE_KEY")
        with self._capacity_guard(), self._connect() as connection:
            for sha, count in counts.items():
                connection.execute(
                    "INSERT INTO pins(sha, owner, pid, count) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(sha, owner) DO UPDATE SET count=pins.count + excluded.count",
                    (sha, self._owner, os.getpid(), count))

    def release(self, sha):
        self.release_many(Counter({sha: 1}))

    def release_many(self, counts):
        counts = Counter({sha: count for sha, count in counts.items() if count > 0})
        if not counts:
            return
        for sha in counts:
            _sha_or_fail(sha, "INVALID_CACHE_KEY")
        with self._capacity_guard(), self._connect() as connection:
            for sha, count in counts.items():
                row = connection.execute(
                    "SELECT count FROM pins WHERE sha=? AND owner=?", (sha, self._owner)).fetchone()
                if row is None or row[0] <= count:
                    connection.execute("DELETE FROM pins WHERE sha=? AND owner=?", (sha, self._owner))
                else:
                    connection.execute("UPDATE pins SET count=count-? WHERE sha=? AND owner=?",
                                       (count, sha, self._owner))

    def _pinned(self):
        with self._capacity_guard(), self._connect() as connection:
            self._prune_dead_leases(connection)
            return self._pinned_locked(connection)

    def _touch(self, sha, size):
        with self._index_lock, self._connect() as connection:
            self._touch_locked(connection, sha, size)

    def _forget(self, sha):
        with self._index_lock, self._connect() as connection:
            self._forget_locked(connection, sha)

    def _evict_locked(self, connection, sha):
        try:
            os.remove(self.path_for(sha))
        except FileNotFoundError:
            pass
        except OSError:
            return False
        self._forget_locked(connection, sha)
        return True

    def evict(self, sha):
        """Remove one entry. A reader that already opened the file keeps its
        descriptor on POSIX, so unlinking under an active read is safe there;
        on Windows the unlink fails and the entry is left for a later sweep
        rather than reported as evicted."""
        with self._capacity_guard(), self._connect() as connection:
            self._prune_dead_leases(connection)
            if sha in self._pinned_locked(connection):
                return False
            return self._evict_locked(connection, sha)

    def reserve(self, needed_bytes):
        """Make room for `needed_bytes` of new content, or refuse before anything
        is downloaded. Eviction never runs while an S3 read is in flight: this
        takes the index lock only in short bursts and holds nothing across the
        network.

        Refusing here rather than mid-fetch is the point -- a request that
        cannot fit should cost nothing, and a cache that overruns its bound
        while a download is already streaming has no good move left."""
        if not isinstance(needed_bytes, int) or isinstance(needed_bytes, bool) or needed_bytes < 0:
            raise ValueError("needed_bytes must be a non-negative integer")
        if needed_bytes == 0:
            return _Reservation(self, None)
        if needed_bytes > self.max_bytes:
            raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED, reason="LARGER_THAN_CACHE",
                                    neededBytes=needed_bytes, maxCacheBytes=self.max_bytes)
        with self._capacity_guard(), self._connect() as connection:
            self._prune_dead_leases(connection)
            reserved = self._reserved_bytes_locked(connection)
            free = shutil.disk_usage(self.root).free
            if free - reserved - needed_bytes < self.min_free_disk_bytes:
                raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED, reason="FREE_DISK_RESERVE",
                                        neededBytes=needed_bytes, reservedBytes=reserved, freeBytes=free,
                                        minFreeDiskBytes=self.min_free_disk_bytes)
            blocked = set()
            while self._total_bytes_locked(connection) + reserved + needed_bytes > self.max_bytes:
                params = tuple(blocked)
                exclusion = "" if not blocked else " AND e.sha NOT IN (%s)" % ",".join("?" * len(blocked))
                row = connection.execute(
                    "SELECT e.sha FROM entries e WHERE NOT EXISTS "
                    "(SELECT 1 FROM pins p WHERE p.sha=e.sha)" + exclusion +
                    " ORDER BY e.last_used ASC LIMIT 1", params).fetchone()
                if row is None:
                    total = self._total_bytes_locked(connection)
                    if total + needed_bytes <= self.max_bytes:
                        raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED, reason="CAPACITY_RESERVED",
                                                neededBytes=needed_bytes, reservedBytes=reserved,
                                                maxCacheBytes=self.max_bytes)
                    raise ArchiveQueryError(CACHE_CAPACITY_EXCEEDED, reason="ALL_ENTRIES_PINNED",
                                            neededBytes=needed_bytes, maxCacheBytes=self.max_bytes,
                                            pinned=len(self._pinned_locked(connection)))
                if not self._evict_locked(connection, row[0]):
                    blocked.add(row[0])
            identifier = uuid.uuid4().hex
            connection.execute("INSERT INTO reservations(identifier, bytes, pid, created_at) VALUES(?, ?, ?, ?)",
                               (identifier, needed_bytes, os.getpid(), time.time()))
        return _Reservation(self, identifier)

    def _release_reservation(self, identifier):
        with self._capacity_guard(), self._connect() as connection:
            connection.execute("DELETE FROM reservations WHERE identifier=?", (identifier,))

    def _warm_locked(self, connection, sha, expected_bytes):
        path = self.path_for(sha)
        try:
            info = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_bytes:
            try:
                os.remove(path)
            except OSError:
                pass
            self._forget_locked(connection, sha)
            return None
        self._touch_locked(connection, sha, expected_bytes)
        return path

    def warm(self, sha, expected_bytes):
        """A cache hit, validated without re-reading the content."""
        _sha_or_fail(sha, "INVALID_CACHE_KEY")
        _nonnegative_int(expected_bytes, "INVALID_CACHE_EXPECTED_BYTES")
        with self._capacity_guard(), self._connect() as connection:
            return self._warm_locked(connection, sha, expected_bytes)

    def acquire_warm(self, sha, expected_bytes):
        """Pin a warm artifact in the same critical section that observes it."""
        paths, _counts = self.acquire_warm_many([(sha, expected_bytes)])
        return paths.get(sha)

    def acquire_warm_many(self, wanted):
        """Observe and pin every warm artifact of one request in a single critical section.

        A request over a year of daily partitions wants hundreds of parts, and
        one index transaction per part -- each a file lock, a fresh connection
        and a committed write -- costs more than reading the parts themselves.
        The lookups are made together and the pins are written once, with each
        artifact pinned as many times as the request names it, exactly as the
        per-part path would have."""
        wanted = list(wanted)
        for sha, expected_bytes in wanted:
            _sha_or_fail(sha, "INVALID_CACHE_KEY")
            _nonnegative_int(expected_bytes, "INVALID_CACHE_EXPECTED_BYTES")
        paths, counts = {}, Counter()
        if not wanted:
            return paths, counts
        with self._capacity_guard(), self._connect() as connection:
            for sha, expected_bytes in wanted:
                if sha in counts:
                    counts[sha] += 1
                    continue
                path = self._warm_locked(connection, sha, expected_bytes)
                if path is not None:
                    paths[sha] = path
                    counts[sha] += 1
            for sha, count in counts.items():
                connection.execute(
                    "INSERT INTO pins(sha, owner, pid, count) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(sha, owner) DO UPDATE SET count=pins.count + excluded.count",
                    (sha, self._owner, os.getpid(), count))
        return paths, counts

    @staticmethod
    def _fsync_parent(path):
        if os.name == "nt":
            return
        descriptor = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def admit(self, store, relative_key, sha, expected_bytes, *, on_read=None, cancel_check=None):
        """Safely admit one part outside a multi-part materialisation.

        ``materialise`` reserves its whole cold set before it begins fetches;
        callers using this lower-level method still need the same guarantee.
        """
        _sha_or_fail(sha, "INVALID_CACHE_KEY")
        _nonnegative_int(expected_bytes, "INVALID_CACHE_EXPECTED_BYTES")
        if self.warm(sha, expected_bytes) is not None:
            return self.path_for(sha)
        with self.reserve(expected_bytes):
            return self._admit_reserved(store, relative_key, sha, expected_bytes,
                                        on_read=on_read, cancel_check=cancel_check)

    def _admit_reserved(self, store, relative_key, sha, expected_bytes, *, on_read=None,
                        cancel_check=None):
        """Fetch one part and admit it only once its own bytes prove it.

        The lock is per artifact and keyed by the content hash, so two requests
        wanting different parts never wait on each other and two wanting the
        same part fetch it once."""
        _sha_or_fail(sha, "INVALID_CACHE_KEY")
        _nonnegative_int(expected_bytes, "INVALID_CACHE_EXPECTED_BYTES")
        with self._artifact_guard(sha):
            if cancel_check is not None:
                cancel_check()
            existing = self.warm(sha, expected_bytes)
            if existing is not None:
                return existing
            path = self.path_for(sha)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            for stale in glob.glob(path + ".partial.*"):
                try:
                    os.remove(stale)
                except FileNotFoundError:
                    pass
            temporary = f"{path}.partial.{os.getpid()}.{uuid.uuid4().hex}"
            digest, written = hashlib.sha256(), 0
            try:
                body = store.client.get_object(
                    Bucket=store.bucket, Key=store.key(relative_key))["Body"]
                with body, open(temporary, "wb") as handle:
                    while chunk := body.read(_CHUNK):
                        if cancel_check is not None:
                            cancel_check()
                        written += len(chunk)
                        if written > expected_bytes:
                            raise ArchiveQueryError(
                                PARTITION_VERIFICATION_FAILED, reason="PART_LONGER_THAN_MANIFEST",
                                key=relative_key, expectedBytes=expected_bytes)
                        digest.update(chunk)
                        handle.write(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
                if written != expected_bytes:
                    raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                            reason="PART_SIZE_MISMATCH", key=relative_key,
                                            expectedBytes=expected_bytes, actualBytes=written)
                if digest.hexdigest() != sha:
                    raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                            reason="PART_HASH_MISMATCH", key=relative_key)
                os.replace(temporary, path)
                self._fsync_parent(path)
            finally:
                if written:
                    _record_read(store, written)
                    if on_read is not None:
                        on_read(written)
                if os.path.exists(temporary):
                    os.remove(temporary)
            self._touch(sha, expected_bytes)
            return path


def read_manifest(store, partition, *, manifests=None, on_read=None, cancel_check=None):
    """The manifest is the root of trust for every part beneath it, so it is
    checked against the hash the catalog recorded before a single part name is
    believed. A manifest that does not match its catalogued digest means the
    published partition and the catalog disagree, and nothing under it can be
    trusted to name the right bytes."""
    if not isinstance(partition, dict):
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="INVALID_PARTITION_METADATA")
    date = partition.get("date")
    expected = _sha_or_fail(partition.get("manifest_sha256"), "INVALID_CATALOGUED_MANIFEST_HASH",
                            date=date)
    prefix = _safe_relative(partition.get("s3_prefix"), "INVALID_PARTITION_PREFIX", date=date)
    expected_key = store.key(_archive_query.partition_relative(prefix, partition.get("provider")) + "/_manifest.json")
    key = partition.get("manifest_key")
    if key != expected_key:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                reason="MANIFEST_KEY_DISAGREES_WITH_PREFIX", date=date)
    catalogued_parts = _nonnegative_int(partition.get("part_count"), "INVALID_CATALOGUED_PART_COUNT",
                                         date=date)
    catalogued_records = _nonnegative_int(partition.get("record_count"),
                                           "INVALID_CATALOGUED_RECORD_COUNT", date=date)
    cached = manifests.get(expected) if manifests is not None else None
    if cached is not None:
        return cached
    if cancel_check is not None:
        cancel_check()
    body = store.client.get_object(Bucket=store.bucket, Key=key)["Body"]
    raw = bytearray()
    with body:
        while len(raw) <= _MAX_MANIFEST_BYTES:
            if cancel_check is not None:
                cancel_check()
            chunk = body.read(min(_CHUNK, _MAX_MANIFEST_BYTES + 1 - len(raw)))
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                        reason="MANIFEST_BODY_NOT_BYTES", key=key)
            raw.extend(chunk)
    if len(raw) > _MAX_MANIFEST_BYTES:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="OVERSIZED_MANIFEST", key=key)
    raw = bytes(raw)
    _record_read(store, len(raw))
    if on_read is not None:
        on_read(len(raw))
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                reason="MANIFEST_HASH_MISMATCH", key=key)
    try:
        manifest = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                reason="MANIFEST_INVALID_JSON", key=key) from error
    if not isinstance(manifest, dict):
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="MANIFEST_NOT_OBJECT", key=key)
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="MANIFEST_HAS_NO_PARTS", key=key)
    names, declared = set(), []
    for part in parts:
        if not isinstance(part, dict):
            raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="INVALID_PART_ENTRY", key=key)
        name = part.get("name")
        if (not isinstance(name, str) or "/" in name or "\\" in name
                or name in ("", ".", "..") or "\x00" in name):
            raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="UNSAFE_PART_NAME", key=key)
        if name in names:
            raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="DUPLICATE_PART_NAME", key=key)
        names.add(name)
        declared.append((
            _sha_or_fail(part.get("sha256"), "INVALID_PART_HASH", key=key),
            _nonnegative_int(part.get("bytes"), "INVALID_PART_BYTES", key=key),
            _nonnegative_int(part.get("row_count"), "INVALID_PART_ROW_COUNT", key=key),
        ))
    if catalogued_parts != len(parts):
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="PART_COUNT_DISAGREES_WITH_CATALOG",
                                key=key, catalogued=catalogued_parts, manifest=len(parts))
    manifest_records = _nonnegative_int(manifest.get("record_count"), "INVALID_MANIFEST_RECORD_COUNT", key=key)
    part_records = sum(row_count for _sha, _bytes, row_count in declared)
    if manifest_records != part_records or catalogued_records != manifest_records:
        raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED, reason="RECORD_COUNT_DISAGREES_WITH_MANIFEST",
                                key=key, catalogued=catalogued_records, manifest=manifest_records,
                                parts=part_records)
    if manifests is not None:
        manifests.remember(expected, manifest)
    return manifest


def materialise(store, cache, partitions, *, max_scan_bytes, concurrency=FETCH_CONCURRENCY,
                cancel_check=None):
    """Bring every part of every partition into the cache and return their local
    paths, pinned.

    The byte gate here is the real one. Step 1 refuses early from
    `record_count` times a measured per-row rate, which is a screen, not a
    capacity proof: it is an estimate and it errs high by design. The manifests
    carry the exact published byte count, so the sum of `parts[].bytes` is
    checked against the caller's budget before any Parquet part is downloaded.

    Parts are pinned before their paths are returned and stay pinned until the
    caller releases them, so a concurrent request cannot evict a file out from
    under a read that has not started yet."""
    if (not isinstance(max_scan_bytes, int) or isinstance(max_scan_bytes, bool)
            or max_scan_bytes < 1):
        raise ValueError("max_scan_bytes must be a positive integer")
    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1:
        raise ValueError("concurrency must be a positive integer")
    read_lock, bytes_read = threading.Lock(), 0

    def count_read(size):
        nonlocal bytes_read
        with read_lock:
            bytes_read += size

    partitions = list(partitions)

    def _manifest(partition):
        return read_manifest(store, partition, manifests=cache.manifests,
                             on_read=count_read, cancel_check=cancel_check)

    manifest_started = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        manifests = list(zip(partitions, pool.map(_manifest, partitions)))
    exact_bytes = sum(part["bytes"] for _partition, manifest in manifests for part in manifest["parts"])
    manifest_ms = (time.monotonic() - manifest_started) * 1000.0

    if exact_bytes > max_scan_bytes:
        raise ArchiveQueryError(RANGE_TOO_LARGE, reason="MANIFEST_BYTES_EXCEED_BUDGET",
                                estimatedScanBytes=exact_bytes,
                                effectiveMaxScanBytes=max_scan_bytes,
                                partitions=len(partitions))

    wanted = []
    for partition, manifest in manifests:
        for part in manifest["parts"]:
            wanted.append((partition, part))

    declared_sizes = {}
    for _partition, part in wanted:
        prior = declared_sizes.setdefault(part["sha256"], part["bytes"])
        if prior != part["bytes"]:
            raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                    reason="SAME_PART_HASH_HAS_DIFFERENT_SIZES",
                                    sha256=part["sha256"])

    cold_by_sha = {}
    lookup_started = time.monotonic()
    download_ms = 0.0
    if cancel_check is not None:
        cancel_check()
    warm_paths, pin_counts = cache.acquire_warm_many((part["sha256"], part["bytes"]) for _partition, part in wanted)
    try:
        for partition, part in wanted:
            if part["sha256"] not in warm_paths:
                cold_by_sha.setdefault(part["sha256"], (partition, part))
        cold_counts = Counter(part["sha256"] for _partition, part in wanted
                              if part["sha256"] in cold_by_sha)
        with cache.reserve(sum(part["bytes"] for _partition, part in cold_by_sha.values())):
            cache._pin_many(cold_counts)
            pin_counts.update(cold_counts)

            def _one(item):
                partition, part = item
                if cancel_check is not None:
                    cancel_check()
                relative = _archive_query.partition_relative(partition["s3_prefix"], partition.get("provider")) + "/" + part["name"]
                return part["sha256"], cache._admit_reserved(
                    store, relative, part["sha256"], part["bytes"], on_read=count_read,
                    cancel_check=cancel_check)

            download_started = time.monotonic()
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                for sha, path in pool.map(_one, cold_by_sha.values()):
                    warm_paths[sha] = path
            download_ms = (time.monotonic() - download_started) * 1000.0 if cold_by_sha else 0.0
    except BaseException:
        cache.release_many(pin_counts)
        raise

    cache_lookup_ms = max(0.0, (time.monotonic() - lookup_started) * 1000.0 - download_ms)
    distinct = {part["sha256"] for _partition, part in wanted}
    return {
        "stageMs": {"manifestMs": manifest_ms, "cacheLookupMs": cache_lookup_ms, "downloadMs": download_ms},
        "exactScanBytes": exact_bytes,
        "partitionsRead": len(manifests),
        "bytesRead": bytes_read,
        "cacheHits": len(distinct) - len(cold_by_sha),
        "cacheMisses": len(cold_by_sha),
        "parts": [{"partition": partition, "name": part["name"], "sha256": part["sha256"],
                   "bytes": part["bytes"], "path": warm_paths[part["sha256"]]}
                  for partition, part in wanted],
    }


def release_materialised(cache, materialised):
    """Release every durable pin returned by :func:`materialise` exactly once."""
    cache.release_many(Counter(part["sha256"] for part in materialised["parts"]))
