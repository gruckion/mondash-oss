# Security

Do not post tokens, private work excerpts, OAuth files or database dumps in public issues. For a suspected vulnerability, use GitHub's private vulnerability reporting on this repository when enabled; otherwise contact the maintainer privately through an existing channel. Public reporting configuration is a publication prerequisite, not assumed enabled here.

Mondash is designed for one trusted user on a Mac. The backend has no application login, binds to loopback by default and must only be exposed to a private trusted tailnet for phone access. Settings and action endpoints can write local configuration or start local programs. Cross-site browser writes require an allowed origin and JSON. Treat access to the backend as access to your work and Mac actions.

Keep .env, OAuth files, profiles and caches private. Atomic credential writes use mode 0600 and retain a previous value; protect backups equally. Classification, notification and trace export are opt-in and send data to the services you configure. See docs/data-flows.md. No supported release policy is established until the initial public release.
