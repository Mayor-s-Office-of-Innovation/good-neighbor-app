# Provision ahead of DT delegation. This does not change existing app DNS,
# CloudFront aliases, or certificates.
resource "aws_route53_zone" "gn" {
  name    = "gn.sf.gov"
  comment = "Good Neighbor App: awaiting sf.gov delegation from SF Department of Technology."

  lifecycle {
    prevent_destroy = true
  }
}

output "gn_dns_zone_id" {
  description = "Route 53 public hosted zone for gn.sf.gov."
  value       = aws_route53_zone.gn.zone_id
}

output "gn_dns_name_servers" {
  description = "Provide all four name servers to DT for gn.sf.gov NS delegation."
  value       = aws_route53_zone.gn.name_servers
}
