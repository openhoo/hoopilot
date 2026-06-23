import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
// Match only Dockerfile instructions, ignoring comment lines (which legitimately
// mention the env vars while explaining the fail-closed behavior).
const instructions = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("Dockerfile runtime defaults", () => {
  it("binds 0.0.0.0 so Docker port publishing can reach the proxy", () => {
    expect(instructions).toMatch(/HOST=0\.0\.0\.0/);
  });

  it("does not ship an unauthenticated-by-default credential proxy", () => {
    // The image binds a non-loopback interface, so it must NOT also opt into
    // unauthenticated operation by default: that combination would expose the
    // stored Copilot OAuth credential to any client that can reach a published
    // port. Operators can still opt in at runtime via HOOPILOT_ALLOW_UNAUTHENTICATED=1.
    expect(instructions).not.toMatch(/HOOPILOT_ALLOW_UNAUTHENTICATED/);
  });

  it("does not bake in a predictable default HOOPILOT_API_KEY", () => {
    // A reference like the healthcheck's `process.env.HOOPILOT_API_KEY` is fine;
    // only a baked-in assignment (`HOOPILOT_API_KEY=<value>`) would ship a key.
    expect(instructions).not.toMatch(/HOOPILOT_API_KEY=/);
  });
});
