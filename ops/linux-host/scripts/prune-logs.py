#!/usr/bin/env python3
"""Periodic dated-log retention, not a hard quota. Preserves active-day logs."""
import datetime as dt
import os
import re
import stat
import json
import argparse


def prune(root, days=30, budget=2 * 1024**3, today=None):
    if days < 1 or budget < 1:
        raise ValueError('Positive limits required')
    today = today or dt.datetime.now(dt.timezone.utc).date()
    total, deleted = 0, 0
    entries, descriptors = [], []
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for role in os.listdir(rootfd):
            st = os.stat(role, dir_fd=rootfd, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode):
                if stat.S_ISREG(st.st_mode):
                    total += st.st_size
                continue
            fd = os.open(role, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
            descriptors.append(fd)
            for name in os.listdir(fd):
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(st.st_mode):
                    continue
                total += st.st_size
                match = re.fullmatch(r'.+-(\d{4}-\d{2}-\d{2})\.log(?:[.-].+)?', name)
                if not match:
                    continue
                try:
                    date = dt.date.fromisoformat(match[1])
                except ValueError:
                    continue
                if date < today:
                    entries.append((date, name, fd, st.st_ino, st.st_size))
        for date, name, fd, ino, size in sorted(entries):
            if (today - date).days <= days and total <= budget:
                continue
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode) or (st.st_ino, st.st_size) != (ino, size):
                raise RuntimeError('Log changed during retention')
            os.unlink(name, dir_fd=fd)
            total -= size
            deleted += 1
    finally:
        for fd in descriptors:
            os.close(fd)
        os.close(rootfd)
    return dict(deleted=deleted, remaining_bytes=total, within_budget=total <= budget)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/var/log/terminal-l1-l2')
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--budget-bytes', type=int, default=2 * 1024**3)
    args = parser.parse_args()
    result = prune(args.root, args.days, args.budget_bytes)
    print(json.dumps(result))
    raise SystemExit(0 if result['within_budget'] else 1)
