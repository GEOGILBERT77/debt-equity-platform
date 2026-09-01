import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { computeETag, conditionalResponse, conditionalJsonResponse } from "../src/lib/api/caching.js";

// Same reasoning as tests/pagination.test.ts: a minimal stand-in for NextRequest,
// since constructing a real one needs the `next` package installed, which this
// sandbox doesn't have. `conditionalResponse` only ever reads `req.headers.get(...)`.
function reqWithIfNoneMatch(value: string | null): NextRequest {
  const headers = new Headers();
  if (value !== null) headers.set("if-none-match", value);
  return { headers } as unknown as NextRequest;
}

test("computeETag: identical bodies produce identical ETags", () => {
  const a = computeETag('{"foo":"bar"}');
  const b = computeETag('{"foo":"bar"}');
  assert.equal(a, b);
});

test("computeETag: different bodies produce different ETags", () => {
  const a = computeETag('{"foo":"bar"}');
  const b = computeETag('{"foo":"baz"}');
  assert.notEqual(a, b);
});

test("computeETag: is quoted per RFC 9110 ETag syntax", () => {
  const etag = computeETag("hello");
  assert.ok(etag.startsWith('"') && etag.endsWith('"'));
});

test("conditionalResponse: no If-None-Match header returns 200 with the body and an ETag", async () => {
  const res = conditionalResponse(reqWithIfNoneMatch(null), "hello world", { contentType: "text/csv" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello world");
  assert.ok(res.headers.get("ETag"));
  assert.equal(res.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
  assert.equal(res.headers.get("Content-Type"), "text/csv");
});

test("conditionalResponse: a matching If-None-Match returns 304 with no body", async () => {
  const body = "hello world";
  const etag = computeETag(body);
  const res = conditionalResponse(reqWithIfNoneMatch(etag), body, { contentType: "text/csv" });
  assert.equal(res.status, 304);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("ETag"), etag);
});

test("conditionalResponse: a stale If-None-Match (body changed) returns 200, not 304", async () => {
  const oldEtag = computeETag("old body");
  const res = conditionalResponse(reqWithIfNoneMatch(oldEtag), "new body", { contentType: "text/csv" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "new body");
});

test("conditionalResponse: honors a custom maxAge", () => {
  const res = conditionalResponse(reqWithIfNoneMatch(null), "x", { contentType: "text/plain", maxAge: 30 });
  assert.equal(res.headers.get("Cache-Control"), "private, max-age=30, must-revalidate");
});

test("conditionalJsonResponse: serializes the payload and sets a JSON content type", async () => {
  const res = conditionalJsonResponse(reqWithIfNoneMatch(null), { a: 1 });
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(await res.text()), { a: 1 });
});

test("conditionalJsonResponse: two calls with the same payload produce the same ETag, enabling a real 304 round trip", async () => {
  const payload = { entries: [1, 2, 3] };
  const first = conditionalJsonResponse(reqWithIfNoneMatch(null), payload);
  const etag = first.headers.get("ETag")!;
  const second = conditionalJsonResponse(reqWithIfNoneMatch(etag), payload);
  assert.equal(second.status, 304);
});
