/**
 * ADT data preview (SQL console) parsing.
 *
 * Measured on the reference system: the answer is **column-major** — one
 * `<dataPreview:columns>` block per select-list item, each carrying that column's
 * values in row order — and `<dataPreview:totalRows>` is unreliable (it reports 0
 * while rows are present). So the row set, not the counter, decides.
 */

export interface PreviewResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** What SAP says it actually executed, including the implicit `INTO`/`UP TO`. */
  readonly executedQuery?: string;
}

const COLUMN = /<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g;
const VALUE = /<dataPreview:data>([\s\S]*?)<\/dataPreview:data>/g;

export function parseDataPreview(xml: string): PreviewResult {
  const columns = [...xml.matchAll(COLUMN)].map((match) => {
    const block = match[1] ?? "";
    const name = /dataPreview:metadata dataPreview:name="([^"]+)"/.exec(block)?.[1] ?? "";
    const dataSet = /<dataPreview:dataSet>([\s\S]*?)<\/dataPreview:dataSet>/.exec(block)?.[1] ?? "";
    const values = [...dataSet.matchAll(VALUE)].map((cell) => (cell[1] ?? "").trim());
    return { name, values };
  });

  const rowCount = columns.reduce((max, column) => Math.max(max, column.values.length), 0);
  const rows = Array.from({ length: rowCount }, (_, index) =>
    Object.fromEntries(columns.map((column) => [column.name, column.values[index] ?? ""])),
  );

  const executedQuery = /<dataPreview:executedQueryString>([\s\S]*?)<\/dataPreview:executedQueryString>/.exec(xml)?.[1];

  return {
    columns: columns.map((column) => column.name),
    rows,
    ...(executedQuery === undefined ? {} : { executedQuery }),
  };
}
