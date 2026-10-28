/** drizzle's Postgres migrator skips any migration whose journal `when` is not after the last applied one. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("migration journals", () => {
  for (const d of ["pg", "sqlite"]) {
    it(`${d}: 'when' strictly increasing`, () => {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, `../../drizzle/${d}/meta/_journal.json`), "utf8"));
      const w = j.entries.map((e: any) => e.when);
      for (let i = 1; i < w.length; i++) expect(w[i], j.entries[i].tag).toBeGreaterThan(w[i - 1]);
    });
  }
});
