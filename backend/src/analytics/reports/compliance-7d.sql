-- Check compliance over the last 7 days (7 dates: today − 7 through today − 1).
-- A day is compliant iff it had ≥ 3 completed checks (dynamodb-data-model.md,
-- Metric definitions); compliance rate = compliant_days / 7.
--
-- The population is every site × every one of the 7 dates, so fully-inactive
-- sites and zero-check site-days appear with 0 checks and rate 0 — the whole
-- point of this report is surfacing them. Excludes 'unknown' date partitions
-- (rows whose item had no usable timestamp).
WITH dates AS (
  SELECT unnest(generate_series(
    current_date - INTERVAL 7 DAY,
    current_date - INTERVAL 1 DAY,
    INTERVAL 1 DAY
  ))::DATE AS date
),
sites AS (SELECT DISTINCT siteId FROM checks WHERE siteId IS NOT NULL),
per_site_day AS (
  SELECT siteId,
         CAST(startedAt AS DATE) AS date,
         count(*) AS checks
  FROM checks
  WHERE status = 'completed'
    AND startedAt IS NOT NULL
  GROUP BY siteId, CAST(startedAt AS DATE)
),
population AS (
  SELECT s.siteId, d.date
  FROM sites s CROSS JOIN dates d
)
SELECT p.siteId,
       p.date,
       COALESCE(c.checks, 0) AS checks,
       (COALESCE(c.checks, 0) >= 3) AS compliant
FROM population p
LEFT JOIN per_site_day c
  ON c.siteId = p.siteId AND c.date = p.date
ORDER BY p.siteId, p.date;