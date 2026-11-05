# Care log deletion boundary

Saved care work is append-only. The list offers navigation to a saved entry,
while pending entries retain retry and edit-before-retry actions. It does not
show deletion controls: the backend has no `DELETE /v1/care-work/{workId}` route.

Any future deletion feature needs an explicit authorization and reporting policy,
a Site-scoped backend handler, and photo cleanup semantics before exposing a UI
that promises permanent deletion. The current list and detail screens preserve
saved records.
