# Terraform's init and plan output for plan-dev.yml's public log, read with jq -n -R --arg status <exit status>.
# Summaries and details are read only for the error class, since no scrub catches every value from state.
include "public-address" {search: "./"};

def level: if test("^warning$"; "i") then "warning" else "error" end;
# A fixed name, read only after the AWS SDK's full error chain, so stray text rarely sets it.
def error_class:
  [
    "AccessDeniedException", "AccessDenied", "UnauthorizedOperation", "Forbidden",
    "AuthorizationError", "UnrecognizedClientException", "InvalidAccessKeyId",
    "SignatureDoesNotMatch", "ResourceNotFoundException", "NoSuchEntity", "NoSuchBucket",
    "NotFound", "ThrottlingException", "Throttling", "ExpiredTokenException", "ExpiredToken",
    "InvalidClientTokenId", "ValidationException"
  ] as $names
  | ([.summary, .detail] | map(select(type == "string")) | join("\n")) as $s
  | ($s | [match("operation error [A-Za-z0-9 ]+: [A-Za-z0-9]+, (?:exceeded maximum number of attempts, [0-9]+, )?https response error StatusCode: [0-9]{3}, RequestID: [^,]*, (?:HostID: [^,]*, )?(?:api error )?(" + ($names | join("|")) + "):"; "g")]
       | first(.[] | .captures[0].string) // "-");
# Relative .tf paths only; others can show runner paths or values.
def public_file:
  if type == "string" and test("^[A-Za-z0-9_.-][A-Za-z0-9_./-]*\\.tf(\\.json)?$") then . else "-" end;
def public_range:
  if type == "object" and (.filename | public_file) != "-" then
    .filename + (if (.start | type) == "object" and (.start.line | type) == "number"
                 then ":\(.start.line | floor)" else "" end)
  else "-" end;
# Rebuilt from the captured name and version, so nothing else in the message prints.
def provider_version:
  strings
  | first(
      capture("^Installed provider version: (?<p>[a-z0-9-]+/[a-z0-9-]+) (?<v>v[0-9]+\\.[0-9]+\\.[0-9]+)(?: |$)"),
      capture("^(?<p>[a-z0-9-]+/[a-z0-9-]+) (?<v>v[0-9]+\\.[0-9]+\\.[0-9]+): Using previously-installed provider version$")
    )
  | "Provider: \(.p) \(.v)";

# Each row is {t: text, d: whether it's a diagnostic}; only diagnostics call for the hint.
[
  inputs
  | (try fromjson catch null) as $m
  | if ($m | type) == "object" then
      if $m.type == "diagnostic" then
        # One bad diagnostic must not drop the rest.
        {d: true, t: (try (
          $m.diagnostic
          | [
              (.severity // "" | tostring | level),
              (.address | public_address),
              (.range | public_range),
              error_class
            ]
          | join("\t")
        ) catch "error\t-\t-\t-")}
      elif $m.type == "log" then
        {d: false, t: ($m["@message"] | provider_version)}
      elif $m.type == "init_output" then
        {d: false, t: ({
          lock_info: "Lock file: created .terraform.lock.hcl",
          dependencies_lock_changes_info: "Lock file: provider selections changed in .terraform.lock.hcl"
        }[$m.message_code | strings] // empty)}
      else empty end
    else
      gsub("\u001b\\[[0-9;]*[A-Za-z]"; "")
      | if test("^(│ )?Error: ") then {d: true, t: "error\t-\t-\t\({summary: .} | error_class)"}
        elif test("^(│ )?Warning: ") then {d: true, t: "warning\t-\t-\t\({summary: .} | error_class)"}
        elif test("^Terraform initialization failed; retrying in [0-9]+ seconds \\(attempt [0-9]/3\\)\\.$") then {d: false, t: .}
        else empty end
    end
]
| (.[] | .t),
  (if any(.[]; .d) or (($ARGS.named.status // "0") != "0") then
    "Summaries are withheld from this public log. Each error shows its level and error class; a plan error also shows its resource address and file line where Terraform gives them. Config errors reproduce in a local plan with dev credentials. A permission failure shows its denial class but not the action: find the action from the class and the resource address."
  else empty end)
