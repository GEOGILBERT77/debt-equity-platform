import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuditTrail, summarizeAttributionCoverage, AuditTrailInput } from "../src/lib/accounting/auditTrail.js";

test("buildAuditTrail: sorts term versions and corrections into one chronological timeline", () => {
  const inputs: AuditTrailInput[] = [
    {
      kind: "CORRECTION",
      instrumentId: "inst-1",
      instrumentType: "TERM_LOAN",
      stakeholderName: "Acme Lender LLC",
      correctionId: "corr-1",
      discoveredDate: "2025-06-01",
      reason: "Wrong interest rate used for Q1",
      election: "RETROSPECTIVE",
      createdAt: "2025-06-02",
      cumulativeDelta: "1250.00",
    },
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-1",
      instrumentType: "TERM_LOAN",
      stakeholderName: "Acme Lender LLC",
      effectiveDate: "2024-01-01",
      label: "Original terms",
      createdAt: "2024-01-01",
      createdByUserEmail: "cfo@example.com",
      isOriginal: true,
    },
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-1",
      instrumentType: "TERM_LOAN",
      stakeholderName: "Acme Lender LLC",
      effectiveDate: "2025-01-01",
      label: "Rate amendment",
      createdAt: "2025-01-01",
      createdByUserEmail: "cfo@example.com",
      isOriginal: false,
    },
  ];

  const trail = buildAuditTrail(inputs);

  assert.equal(trail.length, 3);
  // Chronological by `date` (effectiveDate / discoveredDate): original grant, then
  // amendment, then the correction discovered afterward.
  assert.equal(trail[0].date, "2024-01-01");
  assert.equal(trail[0].kind, "TERM_VERSION");
  assert.match(trail[0].summary, /issued to Acme Lender LLC/);
  assert.equal(trail[1].date, "2025-01-01");
  assert.match(trail[1].summary, /amended, effective 2025-01-01/);
  assert.equal(trail[2].date, "2025-06-01");
  assert.equal(trail[2].kind, "CORRECTION");
  assert.match(trail[2].summary, /Retrospective correction booked/);
  assert.match(trail[2].summary, /1250\.00/);
});

test("buildAuditTrail: same-day entries break ties by createdAt", () => {
  const inputs: AuditTrailInput[] = [
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-2",
      instrumentType: "RSU",
      stakeholderName: "Dana",
      effectiveDate: "2025-03-01",
      label: "Second",
      createdAt: "2025-03-01T12:00:00",
      isOriginal: false,
    },
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-2",
      instrumentType: "RSU",
      stakeholderName: "Dana",
      effectiveDate: "2025-03-01",
      label: "First",
      createdAt: "2025-03-01T09:00:00",
      isOriginal: true,
    },
  ];
  const trail = buildAuditTrail(inputs);
  assert.equal(trail[0].summary.includes("First") || trail[0].summary.includes(`"First"`), true);
  assert.match(trail[0].summary, /"First"/);
  assert.match(trail[1].summary, /"Second"/);
});

test("summarizeAttributionCoverage: reports partial coverage honestly rather than hiding unknown users", () => {
  const inputs: AuditTrailInput[] = [
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-3",
      instrumentType: "WARRANT",
      stakeholderName: "Elm Capital",
      effectiveDate: "2023-01-01",
      label: "Original terms",
      createdAt: "2023-01-01",
      // No createdByUserEmail — a pre-migration row with no attribution on file.
      isOriginal: true,
    },
    {
      kind: "TERM_VERSION",
      instrumentId: "inst-3",
      instrumentType: "WARRANT",
      stakeholderName: "Elm Capital",
      effectiveDate: "2025-01-01",
      label: "Amendment",
      createdAt: "2025-01-01",
      createdByUserEmail: "controller@example.com",
      isOriginal: false,
    },
  ];
  const trail = buildAuditTrail(inputs);
  const coverage = summarizeAttributionCoverage(trail);
  assert.equal(coverage.totalEntries, 2);
  assert.equal(coverage.entriesWithKnownUser, 1);
  assert.equal(coverage.coveragePercent, 50);
});

test("summarizeAttributionCoverage: an empty trail is trivially fully covered (0%, not NaN)", () => {
  const coverage = summarizeAttributionCoverage([]);
  assert.equal(coverage.totalEntries, 0);
  assert.equal(coverage.coveragePercent, 0);
});
