# Enable the isolated duplicate matcher in dev through the normal CI deployment.
enable_duplicate_detection = true

# CloudWatch Omni trial, scoped to this application's log groups (omni.tf).
# Staff reach the account through the Identity Center PowerUserAccess
# permission set; granting that set's shared role lets them open the space
# from the CloudWatch console. Individual grants go in cloudwatch_omni_members.
enable_cloudwatch_omni = true
cloudwatch_omni_sso_permission_sets = {
  PowerUserAccess = "READ_WRITE_DELETE"
}
