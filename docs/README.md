# reai-mcp documentation

The [README](../README.md) is the front door: what this is, the two safety switches, how to install
it, how to verify it, and an index of the thirteen tool groups. These pages are the reference material
behind it — read them when you have hit something, or before you use a domain in anger.

| Page | What is in it |
|---|---|
| [tools.md](tools.md) | **Every tool**, with its purpose and its risk classification, and per domain what driving it against live books turned out to do — the state machines that do not report their state, the fields that replace when they look like they patch, and the `200`s that mean nothing happened |
| [safety.md](safety.md) | The write policy in detail: the two places an apparently reversible call destroys something, the `PUT` omission gate, the payment-destination field set, and how a remote deployment's write ceiling composes with a sealed grant's |
| [api-quirks.md](api-quirks.md) | The 122-entry quirk registry as prose: shapes that are not what their name suggests, constraints the schema omits, empty states that look like errors |
| [discovery.md](discovery.md) | Why search has to work in Norwegian, the three query corpora it is measured against, and the sweep that answers what a ranking change did to every *other* query |
| [self-hosting.md](self-hosting.md) | Running the remote connector: OAuth 2.1, Docker, Cloud Run, sealed tokens, request limits, and the remote-only environment variables |
| [development.md](development.md) | Tests, adding a tool, refreshing the API snapshot, invoking the live harnesses, the tenant guard, and the `npm audit` posture |
| [audits.md](audits.md) | The four live audit harnesses: what each re-checks against real books, what it deliberately cannot reach, and what it found that was false |

Everything in here was measured against a live ReAI tenant rather than read off the OpenAPI
document, because ReAI has no sandbox and the spec has been wrong about the operations that matter
most.
