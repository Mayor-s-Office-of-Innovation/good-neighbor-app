# Terraform's errors for plan-dev.yml's public log, read with jq -n -R.
# Summaries and details are dropped, since no scrub catches every value from state.
def level: if test("^warning$"; "i") then "warning" else "error" end;
# A key is a quoted string or a number; anything else cuts to the end, so no key text slips out.
def cut_keys:
  gsub("\\[(\"([^\"\\\\]|\\\\.)*\"|[0-9]+)\\]"; "[…]")
  | if test("\\[(?!…\\])") then sub("\\[(?!…\\])[\\s\\S]*$"; "[…]") else . end;

[
  inputs
  | (try fromjson catch null) as $m
  | if ($m | type) == "object" then
      if $m.type == "diagnostic" then
        $m.diagnostic
        | [
            (.severity // "" | tostring | level),
            (if .address then .address | tostring | cut_keys else "-" end),
            (if .range then "\(.range.filename):\(.range.start.line)" else "-" end)
          ]
        | join("\t")
      else empty end
    elif test("^(│ )?Error: ") then "error\t-\t-"
    elif test("^(│ )?Warning: ") then "warning\t-\t-"
    else empty end
]
| if length > 0 then
    .[], "Summaries are withheld from this public log; run terraform plan in infra/environments/dev with dev credentials to read them."
  else empty end
