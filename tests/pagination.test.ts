import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { parsePagination, paginationMeta, paginateArray } from "../src/lib/api/pagination.js";

// A minimal stand-in for NextRequest — `parsePagination` only ever reads
// `req.nextUrl.searchParams`, and constructing a real `NextRequest` would require the
// `next` package to actually be installed, which this sandbox doesn't have (see the
// README's "no npm registry access" caveat). Plain `URL` already implements
// `searchParams` identically, so this is a faithful stand-in for what this function
// actually touches, not a shortcut around real behavior.
function reqWithQuery(query: string): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/things${query}`) } as unknown as NextRequest;
}

test("parsePagination: defaults to page 1, pageSize 50 with no query params", () => {
  const p = parsePagination(reqWithQuery(""));
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, 50);
  assert.equal(p.skip, 0);
  assert.equal(p.take, 50);
});

test("parsePagination: honors valid page/pageSize and computes skip correctly", () => {
  const p = parsePagination(reqWithQuery("?page=3&pageSize=20"));
  assert.equal(p.page, 3);
  assert.equal(p.pageSize, 20);
  assert.equal(p.skip, 40); // (3-1) * 20
  assert.equal(p.take, 20);
});

test("parsePagination: caps pageSize at 200 rather than erroring", () => {
  const p = parsePagination(reqWithQuery("?pageSize=5000"));
  assert.equal(p.pageSize, 200);
});

test("parsePagination: invalid/non-positive values fall back to defaults, not an error", () => {
  const p1 = parsePagination(reqWithQuery("?page=0&pageSize=-5"));
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 50);

  const p2 = parsePagination(reqWithQuery("?page=abc&pageSize=xyz"));
  assert.equal(p2.page, 1);
  assert.equal(p2.pageSize, 50);
});

test("paginationMeta: computes totalPages correctly, including a partial last page", () => {
  const p = parsePagination(reqWithQuery("?page=1&pageSize=10"));
  const meta = paginationMeta(25, p);
  assert.equal(meta.totalPages, 3); // 25 / 10 -> 3 pages
  assert.equal(meta.totalCount, 25);
  assert.equal(meta.page, 1);
  assert.equal(meta.pageSize, 10);
});

test("paginationMeta: totalPages is at least 1 even with zero total rows", () => {
  const p = parsePagination(reqWithQuery(""));
  const meta = paginationMeta(0, p);
  assert.equal(meta.totalPages, 1);
});

test("paginateArray: slices the correct page out of an in-memory array", () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1); // [1..25]
  const p = parsePagination(reqWithQuery("?page=2&pageSize=10"));
  assert.deepEqual(paginateArray(items, p), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test("paginateArray: an out-of-range page returns an empty slice, not an error", () => {
  const items = [1, 2, 3];
  const p = parsePagination(reqWithQuery("?page=10&pageSize=10"));
  assert.deepEqual(paginateArray(items, p), []);
});
