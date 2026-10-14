#!/usr/bin/env python3
"""Verify a per-UID archive offline; optional manual samples are compared byte for byte."""
import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from archive import atomic_json, load_state, validate_post
from download_images import FORMATS, inspect_file


def verify(root, samples=(), write=True):
    root = Path(root).expanduser().resolve()
    state = load_state(root)
    manifest = json.loads((root / 'download_manifest.json').read_text(encoding='utf-8'))
    expected, actual, errors, cache = {}, {}, [], {}
    for post in manifest['posts']:
        try:
            validate_post(post, state['uid'])
            if not post.get('capture_complete'):
                raise ValueError('capture incomplete')
        except Exception as exc:
            errors.append({'post': post.get('id'), 'error': str(exc)})
        expected.update({(post['id'], image['ordinal']): image for image in post['images']})
    for row in manifest['images']:
        key = row['post_id'], row['ordinal']
        actual[key] = row
        try:
            image = expected[key]
            if row['status'] != 'success':
                raise ValueError(f"download status: {row['status']}")
            target = Path(row['path'])
            stat = target.stat()
            inode = stat.st_dev, stat.st_ino
            if inode not in cache:
                cache[inode] = inspect_file(target)
            info = cache[inode]
            if any(info[field] != row[field] for field in ('sha256', 'bytes', 'format', 'width', 'height', 'frames')):
                raise ValueError('file bytes/format/dimensions/frames differ from manifest')
            if (row['url'], info['width'], info['height']) != (image['url'], image['width'], image['height']):
                raise ValueError('file does not match loaded viewer resource')
            folder = root / row['published'][:4] / f"{row['published'][:10]}_{row['post_id']}"
            if target.parent != folder or target.name != f"{row['ordinal']:03d}.{FORMATS[info['format']]}":
                raise ValueError('unexpected archive location or extension')
            if row.get('duplicate_of'):
                source = Path(row['duplicate_of'])
                if inspect_file(source)['sha256'] != info['sha256']:
                    raise ValueError('reuse source changed')
                if row['reuse_mode'] == 'hardlink':
                    source_stat = source.stat()
                    if inode != (source_stat.st_dev, source_stat.st_ino):
                        raise ValueError('claimed hardlink is not a hardlink')
        except Exception as exc:
            errors.append({'post': key[0], 'ordinal': key[1], 'error': str(exc)})
    if set(actual) != set(expected):
        errors.append({'error': 'manifest coverage mismatch', 'missing': sorted(set(expected) - set(actual)),
                       'extra': sorted(set(actual) - set(expected))})
    sample_results = []
    for specification in samples:
        try:
            label, filename = specification.split('=', 1)
            post_id, ordinal = label.split(':')
            row = actual[(post_id, int(ordinal))]
            identical = Path(row['path']).read_bytes() == Path(filename).expanduser().read_bytes()
            sample_results.append({'post': post_id, 'ordinal': int(ordinal), 'byte_identical': identical})
            if not identical:
                raise ValueError('manual sample differs byte for byte')
        except Exception as exc:
            errors.append({'sample': specification, 'error': str(exc)})
    result = {
        'verified_at': datetime.now(timezone.utc).isoformat(), 'uid': state['uid'],
        'complete': bool(manifest['summary']['complete']) and not errors,
        'files_valid': not errors, 'images': len(actual), 'unique_files': len(cache),
        'formats': dict(Counter(row.get('format') for row in actual.values())),
        'samples': sample_results, 'errors': errors,
    }
    if write:
        atomic_json(root / '.verification' / 'archive-check.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--sample', action='append', default=[], metavar='POST_ID:ORDINAL=FILE')
    parser.add_argument('--no-write', action='store_true')
    args = parser.parse_args()
    result = verify(args.root, args.sample, not args.no_write)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['complete'] else 1)
