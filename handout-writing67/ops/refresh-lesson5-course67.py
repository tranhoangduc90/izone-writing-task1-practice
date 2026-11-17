"""Refresh the mounted Lesson 5 access snapshot without granting Handout access to mapping_db."""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import tempfile


def refresh(root):
    sql = (root / 'lesson5-course67-roster.sql').read_bytes()
    raw = subprocess.check_output([
        'docker', 'exec', '-i', 'mapping-postgres', 'sh', '-c',
        'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db',
    ], input=sql, timeout=25)
    snapshot = json.loads(raw)
    observed = datetime.fromisoformat(snapshot['observedAt'])
    age = datetime.now(timezone.utc) - observed
    if snapshot['course'] != '67' or not snapshot['classes'] or not timedelta(0) <= age <= timedelta(hours=36):
        raise ValueError('LESSON5_ROSTER_INVALID_OR_STALE')
    directory = root / 'data'
    destination = directory / 'roster.json'
    if not destination.exists() or destination.read_bytes() != raw:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as draft:
            temporary = Path(draft.name)
            try:
                draft.write(raw)
                draft.flush()
                os.fsync(draft.fileno())
                temporary.chmod(0o644)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
    print(json.dumps({'status': 'updated', 'sourceObservedAt': snapshot['observedAt'],
                      'classes': len(snapshot['classes']),
                      'emptyRosters': sum(not row['students'] for row in snapshot['classes'])}))


if __name__ == '__main__':
    try:
        refresh(Path(__file__).resolve().parent)
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit('LESSON5_ROSTER_REFRESH_FAILED') from None
