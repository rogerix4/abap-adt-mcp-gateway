/**
 * Atom feeds, parsed.
 *
 * Measured live on DS4/100: `RuntimeListFeeds {max_results: 3}` answered 24 KB of
 * `raw_xml` and `RuntimeGetGatewayErrorLog {max_results: 3}` 56 KB — the argument was declared
 * and read by nothing, and the caller got the feed document instead of its entries. Same class
 * of defect as `RuntimeListProfilerTraceFiles` (564 KB), which is why one parser now serves all
 * of them.
 */

import { attributeOf, childTextOf, findElements, nodeTextOf, parseXml, type XmlObject } from "../adt/xml.js";
export interface AtomEntry {
  readonly title: string;
  readonly id: string;
  readonly updated?: string;
  readonly published?: string;
  readonly author?: string;
  readonly summary?: string;
  /** The resource the entry points at (`atom:content/@src`), when the feed inlines nothing. */
  readonly content_src?: string;
}

export interface AtomFeedView {
  readonly title: string;
  readonly updated?: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly entries: readonly AtomEntry[];
}

export interface AtomFeedQuery {
  /** How many entries to keep; the feed itself may hold more. */
  readonly limit?: number | undefined;
  readonly user?: string | undefined;
  /** ISO date/timestamp; entries older than this are dropped. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** `undefined` when the body is not an Atom feed. */
export function parseAtomFeed(body: string, query: AtomFeedQuery = {}): AtomFeedView | undefined {
  const parsed = parseXml(body);
  if (parsed === undefined || !/<(\w+:)?feed[\s>]/i.test(body)) return undefined;
  const feed = findElements(parsed, "feed")[0] ?? parsed;

  let entries: AtomEntry[] = findElements(feed, "entry").map((entry) => {
    const content = findElements(entry, "content")[0];
    const summary = childTextOf(entry, "summary");
    return {
      title: (childTextOf(entry, "title") ?? "").trim(),
      id: (childTextOf(entry, "id") ?? "").trim(),
      ...(childTextOf(entry, "updated") === undefined ? {} : { updated: childTextOf(entry, "updated") ?? "" }),
      ...(childTextOf(entry, "published") === undefined ? {} : { published: childTextOf(entry, "published") ?? "" }),
      ...(authorOf(entry) === undefined ? {} : { author: authorOf(entry) ?? "" }),
      ...(summary === undefined || summary.trim().length === 0 ? {} : { summary: summary.trim() }),
      // Structural: the `src` is the only thing that says where the entry's payload lives.
      ...(content === undefined ? {} : { content_src: attributeOf(content, "src") ?? "" }),
    };
  });

  const user = query.user?.trim().toUpperCase();
  if (user !== undefined && user.length > 0) {
    entries = entries.filter((entry) => (entry.author ?? "").toUpperCase().includes(user));
  }
  const from = query.from?.trim();
  if (from !== undefined && from.length > 0) {
    entries = entries.filter((entry) => (entry.published ?? entry.updated ?? "") >= from);
  }
  const to = query.to?.trim();
  if (to !== undefined && to.length > 0) {
    entries = entries.filter((entry) => (entry.published ?? entry.updated ?? "") <= to);
  }

  // Newest first: a monitoring feed is read for what happened recently.
  entries.sort((left, right) => {
    const a = left.published ?? left.updated ?? "";
    const b = right.published ?? right.updated ?? "";
    return a < b ? 1 : a > b ? -1 : 0;
  });

  const limit = query.limit !== undefined && query.limit > 0 ? Math.trunc(query.limit) : entries.length;
  return {
    title: (childTextOf(feed, "title") ?? "").trim(),
    ...(childTextOf(feed, "updated") === undefined ? {} : { updated: childTextOf(feed, "updated") ?? "" }),
    count: entries.length,
    truncated: entries.length > limit,
    entries: entries.slice(0, limit),
  };
}

/** `atom:author/atom:name`, without depending on how deep the parser keeps the wrapper. */
function authorOf(entry: XmlObject): string | undefined {
  const author = findElements(entry, "author")[0];
  if (author === undefined) return undefined;
  const name = childTextOf(author, "name") ?? nodeTextOf(author);
  return name.trim().length === 0 ? undefined : name.trim();
}
