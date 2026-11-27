# Security

GMI Desk holds GMI credentials (OAuth tokens, inference and Compute keys), can spend money on a GMI account, and runs
a coding agent that executes commands on your machine. Security reports are very welcome.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[kunalsiyag/gmi-desk](https://github.com/kunalsiyag/gmi-desk/security/advisories/new). Please don't open a public
issue. Include the version or commit, your OS, and the steps to reproduce.

Fixes land on `main`; there are no packaged releases yet.

## Especially in scope

- Secrets leaving the main process or the OS keychain (renderer, logs, crash output, the agent's environment).
- Sandbox escapes from the Code agent (bubblewrap on Linux, Seatbelt on macOS), including through git metadata,
  symlinks, MCP servers or the network proxy.
- Paid actions without a confirmation, or ways around the app's budgets.
- The port-preview views in the computer dock reaching private or loopback addresses.
- Anything that lets web content or a model reply run code in the renderer.

Issues in GMI Cloud's own services belong with GMI Cloud.
