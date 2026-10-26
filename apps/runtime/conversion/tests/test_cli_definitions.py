import json
import cli


def test_definition_descriptors_reach_job(tmp_path, monkeypatch):
    inputs = tmp_path / 'inputs.json'
    definitions = tmp_path / 'defs.json'
    inputs.write_text('[]')
    expected = [{'local_path': 'definition.csv', 's3_key': 'raw/definition.csv'}]
    definitions.write_text(json.dumps(expected))
    captured = {}
    def run(*args, **kwargs):
        captured.update(kwargs)
        return {}
    monkeypatch.setattr(cli.job, 'run_job', run)
    assert cli.main(['--inputs-json', str(inputs), '--definitions-json', str(definitions),
                     '--dataset-version', 'test', '--staging-root', str(tmp_path/'stage'),
                     '--curated-root', str(tmp_path/'curated'), '--catalog-root', str(tmp_path/'catalog')]) == 0
    assert captured['definition_sources'] == expected


def test_definitions_rejected_in_legacy_source_mode(tmp_path):
    assert cli.main(['--source', 'unused', '--definitions-json', 'unused',
                     '--dataset-version', 'test', '--staging-root', str(tmp_path/'stage'),
                     '--curated-root', str(tmp_path/'curated'), '--catalog-root', str(tmp_path/'catalog')]) == 2
