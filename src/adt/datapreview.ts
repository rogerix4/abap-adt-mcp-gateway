/**
 * ADT data preview (SQL console) parsing.
 *
 * Measured on the reference system: the answer is **column-major** — one
 * `<dataPreview:columns>` block per select-list item, each carrying that column's
 * values in row order — and `<dataPreview:totalRows>` is unreliable (it reports 0
 * while rows are present). So the row set, not the counter, decides.
 *
 * The document is read with the shared XML parser, not with a regex: a cell value may
 * contain `<` and `>` (escaped), a metadata element may carry other attributes before
 * `name`, and a leaked `&lt;` in a result table is a wrong answer nobody notices.
 */

import { attributeOf, findElements, nodeTextOf, parseXml, type XmlObject } from "./xml.js";

export interface PreviewResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** What SAP says it actually executed, including the implicit `INTO`/`UP TO`. */
  readonly executedQuery?: string;
}

/** The first child of that name, as a node (a plain value is wrapped). */
function childNode(node: XmlObject, name: string): XmlObject | undefined {
  const value = node[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return undefined;
  if (typeof first === "string") return { "#text": first };
  if (typeof first !== "object") return { "#text": String(first) };
  return first as XmlObject;
}

/** The `<dataSet>` cells in order; a single cell is not an array in the parsed tree. */
function cellValues(dataSet: XmlObject): string[] {
  const data = dataSet["data"];
  if (data === undefined || data === null) return [];
  const cells = Array.isArray(data) ? data : [data];
  return cells.map((cell) => {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "string") return cell.trim();
    if (typeof cell === "object") return nodeTextOf(cell as XmlObject);
    return String(cell).trim();
  });
}

export interface PreviewColumn {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly length: number;
  readonly key: boolean;
  readonly values: readonly string[];
}

/**
 * The same document with each column's metadata.
 *
 * `GetTableContents` promises `include_metadata` (column types and descriptions), and
 * `SE16`-style callers need the key flags; the plain `parseDataPreview` drops all of it.
 */
export function parseDataPreviewDetailed(xml: string): {
  readonly columns: readonly PreviewColumn[];
  readonly rows: readonly Readonly<Record<string, string>>[];
} {
  const parsed = parseXml(xml);
  if (parsed === undefined) return { columns: [], rows: [] };

  const columns = findElements(parsed, "columns").map((block) => {
    const metadata = childNode(block, "metadata");
    const dataSet = childNode(block, "dataSet");
    const length = Number(metadata === undefined ? "" : (attributeOf(metadata, "length") ?? ""));
    // SAP spells its booleans both ways (`true` in the preview XML, `X` in AS-XML answers), and
    // a release that sends neither leaves the flag at `false` — never at "assumed key".
    const keyFlag = metadata === undefined ? "" : (attributeOf(metadata, "keyAttribute") ?? attributeOf(metadata, "isKey") ?? "");
    return {
      name: metadata === undefined ? "" : (attributeOf(metadata, "name") ?? ""),
      type: metadata === undefined ? "" : (attributeOf(metadata, "colType") ?? attributeOf(metadata, "type") ?? ""),
      description: metadata === undefined ? "" : (attributeOf(metadata, "description") ?? ""),
      length: Number.isFinite(length) ? length : 0,
      key: /^(true|x|1)$/i.test(keyFlag.trim()),
      values: dataSet === undefined ? [] : cellValues(dataSet),
    };
  });

  const rowCount = columns.reduce((max, column) => Math.max(max, column.values.length), 0);
  const rows = Array.from({ length: rowCount }, (_, index) =>
    Object.fromEntries(columns.map((column) => [column.name, column.values[index] ?? ""])),
  );
  return { columns, rows };
}

export function parseDataPreview(xml: string): PreviewResult {
  const parsed = parseXml(xml);
  if (parsed === undefined) return { columns: [], rows: [] };

  const columns = findElements(parsed, "columns").map((block) => {
    const metadata = childNode(block, "metadata");
    const name = metadata === undefined ? "" : (attributeOf(metadata, "name") ?? "");
    const dataSet = childNode(block, "dataSet");
    const values = dataSet === undefined ? [] : cellValues(dataSet);
    return { name, values };
  });

  const rowCount = columns.reduce((max, column) => Math.max(max, column.values.length), 0);
  const rows = Array.from({ length: rowCount }, (_, index) =>
    Object.fromEntries(columns.map((column) => [column.name, column.values[index] ?? ""])),
  );

  const executed = findElements(parsed, "executedQueryString")[0];
  const executedQuery = executed === undefined ? undefined : nodeTextOf(executed);

  return {
    columns: columns.map((column) => column.name),
    rows,
    ...(executedQuery === undefined || executedQuery.length === 0 ? {} : { executedQuery }),
  };
}
