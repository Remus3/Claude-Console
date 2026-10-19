"""Weekly report task: one background run of /fleet-insights, skipped when this week has a report.

Looks for a report of the current ISO week in {reports_dir}; if none, spawns one run
through the kit's spawn helper and checks afterwards that the page exists (a run
that exits 0 without a page counts as a failure).
"""
import datetime
import glob
import os
import subprocess
import sys

REPORTS = r"{reports_dir}"


def week_tag(today=None):
    y, w, _ = (today or datetime.date.today()).isocalendar()
    return str(y) + "-W" + str(w).zfill(2)


def main():
    tag = week_tag()
    if glob.glob(os.path.join(REPORTS, "*" + tag + "*.html")):
        print("skip: this week has a report")
        return 0
    prompt = os.path.join(".claude", "commands", "fleet-insights.md")
    r = subprocess.run([sys.executable, os.path.join("{kit_dir}", "kit_headless.py"), "spawn", "--root", os.getcwd(),
                        "--code", "{repo_code}", "--note", "weekly-report-" + tag, "--kind", "build",
                        "--prompt-file", prompt, "--timeout", "10800"])
    if r.returncode != 0:
        return r.returncode
    if not glob.glob(os.path.join(REPORTS, "*" + tag + "*.html")):
        print("FAIL run ended without a report page")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
