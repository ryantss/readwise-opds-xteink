import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";

import { OBSERVED_BODY_BYTES, OBSERVED_TAIL_STOP } from "../src/core/budget.js";
import { buildObservedEpub } from "../scripts/observed-tail-server.js";

test("the observed body is a real epub of 502491 bytes", () => {
  const bytes = buildObservedEpub();
  assert.equal(bytes.length, OBSERVED_BODY_BYTES);
  assert.equal(OBSERVED_TAIL_STOP % (16 * 1024), 0);
  const entries = unzipSync(bytes);
  assert.ok(entries["META-INF/container.xml"].length > 0);
});
