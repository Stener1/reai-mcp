# reai-mcp documentation

The [README](../README.md) is the front door: what this is, the safety model, how to install it, and
the complete tool tables. These pages are the reference material behind it — read them when you have
hit something, not before you start.

| Page | What is in it |
|---|---|
| [safety.md](safety.md) | The write policy in detail: the two places an apparently reversible call destroys something, the `PUT` omission gate, the payment-destination field set, and how a remote deployment's write ceiling composes with a sealed grant's |
| [tools.md](tools.md) | Measured behaviour per domain — the state machines that do not report their state, the fields that replace when they look like they patch, and the `200`s that mean nothing happened |
| [api-quirks.md](api-quirks.md) | The 105-entry quirk registry as prose: shapes that are not what their name suggests, constraints the schema omits, empty states that look like errors |
| [discovery.md](discovery.md) | Why search has to work in Norwegian, and the three query corpora it is measured against |
| [self-hosting.md](self-hosting.md) | Running the remote connector: OAuth 2.1, Docker, Cloud Run, sealed tokens, request limits, and the remote-only environment variables |
| [development.md](development.md) | Tests, adding a tool, refreshing the API snapshot, the live write harnesses, and the `npm audit` posture |

Everything in here was measured against a live ReAI tenant rather than read off the OpenAPI
document, because ReAI has no sandbox and the spec has been wrong about the operations that matter
most.
