import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCollector} from '../skills/bilibili-space-image-downloader/scripts/browser_collect.mjs';

const PID = '90071992547409931';

async function fixture(phase = 'capturing') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-collect-test-'));
  await fs.mkdir(path.join(root, '.collection', 'posts'), {recursive: true});
  await fs.writeFile(path.join(root, '.collection', 'index.json'), JSON.stringify({
    schema_version: 2, uid: '12345', include_columns: false,
    required_entries: ['dynamic', 'opus'], phase, candidates: {}, traversal: {},
  }));
  return root;
}

const img = () => ({tagName: 'IMG', closest: () => ({}), matches: () => false, querySelectorAll: () => []});
const wrapper = (cls, images) => ({
  tagName: 'DIV', cls, closest: () => ({}),
  matches: sel => sel === cls,
  querySelectorAll: sel => (sel === 'img' ? images : []),
});

function stubDocument(layoutEls, bodyImgs) {
  const byClass = cls => layoutEls.filter(e => e.cls === cls);
  const root = {
    querySelector: () => null,
    querySelectorAll: sel => sel.includes(',') ? layoutEls : ({
      '.opus-pic-view': byClass('.opus-pic-view'),
      '.horizontal-scroll-album__pic__img': byClass('.horizontal-scroll-album__pic__img'),
      '.bili-album__preview__picture__img': byClass('.bili-album__preview__picture__img'),
      'picture.b-img__inner': byClass('picture.b-img__inner'),
      'img': bodyImgs,
    }[sel] ?? []),
  };
  globalThis.document = {querySelector: sel => (sel === '.bili-opus-view' ? root : null), body: {innerText: ''}};
}

const stubTab = () => ({playwright: {evaluate: async fn => fn()}});

function currentPost(collector, metadata, candidate = {id: PID, status: 'pending'}) {
  collector.current = {
    candidate, groups: metadata.groups, gi: 0, base: 0, page: 0, total: 0, phase: 'open',
    expected: metadata.expected_images, group_pictures: metadata.group_pictures, body_images: metadata.bodyImages,
    post: {id: PID, images: [], image_count: 0, capture_complete: false},
  };
}

const slide = (page, total) => ({page, total, url: `https://i0.hdslb.com/bfs/album/f${page}.png`, width: 100, height: 80});

test('mixed layouts become DOM-ordered groups and a spanning viewer collapses them', async () => {
  const root = await fixture();
  const rich = wrapper('.opus-pic-view', [img()]);
  const h1 = wrapper('.horizontal-scroll-album__pic__img', [img()]);
  const h2 = wrapper('.horizontal-scroll-album__pic__img', [img()]);
  stubDocument([rich, h1, h2], [img(), img(), img()]);
  const collector = await createCollector({tab: stubTab(), root, cdp: null});
  const metadata = await collector.metadata();
  assert.deepEqual(metadata.groups, [{type: 'rich', index: 0, pictures: 1}, {type: 'horizontal', index: 0}]);
  assert.deepEqual(metadata.group_pictures, [1, 2]);
  assert.equal(metadata.expected_images, 3);
  assert.equal(metadata.bodyImages, 3);
  currentPost(collector, metadata);
  await collector.record(slide(1, 3));
  assert.equal(collector.current.groups.length, 1);
  await collector.record(slide(2, 3));
  await collector.record(slide(3, 3));
  const step = await collector.captureStep();
  assert.equal(step.status, 'captured');
  assert.equal(step.images, 3);
});

test('horizontal before rich in the body keeps document order', async () => {
  const root = await fixture();
  const h1 = wrapper('.horizontal-scroll-album__pic__img', [img()]);
  const rich = wrapper('.opus-pic-view', [img()]);
  stubDocument([h1, rich], [img(), img()]);
  const collector = await createCollector({tab: stubTab(), root, cdp: null});
  const metadata = await collector.metadata();
  assert.deepEqual(metadata.groups.map(g => g.type), ['horizontal', 'rich']);
});

test('single-layout group shapes stay byte-identical for resume compatibility', async () => {
  const root = await fixture();
  const r1 = wrapper('.opus-pic-view', [img()]);
  const r2 = wrapper('.opus-pic-view', [img()]);
  stubDocument([r1, r2], [img(), img()]);
  const collector = await createCollector({tab: stubTab(), root, cdp: null});
  const metadata = await collector.metadata();
  assert.deepEqual(metadata.groups, [
    {type: 'rich', index: 0, pictures: 1}, {type: 'rich', index: 1, pictures: 1}]);
  const hroot = await fixture();
  stubDocument([wrapper('.horizontal-scroll-album__pic__img', [img(), img()])], [img(), img()]);
  const hcollector = await createCollector({tab: stubTab(), root: hroot, cdp: null});
  assert.deepEqual((await hcollector.metadata()).groups, [{type: 'horizontal', index: 0}]);
});

test('unassignable body images fail the post instead of reporting complete', async () => {
  const root = await fixture();
  const rich = wrapper('.opus-pic-view', [img()]);
  stubDocument([rich], [img(), img()]);
  const collector = await createCollector({tab: stubTab(), root, cdp: null});
  const metadata = await collector.metadata();
  assert.equal(metadata.expected_images, 1);
  assert.equal(metadata.bodyImages, 2);
  currentPost(collector, metadata);
  await collector.record(slide(1, 1));
  await assert.rejects(() => collector.captureStep(), /unassigned body images mismatch/);
  assert.equal(collector.current.post.capture_complete, false);
});

test('an unexplainable viewer aggregation fails instead of guessing ordinals', async () => {
  const root = await fixture();
  const rich = wrapper('.opus-pic-view', [img()]);
  const h1 = wrapper('.horizontal-scroll-album__pic__img', [img()]);
  const h2 = wrapper('.horizontal-scroll-album__pic__img', [img()]);
  stubDocument([rich, h1, h2], [img(), img(), img()]);
  const collector = await createCollector({tab: stubTab(), root, cdp: null});
  const metadata = await collector.metadata();
  currentPost(collector, metadata);
  await assert.rejects(() => collector.record(slide(1, 2)), /viewer total mismatch with body group layout/);
});