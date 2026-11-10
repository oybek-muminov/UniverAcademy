"""Validate fixtures against an explicitly supplied, pinned external OpenAPI file.

Uses the environment's existing jsonschema; does not install, fetch or generate a client.
Run: python3 tests/check-wire-fixtures.py /path/to/pinned-openapi.json
"""
import hashlib
import json
from pathlib import Path
import sys
from jsonschema import Draft202012Validator, FormatChecker

if len(sys.argv) != 2:
    raise SystemExit('Supply the pinned OpenAPI JSON path; no network fetch is performed.')
packet = json.loads((Path(__file__).parent / 'fixtures/wire.json').read_text())
source = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(source).hexdigest() != packet['contract_sha256']:
    raise SystemExit('OpenAPI bytes differ from the fixture pin. Owner review and fixture review are required.')
contract = json.loads(source)
for name, case in packet['cases'].items():
    schema = {'$ref': f"#/components/schemas/{case['schema']}", 'components': contract['components']}
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    problems = list(validator.iter_errors(case['data']))
    if problems:
        # Report paths only, never serialize an untrusted payload into the log.
        paths = ['/'.join(str(p) for p in error.absolute_path) for error in problems]
        raise SystemExit(f'Fixture {name} failed schema validation at {paths}')
print(f"PASS: {len(packet['cases'])} synthetic fixtures match the exact pinned draft schema; owner acceptance/live integration NOT claimed")
