import hashlib
import io
import json
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/bilibili-space-image-downloader/scripts'
sys.path.insert(0, str(SCRIPTS))
from archive import atomic_json, initialize, load_state
from download_images import Downloader
from verify_archive import verify


class DownloadChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = initialize('12345', self.tmp.name)
        self.state = {'fail': False, 'interrupt': False, 'ranges': [], 'attempts': 0,
                      'status': 200, 'etag': '"stable"', 'headers': [], 'ignore_range': False}
        self.payload = self.png(96, 64)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                state = outer.state
                state['attempts'] += 1
                state['headers'].append(dict(self.headers))
                if state['fail']:
                    self.send_error(404)
                    return
                if state['status'] != 200:
                    self.send_error(state['status'])
                    return
                offset = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
                if offset:
                    state['ranges'].append((offset, self.headers.get('If-Range')))
                if state['ignore_range']:
                    offset = 0
                self.send_response(206 if offset else 200)
                self.send_header('ETag', state['etag'])
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(outer.payload) - offset))
                if offset:
                    self.send_header('Content-Range', f'bytes {offset}-{len(outer.payload)-1}/{len(outer.payload)}')
                self.end_headers()
                if state['interrupt']:
                    state['interrupt'] = False
                    self.wfile.write(outer.payload[:131072])
                    self.wfile.flush()
                    self.close_connection = True
                else:
                    self.wfile.write(outer.payload[offset:])

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/viewer-resource'
        self.downloaders = []

    @staticmethod
    def png(width, height):
        output = io.BytesIO()
        Image.frombytes('RGB', (width, height), random.Random(19).randbytes(width * height * 3)).save(output, format='PNG')
        return output.getvalue()

    def tearDown(self):
        for downloader in self.downloaders:
            downloader.close()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def downloader(self):
        downloader = Downloader(self.root, allow_local=True)
        downloader.stop.wait = lambda _: False
        self.downloaders.append(downloader)
        return downloader

    def post(self, post_id='90071992547409931', count=1, width=96, height=64, evidence=True):
        images = []
        for ordinal in range(1, count + 1):
            image = {'ordinal': ordinal, 'url': self.url, 'width': width, 'height': height}
            if evidence:
                image['viewer'] = {'source': 'gray_overlay', 'page': ordinal, 'total': count,
                                   'current_src': self.url, 'loaded': True}
            images.append(image)
        atomic_json(self.root / '.collection/posts' / f'{post_id}.json', {
            'id': post_id, 'url': f'https://www.bilibili.com/opus/{post_id}', 'uid': '12345',
            'author_uid_verified': True, 'published': '2020-01-01T00:00:00+08:00',
            'text': 'generated fixture', 'image_count': count, 'capture_complete': True, 'images': images,
        })
        state = load_state(self.root)
        state['candidates'][post_id] = {'id': post_id, 'status': 'captured', 'sources': ['dynamic', 'opus']}
        atomic_json(self.root / '.collection/index.json', state)

    def finish_history(self):
        state = load_state(self.root)
        state['traversal'] = {entry: {'complete': True, 'end_evidence': {
            'type': 'browser_observed_response', 'has_more': False}} for entry in state['required_entries']}
        state['phase'] = 'captured'
        atomic_json(self.root / '.collection/index.json', state)

    def test_disconnect_resume_dedup_and_no_credentials(self):
        self.payload = self.png(512, 512)
        self.state['interrupt'] = True
        self.post(width=512, height=512)
        self.post('90071992547409932', width=512, height=512)
        self.finish_history()
        downloader = self.downloader()
        report = downloader.run()
        self.assertTrue(report['complete'])
        self.assertEqual(report['duplicate_images'], 1)
        self.assertTrue(self.state['ranges'])
        self.assertEqual(self.state['ranges'][0][1], '"stable"')
        rows = list(downloader.db.execute('SELECT path,sha256 FROM images'))
        self.assertEqual(Path(rows[0]['path']).read_bytes(), self.payload)
        self.assertEqual(rows[0]['sha256'], hashlib.sha256(self.payload).hexdigest())
        self.assertEqual(os.stat(rows[0]['path']).st_ino, os.stat(rows[1]['path']).st_ino)
        self.assertTrue(all('Cookie' not in h and 'Authorization' not in h for h in self.state['headers']))
        self.assertTrue(verify(self.root)['complete'])

    def test_failure_repair_animation_and_success_skip(self):
        output = io.BytesIO()
        Image.new('RGB', (32, 24), 'red').save(output, format='GIF', save_all=True,
            append_images=[Image.new('RGB', (32, 24), 'blue')], duration=[90, 120], loop=0)
        self.payload = output.getvalue()
        self.post(width=32, height=24)
        self.finish_history()
        downloader = self.downloader()
        self.state['fail'] = True
        self.assertFalse(downloader.run()['complete'])
        self.assertEqual(self.state['attempts'], 4)
        self.state['fail'] = False
        self.assertTrue(downloader.run(failed_only=True)['complete'])
        row = downloader.db.execute('SELECT * FROM images').fetchone()
        self.assertEqual((row['format'], row['frames']), ('GIF', 2))
        self.assertEqual(Path(row['path']).read_bytes(), self.payload)
        attempts = self.state['attempts']
        downloader.run()
        self.assertEqual(self.state['attempts'], attempts)

    def test_unproven_history_and_cli_exit_code(self):
        self.post()
        downloader = self.downloader()
        self.assertFalse(downloader.run()['complete'])
        result = subprocess.run([sys.executable, str(SCRIPTS / 'download_images.py'), '--root', str(self.root), '--report-only'], capture_output=True)
        self.assertEqual(result.returncode, 1)
        state = load_state(self.root)
        state['traversal'] = {entry: {'complete': True} for entry in state['required_entries']}
        atomic_json(self.root / '.collection/index.json', state)
        self.assertFalse(downloader.report()['complete'])

    def test_empty_archive_watch_finishes(self):
        self.finish_history()
        self.assertTrue(self.downloader().watch(interval=0)['complete'])

    def test_watch_waits_for_history_not_just_queue(self):
        self.post()
        downloader = self.downloader()
        waits = []
        def wait(_):
            waits.append(True)
            self.finish_history()
            return False
        downloader.stop.wait = wait
        self.assertTrue(downloader.watch(interval=0)['complete'])
        self.assertEqual(len(waits), 1)

    def test_truncated_recapture_preserves_old_file_but_deactivates_row(self):
        self.post(count=2)
        self.finish_history()
        downloader = self.downloader()
        self.assertTrue(downloader.run()['complete'])
        old_path = downloader.db.execute('SELECT path FROM images WHERE ordinal=2').fetchone()[0]
        self.post(count=1)
        report = downloader.run()
        self.assertTrue(report['complete'])
        self.assertEqual(report['expected_images'], 1)
        self.assertEqual(len(report['obsolete_rows']), 1)
        self.assertTrue(Path(old_path).exists())

    def test_missing_viewer_evidence_rejected(self):
        self.post(evidence=False)
        with self.assertRaisesRegex(ValueError, 'viewer evidence'):
            self.downloader().run()
        self.assertEqual(self.state['attempts'], 0)

    def test_restriction_stops_and_persists_checkpoint(self):
        self.post()
        self.state['status'] = 403
        downloader = self.downloader()
        self.assertFalse(downloader.run()['complete'])
        self.assertTrue(downloader.stop.is_set())
        self.assertTrue((self.root / '.collection/download-stop.json').exists())
        self.assertEqual(self.state['attempts'], 1)

    def test_range_ignored_restarts_from_original_bytes(self):
        self.post()
        downloader = self.downloader()
        partial = downloader.work / '90071992547409931_001.part'
        partial.write_bytes(b'old resource prefix')
        atomic_json(partial.with_suffix('.part.json'), {'url': self.url, 'etag': '"old"'})
        self.state['ignore_range'] = True
        self.finish_history()
        self.assertTrue(downloader.run()['complete'])
        row = downloader.db.execute('SELECT path FROM images').fetchone()
        self.assertEqual(Path(row['path']).read_bytes(), self.payload)

    def test_changed_validator_discards_partial_before_retry(self):
        self.post()
        downloader = self.downloader()
        partial = downloader.work / '90071992547409931_001.part'
        partial.write_bytes(self.payload[:100])
        atomic_json(partial.with_suffix('.part.json'), {'url': self.url, 'etag': '"old"'})
        self.finish_history()
        self.assertTrue(downloader.run()['complete'])
        self.assertEqual(self.state['attempts'], 2)
        self.assertEqual(Path(downloader.db.execute('SELECT path FROM images').fetchone()[0]).read_bytes(), self.payload)

    def test_copy_fallback_records_reason_and_preserves_bytes(self):
        self.post(count=2)
        self.finish_history()
        with patch('download_images.os.link', side_effect=OSError('fixture filesystem has no hardlinks')):
            downloader = self.downloader()
            self.assertTrue(downloader.run()['complete'])
        row = downloader.db.execute("SELECT * FROM images WHERE reuse_mode='copy'").fetchone()
        self.assertIn('no hardlinks', row['reuse_reason'])
        self.assertEqual(Path(row['path']).read_bytes(), self.payload)

    def test_three_rate_limit_responses_stop_without_fourth_attempt(self):
        self.post()
        self.state['status'] = 429
        downloader = self.downloader()
        self.assertFalse(downloader.run()['complete'])
        self.assertEqual(self.state['attempts'], 3)
        self.assertTrue(downloader.stop.is_set())

    def test_uid_isolation_and_scope_guard(self):
        other = initialize('54321', self.tmp.name)
        self.assertNotEqual(other, self.root)
        with self.assertRaisesRegex(ValueError, 'scope differs'):
            initialize('12345', self.tmp.name, include_columns=True)

    def test_sigterm_watcher_saves_report_and_returns_interrupted(self):
        process = subprocess.Popen([sys.executable, str(SCRIPTS / 'download_images.py'),
            '--root', str(self.root), '--watch'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / '.collection/downloads.sqlite3').exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertIsNone(process.poll())
            time.sleep(0.1)
            process.terminate()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130, stderr.decode())
            self.assertFalse(json.loads((self.root / 'download_report.json').read_text())['complete'])
            self.assertIn(b'"history_complete": false', stdout)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
