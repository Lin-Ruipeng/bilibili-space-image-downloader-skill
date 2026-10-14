import test from 'node:test';
import assert from 'node:assert/strict';
import {applyObservedPage, candidateFromItem, identifier, mergeCandidate, observedPage, selectViewer}
  from '../skills/bilibili-space-image-downloader/scripts/browser_core.mjs';

const feed = (id = '90071992547409931', type = 'DYNAMIC_TYPE_DRAW') => ({
  id_str: id, type, modules: {module_author: {mid: 12345},
    module_dynamic: {major: {opus: {pics: [{}, {}]}}}},
});

test('large IDs retain every digit; unsafe numeric IDs are rejected', () => {
  assert.equal(identifier('90071992547409931'), '90071992547409931');
  assert.throws(() => identifier(90071992547409931), /unsafe/);
});

test('pinned and cross-entry appearances retain one post and all sources', () => {
  const index = {candidates: {}};
  mergeCandidate(index, candidateFromItem(feed(), '12345', 'dynamic', false));
  mergeCandidate(index, candidateFromItem(feed(), '12345', 'dynamic', false));
  mergeCandidate(index, candidateFromItem(feed(), '12345', 'opus', false));
  assert.equal(Object.keys(index.candidates).length, 1);
  assert.deepEqual(Object.values(index.candidates)[0].sources, ['dynamic', 'opus']);
});

test('scope excludes reposts, other authors, video, audio, and optional columns', () => {
  assert.equal(candidateFromItem(feed('1', 'DYNAMIC_TYPE_FORWARD'), '12345', 'dynamic', false).exclusion_reason, 'repost');
  assert.equal(candidateFromItem(feed('2', 'DYNAMIC_TYPE_AV'), '12345', 'dynamic', false).exclusion_reason, 'video');
  assert.equal(candidateFromItem(feed('3', 'DYNAMIC_TYPE_MUSIC'), '12345', 'dynamic', false).exclusion_reason, 'audio');
  assert.equal(candidateFromItem(feed('4', 'DYNAMIC_TYPE_ARTICLE'), '12345', 'dynamic', false).exclusion_reason, 'column_disabled');
  assert.equal(candidateFromItem(feed('4', 'DYNAMIC_TYPE_ARTICLE'), '12345', 'column', true).status, 'pending');
  assert.equal(candidateFromItem(feed(), '54321', 'dynamic', false).exclusion_reason, 'other_author');
});

test('end evidence must come from the requested UID and correct entry', () => {
  const payload = {code: 0, data: {items: [], has_more: false}};
  const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=12345';
  assert.equal(observedPage(url, payload, '54321', 'dynamic'), null);
  assert.equal(observedPage(url, payload, '12345', 'opus'), null);
  const index = {uid: '12345', include_columns: false, candidates: {}, traversal: {}};
  applyObservedPage(index, 'dynamic', observedPage(url, payload, '12345', 'dynamic'));
  assert.equal(index.traversal.dynamic.complete, true);
  assert.equal(index.traversal.dynamic.end_evidence.has_more, false);
});

test('an observation gap keeps history incomplete even at its final page', () => {
  const index = {uid: '12345', candidates: {}, traversal: {dynamic: {pages: 0, observation_gap: true}}};
  applyObservedPage(index, 'dynamic', {items: [], has_more: false, endpoint: 'fixture', offset: ''});
  assert.equal(index.traversal.dynamic.complete, false);
});

const image = (url = 'https://i0.hdslb.com/bfs/album/fixture.png', extra = {}) => ({
  url, complete: true, width: 100, height: 80, area: 8000, placeholder: false, ...extra,
});
const snapshot = (counter = '1 / 2') => ({open: true, counter, viewportWidth: 400, slides: [
  {index: 0, center: -200, visibleWidth: 0, images: [image('preload')]},
  {index: 1, center: 200, visibleWidth: 400, images: [image()]},
  {index: 2, center: 600, visibleWidth: 0, images: [image('next-preload')]},
]});

test('viewer chooses the aligned active slide rather than a loaded neighbor', () => {
  assert.match(selectViewer(snapshot(), 1).url, /fixture/);
  assert.equal(selectViewer(snapshot(), 2), null);
});

test('a changed page may legitimately show the same image URL', () => {
  assert.equal(selectViewer(snapshot('1 / 2'), 1).url, selectViewer(snapshot('2 / 2'), 2).url);
});

test('activity and alignment use the viewer frame, including scrollbar width', () => {
  const value = snapshot();
  value.viewportWidth = 385;
  value.slides[1].center = 192.5;
  value.slides[1].visibleWidth = 385;
  assert.ok(selectViewer(value, 1));
  value.slides[1].ariaHidden = true;
  assert.equal(selectViewer(value, 1), null);
});

test('animation transitions, placeholders, and unfinished loading cannot be captured', () => {
  const transition = snapshot(); transition.slides[1].center = 240;
  assert.equal(selectViewer(transition), null);
  const placeholder = snapshot(); placeholder.slides[1].images[0].placeholder = true;
  assert.equal(selectViewer(placeholder), null);
  const loading = snapshot(); loading.slides[1].images[0].complete = false;
  assert.equal(selectViewer(loading), null);
});
