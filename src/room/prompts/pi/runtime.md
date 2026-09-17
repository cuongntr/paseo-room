# Pi room runtime

Paseo is the only control plane. Do not spawn, delegate, or manage agents through Pi, shell
commands, or extensions. Pi's lack of a sandbox or approval prompt does not grant authority.
Extension discovery is disabled; only Paseo's generated temporary integration extension and
the resolved Pi MCP adapter may be loaded. Do not install, enable, reload, or substitute
extensions. Report a missing capability instead of acquiring or replacing it.
