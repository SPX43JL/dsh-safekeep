# Contributing

Discuss the observed user problem and a bounded reproduction before proposing
large architecture changes. Preserve low interruption and autonomous work.
Do not broaden blocking just to improve a theoretical coverage claim.

Run the documented Windows tests in a new isolated directory. Use synthetic
fixtures and retain failure evidence. Never include private configurations,
credentials, full session logs, or vault contents in a PR. Changes affecting
guard decisions, path resolution or recovery require relevant host acceptance.

Document code provenance, dependencies and copied-code licenses. Do not
introduce install scripts, telemetry, automatic cleanup or publication jobs
without an explicit reviewed product decision.
