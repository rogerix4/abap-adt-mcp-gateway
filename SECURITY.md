# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting flow: the repository's
**Security** tab → *Report a vulnerability*. That opens a private advisory visible only to the
maintainers.

Include what you can: the version (`node dist/bin.js --version`), the tool that was called, the
configuration shape with secrets removed, and what you expected instead.

## Supported versions

This project is developed on `main` and released by tag. Only the latest release and `main`
receive fixes; an older checkout is supported by updating.

## What this software can do, and what that implies

- It runs **locally**, as a child process of your MCP client. Treat `dist/` and
 `adt-mcp.config.jsonc` as code and configuration you trust — whoever can write them can run
 anything the gateway can.
- It talks to SAP **with the credentials you configure**. It cannot exceed that user's
 authorizations, so give it a technical user with the roles the task needs, and keep the
 writable system a development client (`tier: "dev"`).
- It accepts **writes** on systems labelled `dev` only. A missing or misspelled tier counts as
 production. Do not widen the tier to "make it work".
- It keeps an on-disk **lock journal** (object URL and lock handle, no credentials) so a stale
 handle can be released before the next lock. Deleting it is safe: the worst case is a lock that
 has to expire on the SAP side.
- **Credentials are references**, never literals: `keychain:` / `env:` / `file:`. A plain-text
 secret in the config fails startup validation, and `npm run verify:private` refuses to publish
 one.

## Out of scope

- Misconfiguration that widens access (a `prd` system labelled `dev`, a shared privileged user,
 a credential file readable by others).
- Vulnerabilities in SAP, in the MCP client, or in a third-party dependency — report those
 upstream; we will still take a report that shows this project makes it worse.
