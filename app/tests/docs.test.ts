import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_SECTIONS,
  getAllArticles,
  getArticle,
  getAdjacent,
  firstArticleSlug,
} from '@/services/docs';

test('docs registry: sections are non-empty and every article has required fields', () => {
  assert.ok(DOC_SECTIONS.length > 0);
  for (const s of DOC_SECTIONS) {
    assert.ok(s.id && s.title, 'section has id + title');
    assert.ok(s.articles.length > 0, `section ${s.id} has at least one article`);
    for (const a of s.articles) {
      assert.ok(a.slug, 'article has a slug');
      assert.ok(a.title, `article ${a.slug} has a title`);
      assert.ok(a.summary, `article ${a.slug} has a summary`);
      assert.ok(a.body.trim().length > 0, `article ${a.slug} has a body`);
      // The body should lead with an H1 so the rendered page has a heading.
      assert.match(a.body.trimStart(), /^# /, `article ${a.slug} body starts with an H1`);
    }
  }
});

test('docs registry: slugs are globally unique', () => {
  const slugs = getAllArticles().map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
});

test('getArticle resolves known slugs and returns null for unknown', () => {
  const all = getAllArticles();
  assert.ok(all.length > 0);
  for (const a of all) {
    assert.equal(getArticle(a.slug)?.slug, a.slug);
  }
  assert.equal(getArticle('does-not-exist'), null);
});

test('firstArticleSlug is the first article in section order', () => {
  assert.equal(firstArticleSlug(), DOC_SECTIONS[0].articles[0].slug);
});

test('getAdjacent gives correct prev/next and nulls at the ends', () => {
  const all = getAllArticles();
  const first = all[0];
  const last = all[all.length - 1];

  assert.equal(getAdjacent(first.slug).prev, null);
  assert.equal(getAdjacent(first.slug).next?.slug, all[1].slug);

  assert.equal(getAdjacent(last.slug).next, null);
  assert.equal(getAdjacent(last.slug).prev?.slug, all[all.length - 2].slug);

  // Unknown slug: both null.
  assert.deepEqual(getAdjacent('nope'), { prev: null, next: null });
});

test('internal /docs links in bodies point to real articles', () => {
  const known = new Set(getAllArticles().map((a) => a.slug));
  const re = /\]\(\/docs\/([a-z0-9-]+)\)/g;
  for (const a of getAllArticles()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(a.body)) !== null) {
      assert.ok(known.has(m[1]), `article ${a.slug} links to unknown doc /docs/${m[1]}`);
    }
  }
});
