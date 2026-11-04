# Supplemental IAM policy templates

`prod-logs-read-only.json` grants read-only access to the listed production
application log groups and streams. Render it with Terraform's `templatefile`
function in the infrastructure that owns the reader role:

```hcl
templatefile("prod-logs-read-only.json", {
  account_id = var.account_id
  aws_region = var.aws_region
})
```

Supply the production account and region from environment configuration. Do not
attach the unrendered template or commit a rendered policy containing the account
ID. The template grants no log-write or IAM permissions and keeps the explicit
log-group list; rendering does not broaden access to other groups.
