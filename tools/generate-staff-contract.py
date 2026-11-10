"""Local staff operations from the exact full candidate; no handwritten wire DTOs."""
from pathlib import Path
from copy import deepcopy
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
raw = (ROOT / 'contracts/review-only.openapi.json').read_bytes()
digest = hashlib.sha256(raw).hexdigest()
assert digest == '9c7518f887aafacc5cf53b73d33a87d42b11a9fcd46730185b39360e62fe3bb4'
source = json.loads(raw)
paths = {name: {method: deepcopy(source['paths'][name][method])} for name, method in [
    ('/admin/students/{student_id}/transfer', 'post'), ('/admin/versions/{version_id}', 'patch'),
    ('/admin/groups/{group_id}/members', 'put'), ('/admin/assignments', 'post'),
    ('/admin/versions/{version_id}/questions/{question_id}', 'put'),
    ('/admin/versions/{version_id}/publish', 'post')]}
def refs(value):
    if isinstance(value, dict):
        return ([value['$ref']] if '$ref' in value else []) + [r for v in value.values() for r in refs(v)]
    if isinstance(value, list):
        return [r for v in value for r in refs(v)]
    return []
def resolve(pointer):
    out = source
    for token in pointer[2:].split('/'):
        out = out[token.replace('~1', '/').replace('~0', '~')]
    return out
pending = refs(paths) + ['#/components/securitySchemes/StaffJWT']
components = {}
seen = set()
while pending:
    pointer = pending.pop()
    if pointer in seen:
        continue
    seen.add(pointer)
    _, _, group, name = pointer.split('/')
    value = deepcopy(resolve(pointer))
    components.setdefault(group, {})[name] = value
    pending.extend(refs(value))
out = {'openapi': source['openapi'], 'info': source['info'], 'servers': source['servers'],
       'paths': paths, 'components': {g: dict(sorted(items.items())) for g, items in sorted(components.items())},
       'x-source-sha256': digest, 'x-status': 'LOCAL_STAFF_HANDLER_CANDIDATE_NOT_PRODUCTION_ACCEPTANCE'}
(ROOT / 'packages/api-client/staff-openapi.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'source_sha256': digest, 'operations': len(paths), 'schemas': len(components['schemas'])}))
