# Terraform's errors for plan-dev.yml's public log, read line by line with jq -R.
# Details, snippets and quoted text are dropped, since any can hold a value from state.
def scrub: gsub("\"[^\"]*\""; "\"…\"") | gsub("'[^']*'"; "'…'");

(try fromjson catch null) as $m
| if ($m | type) == "object" then
    if $m.type == "diagnostic" then
      $m.diagnostic
      | [
          .severity,
          (.summary // "" | scrub),
          (.address // "-"),
          (if .range then "\(.range.filename):\(.range.start.line)" else "-" end)
        ]
      | join("\t")
    else empty end
  elif test("^(│ )?(Error|Warning): ") then scrub
  else empty end
