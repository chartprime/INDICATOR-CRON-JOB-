# Pinned provider fixtures

Unmodified public files from Databento's Apache-2.0 DBN repository, commit `a7d8ee93a5d5d0b7082d0ca15ab85c01e3cce550`, fetched 2026-09-08:

- `databento-mbp1.dbn`: upstream `tests/data/test_data.mbp-1.dbn`, 513 bytes, two Add records.
- `databento-tbbo.dbn`: upstream `tests/data/test_data.tbbo.dbn`, 513 bytes, two Trade records using the same MBP-1 record layout. This is TBBO fixture provenance, not a claim that it came from the user's MBP-1 archive.

[Upstream pinned fixtures](https://github.com/databento/dbn/tree/a7d8ee93a5d5d0b7082d0ca15ab85c01e3cce550/tests/data). Original license is retained in `LICENSE-databento.txt`; no binary contents were modified. SHA-256 checks live in `decode-pinned-dbn.js`.

The decoder is restricted to these exact hashes, DBN v2, two 80-byte rtype=1 records. It does not decode production archives, compressed files, metadata symbol mappings or arbitrary versions. The test identity mapping is synthetic and explicitly labelled; the original numeric instrument ID and prices/times are retained. Other edge-case vectors in the Jest test are constructed fixtures, not downloaded market observations.
