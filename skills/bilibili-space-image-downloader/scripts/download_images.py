#!/usr/bin/env python3
"""Download only URLs observed in Bilibili's large-image viewer; never use cookies."""
import argparse
import csv
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image
from archive import atomic_json, load_state, history_complete, validate_post

Image.MAX_IMAGE_PIXELS = None
FORMATS = {'JPEG': 'jpg', 'MPO': 'mpo', 'PNG': 'png', 'GIF': 'gif', 'WEBP': 'webp', 'AVIF': 'avif', 'TIFF': 'tif', 'BMP': 'bmp'}


def inspect_file(path):
    with Image.open(path) as im:
        fmt, size = im.format, im.size
        im.verify()
    with Image.open(path) as im:
        frames = getattr(im, 'n_frames', 1)
        for n in range(frames):
            im.seek(n)
            im.load()
    if fmt not in FORMATS:
        raise ValueError(f'unsupported actual format: {fmt}')
    sha = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            sha.update(chunk)
    return {'format': fmt, 'width': size[0], 'height': size[1], 'frames': frames,
            'animated': frames > 1 and fmt in {'GIF', 'PNG', 'WEBP', 'AVIF'},
            'bytes': Path(path).stat().st_size, 'sha256': sha.hexdigest()}


class Restriction(Exception):
    pass


