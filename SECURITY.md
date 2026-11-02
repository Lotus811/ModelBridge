# Security Policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch. Older snapshots are not maintained separately.

## Reporting a vulnerability

Please do not disclose a vulnerability, API key, private endpoint, `config.local.json`, or `api.txt` in a public issue.

Use GitHub's **Security → Report a vulnerability** flow when private vulnerability reporting is enabled. If that option is not available, open a public issue that contains no technical exploit details or credentials and ask the maintainer to arrange a private reporting channel.

Include the affected version, operating system, Node.js version, a minimal reproduction, impact, and any suggested mitigation. Redact provider account IDs, workspace hostnames, request headers, and message content that is not necessary to reproduce the issue.

If a real credential may have been exposed, revoke or rotate it at the provider immediately. Removing a file or adding it to `.gitignore` does not remove a secret from existing Git history.
