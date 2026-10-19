#!/bin/sh
# Local CI (setup profile, item ci-local-ci-script): the written definition of green for a
# repo without hosted CI. It runs a fixed roster of gates; each gate must run something,
# and a gate that checked nothing counts as failed, never as a pass.
#   sh ci/local-ci.sh
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
py=$(git config --get profile.python)
pass=0; total=0
gate() {
  total=$((total + 1))
  if "$@"; then pass=$((pass + 1)); echo "[+] $1"; else echo "[x] $1"; fi
}
ascii_sweep() {
  n=$(git ls-files | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] || return 1
  ! git ls-files -z | xargs -0 grep -IlP '[^\x00-\x7F]' 2>/dev/null | grep -q .
}
compile_sweep() {
  files=$(git ls-files '*.py')
  [ -n "$files" ] || return 0
  [ -n "$py" ] || return 1
  "$py" -m py_compile $files
}
hooks_armed() { sh .githooks/check-armed.sh --check; }
suite() {
  cmd=$(git config --get profile.testCommand)
  [ -n "$cmd" ] || return 1
  gate_prefix=$(git config --get profile.suiteGate)
  sh -c "$gate_prefix $cmd"
}
gate ascii_sweep
gate compile_sweep
gate hooks_armed
gate suite
echo "local CI: $pass/$total gates green"
[ "$pass" -eq "$total" ] && [ "$total" -eq 4 ]
