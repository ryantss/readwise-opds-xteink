import assert from "node:assert/strict";
import test from "node:test";

import {
  EPUB_BYTE_BUDGET,
  OBSERVED_BODY_BYTES,
  OBSERVED_TAIL_STOP,
  UNCAPPED_TEXT_EXAMPLE_BYTES,
  x3DownloadOutcome
} from "../src/core/budget.js";

test("a full body completes; the observed screen is the stream stopping near the tail", () => {
  assert.equal(OBSERVED_BODY_BYTES, 502491);
  assert.equal(OBSERVED_TAIL_STOP, 458752);
  assert.equal((100 * OBSERVED_TAIL_STOP) / OBSERVED_BODY_BYTES > 91, true);

  const full = x3DownloadOutcome(OBSERVED_BODY_BYTES);
  assert.equal(full.ok, true);
  assert.equal(full.received, OBSERVED_BODY_BYTES);

  const cut = x3DownloadOutcome(OBSERVED_BODY_BYTES, OBSERVED_TAIL_STOP);
  assert.equal(cut.ok, false);
  assert.equal(cut.received, 458752);
  assert.equal(cut.total, 502491);
  assert.equal(cut.error, "SOCKET_PEER_CLOSED_E");

  assert.equal(x3DownloadOutcome(EPUB_BYTE_BUDGET).ok, true);
  assert.ok(UNCAPPED_TEXT_EXAMPLE_BYTES > EPUB_BYTE_BUDGET);
  assert.equal(x3DownloadOutcome(UNCAPPED_TEXT_EXAMPLE_BYTES).ok, true);
});
