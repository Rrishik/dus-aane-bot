import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let escapeMarkdown;

beforeAll(() => {
  ({ escapeMarkdown } = loadAppsScript(["TelegramUtils.js"], ["escapeMarkdown"], {
    // sendRequest is referenced inside other functions but never at top level,
    // so no stubs needed for module load.
  }));
});

describe("escapeMarkdown", () => {
  it("returns non-strings unchanged", () => {
    expect(escapeMarkdown(42)).toBe(42);
    expect(escapeMarkdown(null)).toBe(null);
    expect(escapeMarkdown(undefined)).toBe(undefined);
  });

  it("leaves plain text alone", () => {
    expect(escapeMarkdown("hello world")).toBe("hello world");
  });

  it("escapes underscores and asterisks (italic/bold markers)", () => {
    expect(escapeMarkdown("foo_bar*baz")).toBe("foo\\_bar\\*baz");
  });

  it("escapes [ and backtick (link start, inline code)", () => {
    expect(escapeMarkdown("a[b `c`")).toBe("a\\[b \\`c\\`");
  });

  it("does NOT escape ] ( ) ~ > # + = | { } ! . — these are literal in legacy Markdown", () => {
    // Telegram legacy Markdown (parse_mode: "Markdown") treats only _ * [ ` as
    // special. Escaping the MarkdownV2 set leaks visible backslashes into the
    // rendered output (e.g. "\(May 01 to May 05\)" in /ask answers).
    expect(escapeMarkdown("a]b(c)d~e>f#g+h=i|j{k}l!m.n")).toBe("a]b(c)d~e>f#g+h=i|j{k}l!m.n");
  });

  it("does NOT escape periods or dashes", () => {
    expect(escapeMarkdown("3.14 - hi")).toBe("3.14 - hi");
  });
});
