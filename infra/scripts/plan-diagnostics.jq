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
    "NotFound", "ThrottlingException", "Throttling", "RequestLimitExceeded",
    "ExpiredTokenException", "ExpiredToken", "InvalidClientTokenId", "ValidationException"
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
# Rebuilt from the captured name and version, so nothing else in the message prints. A version
# outside the pattern could carry other text, so only its provider's name prints.
def provider_version:
  strings
  | first(
      (capture("^Installed provider version: (?<p>[a-z0-9-]+/[a-z0-9-]+) (?<v>v[0-9]+\\.[0-9]+\\.[0-9]+(?:-(?:alpha|beta|rc|dev|pre)[0-9.]{0,10})?)(?: |$)"),
       capture("^(?<p>[a-z0-9-]+/[a-z0-9-]+) (?<v>v[0-9]+\\.[0-9]+\\.[0-9]+(?:-(?:alpha|beta|rc|dev|pre)[0-9.]{0,10})?): Using previously-installed provider version$")
      | "Provider: \(.p) \(.v)"),
      (capture("^Installed provider version: (?<p>[a-z0-9-]+/[a-z0-9-]+) "),
       capture("^(?<p>[a-z0-9-]+/[a-z0-9-]+) [^ ]+: Using previously-installed provider version$")
      | "Provider: \(.p) (version withheld)")
    );

def json_row:
  if .type == "diagnostic" then
    # One bad diagnostic must not drop the rest.
    try (
      .diagnostic
      | [
          (.severity // "" | tostring | level),
          (.address | public_address),
          (.range | public_range),
          error_class
        ]
      | join("\t")
    ) catch "error\t-\t-\t-"
  elif .type == "log" then
    .["@message"] | provider_version
  elif .type == "init_output" then
    {
      lock_info: "Lock file: created .terraform.lock.hcl",
      dependencies_lock_changes_info: "Lock file: provider selections changed in .terraform.lock.hcl"
    }[.message_code | strings] // empty
  else empty end;
# A plain-text error's AWS chain often sits in its wrapped detail lines, so they're joined first.
def text_row: "\(.level)\t-\t-\t\({summary: (.lines | join(" "))} | error_class)";
def close: if .chain then [.chain | text_row] else [] end;

foreach ((inputs | {line: .}), {eof: true}) as $in (
  {chain: null, out: []};
  if $in.eof then {chain: null, out: close}
  else
    ($in.line | try fromjson catch null) as $m
    | ($in.line | gsub("\u001b\\[[0-9;]*[A-Za-z]"; "")) as $l
    | if ($m | type) == "object" then {chain: null, out: (close + [$m | json_row])}
      elif ($l | test("^(│ )?(Error|Warning): ")) then
        {chain: {
          level: ($l | capture("^(│ )?(?<l>Error|Warning): ").l | level),
          lines: [$l | sub("^(│ )?(Error|Warning): "; "")]
        }, out: close}
      elif .chain and ($l | startswith("│")) then
        .chain.lines += [$l | sub("^│\\s*"; "") | sub("\\s+$"; "") | select(. != "")]
        | .out = []
      else {chain: null, out: close} end
  end;
  .out[]
),
(if ($ARGS.named.status // "0") != "0" then
  "Summaries are withheld from this public log. Each error shows its level and error class, plus its resource address and file line where Terraform gives them. Config errors reproduce in a local plan with dev credentials. A permission failure shows its denial class but not the action: find the action from the class and the resource address. Init makes one attempt, so re-run the workflow after a network error."
else empty end)
