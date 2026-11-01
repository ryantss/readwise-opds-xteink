import assert from "node:assert/strict";
import { after, test } from "node:test";

import { FIXTURE_PASSWORD, FIXTURE_USERNAME, startFixtureCatalog } from "../scripts/fixture-catalog.js";

const catalogs = [];
after(async () => {
  await Promise.all(catalogs.map((catalog) => catalog.close()));
});

test("startFixtureCatalog defaults to fixture-reader credentials", async () => {
  const catalog = await startFixtureCatalog();
  catalogs.push(catalog);
  assert.equal(catalog.username, FIXTURE_USERNAME);
  assert.equal(catalog.password, FIXTURE_PASSWORD);
  const denied = await fetch(`${catalog.baseUrl}/opds`);
  assert.equal(denied.status, 401);
  const ok = await fetch(`${catalog.baseUrl}/opds`, {
    headers: { authorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString("base64")}` }
  });
  assert.equal(ok.status, 200);
});

test("startFixtureCatalog can bind 8787-style ryan credentials for sim:x3", async () => {
  const catalog = await startFixtureCatalog({ username: "ryan", password: "x3-sim-test" });
  catalogs.push(catalog);
  assert.equal(catalog.username, "ryan");
  const denied = await fetch(`${catalog.baseUrl}/opds`, {
    headers: { authorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString("base64")}` }
  });
  assert.equal(denied.status, 401);
  const ok = await fetch(`${catalog.baseUrl}/opds`, {
    headers: { authorization: `Basic ${Buffer.from("ryan:x3-sim-test").toString("base64")}` }
  });
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /Inbox/);
});

test("startFixtureCatalog can delay EPUB bytes so the simulator download screen stays up", async () => {
  const catalog = await startFixtureCatalog({ downloadDelayMs: 200 });
  catalogs.push(catalog);
  const started = Date.now();
  const response = await fetch(`${catalog.baseUrl}/opds/books/inbox-001.epub`, {
    headers: { authorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString("base64")}` }
  });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started >= 200);
});
