import { describe, expect, it } from "bun:test";
import {
  asRecord,
  envValue,
  isHttpsOrLoopbackUrl,
  isTrustedTokenBaseUrl,
  parseBooleanEnv,
  parseUsageAccountingMode,
  trimTrailingSlash,
  truncatedResponseText,
} from "../src/util";

describe("utility helpers", () => {
  it("normalizes simple string and environment values", () => {
    expect(trimTrailingSlash("https://example.test///")).toBe("https://example.test");
    expect(envValue(" value ")).toBe("value");
    expect(envValue(" \t ")).toBeUndefined();
    expect(envValue(undefined)).toBeUndefined();
  });

  it("parses low-power server option values", () => {
    expect(parseUsageAccountingMode("full")).toBe("full");
    expect(parseUsageAccountingMode("basic")).toBe("basic");
    expect(parseUsageAccountingMode("off")).toBe("off");
    expect(() => parseUsageAccountingMode("cheap")).toThrow("Invalid usage accounting mode");

    expect(parseBooleanEnv("1", "FLAG")).toBe(true);
    expect(parseBooleanEnv("false", "FLAG")).toBe(false);
    expect(parseBooleanEnv(" off ", "FLAG")).toBe(false);
    expect(parseBooleanEnv(undefined, "FLAG")).toBeUndefined();
    expect(() => parseBooleanEnv("maybe", "FLAG")).toThrow("FLAG must be one of");
  });

  it("recognizes HTTPS and loopback HTTP URLs", () => {
    expect(isHttpsOrLoopbackUrl("https://api.example.test")).toBe(true);
    expect(isHttpsOrLoopbackUrl("http://localhost:4141")).toBe(true);
    expect(isHttpsOrLoopbackUrl("http://127.0.0.1:4141")).toBe(true);
    expect(isHttpsOrLoopbackUrl("http://[::1]:4141")).toBe(true);
    expect(isHttpsOrLoopbackUrl("http://api.example.test")).toBe(false);
    expect(isHttpsOrLoopbackUrl("not a url")).toBe(false);
  });

  it("accepts only trusted token base URLs by default", () => {
    const allowedHosts = ["api.example.test"];

    expect(isTrustedTokenBaseUrl("https://API.EXAMPLE.TEST/", allowedHosts)).toBe(true);
    expect(isTrustedTokenBaseUrl("http://localhost:4141", allowedHosts)).toBe(true);
    expect(isTrustedTokenBaseUrl("http://127.0.0.1:4141", allowedHosts)).toBe(true);
    expect(isTrustedTokenBaseUrl("http://[::1]:4141", allowedHosts)).toBe(true);

    expect(isTrustedTokenBaseUrl("not a url", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("http://api.example.test", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("https://user:pass@api.example.test", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("https://api.example.test/path", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("https://api.example.test?x=1", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("https://api.example.test#token", allowedHosts)).toBe(false);
    expect(isTrustedTokenBaseUrl("https://untrusted.example.test", allowedHosts)).toBe(false);
  });

  it("allows arbitrary HTTPS token URLs only with the unsafe opt-in", () => {
    expect(isTrustedTokenBaseUrl("https://untrusted.example.test", [], true)).toBe(true);
    expect(isTrustedTokenBaseUrl("https://untrusted.example.test/path", [], true)).toBe(false);
  });

  it("bounds response snippets and narrows plain objects", async () => {
    const response = new Response("abcdef");
    expect(await truncatedResponseText(response, 3)).toBe("abc");

    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord(["not", "record"])).toEqual({});
    expect(asRecord(null)).toEqual({});
  });
});
