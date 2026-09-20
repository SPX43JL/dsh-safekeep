# Reporting a safety or recovery defect

Use the GitHub project's private vulnerability reporting when it is enabled.
For ordinary bugs use a minimal synthetic reproduction in Issues. Never attach
API keys, Web authentication URLs, full sessions, credentials, recovery data,
or private file contents. Do not test deletion against irreplaceable files.

Include Windows, Node, PowerShell, DSH and plugin versions, the affected entry
point, the error code, and whether the matching version's canary passed.
Local status/doctor output contains paths and session identifiers: redact them.

Support is best effort; no response-time guarantee or external audit is claimed.
See docs/SAFETY.md for the supported accident-mitigation boundary.
