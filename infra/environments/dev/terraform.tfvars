# Enable the isolated duplicate matcher in dev through the normal CI deployment.
enable_duplicate_detection = true

# Public verification key for media cookies; private PEM lives in Secrets Manager.
media_signing_public_key_pem = <<-PEM
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxh/a58y0YUuCxxJd82jD
HiePlJXSECngGzkKI7U6kfZQ6+wKNK0c38K/QumVRP/1ck1jiSWaM/hjQivvncdA
8XeCcm6QpZTgYDtq+cscGlzXdGSi12da61KPc2h6tlKhVTMAnxXFYeMQOAqzjqu2
c561mQZKzDasFHulBrt2Xu8yOXEnQn5I4uYMguLwwF+YMF208CLSO20w6J8CIcbL
vykUDXHKYa1glqc4kcQzeLvBmP2uDW9mhjzk2wkDI8k3FH7nDZuAfi2VMZv6kiut
Jn/Wx859kYQvIU0kEE7eY6YcDO6CDTBG0zFZnaiNu7tTQASRj3KJw+VrDZGaHcGQ
5wIDAQAB
-----END PUBLIC KEY-----
PEM

# CloudWatch Omni trial, scoped to this application's log groups (omni.tf).
# Staff reach the account through the Identity Center PowerUserAccess
# permission set; granting that set's shared role lets them open the space
# from the CloudWatch console. Individual grants go in cloudwatch_omni_members.
enable_cloudwatch_omni = true
cloudwatch_omni_sso_permission_sets = {
  PowerUserAccess = "READ_WRITE_DELETE"
}
