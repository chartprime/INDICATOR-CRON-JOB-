from __future__ import annotations

import datetime as dt
import hashlib
import io


def etag(data):
    return hashlib.sha256(data).hexdigest()


class S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class SharedFakeClient:
    def __init__(self, objects, last_modified, guard):
        self.objects, self.last_modified, self._guard = objects, last_modified, guard

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        client = self

        class _Paginator:
            def paginate(self, Bucket, Prefix):
                with client._guard:
                    matching = sorted(k for k in client.objects.keys() if k.startswith(Prefix))
                    contents = [{"Key": k, "Size": len(client.objects[k]), "LastModified": client.last_modified[k],
                                 "ETag": etag(client.objects[k])} for k in matching]
                yield {"Contents": contents}
        return _Paginator()

    def head_object(self, Bucket, Key, ChecksumMode=None):
        with self._guard:
            return {"ContentLength": len(self.objects[Key]), "ETag": etag(self.objects[Key])}

    def get_object(self, Bucket, Key, IfMatch=None):
        with self._guard:
            if Key not in self.objects:
                raise S3Error(404)
            data = self.objects[Key]
            if IfMatch is not None and IfMatch != etag(data):
                raise S3Error(412)
            return {"Body": io.BytesIO(data), "ETag": etag(data)}

    def put_object(self, **args):
        with self._guard:
            key = args["Key"]
            old = self.objects.get(key)
            if args.get("IfNoneMatch") == "*" and old is not None:
                raise S3Error(412)
            if "IfMatch" in args and (old is None or etag(old) != args["IfMatch"]):
                raise S3Error(412)
            body = args["Body"]
            data = body.read() if hasattr(body, "read") else body
            self.objects[key] = data
            self.last_modified[key] = dt.datetime.now(dt.timezone.utc)
