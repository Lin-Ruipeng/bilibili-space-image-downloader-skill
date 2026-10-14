#!/usr/bin/env python3
"""Initialize a per-UID archive and validate its collection state."""
import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def uid_string(value):
    value = str(value)
    if not re.fullmatch(r'[1-9][0-9]*', value):
        raise ValueError('UID must be a positive decimal identifier')
    return value


def initialize(uid, output_root=None, include_columns=False, reuse_files=(), refresh=False, resume=False):
    uid = uid_string(uid)
    base = Path(output_root or Path.home() / '图片' / 'bilibili').expanduser().resolve()
    root = base / uid
    path = root / '.collection' / 'index.json'
    if path.exists():
        state = json.loads(path.read_text(encoding='utf-8'))
        if state.get('uid') != uid:
            raise ValueError('archive belongs to another UID')
        if bool(state.get('include_columns')) != bool(include_columns):
            raise ValueError('existing scope differs; use a separate output root for another scope')
        if refresh:
            state.update(phase='discovering', traversal={})
            state.pop('blocked_reason', None)
            state.pop('error', None)
            atomic_json(path, state)
        elif resume and state.get('phase') in {'blocked', 'interrupted'}:
            state['phase'] = 'capturing' if history_complete(state) else 'discovering'
            state.pop('blocked_reason', None)
            state.pop('error', None)
            atomic_json(path, state)
        return root
    for name in ('posts', 'partial'):
        (root / '.collection' / name).mkdir(parents=True, exist_ok=True)
    atomic_json(path, {
        'schema_version': 2, 'uid': uid, 'include_columns': bool(include_columns),
        'required_entries': ['dynamic', 'opus'] + (['column'] if include_columns else []),
        'phase': 'discovering', 'started_at': datetime.now(timezone.utc).isoformat(),
        'candidates': {}, 'traversal': {},
        'reuse_files': [str(Path(p).expanduser().resolve()) for p in reuse_files],
    })
    return root


def load_state(root):
    return json.loads((Path(root) / '.collection' / 'index.json').read_text(encoding='utf-8'))


def history_complete(state):
    entries = state.get('required_entries') or []
    traversal = state.get('traversal', {})
    return bool(entries) and all(
        traversal.get(entry, {}).get('complete') is True
        and valid_end_evidence(traversal.get(entry, {}).get('end_evidence'))
        for entry in entries
    )


def valid_end_evidence(evidence):
    if not isinstance(evidence, dict):
        return False
    if evidence.get('type') == 'browser_observed_response':
        return evidence.get('has_more') is False
    return evidence.get('type') == 'visible_end_marker' and bool(evidence.get('text'))


def validate_post(post, uid):
    if not isinstance(post.get('id'), str) or not re.fullmatch(r'[1-9][0-9]*', post['id']):
        raise ValueError('post ID must be a decimal string')
    match = re.search(r'https://www\.bilibili\.com/opus/([0-9]+)', post.get('url', ''))
    if not match or match.group(1) != post['id']:
        raise ValueError('post URL/ID mismatch')
    if post.get('uid') != uid or post.get('author_uid_verified') is not True:
        raise ValueError('post author UID is not verified')
    datetime.fromisoformat(post['published'])
    images = post.get('images', [])
    if post.get('capture_complete') and (
        len(images) != post.get('image_count')
        or [i.get('ordinal') for i in images] != list(range(1, len(images) + 1))
    ):
        raise ValueError('post image count/order mismatch')
    for image in images:
        evidence = image.get('viewer', {})
        if (evidence.get('source') != 'gray_overlay' or evidence.get('loaded') is not True
                or evidence.get('current_src') != image.get('url')
                or not 1 <= evidence.get('page', 0) <= evidence.get('total', 0)
                or not image.get('width', 0) > 0 or not image.get('height', 0) > 0):
            raise ValueError('image lacks loaded gray-viewer evidence')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uid', required=True)
    parser.add_argument('--output-root', type=Path)
    parser.add_argument('--include-columns', action='store_true')
    parser.add_argument('--reuse-file', action='append', default=[])
    parser.add_argument('--refresh', action='store_true', help='Revisit all history while keeping captured files')
    parser.add_argument('--resume', action='store_true', help='Resume after actually resolving a restriction/interruption')
    args = parser.parse_args()
    print(initialize(args.uid, args.output_root, args.include_columns, args.reuse_file, args.refresh, args.resume))


if __name__ == '__main__':
    main()
