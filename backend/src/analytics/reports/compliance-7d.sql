-- Check compliance: sites missing their legal 3×/day duty over the last 7 days.
-- A day is compliant iff it had ≥ 3 completed checks (dynamodb-data-model.md,
-- Metric definitions); compliance rate = compliant_days / total_days.
WITH per_site_day AS (
  SELECT siteId,
         date,
         count(*) AS checks
  FROM checks
  WHERE date >= current_date - INTERVAL 7 DAY
    AND status = 'completed'
  GROUP BY siteId, date
)
SELECT siteId,
       count(*) FILTER (checks >= 3) AS compliant_days,
       count(*)                      AS days_with_any_check,
       round(count(*) FILTER (checks >= 3) / 7.0, 3) AS compliance_rate_7d
FROM per_site_day
GROUP BY siteId
ORDER BY compliance_rate_7d ASC
LIMIT 25;