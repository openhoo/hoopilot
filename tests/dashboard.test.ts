import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_HTML } from "../src/dashboard";

describe("DASHBOARD_HTML", () => {
  it("is a self-contained page with no external resources", () => {
    expect(typeof DASHBOARD_HTML).toBe("string");
    expect(DASHBOARD_HTML).toContain("<title>hoopilot");
    expect(DASHBOARD_HTML).toContain("/v1/usage");
    expect(DASHBOARD_HTML).not.toContain("<script src");
    expect(DASHBOARD_HTML).not.toContain("<link");
    expect(DASHBOARD_HTML).not.toMatch(/https?:\/\//);
  });

  it("carries no stray template-substitution markers in the resolved string", () => {
    expect(DASHBOARD_HTML.includes("`")).toBe(false);
    expect(DASHBOARD_HTML.includes("${")).toBe(false);
  });

  // The page is embedded in a TS backtick template literal, so a nested backtick,
  // a ${...} substitution, or a lone backslash in the literal body would silently
  // corrupt (or break) the served output with no compile error. Guard the raw
  // source so such an edit fails here instead of shipping broken HTML.
  it("uses no backtick, interpolation, or lone backslash in the embedded source", () => {
    const source = readFileSync(join(import.meta.dir, "../src/dashboard.ts"), "utf8");
    // Anchor on the assignment so backticks in the file's leading comment do not
    // count; the opening delimiter is the first backtick after "DASHBOARD_HTML =".
    const open = source.indexOf("DASHBOARD_HTML =");
    const first = source.indexOf("`", open);
    const last = source.lastIndexOf("`");
    expect(open).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const body = source.slice(first + 1, last);
    expect(body.includes("`")).toBe(false);
    expect(body.includes("${")).toBe(false);
    // Only a doubled backslash or a \uXXXX escape is allowed; a single backslash
    // would be consumed by the template literal and never reach the browser.
    expect(body).not.toMatch(/(?<!\\)\\(?!\\|u[0-9a-fA-F]{4})/);
  });
});
