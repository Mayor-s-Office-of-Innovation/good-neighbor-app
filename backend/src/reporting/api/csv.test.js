import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.js";

describe("toCsv", () => {
  it("writes a header row and one line per row, ending in CRLF", () => {
    expect(toCsv(["siteId", "issues"], [{ siteId: "s1", issues: 2 }])).toBe(
      "\uFEFFsiteId,issues\r\ns1,2\r\n",
    );
  });

  it("starts with a byte-order mark, so Excel reads accented names", () => {
    expect(toCsv(["name"], [{ name: "Misión" }]).charCodeAt(0)).toBe(0xfeff);
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(
      toCsv(["name"], [{ name: 'Big "A", Inc.\nAnnex' }]).split("\r\n")[1],
    ).toBe('"Big ""A"", Inc.\nAnnex"');
  });

  it.each(["=SUM(A1)", "+1", "-1+2", "@cmd", "\tx", "\rx"])(
    "stops a spreadsheet running %j as a formula",
    (value) => {
      const line = toCsv(["name"], [{ name: value }]).split("\r\n")[1];
      expect(line.replace(/^"|"$/g, "").startsWith(`'${value[0]}`)).toBe(true);
    },
  );

  it("leaves numbers alone, including negative ones", () => {
    expect(toCsv(["change"], [{ change: -3 }]).split("\r\n")[1]).toBe("-3");
  });

  it("writes missing values as empty cells, never as the word null", () => {
    expect(
      toCsv(["a", "b"], [{ a: null, b: undefined }]).split("\r\n")[1],
    ).toBe(",");
  });

  it("writes true and false as words", () => {
    expect(toCsv(["reopened"], [{ reopened: true }]).split("\r\n")[1]).toBe(
      "true",
    );
  });
});
