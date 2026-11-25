import { afterEach, expect, it, vi } from "vitest";
import { handoffUrl } from "./browser-escape.js";
import { forgetSetupCode, rememberSetupCode } from "./pending-setup-code.js";

afterEach(() => {
  forgetSetupCode();
  vi.unstubAllGlobals();
});

/** @param {string} href */
const at = (href) => vi.stubGlobal("location", { href });

it("adds a stripped setup code back to the handoff URL as a fragment", () => {
  rememberSetupCode("A1B2C3");
  at("https://app.example.org/setup");
  const url = new URL(handoffUrl());
  expect(url.search).toBe("");
  expect(new URLSearchParams(url.hash.slice(1)).get("code")).toBe("A1B2C3");
});

it("keeps other fragment values and doesn't duplicate a code still in the URL", () => {
  rememberSetupCode("A1B2C3");
  at("https://app.example.org/setup#lang=es");
  const fragment = new URLSearchParams(new URL(handoffUrl()).hash.slice(1));
  expect(fragment.get("lang")).toBe("es");
  expect(fragment.get("code")).toBe("A1B2C3");

  at("https://app.example.org/setup?code=Z9Y8X7");
  expect(handoffUrl()).toBe("https://app.example.org/setup?code=Z9Y8X7");
});

it("hands off the plain URL once the code is validated and forgotten", () => {
  rememberSetupCode("A1B2C3");
  forgetSetupCode();
  at("https://app.example.org/setup");
  expect(handoffUrl()).toBe("https://app.example.org/setup");
});
