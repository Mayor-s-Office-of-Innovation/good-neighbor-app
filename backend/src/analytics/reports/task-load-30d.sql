-- Open task load by site (onsite vs city escalation), current state only —
-- latest-wins dedupe in the tasks view makes status transitions collapse to
-- the current state.
SELECT siteId,
       count(*) FILTER (taskStatus = 'open')  AS open_tasks,
       count(*) FILTER (taskStatus = 'open' AND type = 'city_escalation') AS open_escalations,
       count(*) FILTER (taskStatus = 'resolved') AS resolved_tasks
FROM tasks
WHERE createdAt >= (current_date - INTERVAL 30 DAY)
GROUP BY siteId
ORDER BY open_tasks DESC
LIMIT 25;