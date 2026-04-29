import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let buildGmailFilterQuery, buildFilterEmailHtml, buildGmailFilterPrefillUrl;

beforeAll(() => {
  ({ buildGmailFilterQuery, buildFilterEmailHtml, buildGmailFilterPrefillUrl } = loadAppsScript(
    ["Onboarding.js"],
    ["buildGmailFilterQuery", "buildFilterEmailHtml", "buildGmailFilterPrefillUrl"],
    {
      TRANSACTION_SENDERS: ["alerts@hdfcbank.net", "alerts@axisbank.com"],
      FILTER_OTP_SUBJECTS: ["OTP", "MPIN", '"one-time password"']
    }
  ));
});

describe("buildGmailFilterQuery", () => {
  it("combines senders with from:() and excludes only OTP-subject keywords", () => {
    var q = buildGmailFilterQuery();
    expect(q).toBe(
      'from:(alerts@hdfcbank.net OR alerts@axisbank.com) -(subject:OTP OR subject:MPIN OR subject:"one-time password")'
    );
  });
});

describe("buildFilterEmailHtml", () => {
  it("includes the filter query inside a <pre> block", () => {
    var html = buildFilterEmailHtml("from:(a@b.com)", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html).toMatch(/<pre[^>]*>[\s\S]*from:\(a@b\.com\)[\s\S]*<\/pre>/);
  });

  it("includes the bot inbox address", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html).toContain("bot@gmail.com");
  });

  it("includes both the demo and guide links", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo.example", "https://guide.example", null);
    expect(html).toContain('href="https://demo.example"');
    expect(html).toContain('href="https://guide.example"');
  });

  it("escapes HTML-significant characters in the query", () => {
    var html = buildFilterEmailHtml('a<b>&"c', "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(html).not.toContain("a<b>&"); // raw injection blocked
  });

  it("returns a string with the expected outer structure", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html.startsWith("<div")).toBe(true);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html).toContain("Auto-forward bank emails");
  });

  it("includes the prefill URL as the primary CTA and target=_blank on links", () => {
    var html = buildFilterEmailHtml("from:(a@b.com)", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html).toContain('href="https://mail.google.com/mail/#search/from%3A(a%40b.com)"');
    // Every external link should open in a new tab so the email tab survives.
    var anchorCount = (html.match(/<a /g) || []).length;
    var blankCount = (html.match(/target="_blank"/g) || []).length;
    expect(blankCount).toBe(anchorCount);
  });

  it("includes a desktop-only notice", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html.toLowerCase()).toContain("desktop");
  });

  it("renders the verify button when verifyUrl is provided", () => {
    var html = buildFilterEmailHtml(
      "q",
      "bot@gmail.com",
      "https://demo",
      "https://guide",
      "https://script.google.com/macros/s/abc/exec?action=verify_forwarding&t=1&iat=2&sig=z"
    );
    expect(html).toContain("Verify forwarding address");
    expect(html).toContain(
      'href="https://script.google.com/macros/s/abc/exec?action=verify_forwarding&amp;t=1&amp;iat=2&amp;sig=z"'
    );
  });

  it("hides the verify button when verifyUrl is null", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide", null);
    expect(html).not.toContain("Verify forwarding address");
  });
});

describe("buildGmailFilterPrefillUrl", () => {
  it("URL-encodes the query into the Gmail search hash", () => {
    var url = buildGmailFilterPrefillUrl('from:(a@b.com) -(subject:"x y")');
    expect(url).toBe("https://mail.google.com/mail/#search/from%3A(a%40b.com)%20-(subject%3A%22x%20y%22)");
  });
});
