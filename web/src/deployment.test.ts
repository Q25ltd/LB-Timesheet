import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { PRODUCTION_API } from "./auth/apiBase";
import { PATHS } from "./paths";

/**
 * The website's Vercel deployment (B4): `vercel.json` is part of the product.
 *
 *   every route the app owns is served by index.html — direct visits,
 *   refreshes, and the emailed /verify-email and /reset-password links
 *   (whose token rides in the fragment, which Vercel never sees)
 *   the page may talk only to its own origin and the Timesheets API
 *   it cannot be framed, sniffed, or leak its URL in a Referer
 */
// Read from the web package (the test runner's working directory), and
// narrowed field by field — what Vercel will read, not what a type claims.
const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"));

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (Reflect.get(value, key) as unknown) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, key: string): string {
  const found = field(value, key);
  return typeof found === "string" ? found : "";
}

const config = {
  framework:       text(raw, "framework"),
  outputDirectory: text(raw, "outputDirectory"),
  rewrites:        list(field(raw, "rewrites")).map(r => ({ source: text(r, "source"), destination: text(r, "destination") })),
};

function headersFor(source: string): Map<string, string> {
  const block = list(field(raw, "headers")).find(h => text(h, "source") === source);
  return new Map(list(field(block, "headers")).map(h => [text(h, "key"), text(h, "value")]));
}

function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(";").map(d => d.trim()).filter(Boolean).map(d => {
    const [name = "", ...values] = d.split(/\s+/);
    return [name, values];
  }));
}

describe("SPA routing on Vercel", () => {
  test("every path falls back to index.html — so a refresh or an emailed link opens the app, not a 404", () => {
    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
    expect(config.framework).toBe("vite");
    expect(config.outputDirectory).toBe("dist");
    // The routes that must survive a direct visit include the emailed links.
    for (const path of [PATHS.verifyEmail, PATHS.resetPassword, PATHS.account, PATHS.company]) {
      expect(new RegExp(`^${config.rewrites[0]?.source ?? "$^"}$`).test(path), path).toBe(true);
    }
  });
});

describe("security headers", () => {
  const all = headersFor("/(.*)");

  test("the Content-Security-Policy allows scripts and styles from this site only, and data only to the Timesheets API", () => {
    const csp = directives(all.get("Content-Security-Policy") ?? "");
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(["'self'", PRODUCTION_API]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(all.get("Content-Security-Policy")).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  test("the production API is the decided host", () => {
    expect(PRODUCTION_API).toBe("https://api.timesheets.logisticbay.com");
  });

  test("no framing, no sniffing, no Referer, https only", () => {
    expect(all.get("X-Frame-Options")).toBe("DENY");
    expect(all.get("X-Content-Type-Options")).toBe("nosniff");
    expect(all.get("Referrer-Policy")).toBe("no-referrer");
    expect(all.get("Strict-Transport-Security")).toMatch(/^max-age=\d{8,}/);
  });

  test("only fingerprinted build assets are cached forever", () => {
    expect(headersFor("/assets/(.*)").get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(all.has("Cache-Control")).toBe(false);
  });
});
