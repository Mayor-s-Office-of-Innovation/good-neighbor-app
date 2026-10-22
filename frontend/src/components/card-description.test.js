import { describe, expect, it } from "vitest";
import {
  cardDescription,
  shortenedCardDescription,
} from "./card-description.js";

describe("card descriptions", () => {
  it("keeps short descriptions and a final crossing word intact", () => {
    expect(cardDescription("Short text")).toBe("<p>Short text</p>");
    expect(shortenedCardDescription("x".repeat(201))).toBe("x".repeat(201));
  });
  it("finishes the word crossing 200 characters before appending three dots", () => {
    const prefix = "a ".repeat(98);
    expect(
      shortenedCardDescription(prefix + "crossingword remaining text"),
    ).toBe(prefix + "crossingword...");
  });
  it("counts Unicode characters and exposes escaped short and full text in a native disclosure", () => {
    const text = "😀 ".repeat(101) + "<script>";
    const markup = cardDescription(text);
    expect(markup).toContain('<details class="card-description">');
    expect(markup).toContain("<summary>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(shortenedCardDescription(text)).toBe(
      "😀 ".repeat(101).trimEnd() + "...",
    );
  });
});
