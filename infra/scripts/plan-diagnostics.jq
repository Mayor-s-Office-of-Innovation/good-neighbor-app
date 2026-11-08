# Terraform's errors for plan-dev.yml's public log, read with jq -n -R --arg status <plan exit status>.
# Summaries and details are read only for the error class, since no scrub catches every value from state.
include "public-address" {search: "./"};

def level: if test("^warning$"; "i") then "warning" else "error" end;
# Only a fixed name, taken where the AWS SDK puts it, so a quoted value can't fake or leak one.
def error_class:
  [
    "AccessDeniedException", "AccessDenied", "UnauthorizedOperation", "Forbidden",
    "AuthorizationError", "UnrecognizedClientException", "InvalidAccessKeyId",
    "SignatureDoesNotMatch", "ResourceNotFoundException", "NoSuchEntity", "NoSuchBucket",
    "NotFound", "ThrottlingException", "Throttling", "ExpiredToken",
    "InvalidClientTokenId", "ValidationException"
  ] as $names
  | ([.summary, .detail] | map(select(type == "string")) | join("\n")) as $s
  | ($s | [match("(?:api error |StatusCode: [0-9]{3}, RequestID: [^,]*, (?:HostID: [^,]*, )?)(" + ($names | join("|")) + "):"; "g")]
       | first(.[] | .captures[0].string) // "-");
# Only a relative .tf or .tf.json path: an absolute path or a .tfvars name could expose runner paths or values.
def public_file:
  if type == "string" and test("^[A-Za-z0-9_.-][A-Za-z0-9_./-]*\\.tf(\\.json)?$") then . else "-" end;
def public_range:
  if type == "object" and (.filename | public_file) != "-" then
    .filename + (if (.start | type) == "object" and (.start.line | type) == "number"
                 then ":\(.start.line | floor)" else "" end)
  else "-" end;

[
  inputs
  | (try fromjson catch null) as $m
  | if ($m | type) == "object" then
      if $m.type == "diagnostic" then
        # One bad diagnostic must not drop the rest.
        try (
          $m.diagnostic
          | [
              (.severity // "" | tostring | level),
              (.address | public_address),
              (.range | public_range),
              error_class
            ]
          | join("\t")
        ) catch "error\t-\t-\t-"
      else empty end
    else
      gsub("\u001b\\[[0-9;]*[A-Za-z]"; "")
      | if test("^(│ )?Error: ") then "error\t-\t-\t-"
        elif test("^(│ )?Warning: ") then "warning\t-\t-\t-"
        else empty end
    end
]
| if length > 0 or (($ARGS.named.status // "0") != "0") then
    .[], "Summaries are withheld from this public log; the last column names the error class. Config errors such as typos reproduce in a local plan with dev credentials; a permission failure needs the plan role's permissions, and its error class names the denial."
  else empty end
