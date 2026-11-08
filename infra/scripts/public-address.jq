# Shared by plan-summary.jq and plan-diagnostics.jq, whose output is public.
# A for_each or count key can hold a value from config, so every [...] key cuts to […];
# the rest must have a Terraform address's shape, or "-" prints, so no other text slips out.
def public_address:
  if type == "string" then
    gsub("\\[(\"([^\"\\\\]|\\\\.)*\"|[0-9]+)\\]"; "[…]")
    | if test("^(module\\.[A-Za-z_][A-Za-z0-9_-]*(\\[…\\])?\\.)*(data\\.)?[A-Za-z_][A-Za-z0-9_-]*\\.[A-Za-z_][A-Za-z0-9_-]*(\\[…\\])?$")
      then . else "-" end
  else "-" end;
