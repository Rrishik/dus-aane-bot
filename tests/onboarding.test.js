import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let buildGmailFilterQuery, buildFilterEmailHtml;

beforeAll(() => {
  ({ buildGmailFilterQuery, buildFilterEmailHtml } = loadAppsScript(
    ["Onboarding.js"],
    ["buildGmailFilterQuery", "buildFilterEmailHtml"],
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
    var html = buildFilterEmailHtml("from:(a@b.com)", "bot@gmail.com", "https://demo", "https://guide");
    expect(html).toMatch(/<pre[^>]*>[\s\S]*from:\(a@b\.com\)[\s\S]*<\/pre>/);
  });

  it("includes the bot inbox address", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide");
    expect(html).toContain("bot@gmail.com");
  });

  it("includes both the demo and guide links", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo.example", "https://guide.example");
    expect(html).toContain('href="https://demo.example"');
    expect(html).toContain('href="https://guide.example"');
  });

  it("escapes HTML-significant characters in the query", () => {
    var html = buildFilterEmailHtml('a<b>&"c', "bot@gmail.com", "https://demo", "https://guide");
    expect(html).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(html).not.toContain("a<b>&"); // raw injection blocked
  });

  it("returns a string with the expected outer structure", () => {
    var html = buildFilterEmailHtml("q", "bot@gmail.com", "https://demo", "https://guide");
    expect(html.startsWith("<div")).toBe(true);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html).toContain("Set up auto-forwarding");
  });
});
