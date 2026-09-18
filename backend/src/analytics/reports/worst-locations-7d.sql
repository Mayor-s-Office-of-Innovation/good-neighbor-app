-- Worst locations over the last 7 days (ADR 0013 §Phase 4 example).
-- grade_score: Excellent=5 … Very Poor=1 (lower = worse); NULL grades are
-- excluded by the aggregates, not counted as 0.
SELECT siteId,
       avg(gradeScore) AS avg_grade_score,
       min(gradeScore) AS worst_grade_score,
       count(*)        AS reports
FROM checks
WHERE date >= current_date - INTERVAL 7 DAY
  AND gradeScore IS NOT NULL
  AND status = 'completed'
GROUP BY siteId
ORDER BY avg_grade_score ASC
LIMIT 10;