class Downloader:
    def __init__(self, root, allow_local=False):
        self.root = Path(root).resolve()
        self.state = load_state(self.root)
        if self.state.get('schema_version') != 2 or not isinstance(self.state.get('uid'), str):
            raise ValueError('initialize a version-2 per-UID archive before downloading')
        self.collection = self.root / '.collection'
        self.work = self.collection / 'partial'
        self.work.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.collection / 'downloads.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS images (
            post_id TEXT, ordinal INTEGER, post_url TEXT, published TEXT, text TEXT,
            total INTEGER, url TEXT, expected_width INTEGER, expected_height INTEGER,
            status TEXT DEFAULT 'pending', path TEXT, format TEXT, width INTEGER,
            height INTEGER, frames INTEGER, bytes INTEGER, sha256 TEXT, duplicate_of TEXT,
            reuse_mode TEXT, attempts INTEGER DEFAULT 0, error TEXT, updated TEXT,
            PRIMARY KEY(post_id, ordinal))''')
        self.db.commit()
        columns = {r[1] for r in self.db.execute('PRAGMA table_info(images)')}
        if 'active' not in columns:
            self.db.execute('ALTER TABLE images ADD COLUMN active INTEGER DEFAULT 1')
        if 'reuse_reason' not in columns:
            self.db.execute('ALTER TABLE images ADD COLUMN reuse_reason TEXT')
        self.db.commit()
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.restrictions = 0
        self.allow_local = allow_local
        self.hash_paths = {}
        self.interrupted = False

    def close(self):
        self.db.close()

    def import_posts(self):
        self.state = load_state(self.root)
        for path in sorted((self.collection / 'posts').glob('*.json')):
            post = json.loads(path.read_text(encoding='utf-8'))
            validate_post(post, self.state['uid'])
            candidate = self.state.get('candidates', {}).get(post['id'], {})
            if candidate.get('status') == 'excluded':
                self.db.execute('UPDATE images SET active=0 WHERE post_id=?', (post['id'],))
                continue
            for img in post.get('images', []):
                values = (str(post['id']), int(img['ordinal']), post['url'], post['published'],
                          post.get('text', ''), int(post['image_count']), img['url'],
                          int(img['width']), int(img['height']))
                old = self.db.execute('SELECT url,expected_width,expected_height FROM images WHERE post_id=? AND ordinal=?', values[:2]).fetchone()
                if old and tuple(old) != (values[6], values[7], values[8]):
                    self.db.execute("UPDATE images SET status='pending',error='viewer resource changed' WHERE post_id=? AND ordinal=?", values[:2])
                self.db.execute('''INSERT INTO images(post_id,ordinal,post_url,published,text,total,url,expected_width,expected_height)
                    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(post_id,ordinal) DO UPDATE SET
                    post_url=excluded.post_url,published=excluded.published,text=excluded.text,
                    total=excluded.total,url=excluded.url,expected_width=excluded.expected_width,
                    expected_height=excluded.expected_height,active=1''', values)
            if post.get('capture_complete'):
                self.db.execute('UPDATE images SET active=0 WHERE post_id=? AND ordinal>?',
                                (post['id'], post['image_count']))
        self.db.commit()

    def index_existing(self):
        paths = [p for p in self.root.rglob('*') if '.collection' not in p.relative_to(self.root).parts]
        paths += [Path(p) for p in self.state.get('reuse_files', [])]
        for path in paths:
            if path.is_file() and path.suffix.lower().lstrip('.') in set(FORMATS.values()) | {'jpeg'}:
                try:
                    info = inspect_file(path)
                    self.hash_paths.setdefault(info['sha256'], str(path))
                except Exception:
                    pass

    def update(self, row, **values):
        values['updated'] = datetime.now().astimezone().isoformat()
        with self.lock:
            self.db.execute('UPDATE images SET ' + ','.join(f'{k}=?' for k in values) + ' WHERE post_id=? AND ordinal=?',
                            [*values.values(), row['post_id'], row['ordinal']])
            self.db.commit()

    def fetch(self, row, part):
        parsed = urlparse(row['url'])
        if parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.hdslb.com'):
            if not (self.allow_local and parsed.hostname in {'127.0.0.1', 'localhost'}):
                raise ValueError('URL is not an observed HTTPS Bilibili image CDN resource')
        meta_path = part.with_suffix('.part.json')
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        offset = part.stat().st_size if part.exists() and meta.get('url') == row['url'] else 0
        validator = meta.get('etag') or meta.get('last_modified')
        if validator and validator.startswith('W/'):
            validator = meta.get('last_modified')
        if offset and not validator:
            offset = 0
        headers = {'Referer': row['post_url'], 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity'}
        if offset:
            headers.update({'Range': f'bytes={offset}-', 'If-Range': validator})
        # A fresh Session per transfer; no browser credentials or cookie store is accessed.
        with requests.Session() as session:
            session.trust_env = False  # Also disables implicit .netrc credentials.
            session.cookies.clear()
            with session.get(row['url'], headers=headers, stream=True, timeout=(15, 60), allow_redirects=False) as response:
                if response.status_code in {401, 403, 412}:
                    raise Restriction(f'access restriction HTTP {response.status_code}')
                if response.status_code == 429:
                    with self.lock:
                        self.restrictions += 1
                        if self.restrictions >= 3:
                            raise Restriction('three consecutive HTTP 429 responses')
                    response.raise_for_status()
                elif response.status_code == 416:
                    part.unlink(missing_ok=True)
                    meta_path.unlink(missing_ok=True)
                    raise requests.RequestException('Range no longer valid; restart transfer')
                else:
                    with self.lock:
                        self.restrictions = 0
                response.raise_for_status()
                if response.status_code not in {200, 206}:
                    raise requests.RequestException(f'unexpected image response HTTP {response.status_code}')
                if 'text/html' in response.headers.get('Content-Type', '').lower():
                    raise Restriction('image URL returned HTML; possible login/captcha/access restriction')
                if response.status_code == 206:
                    content_range = response.headers.get('Content-Range', '')
                    if not offset or not content_range.startswith(f'bytes {offset}-'):
                        part.unlink(missing_ok=True)
                        meta_path.unlink(missing_ok=True)
                        raise requests.RequestException('invalid resumed Content-Range')
                    new_validator = response.headers.get('ETag') or response.headers.get('Last-Modified')
                    if new_validator and new_validator != validator:
                        part.unlink(missing_ok=True)
                        meta_path.unlink(missing_ok=True)
                        raise requests.RequestException('resource validator changed')
                else:
                    offset = 0
                atomic_json(meta_path, {'url': row['url'], 'etag': response.headers.get('ETag'),
                                       'last_modified': response.headers.get('Last-Modified')})
                received = 0
                with open(part, 'ab' if offset else 'wb') as f:
                    for chunk in response.iter_content(64 * 1024):
                        if self.stop.is_set():
                            raise Restriction('stopped after another transfer encountered restriction')
                        if chunk:
                            f.write(chunk)
                            received += len(chunk)
                    f.flush()
                    os.fsync(f.fileno())
                length = response.headers.get('Content-Length')
                if length is not None and received != int(length):
                    raise requests.RequestException('response length mismatch')
                if response.status_code == 206:
                    total = response.headers.get('Content-Range', '').rsplit('/', 1)[-1]
                    if not total.isdigit() or part.stat().st_size != int(total):
                        raise requests.RequestException('resumed resource total length mismatch')

    def download(self, row):
        if self.stop.is_set():
            return
        if row['status'] == 'success' and row['path']:
            try:
                info = inspect_file(row['path'])
                if info['sha256'] == row['sha256'] and (info['width'], info['height']) == (row['expected_width'], row['expected_height']):
                    return
            except Exception:
                pass
        part = self.work / f"{row['post_id']}_{row['ordinal']:03d}.part"
        self.update(row, status='downloading', error=None)
        for attempt in range(4):
            if self.stop.is_set():
                self.update(row, status='pending', error='stopped due to access restriction')
                return
            try:
                self.update(row, attempts=row['attempts'] + attempt + 1)
                self.fetch(row, part)
                info = inspect_file(part)
                if (info['width'], info['height']) != (row['expected_width'], row['expected_height']):
                    raise ValueError(f"size mismatch: {(info['width'], info['height'])} != {(row['expected_width'], row['expected_height'])}")
                date = row['published'][:10]
                datetime.strptime(date, '%Y-%m-%d')
                folder = self.root / date[:4] / f"{date}_{row['post_id']}"
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / f"{row['ordinal']:03d}.{FORMATS[info['format']]}"
                duplicate, reuse, reuse_reason = None, None, None
                with self.lock:
                    if target.exists():
                        if inspect_file(target)['sha256'] != info['sha256']:
                            raise ValueError(f'preserving existing different file: {target}')
                        duplicate = self.hash_paths.get(info['sha256'])
                        if duplicate == str(target):
                            duplicate = None
                        reuse = 'existing'
                        part.unlink(missing_ok=True)
                    elif info['sha256'] in self.hash_paths:
                        duplicate = self.hash_paths[info['sha256']]
                        try:
                            os.link(duplicate, target)
                            reuse = 'hardlink'
                        except OSError as exc:
                            shutil.copyfile(duplicate, target)
                            reuse = 'copy'
                            reuse_reason = str(exc)
                        part.unlink(missing_ok=True)
                    else:
                        os.replace(part, target)
                    self.hash_paths.setdefault(info['sha256'], str(target))
                part.with_suffix('.part.json').unlink(missing_ok=True)
                self.update(row, status='success', path=str(target), duplicate_of=duplicate,
                            reuse_mode=reuse, reuse_reason=reuse_reason, error=None,
                            **{k: info[k] for k in ['format', 'width', 'height', 'frames', 'bytes', 'sha256']})
                print(json.dumps({'post': row['post_id'], 'image': row['ordinal'], 'status': 'success',
                                  'format': info['format'], 'frames': info['frames'], 'duplicate': bool(duplicate)}, ensure_ascii=False), flush=True)
                return
            except Restriction as exc:
                self.stop.set()
                self.update(row, status='pending' if self.interrupted else 'blocked', error=str(exc))
                if not self.interrupted:
                    atomic_json(self.collection / 'download-stop.json', {'reason': str(exc)})
                print(json.dumps({'status': 'blocked', 'error': str(exc)}, ensure_ascii=False), flush=True)
                return
            except Exception as exc:
                self.update(row, status='failed', error=f'{type(exc).__name__}: {exc}')
                if isinstance(exc, ValueError):
                    return
                if attempt < 3:
                    self.stop.wait(min(2 ** (attempt + 1), 8))
        print(json.dumps({'post': row['post_id'], 'image': row['ordinal'], 'status': 'failed'}, ensure_ascii=False), flush=True)

    def run(self, ids=None, failed_only=False):
        self.import_posts()
        self.index_existing()
        query = 'SELECT * FROM images WHERE active=1'
        rows = list(self.db.execute(query))
        rows = [r for r in rows if (not ids or r['post_id'] in ids) and
                (not failed_only or r['status'] in {'failed', 'blocked', 'pending', 'downloading'})]
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.download, r) for r in rows]
            for f in as_completed(futures):
                f.result()
        return self.report()

    def watch(self, interval=15):
        """Consume newly captured rows, without repeatedly retrying failed rows."""
        self.import_posts()
        self.index_existing()
        while not self.stop.is_set():
            self.import_posts()
            if self.state.get('phase') in {'blocked', 'interrupted'}:
                break
            rows = list(self.db.execute("SELECT * FROM images WHERE status IN ('pending','downloading')"))
            rows = [r for r in rows if r['active']]
            if rows:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    for future in as_completed([pool.submit(self.download, row) for row in rows]):
                        future.result()
                self.report()
            index_path = self.collection / 'index.json'
            index = json.loads(index_path.read_text()) if index_path.exists() else {}
            candidates = index.get('candidates', {})
            terminal = index.get('phase') in {'captured', 'blocked', 'interrupted'}
            if terminal or (history_complete(index) and all(
                c.get('status') in {'captured', 'excluded', 'failed', 'blocked'} for c in candidates.values()
            )):
                # Capture writes the post file before marking its index entry complete.
                # Import once more after that marker to close the final-file race.
                self.import_posts()
                if self.db.execute("SELECT 1 FROM images WHERE active=1 AND status IN ('pending','downloading') LIMIT 1").fetchone():
                    continue
                break
            self.stop.wait(interval)
        return self.report()

    def report(self):
        rows = [dict(r) for r in self.db.execute('SELECT * FROM images WHERE active=1 ORDER BY published,post_id,ordinal')]
        index_path = self.collection / 'index.json'
        index = json.loads(index_path.read_text()) if index_path.exists() else {}
        posts = [json.loads(p.read_text()) for p in (self.collection / 'posts').glob('*.json')]
        posts = [p for p in posts if index.get('candidates', {}).get(p['id'], {}).get('status') != 'excluded']
        traversal = index.get('traversal', {})
        history_done = history_complete(index)
        complete_posts = all(p.get('capture_complete', False) for p in posts)
        capture_failures = [v for v in index.get('candidates', {}).values() if v.get('status') not in {'captured', 'excluded'}]
        successes = [r for r in rows if r['status'] == 'success']
        failures = [r for r in rows if r['status'] != 'success']
        capture_keys = {(str(p['id']), int(i['ordinal'])) for p in posts for i in p.get('images', [])}
        download_keys = {(r['post_id'], r['ordinal']) for r in rows}
        count_mismatches = [p['id'] for p in posts if p.get('capture_complete') and (
            p['image_count'] != len(p.get('images', []))
            or [i['ordinal'] for i in p['images']] != list(range(1, p['image_count'] + 1)))]
        coverage_complete = capture_keys == download_keys and not count_mismatches
        captured_ids = {k for k, c in index.get('candidates', {}).items() if c.get('status') == 'captured'}
        coverage_complete = coverage_complete and captured_ids == {p['id'] for p in posts if p.get('capture_complete')}
        summary = {'complete': history_done and complete_posts and coverage_complete and not capture_failures and not failures
                   and index.get('phase') not in {'blocked', 'interrupted'},
                   'uid': index.get('uid'), 'history_complete': history_done, 'candidate_posts': len(index.get('candidates', {})),
                   'eligible_posts': len(posts), 'expected_images': sum(p['image_count'] for p in posts), 'successful_images': len(successes),
                   'duplicate_images': sum(bool(r['duplicate_of']) for r in successes),
                   'unique_successful_hashes': len({r['sha256'] for r in successes}),
                   'animated_images': sum((r['frames'] or 1) > 1 and r['format'] in {'GIF', 'PNG', 'WEBP', 'AVIF'} for r in successes),
                   'capture_failures': capture_failures, 'download_failures': failures, 'traversal': traversal,
                   'coverage_complete': coverage_complete, 'count_mismatches': count_mismatches,
                   'untracked_images': sorted(capture_keys - download_keys),
                   'obsolete_rows': [dict(r) for r in self.db.execute('SELECT * FROM images WHERE active=0')]}
        atomic_json(self.root / 'download_manifest.json', {'summary': summary, 'images': rows, 'posts': posts})
        csv_path = self.root / 'download_manifest.csv'
        tmp = csv_path.with_suffix('.csv.tmp')
        with tmp.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ['post_id', 'ordinal', 'status'])
            writer.writeheader()
            writer.writerows(rows)
        os.replace(tmp, csv_path)
        atomic_json(self.root / 'download_report.json', summary)
        print(json.dumps({k: v for k, v in summary.items() if k not in {'capture_failures', 'download_failures', 'traversal'}}, ensure_ascii=False), flush=True)
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Per-UID archive directory printed by archive.py')
    parser.add_argument('--post', action='append')
    parser.add_argument('--failed-only', action='store_true')
    parser.add_argument('--report-only', action='store_true')
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    dl = Downloader(args.root)
    def interrupt(*_):
        dl.interrupted = True
        dl.stop.set()
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        if args.failed_only:
            (dl.collection / 'download-stop.json').unlink(missing_ok=True)
        elif (dl.collection / 'download-stop.json').exists() and not args.report_only:
            raise SystemExit('Access restriction checkpoint exists; resolve it before --failed-only.')
        summary = dl.report() if args.report_only else dl.watch() if args.watch else dl.run(set(args.post or []), args.failed_only)
    finally:
        dl.close()
    raise SystemExit(130 if dl.interrupted else 0 if summary['complete'] else 1)


if __name__ == '__main__':
    main()
