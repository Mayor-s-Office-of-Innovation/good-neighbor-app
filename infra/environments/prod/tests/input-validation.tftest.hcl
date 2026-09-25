mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [
        {
          domain_name           = "goodneighbor.sf.gov"
          resource_record_name  = "_validation.goodneighbor.sf.gov"
          resource_record_type  = "CNAME"
          resource_record_value = "_validation.acm-validations.aws"
        },
        {
          domain_name           = "goodneighborsf.org"
          resource_record_name  = "_validation.goodneighborsf.org"
          resource_record_type  = "CNAME"
          resource_record_value = "_validation.acm-validations.aws"
        },
      ]
    }
  }
}
mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [
        {
          domain_name           = "goodneighbor.sf.gov"
          resource_record_name  = "_validation.goodneighbor.sf.gov"
          resource_record_type  = "CNAME"
          resource_record_value = "_validation.acm-validations.aws"
        },
        {
          domain_name           = "goodneighborsf.org"
          resource_record_name  = "_validation.goodneighborsf.org"
          resource_record_type  = "CNAME"
          resource_record_value = "_validation.acm-validations.aws"
        },
      ]
    }
  }
}
mock_provider "archive" {}

override_resource {
  target = aws_sesv2_email_identity.setup_codes
}

override_resource {
  target = aws_route53_record.setup_code_dev_dkim[0]
}

override_resource {
  target = aws_route53_record.setup_code_dev_dkim[1]
}

override_resource {
  target = aws_route53_record.setup_code_dev_dkim[2]
}

override_resource {
  target = aws_route53_record.setup_code_prod_dkim[0]
}

override_resource {
  target = aws_route53_record.setup_code_prod_dkim[1]
}

override_resource {
  target = aws_route53_record.setup_code_prod_dkim[2]
}

run "accepts_valid_name_servers_with_optional_trailing_periods" {
  command = plan

  plan_options {
    target = [aws_route53_record.frontend_subdomain_delegation]
  }

  variables {
    dev_frontend_dns_name_servers = [
      "ns-1312.awsdns-36.org",
      "ns-1886.awsdns-43.co.uk.",
      "ns-482.awsdns-60.com",
      "ns-645.awsdns-16.net.",
    ]
  }
}

run "accepts_three_distinct_dkim_tokens" {
  command = plan

  plan_options {
    target = [aws_route53_record.setup_code_dev_dkim]
  }

  variables {
    setup_code_dev_dkim_tokens = [
      "7rxq7zquj342nyi6ipribuy3p67fh2ik",
      "mdld2zah6porodxrvafpl4ti4nvp4oai",
      "gi2cbrtmuxmodqdztfoq33ee5ifc4pqi",
    ]
  }
}

run "rejects_malformed_name_server_with_trailing_period" {
  command = plan

  plan_options {
    target = [aws_route53_record.frontend_subdomain_delegation]
  }

  variables {
    dev_frontend_dns_name_servers = [
      "ns-1312.awsdns-36.org",
      "ns-1886.awsdns-43.co.uk",
      "ns-482.awsdns-60.com",
      "not-a-route53-name-server.",
    ]
  }

  expect_failures = [var.dev_frontend_dns_name_servers]
}

run "rejects_duplicate_name_servers" {
  command = plan

  plan_options {
    target = [aws_route53_record.frontend_subdomain_delegation]
  }

  variables {
    dev_frontend_dns_name_servers = [
      "ns-1312.awsdns-36.org",
      "ns-1886.awsdns-43.co.uk",
      "ns-482.awsdns-60.com",
      "ns-482.awsdns-60.com",
    ]
  }

  expect_failures = [var.dev_frontend_dns_name_servers]
}

run "rejects_duplicate_dkim_tokens" {
  command = plan

  plan_options {
    target = [aws_route53_record.setup_code_dev_dkim]
  }

  variables {
    setup_code_dev_dkim_tokens = [
      "7rxq7zquj342nyi6ipribuy3p67fh2ik",
      "mdld2zah6porodxrvafpl4ti4nvp4oai",
      "mdld2zah6porodxrvafpl4ti4nvp4oai",
    ]
  }

  expect_failures = [var.setup_code_dev_dkim_tokens]
}

run "rejects_malformed_dkim_token" {
  command = plan

  plan_options {
    target = [aws_route53_record.setup_code_dev_dkim]
  }

  variables {
    setup_code_dev_dkim_tokens = [
      "7rxq7zquj342nyi6ipribuy3p67fh2ik",
      "mdld2zah6porodxrvafpl4ti4nvp4oai",
      "too-short",
    ]
  }

  expect_failures = [var.setup_code_dev_dkim_tokens]
}
