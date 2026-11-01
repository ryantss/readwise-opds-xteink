import assert from "node:assert/strict";
import test from "node:test";

import { EPUB_BYTE_BUDGET, X3_COMPLETE_READ_BYTES, x3DownloadOutcome } from "../src/core/budget.js";

const PUBLISHED = [
  ["01m6ayz163q7d673wrkq76hcn1.epub", 502491],
  ["01m5ad7pndwt54mkgwpg845shq.epub", 293924],
  ["01m62s8vznfmgdxc37yevr5efq.epub", 681709]
];

test("bodies past the published X3 read die, and the budget finishes inside it", () => {
  assert.ok(EPUB_BYTE_BUDGET < X3_COMPLETE_READ_BYTES);
  assert.equal(x3DownloadOutcome(EPUB_BYTE_BUDGET).ok, true);
  for (const [name, bytes] of PUBLISHED) {
    const outcome = x3DownloadOutcome(bytes);
    assert.equal(outcome.ok, false, name);
    assert.ok(outcome.received < outcome.total, name);
    assert.equal(outcome.error, "MEMORY_E");
  }
});
