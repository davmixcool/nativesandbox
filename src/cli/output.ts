/**
 * Terminal output.
 *
 * Colour only when stdout is a TTY and NO_COLOR is unset, so piping into a file or a CI log
 * produces text rather than escape codes.
 */
const plain = !process.stdout.isTTY || process.env.NO_COLOR !== undefined;

const wrap = (code: string) => (text: string) => (plain ? text : `\u001b[${code}m${text}\u001b[0m`);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/** A check's outcome. `warn` is "works, but you will regret it later". */
export type Status = "ok" | "warn" | "fail" | "skip";

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", skip: "–" };
const PAINT: Record<Status, (s: string) => string> = { ok: green, warn: yellow, fail: red, skip: dim };

export const info = (label: string, value: string): void =>
  console.log(`${dim("info")} ${label.padEnd(12)} ${value}`);

/** One check. `detail` is the evidence — what was actually found, not a restatement of the label. */
export function check(status: Status, label: string, detail = ""): void {
  console.log(`   ${PAINT[status](MARK[status])} ${label.padEnd(24)} ${detail}`);
}

export const note = (text: string): void => console.log(`     ${dim(text)}`);

export const done = (text: string): void => console.log(`${green("done")} ${text}`);
export const warn = (text: string): void => console.log(`${yellow("warn")} ${text}`);
export const fatal = (text: string): void => console.error(`${red("error")} ${text}`);

/** A left-aligned table. Written here rather than pulled in, because the package has no deps. */
export function table(rows: string[][], headers: string[]): void {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[], paint = (s: string) => s) =>
    console.log("  " + cells.map((c, i) => paint((c ?? "").padEnd(widths[i]!))).join("  ").trimEnd());

  line(headers, dim);
  for (const row of rows) line(row);
}
