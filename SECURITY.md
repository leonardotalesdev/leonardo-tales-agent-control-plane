# Security policy

Leonardo Tales Constitution v1.1.1 governs internal project decisions.

## Scope

Leonardo Tales Agent Control Plane v0.1.0 runs on one trusted Linux host with private, exclusive access to a Task directory and a registered local fixture handler. It covers synthetic input and host-bound local identities. The host controls its own process, trusted registration and operator access. Treat proposed input and operation handles as untrusted. Keep the operator callback, host object, registry, raw Task state and handler outside the agent-facing interface.

Report a bound client crossing an agent or Run boundary, dispatch without exact approval or beyond the Task cap, a fresh or resumed submission bypassing an effective pause before the handler starts, or replay causing a second effect. Also report loss or misattribution of held allowance, request binding or execution evidence in the supported setup. Include the affected version, configuration, expected and observed behavior, impact and sanitized synthetic observations.

The pilot assumes a trusted OS operator and local filesystem. Production authentication, distributed execution, provider-side exactly-once effects and recovery from every crash are outside the tested configuration. Preserve the private directory when the outcome is uncertain or the writer lock is stranded. [Project boundary](PROJECT_BOUNDARY.md)

## Responsible reporting

The proposed channel is GitHub private vulnerability reporting. Once maintainers enable and verify it, use **Security and quality → Report a vulnerability**. Maintainers will review reports privately, confirm the supported configuration and impact, coordinate fixes and agree with reporters on disclosure timing and credit. Keep vulnerability details, credentials and raw Task records out of public issues, pull requests and chat. Use synthetic data and redact any identifying details. [GitHub reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)

Maintainer access, notifications and private intake readiness are pending verification.
