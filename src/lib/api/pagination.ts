import { NextRequest } from "next/server";

/**
 * Shared pagination helper for list endpoints — added in v0.20.0 to close the
 * "pagination on list endpoints" gap flagged in the task-status spreadsheet's
 * Performance & Scaling area: every list endpoint in this app previously returned its
 * full result set with no limit, fine at demo scale and a real problem once an entity
 * has years of closed periods or thousands of journal entries.
 *
 * TWO WAYS THIS GETS USED, deliberately different, per the shape of the endpoint:
 *
 * 1. TRUE LIST endpoints (instruments, stakeholders) — `page`/`pageSize` translate
 *    directly into Prisma's `skip`/`take`, so the database itself only reads the page
 *    being returned. This is the real win: less work for Postgres, not just a smaller
 *    HTTP response.
 *
 * 2. REPORT endpoints that also compute an aggregate over the SAME filtered rows
 *    (journal-entries' account summary and reconciliation, audit-trail's attribution
 *    coverage) — those aggregates are only correct computed over the FULL filtered set,
 *    not one page of it, so those routes still fetch every matching row and run the
 *    aggregate over all of them, then apply `page`/`pageSize` only to the row LIST in
 *    the JSON response. That still bounds response payload size (the actual bandwidth
 *    concern this item was about) even though it doesn't reduce the query itself — a
 *    real, flagged difference from case 1, not an oversight.
 */

export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Parses `?page=` (1-based, default 1) and `?pageSize=` (default 50, capped at 200 —
 * a caller asking for more than that gets 200, not an error, since silently capping is
 * friendlier than a 400 for what's almost always an honest "give me everything"
 * request from a small dataset). Invalid/non-positive values fall back to the default
 * rather than erroring — a malformed pagination param on a GET request isn't worth a
 * hard failure. */
export function parsePagination(req: NextRequest): PaginationParams {
  const pageRaw = Number(req.nextUrl.searchParams.get("page"));
  const pageSizeRaw = Number(req.nextUrl.searchParams.get("pageSize"));

  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize =
    Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function paginationMeta(totalCount: number, params: PaginationParams): PaginationMeta {
  return {
    page: params.page,
    pageSize: params.pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / params.pageSize)),
  };
}

/** Slices an already-fetched array to one page — for the "aggregate over everything,
 * paginate only the row list in the response" case described above (case 2 in the
 * module doc comment). Not a substitute for DB-level `skip`/`take` where that's
 * possible (case 1) — only use this where the full set genuinely has to be read
 * anyway. */
export function paginateArray<T>(items: T[], params: PaginationParams): T[] {
  return items.slice(params.skip, params.skip + params.take);
}
