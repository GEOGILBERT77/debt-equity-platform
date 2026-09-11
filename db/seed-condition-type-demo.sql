-- Demo dataset: 30 STOCK_OPTION grants (10 service-condition, 10 performance-condition,
-- 10 market-condition), one of each condition type for each of 10 investors — built to
-- exercise every one of the three ASC 718 stock-comp engines end to end
-- (buildServiceConditionSchedule / buildPerformanceConditionSchedule /
-- buildMarketConditionSchedule, all wired into dispatch.ts's STOCK_OPTION case as of
-- this pass via the new `conditionType` discriminator — see StockOptionInstrumentTerms's
-- doc comment in dispatch.ts) and to validate the reports that read from them.
--
-- >>> BEFORE RUNNING: replace every occurrence of REPLACE_WITH_YOUR_ENTITY_ID below
-- >>> with your real entity's id (find/replace in your SQL editor) — the id shows up
-- >>> in the URL of any page for that entity, e.g. /captable?entityId=THIS_PART.
--
-- Safe to re-run: every INSERT uses a fixed id and ON CONFLICT (id) DO NOTHING, same
-- convention as db/seed.sql.
--
-- ASSUMED VALUES (none of these were specified beyond "between 1/1/26 and 5/31/26,"
-- "the same strike price," "FV between $3.00 and $3.75," and "6-year service period,
-- straight-line vesting and expensing" — pick different numbers before using this for
-- anything other than an engine/report smoke test):
--   - Quantity: 10,000 shares per grant, every grant.
--   - Strike price: $12.00, every grant (the one thing that WAS asked to be uniform).
--   - Grant-date fair value: cycles through $3.00-$3.75 in $0.05 steps, a different
--     value per grant (differs across the three awards within one investor too, via a
--     different starting offset per condition type, so nothing here accidentally lines
--     up 1:1 with another award and masks a bug).
--   - Grant dates: the 1st and 16th of each month from January through May 2026 (10
--     distinct dates), one shared date across an investor's three awards.
--   - "Straight-line vesting" for the SERVICE-condition awards is modeled as ONE
--     tranche vesting the full quantity at the 6-year mark (a cliff, not graded interim
--     tranches) — this keeps all three condition types on the exact same "one total
--     value, recognized straight-line over one 6-year window" shape, which is what
--     makes the three directly comparable in the consolidated schedule.
--   - Performance-condition awards are recorded as "probable" for every month of the
--     6-year service period from day one — the ordinary initial estimate for an award
--     granted on the expectation performance will be met. This produces a schedule
--     identical in shape to the other two (see dispatch.ts's doc comment on why) —
--     it's what makes all 30 grants reconcile to a clean consolidated total. Changing
--     the assessment later is a real accounting event (a "Modify terms" edit to
--     probabilityAssessments), not something this seed does for you.
--
-- CALENDAR-MONTH ALIGNMENT: computeFullSchedule (dispatch.ts) generates its monthly
-- periods aligned to actual calendar months (1st-of-month boundaries) — a grant
-- dated the 16th gets a partial first period (grant date through the 1st of the
-- following month) and a partial last period, not a full "month" of expense in
-- either. This only changes WHEN expense lands within a calendar month, never the
-- total — but it does mean the performance-condition awards' `probabilityAssessments`
-- array below (matched positionally to the engine's actual periods) has to carry the
-- right COUNT of entries for each grant date: 72 for a grant dated the 1st, 73 for
-- one dated the 16th (the extra entry covering the stub periods). See the comment
-- right above that field below for exactly how it's built.
--
-- WHAT THIS SCRIPT DOES NOT DO: approve these schedules. Per this platform's "one
-- approval per data-entry event" model, every grant needs an explicit approval before
-- it shows up in any report — same as a bulk upload. After running this script, go to
-- Reports > Stock option amortization for this entity and click "Approve all stock
-- option amortization schedules" ONCE to approve all 30 (plus anything else
-- unapproved) in one action — that's the real approval engine actually computing and
-- storing each grant's amortization rows, not something this file fakes.

BEGIN;

-- ---------------------------------------------------------------------------
-- 10 investor stakeholders. Names are placeholders ("Investor 1".."Investor 10") —
-- rename freely, the id is what everything else below references.
-- ---------------------------------------------------------------------------
INSERT INTO "Stakeholder" ("id", "entityId", "type", "name")
SELECT 'seed_demo_inv_' || lpad(n::text, 2, '0'), 'REPLACE_WITH_YOUR_ENTITY_ID', 'INVESTOR', 'Investor ' || n
FROM generate_series(1, 10) AS n
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SERVICE-CONDITION awards (10) — conditionType omitted (defaults to "service"),
-- the ordinary pre-existing STOCK_OPTION shape. One cliff tranche at the 6-year mark.
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
SELECT 'seed_demo_so_svc_' || lpad(g.n::text, 2, '0'), 'REPLACE_WITH_YOUR_ENTITY_ID',
       'seed_demo_inv_' || lpad(g.n::text, 2, '0'), 'STOCK_OPTION', g.grant_date, 'USD'
FROM (VALUES
  (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
  (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
  (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
) AS g(n, grant_date)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
SELECT
  'seed_demo_tv_svc_' || lpad(p.n::text, 2, '0'),
  'seed_demo_so_svc_' || lpad(p.n::text, 2, '0'),
  p.grant_date,
  'Original grant (service condition)',
  jsonb_build_object(
    'grantDate', to_char(p.grant_date, 'YYYY-MM-DD'),
    'quantity', 10000,
    'grantDateFairValuePerUnit', p.fair_value,
    'strikePrice', 12.00,
    'attributionMethod', 'straight-line',
    'tranches', jsonb_build_array(
      jsonb_build_object('id', 't1', 'vestDate', to_char(p.grant_date + interval '6 years', 'YYYY-MM-DD'), 'quantity', 10000)
    )
  )
FROM (
  SELECT g.n, g.grant_date, (3.00 + (((g.n - 1 + 0) % 16)) * 0.05)::numeric(6,2) AS fair_value
  FROM (VALUES
    (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
    (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
    (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
  ) AS g(n, grant_date)
) p
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PERFORMANCE-CONDITION awards (10) — conditionType "performance". Assessed probable
-- for every one of the 72 months in the 6-year requisite service period (see the
-- module comment above for why) — one entry per calendar month, matched positionally
-- to the computed schedule's periods, same convention as WARRANT's remeasurement.
-- observations / a cash-settled SAR's observations.
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
SELECT 'seed_demo_so_perf_' || lpad(g.n::text, 2, '0'), 'REPLACE_WITH_YOUR_ENTITY_ID',
       'seed_demo_inv_' || lpad(g.n::text, 2, '0'), 'STOCK_OPTION', g.grant_date, 'USD'
FROM (VALUES
  (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
  (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
  (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
) AS g(n, grant_date)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
SELECT
  'seed_demo_tv_perf_' || lpad(p.n::text, 2, '0'),
  'seed_demo_so_perf_' || lpad(p.n::text, 2, '0'),
  p.grant_date,
  'Original grant (performance condition)',
  jsonb_build_object(
    'conditionType', 'performance',
    'grantDate', to_char(p.grant_date, 'YYYY-MM-DD'),
    'quantity', 10000,
    'grantDateFairValuePerUnit', p.fair_value,
    'strikePrice', 12.00,
    'requisiteServiceEndDate', to_char(p.grant_date + interval '6 years', 'YYYY-MM-DD'),
    -- One entry per period the engine will actually generate, in order — matched
    -- POSITIONALLY (by array index), same convention as WARRANT's
    -- remeasurement.observations. As of the platform's calendar-month-alignment fix,
    -- computeFullSchedule's periods are calendar months (1st-of-month boundaries),
    -- not "one month after the grant date" — so this can't just be a plain monthly
    -- generate_series from the grant date. A grant dated the 1st needs no stub (its
    -- periods already land on the 1st); a grant dated the 16th gets a STUB first
    -- period (ending the 1st of the following month) and a STUB last period (ending
    -- exactly 6 years after the grant date) bracketing the ordinary 1st-of-month
    -- periods in between. Built here as: every 1st-of-month date from the month
    -- after the grant through the 1st of the month the service period ends in, plus
    -- the exact 6-years-out end date itself — DISTINCT so a grant already dated the
    -- 1st (where that exact end date duplicates the last 1st-of-month value) doesn't
    -- get an extra entry.
    'probabilityAssessments', (
      SELECT jsonb_agg(jsonb_build_object('date', to_char(d, 'YYYY-MM-DD'), 'probable', true) ORDER BY d)
      FROM (
        SELECT DISTINCT all_dates.d::date AS d
        FROM (
          SELECT generate_series(
            (date_trunc('month', p.grant_date) + interval '1 month')::date,
            (date_trunc('month', p.grant_date + interval '6 years'))::date,
            interval '1 month'
          ) AS d
          UNION ALL
          SELECT (p.grant_date + interval '6 years')::date
        ) all_dates
      ) deduped
    )
  )
FROM (
  SELECT g.n, g.grant_date, (3.00 + (((g.n - 1 + 5) % 16)) * 0.05)::numeric(6,2) AS fair_value
  FROM (VALUES
    (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
    (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
    (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
  ) AS g(n, grant_date)
) p
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- MARKET-CONDITION awards (10) — conditionType "market". No attribution-method
-- choice, no tranches — always a single straight-line allocation to
-- derivedServiceEndDate (see buildMarketConditionSchedule's doc comment in vesting.ts).
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
SELECT 'seed_demo_so_mkt_' || lpad(g.n::text, 2, '0'), 'REPLACE_WITH_YOUR_ENTITY_ID',
       'seed_demo_inv_' || lpad(g.n::text, 2, '0'), 'STOCK_OPTION', g.grant_date, 'USD'
FROM (VALUES
  (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
  (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
  (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
) AS g(n, grant_date)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
SELECT
  'seed_demo_tv_mkt_' || lpad(p.n::text, 2, '0'),
  'seed_demo_so_mkt_' || lpad(p.n::text, 2, '0'),
  p.grant_date,
  'Original grant (market condition)',
  jsonb_build_object(
    'conditionType', 'market',
    'grantDate', to_char(p.grant_date, 'YYYY-MM-DD'),
    'quantity', 10000,
    'grantDateFairValuePerUnit', p.fair_value,
    'strikePrice', 12.00,
    'derivedServiceEndDate', to_char(p.grant_date + interval '6 years', 'YYYY-MM-DD')
  )
FROM (
  SELECT g.n, g.grant_date, (3.00 + (((g.n - 1 + 11) % 16)) * 0.05)::numeric(6,2) AS fair_value
  FROM (VALUES
    (1, DATE '2026-01-01'), (2, DATE '2026-01-16'), (3, DATE '2026-02-01'), (4, DATE '2026-02-16'),
    (5, DATE '2026-03-01'), (6, DATE '2026-03-16'), (7, DATE '2026-04-01'), (8, DATE '2026-04-16'),
    (9, DATE '2026-05-01'), (10, DATE '2026-05-16')
  ) AS g(n, grant_date)
) p
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Next step: open Reports > Stock option amortization for this entity and click
-- "Approve all stock option amortization schedules" to approve all 30 grants at once
-- (see the module comment at the top of this file for why this script doesn't do that
-- part itself).
