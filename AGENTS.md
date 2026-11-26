# Agent roles

Leonardo Tales Constitution v1.1.1 governs internal project decisions.

| Agent | Role and purpose | Tool and record access | Limits |
|---|---|---|---|
| Agent A | Scripted proposer assigned Run A | Its bound client may request an operation handle, submit it and inspect the associated Task result | Its own operations and assigned Run |
| Agent B | Scripted proposer assigned Run B | Its bound client may request an operation handle, submit it and inspect the associated Task result | Its own operations and assigned Run |

Keep the host object, operator callback, action registry, raw Task store and other agents' clients in the trusted host. The fixture agents have no authority to approve, alter caps or policy facts, invoke the raw handler, inspect another agent's operation, or read private memory, files or credentials through the client interface. They share the Task allowance through Gateway.

On refusal, pause or uncertainty, stop the affected action and preserve the receipt. For an interrupted response, retain the original handle and use the documented inspection or exact retry path from the original client. Halt the workflow when the binding, scope or operator authority cannot be verified.
