export interface ParsedTable {
  html: string;
  rows: string[][];
  row_count: number;
  column_count: number;
}

interface HtmlCell {
  content: string;
  rowSpan: number;
  colSpan: number;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function stripTags(html: string): string {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function sanitizeTableHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, "");
}

function toSpan(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 1;
}

/** Convert one HTML table to a padded row/column matrix, expanding spans. */
export function htmlTableToGrid(html: string): ParsedTable | null {
  const source = String(html ?? "").trim();
  if (!source) return null;

  const rowCells: HtmlCell[][] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRe.exec(source))) {
    const cells: HtmlCell[] = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(trMatch[1] ?? ""))) {
      const attrs = parseAttrs(cellMatch[2] ?? "");
      cells.push({
        content: stripTags(cellMatch[3] ?? ""),
        rowSpan: toSpan(attrs.rowspan),
        colSpan: toSpan(attrs.colspan),
      });
    }
    if (cells.length > 0) rowCells.push(cells);
  }

  if (rowCells.length === 0) return null;

  const grid: string[][] = [];
  rowCells.forEach((cells, rowIndex) => {
    grid[rowIndex] ??= [];
    let columnIndex = 0;
    for (const cell of cells) {
      while (grid[rowIndex]![columnIndex] !== undefined) columnIndex += 1;
      for (let rowSpan = 0; rowSpan < cell.rowSpan; rowSpan += 1) {
        const targetRow = rowIndex + rowSpan;
        grid[targetRow] ??= [];
        for (let colSpan = 0; colSpan < cell.colSpan; colSpan += 1) {
          const targetColumn = columnIndex + colSpan;
          // Merged cells are expanded; only the top-left cell carries content.
          grid[targetRow]![targetColumn] = rowSpan === 0 && colSpan === 0 ? cell.content : "";
        }
      }
      columnIndex += cell.colSpan;
    }
  });

  const columnCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return null;
  const rows = grid.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));

  return { html: sanitizeTableHtml(source), rows, row_count: rows.length, column_count: columnCount };
}

export function extractHtmlTables(text: string): ParsedTable[] {
  const source = String(text ?? "");
  const tables: ParsedTable[] = [];
  const tableRe = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(source))) {
    const parsed = htmlTableToGrid(match[0]);
    if (parsed) tables.push(parsed);
  }
  return tables;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fallback for results that only provide Markdown pipe tables. */
export function extractMarkdownPipeTables(markdown: string): ParsedTable[] {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const tables: ParsedTable[] = [];
  let index = 0;

  const parseRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  while (index < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[index] ?? "")) {
      index += 1;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? "")) {
      block.push(lines[index] ?? "");
      index += 1;
    }
    if (block.length < 2) continue;

    const separator = block[1] ?? "";
    const hasSeparator = /^\s*\|?[\s:-]+\|[\s|:-]*\|?\s*$/.test(separator);
    const dataLines = hasSeparator ? [block[0]!, ...block.slice(2)] : block;
    if (dataLines.length === 0) continue;

    const matrix = dataLines.map(parseRow);
    const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    if (columnCount === 0) continue;
    const rows = matrix.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? ""));
    const [header, ...body] = rows;
    const html = [
      "<table>",
      "<thead><tr>",
      ...(header ?? []).map((cell) => `<th>${escapeHtml(cell)}</th>`),
      "</tr></thead>",
      "<tbody>",
      ...body.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`),
      "</tbody>",
      "</table>",
    ].join("");
    tables.push({ html, rows, row_count: rows.length, column_count: columnCount });
  }

  return tables;
}
