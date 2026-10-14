#!/usr/bin/env python3
"""Install the bundled skill without overwriting an existing installation."""
import argparse
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

NAME = 'bilibili-space-image-downloader'


def install(destination=None, update=False):
    source = Path(__file__).resolve().parent / 'skills' / NAME
    base = Path(destination).expanduser() if destination else Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'skills'
    target = base.resolve() / NAME
    if source.resolve() == target:
        raise ValueError('source is already the target')
    if target.exists() and not update:
        raise FileExistsError(f'{target} already exists; --update preserves it as a timestamped backup')
    stage = target.with_name(target.name + '.installing')
    if stage.exists():
        raise FileExistsError(f'previous installation staging directory exists: {stage}')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, stage, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo'))
    if target.exists():
        timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        target.rename(target.with_name(target.name + '.backup-' + timestamp))
    stage.rename(target)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    print(install(args.destination, args.update))
