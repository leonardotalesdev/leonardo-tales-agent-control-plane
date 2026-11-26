# Human approval gate

Leonardo Tales Constitution v1.1.1 governs internal project decisions.

For each eligible action, the operator reviews the bound target, originating agent, action revision, normalized input, quantity, request ID and digest, and expiry. The host derives the approval fact from the exact operator decision and re-evaluates policy. Gateway binds that decision to the request, enforces the shared cap and controls dispatch. A Task-wide pause stops fresh and resumed submissions before the fixture handler begins. An already started handler continues. A reservation interrupted before the handler starts can yield an unknown outcome with its hold preserved.

Stop when approval or authority is missing, when sensitive information may be exposed, or when approved scope cannot be established. Resolve contradictory records before relying on them. Inspect uncertain actions and preserve their holds.

Repository release, publication, deployment, irreversible changes, permission expansion, and changes to identity, memory or security posture each require explicit human approval for the specific scope. Approval in this fixture workflow applies only to its exact action. [Permissions](PERMISSIONS.md)
