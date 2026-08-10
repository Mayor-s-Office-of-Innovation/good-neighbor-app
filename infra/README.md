# Infrastructure

Terraform is organized by environment roots and reusable modules. State must use a remote S3 backend with DynamoDB locking before any shared environment is deployed.

```text
infra/
  environments/
    dev/
    prod/
  modules/
    app/
```

The starter environment keeps the backend block commented until DT Platform Engineering provisions the state bucket and lock table.
