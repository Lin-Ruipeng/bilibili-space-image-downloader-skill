// Pure state transitions shared by the browser adapter and synthetic tests.
export function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('unsafe numeric identifier');
  const id = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(id)) throw Error('missing decimal identifier');
  return id;
}

export function candidateFromItem(item, uid, source, includeColumns) {
  const id = identifier(item.id_str ?? item.opus_id ?? item.id);
  const author = item.modules?.module_author;
  let authorUid = author?.mid ?? item.author?.mid ?? item.mid;
  if (authorUid != null) authorUid = identifier(authorUid);
  const major = item.modules?.module_dynamic?.major;
  const type = item.type ?? item.dynamic_type ?? (source === 'column' ? 'DYNAMIC_TYPE_ARTICLE' : null);
  const pictures = major?.opus?.pics ?? major?.draw?.items ?? item.pics;
  const columnId = item.article_id ?? item.cvid ?? major?.article?.id ?? major?.opus?.article_id;
  let exclusion = null;
  if (item.orig || type === 'DYNAMIC_TYPE_FORWARD') exclusion = 'repost';
  else if (item.visible === false) exclusion = 'not_visible';
  else if (authorUid && authorUid !== uid) exclusion = 'other_author';
  else if (['DYNAMIC_TYPE_AV', 'DYNAMIC_TYPE_PGC', 'DYNAMIC_TYPE_LIVE_RCMD'].includes(type)) exclusion = 'video';
  else if (type === 'DYNAMIC_TYPE_MUSIC') exclusion = 'audio';
  else if (!includeColumns && (source === 'column' || type === 'DYNAMIC_TYPE_ARTICLE' || columnId)) exclusion = 'column_disabled';
  return {
    id, url: `https://www.bilibili.com/opus/${id}`, sources: [source],
    author_uid: authorUid ?? null, dynamic_type: type,
    author_uid_source: authorUid ? 'browser_observed_feed' : null,
    expected_images_hint: type === 'DYNAMIC_TYPE_DRAW' && Array.isArray(pictures) ? pictures.length : 0,
    author_pub_ts: author?.pub_ts ? String(author.pub_ts) : null,
    column_id: columnId ? identifier(columnId) : null,
    status: exclusion ? 'excluded' : 'pending', ...(exclusion ? {exclusion_reason: exclusion} : {}),
  };
}

export function mergeCandidate(index, candidate) {
  const old = index.candidates[candidate.id];
  if (!old) { index.candidates[candidate.id] = candidate; return true; }
  old.sources = [...new Set([...old.sources, ...candidate.sources])];
  for (const field of ['author_uid', 'author_uid_source', 'dynamic_type', 'expected_images_hint', 'author_pub_ts', 'column_id']) {
    if (candidate[field]) old[field] = candidate[field];
  }
  // Classification from the actual feed supersedes an unclassified DOM link.
  if (candidate.exclusion_reason) {
    old.status = 'excluded'; old.exclusion_reason = candidate.exclusion_reason;
  }
  return false;
}

export function observedPage(url, payload, uid, entry) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.bilibili.com' || !/\/feed\/space$/.test(parsed.pathname)) return null;
  const requestUid = parsed.searchParams.get('host_mid') ?? parsed.searchParams.get('mid');
  if (requestUid !== uid) return null;
  const opus = /\/opus\//.test(parsed.pathname);
  if (entry === 'dynamic' && opus || entry !== 'dynamic' && !opus) return null;
  if (entry === 'column' && parsed.searchParams.get('type') !== 'article') return null;
  if (entry === 'opus' && parsed.searchParams.get('type') !== 'all') return null;
  if (payload.code !== 0) throw Error(`feed returned code ${payload.code}: ${payload.message ?? ''}`);
  const data = payload.data;
  if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean') return null;
  return {
    items: data.items, has_more: data.has_more,
    endpoint: parsed.origin + parsed.pathname, // No query fingerprints, cookies, or signed parameters.
    offset: parsed.searchParams.get('offset') ?? '',
  };
}

export function applyObservedPage(index, entry, page) {
  for (const item of page.items) mergeCandidate(index, candidateFromItem(item, index.uid, entry, index.include_columns));
  const traversal = index.traversal[entry] ?? {complete: false, pages: 0};
  traversal.pages = (traversal.pages ?? 0) + 1;
  traversal.last_offset = page.offset;
  traversal.observed_at = new Date().toISOString();
  traversal.total_seen = Object.values(index.candidates).filter(c => c.sources.includes(entry)).length;
  if (!page.has_more) {
    traversal.complete = !traversal.observation_gap;
    traversal.end_evidence = {type: 'browser_observed_response', has_more: false,
      endpoint: page.endpoint, last_page_item_count: page.items.length};
  }
  index.traversal[entry] = traversal;
}

export function selectViewer(snapshot, expectedPage) {
  const counter = snapshot.counter?.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!snapshot.open || !counter) return null;
  const page = Number(counter[1]), total = Number(counter[2]);
  if (page < 1 || page > total || expectedPage && page !== expectedPage) return null;
  // Require an aligned active slide, not just the largest loaded image.
  const active = snapshot.slides.filter(s => s.ariaHidden !== true && Math.abs(s.center - snapshot.viewportWidth / 2) <= 2
    && s.visibleWidth >= snapshot.viewportWidth * 0.9);
  if (active.length !== 1) return null;
  const images = active[0].images.filter(i => !i.placeholder && i.complete && i.width > 0
    && i.height > 0 && i.area > 0 && i.url);
  if (images.length !== 1) return null;
  return {page, total, ...images[0], slide: active[0].index};
}

export function viewerDomSnapshot() {
  const root = document.querySelector('.pswp--open');
  const frame = root?.querySelector('.pswp__scroll-wrap')?.getBoundingClientRect();
  const viewportWidth = frame?.width ?? innerWidth, frameLeft = frame?.left ?? 0;
  return {
    open: Boolean(root), counter: root?.querySelector('.pswp__counter')?.textContent ?? '',
    viewportWidth,
    slides: Array.from(root?.querySelectorAll('.pswp__item') ?? []).map((slide, index) => {
      const r = slide.getBoundingClientRect();
      return {index, ariaHidden: slide.getAttribute('aria-hidden') === 'true',
        center: (r.left + r.right) / 2 - frameLeft,
        visibleWidth: Math.max(0, Math.min(r.right, frameLeft + viewportWidth) - Math.max(frameLeft, r.left)),
        images: Array.from(slide.querySelectorAll('img.pswp__img')).map(image => {
          const rect = image.getBoundingClientRect();
          return {url: image.currentSrc, complete: image.complete, width: image.naturalWidth,
            height: image.naturalHeight, placeholder: image.classList.contains('pswp__img--placeholder'),
            area: Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
              * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0))};
        })};
    }),
  };
}
