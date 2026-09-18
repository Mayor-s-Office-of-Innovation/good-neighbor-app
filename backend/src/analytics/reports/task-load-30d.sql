-- Open task load by site (onsite vs city escalation), current state only —
-- latest-wins dedupe in the tasks view makes status transitions collapse to
-- the current state. Terminal status stored by the app is 'completed'
-- (guidance-store.js), not 'resolved'.
SELECT siteId,
       count(*) FILTER (taskStatus = 'open')  AS open_tasks,
       count(*) FILTER (taskStatus = 'open' AND type = 'city_escalation') AS open_escalations,
       count(*) FILTER (taskStatus = 'completed') AS completed_tasks
FROM tasks
WHERE createdAt IS NOT NULL
  AND CAST(createdAt AS TIMESTAMP) >= current_date - INTERVAL 30 DAY
GROUP BY siteId
ORDER BY open_tasks DESC
LIMIT 25;