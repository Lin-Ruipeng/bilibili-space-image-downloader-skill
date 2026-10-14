// Import inside Codex cua_repl after reading its current browser/CDP documentation.
// Browser operations use the supplied logged-in Tab; no standalone browser or API fetch.
import fs from 'node:fs/promises';
import path from 'node:path';
import {applyObservedPage, identifier, mergeCandidate, observedPage, selectViewer, viewerDomSnapshot} from './browser_core.mjs';

const NETWORK_METHODS = ['Network.responseReceived', 'Network.loadingFinished'];
const RESTRICTION = /saved user permission|captcha|验证码|访问过于频繁|访问受限|登录.{0,4}失效|账号未登录|access restriction/i;

export async function createCollector({tab, root, cdp = null, tabs = null}) {
  root = path.resolve(root);
  const indexPath = path.join(root, '.collection', 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  identifier(index.uid);
  if (['blocked', 'interrupted'].includes(index.phase))
    throw Error('Resolve the saved restriction/interruption, then use archive.py --resume before collecting.');
  const collector = {
    tab, root, index, cdp, cursor: null, requests: new Map(), entry: null,
    lastAction: Date.now(), current: null, stopped: false, idle: 0, lastSignature: '',
  };
  const saveJSON = async (destination, value) => {
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination + '.tmp', JSON.stringify(value, null, 2));
    await fs.rename(destination + '.tmp', destination);
  };
  collector.save = () => saveJSON(indexPath, collector.index);
  collector.block = async reason => {
    collector.stopped = true; collector.index.phase = 'blocked'; collector.index.blocked_reason = String(reason);
    await collector.save();
  };
  collector.action = async operation => {
    try {
      const stopFile = path.join(root, '.collection', 'download-stop.json');
      try {
        const stop = JSON.parse(await fs.readFile(stopFile, 'utf8'));
        throw Error(`access restriction: ${stop.reason}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const delay = 3000 - (Date.now() - collector.lastAction);
      if (delay > 0) await tab.playwright.waitForTimeout(delay);
      await operation(); collector.lastAction = Date.now();
      await tab.getAXState({emit: false});
      if (collector.entry && cdp) await collector.drain();
    } catch (error) {
      if (RESTRICTION.test(String(error))) await collector.block(error);
      throw error;
    }
  };
  collector.enableObservation = async () => {
    if (!cdp) return;
    await cdp.send('Network.enable');
    collector.cursor = (await cdp.readEvents({methods: NETWORK_METHODS})).cursor;
  };
  collector.close = async () => { if (cdp) await cdp.send('Network.disable'); };

  collector.drain = async () => {
    if (!cdp || collector.cursor == null) return;
    let events;
    do {
      events = await cdp.readEvents({afterSequence: collector.cursor, methods: NETWORK_METHODS, limit: 500});
      collector.cursor = events.cursor;
      if (events.truncated) {
        collector.index.traversal[collector.entry] = {
          ...collector.index.traversal[collector.entry], observation_gap: true,
        };
      }
      for (const event of events.events) {
        if (event.method !== 'Network.responseReceived') continue;
        const response = event.params?.response;
        if (!response || !/\/feed\/space(?:\?|$)/.test(response.url)) continue;
        collector.requests.set(event.params.requestId, {url: response.url, status: response.status, entry: collector.entry});
      }
    } while (events.hasMore);
    for (const [requestId, request] of collector.requests) {
      if (request.entry !== collector.entry) { collector.requests.delete(requestId); continue; }
      if ([401, 403, 412, 429].includes(request.status)) {
        await collector.block(`access restriction HTTP ${request.status}`); return;
      }
      let body;
      try { body = await cdp.send('Network.getResponseBody', {requestId}); }
      catch (error) {
        if (RESTRICTION.test(String(error))) { await collector.block(error); throw error; }
        request.bodyAttempts = (request.bodyAttempts ?? 0) + 1;
        if (request.bodyAttempts > 30) {
          collector.index.traversal[collector.entry] = {...collector.index.traversal[collector.entry], observation_gap: true};
          collector.requests.delete(requestId);
        }
        continue;
      }
      const payload = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
      const page = observedPage(request.url, payload, collector.index.uid, collector.entry);
      if (page) applyObservedPage(collector.index, collector.entry, page);
      collector.requests.delete(requestId);
    }
  };

  collector.discoverSnapshot = async () => {
    await collector.drain();
    if (collector.stopped) return;
    const visible = await tab.playwright.evaluate(() => {
      const main = document.querySelector('#app') ?? document.querySelector('.app') ?? document.body;
      const text = main.innerText;
      const links = Array.from(main.querySelectorAll('a[href]')).map(a => a.href)
        .filter(href => /^https:\/\/www\.bilibili\.com\/opus\/[0-9]+/.test(href));
      const markers = Array.from(main.querySelectorAll('*')).filter(e => e.children.length === 0
        && /^(没有更多了|没有更多动态了|暂无动态|TA还没有动态|暂无图文|暂无专栏|TA还没有投稿|没有更多内容了|你已经到达了世界的尽头|已经到底了)[！!。.]?$/.test(e.textContent.trim()))
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return {links: [...new Set(links)], end: markers[0]?.textContent.trim() ?? null,
        restriction: /验证码|访问过于频繁|访问受限|账号登录已失效/.test(text),
        height: document.documentElement.scrollHeight,
        top: document.documentElement.scrollTop, tail: text.slice(-200)};
    });
    if (visible.restriction) { await collector.block('access restriction shown in page'); return; }
    for (const url of visible.links) {
      const id = url.match(/\/opus\/([0-9]+)/)[1];
      mergeCandidate(collector.index, {id, url: `https://www.bilibili.com/opus/${id}`,
        sources: [collector.entry], status: 'pending'});
    }
    if (visible.end) {
      collector.index.traversal[collector.entry] = {...collector.index.traversal[collector.entry], complete: true,
        observed_at: new Date().toISOString(), end_evidence: {type: 'visible_end_marker', text: visible.end}};
    }
    const signature = JSON.stringify([visible.links, visible.height, visible.top, visible.tail]);
    collector.idle = signature === collector.lastSignature ? collector.idle + 1 : 0;
    collector.lastSignature = signature;
    await collector.save();
  };
  collector.enterEntry = async entry => {
    collector.entry = entry; collector.idle = 0; collector.lastSignature = '';
    if (collector.index.traversal[entry]?.observation_gap) {
      // Revisit the entire entry to replace incomplete response observation.
      collector.index.traversal[entry] = {complete: false, pages: 0};
    }
    collector.requests.clear();
    if (cdp) collector.cursor = (await cdp.readEvents({methods: NETWORK_METHODS})).cursor;
    if (entry === 'dynamic') {
      const url = `https://space.bilibili.com/${collector.index.uid}/dynamic`;
      await collector.action(async () => await tab.url() === url ? tab.reload() : tab.goto(url));
    } else {
      await collector.action(() => tab.goto(`https://space.bilibili.com/${collector.index.uid}/upload`));
      await tab.playwright.getByText('图文', {exact: true}).filter({visible: true}).waitFor({state: 'visible', timeoutMs: 15000});
      await collector.action(() => tab.playwright.getByText('图文', {exact: true}).filter({visible: true}).click());
      await tab.playwright.getByText('全部图文', {exact: true}).filter({visible: true}).waitFor({state: 'visible', timeoutMs: 15000});
      if (entry === 'column') {
        await collector.action(() => tab.playwright.getByText('专栏', {exact: true}).filter({visible: true}).click());
      }
    }
    await tab.playwright.waitForTimeout(1000);
    await collector.discoverSnapshot();
  };

  collector.discoverStep = async () => {
    const pending = collector.index.required_entries.find(entry => !collector.index.traversal[entry]?.complete);
    if (!pending) { collector.index.phase = 'capturing'; await collector.save(); return {status: 'history_discovered'}; }
    if (collector.entry !== pending) {
      await collector.enterEntry(pending); return {status: 'entered', entry: pending};
    }
    await collector.discoverSnapshot();
    if (collector.index.traversal[pending]?.complete) return {status: 'entry_complete', entry: pending};
    if (collector.idle >= 8) {
      collector.index.phase = 'interrupted';
      collector.index.traversal[pending] = {...collector.index.traversal[pending], complete: false,
        error: 'loading stalled without explicit end evidence'};
      collector.stopped = true; await collector.save();
      return {status: 'interrupted', entry: pending};
    }
    const point = await tab.playwright.evaluate(() => [Math.floor(innerWidth / 2), Math.floor(innerHeight * 0.75)]);
    await collector.action(() => tab.scroll(point, 'down', 10));
    await collector.discoverSnapshot();
    return {status: 'discovering', entry: pending, candidates: Object.keys(collector.index.candidates).length};
  };

  collector.metadata = async () => tab.playwright.evaluate(() => {
    const root = document.querySelector('.bili-opus-view');
    const own = e => Boolean(e.closest('.opus-module-content,[class*="opus-module-top"]'));
    const richAll = Array.from(root?.querySelectorAll('.opus-pic-view') ?? []), rich = richAll.filter(own);
    const plainAll = Array.from(root?.querySelectorAll('picture.b-img__inner') ?? []), plain = plainAll.filter(own);
    const horizontal = Array.from(root?.querySelectorAll('.horizontal-scroll-album__pic__img') ?? []).filter(own);
    const grid = Array.from(root?.querySelectorAll('.bili-album__preview__picture__img') ?? []).filter(own);
    const groups = rich.length ? rich.map(e => ({type: 'rich', index: richAll.indexOf(e), pictures: e.querySelectorAll('img').length}))
      : horizontal.length ? [{type: 'horizontal', index: 0}] : grid.length ? [{type: 'grid', index: 0}]
      : plain.map(e => ({type: 'plain', index: plainAll.indexOf(e)}));
    const authorNode = root?.querySelector('.opus-module-author__name');
    const authorLink = authorNode?.closest('a')?.href ?? root?.querySelector('[class*="opus-module-author"] a[href*="space.bilibili.com"]')?.href;
    return {author: authorNode?.textContent.trim(), author_uid: authorLink?.match(/space\.bilibili\.com\/([0-9]+)/)?.[1],
      published: root?.querySelector('.opus-module-author__pub__text')?.textContent.trim(),
      text: root?.querySelector('.opus-module-content')?.innerText ?? '',
      title: root?.querySelector('.opus-module-title__text')?.textContent ?? '',
      column_id: root?.querySelector('.opus-module-copyright__right')?.textContent.match(/cv([0-9]+)/i)?.[1] ?? null,
      groups, bodyImages: Array.from(root?.querySelectorAll('img') ?? []).filter(own).length,
      repost: Boolean(root?.querySelector('.opus-module-forward,.bili-dyn-forward')),
      restriction: /验证码|访问过于频繁|访问受限|账号登录已失效/.test(document.body.innerText)};
  });
  collector.viewer = async expected => {
    let signature = null;
    for (let tries = 0; tries < 40; tries++) {
      const image = selectViewer(await tab.playwright.evaluate(viewerDomSnapshot), expected);
      if (image) {
        const current = JSON.stringify([image.page, image.total, image.url, image.width, image.height, image.slide]);
        if (current === signature) return image;
        signature = current;
      } else signature = null;
      await tab.playwright.waitForTimeout(200);
    }
    throw Error('active viewer page did not finish loading');
  };
  collector.persist = async () => {
    const current = collector.current;
    current.post.image_count = current.candidate.expected_images_hint || current.post.images.length;
    if (!current.post.capture_complete) current.post.capture_cursor = {group: current.gi, phase: current.phase, page: current.page};
    else delete current.post.capture_cursor;
    await saveJSON(path.join(root, '.collection', 'posts', current.post.id + '.json'), current.post);
    Object.assign(current.candidate, {status: current.post.capture_complete ? 'captured' : 'capturing', collected_images: current.post.images.length});
    await collector.save();
  };
  collector.startPost = async candidate => {
    collector.activeCandidate = candidate;
    await collector.action(async () => await tab.url() === candidate.url ? tab.reload() : tab.goto(candidate.url));
    await tab.playwright.locator('.opus-module-author__name').waitFor({state: 'visible', timeoutMs: 15000});
    const metadata = await collector.metadata();
    if (metadata.restriction) { await collector.block('access restriction in post'); throw Error('access restriction'); }
    let authorUid = metadata.author_uid;
    let authorSource = authorUid ? 'visible_author_link' : null;
    if (!authorUid && candidate.author_uid && (candidate.sources.includes('dynamic') || candidate.author_uid_source)) {
      authorUid = candidate.author_uid; authorSource = candidate.author_uid_source ?? 'browser_observed_feed';
    }
    if (!authorUid && tabs) {
      const before = new Set((await tabs.list()).map(t => t.id));
      await collector.action(() => tab.playwright.locator('.opus-module-author__name').click());
      for (let attempt = 0; attempt < 25; attempt++) {
        const sameTab = (await tab.url()).match(/^https:\/\/space\.bilibili\.com\/([0-9]+)(?:[/?]|$)/);
        const newTab = (await tabs.list()).find(t => !before.has(t.id) && /^https:\/\/space\.bilibili\.com\/[0-9]+/.test(t.url ?? ''));
        if (sameTab) {
          authorUid = sameTab[1];
          await collector.action(() => tab.goto(candidate.url));
          await tab.playwright.locator('.opus-module-author__name').waitFor({state: 'visible', timeoutMs: 15000});
          break;
        }
        if (newTab) {
          authorUid = newTab.url.match(/space\.bilibili\.com\/([0-9]+)/)[1];
          const profile = await tabs.get(newTab.id);
          await collector.action(() => profile.close()); break;
        }
        await tab.playwright.waitForTimeout(200);
      }
      authorSource = 'author_profile_navigation';
    }
    if (authorUid && authorUid !== collector.index.uid) {
      candidate.status = 'excluded'; candidate.exclusion_reason = 'other_author';
      await collector.save(); return;
    }
    if (!authorUid) throw Error('actual post author UID unavailable');
    candidate.author_uid = authorUid; candidate.author_uid_source = authorSource;
    if (metadata.repost || !collector.index.include_columns && metadata.column_id) {
      candidate.status = 'excluded'; candidate.exclusion_reason = metadata.repost ? 'repost' : 'column_disabled';
      await collector.save(); return;
    }
    const date = metadata.published?.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
    if (!date) throw Error('full publication date unavailable');
    const published = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}T${date[4].padStart(2, '0')}:${date[5]}:00+08:00`;
    if (!metadata.groups.length) {
      if (candidate.expected_images_hint) throw Error('expected body images unavailable');
      if (metadata.bodyImages) throw Error('unrecognized body image layout');
      candidate.status = 'excluded'; candidate.exclusion_reason = 'no_body_images'; await collector.save(); return;
    }
    let previous = null, resumeGroup = 0, prefix = [];
    try { previous = JSON.parse(await fs.readFile(path.join(root, '.collection', 'posts', candidate.id + '.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && !previous.capture_complete && previous.uid === collector.index.uid && previous.published === published
        && previous.text === metadata.text && JSON.stringify(previous.capture_groups) === JSON.stringify(metadata.groups)) {
      resumeGroup = Math.min((previous.capture_cursor?.group ?? 0)
        + (previous.capture_cursor?.phase === 'group_done' ? 1 : 0), metadata.groups.length - 1);
      prefix = previous.images.filter(image => image.viewer?.gallery <= resumeGroup);
      for (let gallery = 1; gallery <= resumeGroup; gallery++) {
        const images = prefix.filter(image => image.viewer.gallery === gallery);
        if (!images.length || images.length !== images[0].viewer.total
            || images.some((image, i) => image.viewer.page !== i + 1 || !image.viewer.loaded)) {
          resumeGroup = 0; prefix = []; break;
        }
      }
    }
    collector.current = {candidate, groups: metadata.groups, gi: resumeGroup, base: prefix.length, page: 0, total: 0, phase: 'open',
      post: {id: candidate.id, url: candidate.url, uid: collector.index.uid, author: metadata.author,
        author_uid_verified: true, author_uid_source: authorSource, published, published_precision: 'minute', platform_publication_timestamp: candidate.author_pub_ts,
        text: metadata.text, title: metadata.title, column_id: metadata.column_id, source_entries: candidate.sources,
        images: prefix, image_count: prefix.length, capture_groups: metadata.groups, capture_complete: false}};
    await collector.persist();
  };
  collector.record = async image => {
    const current = collector.current;
    if (current.gi === 0 && current.groups[0].type === 'rich' && current.groups.every(g => g.pictures === 1)
        && image.total === current.groups.length && image.total > 1) current.groups = current.groups.slice(0, 1);
    current.page = image.page; current.total = image.total;
    const ordinal = current.base + image.page;
    current.post.images[ordinal - 1] = {ordinal, url: image.url, width: image.width, height: image.height,
      viewer: {source: 'gray_overlay', page: image.page, total: image.total, gallery: current.gi + 1,
        current_src: image.url, loaded: true, observed_at: new Date().toISOString()}};
    current.phase = image.page < image.total ? 'next' : 'group_done';
    await collector.persist();
  };
  collector.clickImage = async locator => {
    // Ground the visible hit point; the DOM center can lie outside a tall image's viewport.
    for (let tries = 0; tries < 6; tries++) {
      const point = await locator.evaluate(image => {
        const r = image.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
        const left = Math.max(0, r.left), top = Math.max(90, r.top);
        const right = Math.min(vw - 20, r.right), bottom = Math.min(vh - 30, r.bottom);
        const x = (left + right) / 2, y = (top + bottom) / 2, hit = document.elementFromPoint(x, y);
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const centerHit = document.elementFromPoint(cx, cy);
        return {visible: right > left && bottom > top && (hit === image || image.parentElement?.contains(hit)),
          centerVisible: cx > 0 && cx < vw - 20 && cy > 90 && cy < vh - 30
            && (centerHit === image || image.parentElement?.contains(centerHit)),
          x, y, centerY: cy, centerX: cx, top: r.top, vw, vh};
      });
      if (point.centerVisible) {
        await collector.action(() => locator.click({timeoutMs: 2500})); return;
      }
      if (point.visible && (point.centerX < 0 || point.centerX >= point.vw - 20)) {
        await tab.getScreenshot({emit: false});
        await collector.action(() => tab.click([Math.round(point.x), Math.round(point.y)])); return;
      }
      const pages = Math.min(10, Math.max(0.25, Math.abs(point.centerY - point.vh / 2) / point.vh));
      await collector.action(() => tab.scroll([Math.min(point.vw - 25, Math.max(25, Math.round(point.x))), Math.floor(point.vh * 0.65)], point.centerY < 90 ? 'up' : 'down', pages));
    }
    throw Error('body image has no unobstructed visible point');
  };
  collector.openGroup = async () => {
    const group = collector.current.groups[collector.current.gi];
    const locator = group.type === 'horizontal' ? tab.playwright.locator('.bili-opus-view .horizontal-scroll-album__pic__img img').first()
      : group.type === 'grid' ? tab.playwright.locator('.bili-opus-view .bili-album__preview__picture__img').first()
      : group.type === 'plain' ? tab.playwright.locator('.bili-opus-view picture.b-img__inner').nth(group.index).locator('img')
      : tab.playwright.locator('.bili-opus-view .opus-pic-view').nth(group.index).locator('img').first();
    await collector.clickImage(locator);
    for (let tries = 0; tries < 25; tries++) {
      if (await tab.playwright.locator('.pswp--open').count()) {
        let image = await collector.viewer();
        while (image.page > 1) {
          await collector.action(() => tab.playwright.getByRole('button', {name: 'Previous', exact: true}).click());
          image = await collector.viewer(image.page - 1);
        }
        await collector.record(image); return;
      }
      if (await tab.playwright.getByText('查看大图', {exact: true}).filter({visible: true}).count()) {
        collector.current.phase = 'open_large'; await collector.persist(); return;
      }
      await tab.playwright.waitForTimeout(200);
    }
    throw Error('image click opened neither inline preview nor gray viewer');
  };
  collector.captureStep = async () => {
    if (!collector.current) {
      const candidate = Object.values(collector.index.candidates).find(c => ['pending', 'capturing'].includes(c.status));
      if (!candidate) {
        collector.index.phase = 'captured'; await collector.save(); return {status: 'all_captured'};
      }
      await collector.startPost(candidate);
      if (!collector.current) collector.activeCandidate = null;
      return {status: candidate.status, id: candidate.id};
    }
    const current = collector.current;
    if (current.phase === 'open') await collector.openGroup();
    else if (current.phase === 'open_large') {
      await collector.action(() => tab.playwright.getByText('查看大图', {exact: true}).filter({visible: true}).click());
      await collector.record(await collector.viewer(1));
    } else if (current.phase === 'next') {
      await collector.action(() => tab.playwright.getByRole('button', {name: 'Next', exact: true}).click());
      await collector.record(await collector.viewer(current.page + 1));
    } else if (current.gi + 1 < current.groups.length) {
      // Reopen the body between independent galleries; header hover panels can cover it after Close.
      await collector.action(() => tab.reload());
      await tab.playwright.locator('.opus-module-author__name').waitFor({state: 'visible', timeoutMs: 15000});
      current.base += current.total; current.gi++; current.page = 0; current.phase = 'open'; await collector.persist();
    } else {
      const expected = current.candidate.expected_images_hint;
      if (expected && current.post.images.length !== expected) throw Error('post image count mismatch');
      current.post.capture_complete = true; delete current.candidate.error;
      await collector.persist(); collector.current = null; collector.activeCandidate = null;
      return {status: 'captured', id: current.post.id, images: current.post.images.length};
    }
    return {status: collector.current?.phase, id: current.post.id, images: current.post.images.length};
  };
  collector.run = async (milliseconds = 38000, mode = 'auto') => {
    if (milliseconds > 50000) throw Error('use batches of at most 50 seconds');
    const start = Date.now(), log = [];
    while (Date.now() - start < milliseconds && !collector.stopped) {
      try {
        const discover = mode === 'discover' || mode === 'auto' && collector.index.required_entries.some(e => !collector.index.traversal[e]?.complete);
        const result = discover ? await collector.discoverStep() : await collector.captureStep();
        log.push(result);
        if (['all_captured', 'history_discovered', 'interrupted'].includes(result.status)) break;
      } catch (error) {
        if (RESTRICTION.test(String(error)) || /feed returned code -?(101|352|412)/.test(String(error))) {
          await collector.block(error);
        } else if (collector.current || collector.activeCandidate) {
          const candidate = collector.current?.candidate ?? collector.activeCandidate;
          candidate.capture_attempts = (candidate.capture_attempts ?? 0) + 1;
          candidate.error = String(error);
          candidate.status = candidate.capture_attempts >= 4 || /mismatch|unrecognized|unavailable/.test(String(error)) ? 'failed' : 'pending';
          collector.current = null; collector.activeCandidate = null; await collector.save();
        } else {
          collector.stopped = true; collector.index.phase = 'interrupted'; collector.index.error = String(error); await collector.save();
        }
        log.push({status: collector.stopped ? 'stopped' : 'failed', error: String(error)});
      }
    }
    return {log, phase: collector.index.phase, stopped: collector.stopped,
      candidates: Object.keys(collector.index.candidates).length,
      captured: Object.values(collector.index.candidates).filter(c => c.status === 'captured').length};
  };
  collector.retryFailed = async () => {
    if (collector.stopped || ['blocked', 'interrupted'].includes(collector.index.phase))
      throw Error('resolve access/interruption and create a new collector before retry');
    for (const candidate of Object.values(collector.index.candidates)) {
      if (candidate.status === 'failed') { candidate.status = 'pending'; candidate.capture_attempts = 0; }
    }
    collector.index.phase = 'capturing'; await collector.save();
  };
  collector.recapturePost = async id => {
    const candidate = collector.index.candidates[identifier(id)];
    if (!candidate || candidate.status === 'excluded') throw Error('post is missing or excluded from this scope');
    if (collector.current || collector.stopped) throw Error('finish or resolve the current capture first');
    candidate.status = 'pending'; candidate.capture_attempts = 0;
    collector.index.phase = 'capturing'; await collector.save();
  };
  await collector.enableObservation();
  return collector;
}
