import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let resolveMerchant, lookupMerchantCategory;

beforeAll(() => {
  // GoogleSheetUtils.js has top-level `var` declarations only; no Apps Script
  // globals are touched at load time.
  ({ resolveMerchant, lookupMerchantCategory } = loadAppsScript(
    ["GoogleSheetUtils.js"],
    ["resolveMerchant", "lookupMerchantCategory"]
  ));
});

const RESOLUTIONS = [
  { pattern: "flipkart_mws_merch", resolved: "Flipkart", category: "Shopping" },
  { pattern: "swiggy", resolved: "Swiggy", category: "Food & Dining" },
  { pattern: "amzn", resolved: "Amazon", category: "" } // resolved with no override
];

describe("resolveMerchant", () => {
  it("returns rawName + empty category when no resolutions provided", () => {
    expect(resolveMerchant("ANYTHING")).toEqual({ merchant: "ANYTHING", category: "" });
    expect(resolveMerchant("ANYTHING", [])).toEqual({ merchant: "ANYTHING", category: "" });
  });

  it("returns rawName when no resolution matches", () => {
    expect(resolveMerchant("Unknown Vendor", RESOLUTIONS)).toEqual({ merchant: "Unknown Vendor", category: "" });
  });

  it("substring-matches case-insensitively", () => {
    expect(resolveMerchant("FLIPKART_MWS_MERCH 12345", RESOLUTIONS)).toEqual({
      merchant: "Flipkart",
      category: "Shopping"
    });
  });

  it("returns first matching resolution (order matters)", () => {
    expect(resolveMerchant("payment to swiggy bowl", RESOLUTIONS)).toEqual({
      merchant: "Swiggy",
      category: "Food & Dining"
    });
  });

  it("returns rawName when resolved is empty string but pattern matches", () => {
    var noResolved = [{ pattern: "abc", resolved: "", category: "Shopping" }];
    expect(resolveMerchant("ABC corp", noResolved)).toEqual({ merchant: "ABC corp", category: "Shopping" });
  });

  it("returns empty category when resolution has none", () => {
    expect(resolveMerchant("amzn pay", RESOLUTIONS)).toEqual({ merchant: "Amazon", category: "" });
  });

  it("returns input unchanged on falsy rawName", () => {
    expect(resolveMerchant("", RESOLUTIONS)).toEqual({ merchant: "", category: "" });
    expect(resolveMerchant(null, RESOLUTIONS)).toEqual({ merchant: null, category: "" });
  });
});

describe("lookupMerchantCategory", () => {
  it("returns null when no match", () => {
    expect(lookupMerchantCategory("Nope", RESOLUTIONS)).toBe(null);
  });

  it("matches on resolved name (case-insensitive exact)", () => {
    expect(lookupMerchantCategory("flipkart", RESOLUTIONS)).toEqual({
      merchant: "Flipkart",
      category: "Shopping"
    });
  });

  it("matches on raw pattern (case-insensitive exact)", () => {
    expect(lookupMerchantCategory("SWIGGY", RESOLUTIONS)).toEqual({
      merchant: "Swiggy",
      category: "Food & Dining"
    });
  });

  it("returns null when resolution has no category (even if name matches)", () => {
    expect(lookupMerchantCategory("Amazon", RESOLUTIONS)).toBe(null);
  });

  it("returns null on falsy / empty inputs", () => {
    expect(lookupMerchantCategory("", RESOLUTIONS)).toBe(null);
    expect(lookupMerchantCategory("foo", [])).toBe(null);
    expect(lookupMerchantCategory(null, RESOLUTIONS)).toBe(null);
  });
});
