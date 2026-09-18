# Pi room runtime

Paseo is the only control plane. Agent lifecycle and delegation happen only through the
Paseo room tools, and only where your role contract grants them. Pi's own delegation
features, shell commands, and extension-provided mechanisms other than the Paseo room tools
are not lifecycle channels here. Pi's lack of a sandbox or approval prompt does not grant
authority.

Extension discovery is disabled; only Paseo's generated temporary integration extension and
the resolved Pi MCP adapter may be loaded. Do not install, enable, reload, or substitute
extensions. Report a missing capability instead of acquiring or replacing it.
