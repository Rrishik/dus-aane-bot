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

  it("escapes underscores and asterisks", () => {
    expect(escapeMarkdown("foo_bar*baz")).toBe("foo\\_bar\\*baz");
  });

  it("escapes brackets, parens, and other Markdown specials", () => {
    expect(escapeMarkdown("a[b](c)")).toBe("a\\[b\\]\\(c\\)");
    expect(escapeMarkdown("~tilde~ `code` >quote")).toBe("\\~tilde\\~ \\`code\\` \\>quote");
  });

  it("escapes #+=|{}!", () => {
    expect(escapeMarkdown("#+=|{}!")).toBe("\\#\\+\\=\\|\\{\\}\\!");
  });

  it("does NOT escape periods or dashes (legacy Markdown, not MarkdownV2)", () => {
    expect(escapeMarkdown("3.14 - hi")).toBe("3.14 - hi");
  });
});
