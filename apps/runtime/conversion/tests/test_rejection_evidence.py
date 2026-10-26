from __future__ import annotations

import json

import rejection_evidence as evidence


def test_new_attempt_archives_prior_evidence_and_clears_active_slot(tmp_path):
    prior = evidence.new(source_objects=[{"s3_key": "raw/a", "sha256": "a" * 64}])
    evidence.record(prior, "BAD_ROW", source={"position": 3}, row={"price": "bad"})
    evidence.write(tmp_path, prior)

    archived = evidence.begin_attempt(tmp_path)

    assert archived is not None
    assert not (tmp_path / "rejections.json").exists()
    with open(archived, encoding="utf-8") as fh:
        assert json.load(fh) == prior


def test_record_captures_an_immutable_json_snapshot():
    row = {"nested": {"price": "100.25"}}
    current = evidence.new(source_objects=[])

    evidence.record(current, "BAD_ROW", source={"position": 3}, row=row)
    row["nested"]["price"] = "changed"

    assert current["samples"][0]["row"] == {"nested": {"price": "100.25"}}
