# Security Policy

## Supported Versions

Security fixes are normally made on the latest released version. Older versions may be used to confirm impact, but they should not be assumed to receive a backport.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Report Privately

Do not disclose a suspected vulnerability in a public Issue, Discussion, pull request, screenshot, or chat log.

Use GitHub's [private vulnerability reporting](https://github.com/okoklabs/openlabstock/security/advisories/new). The public repository must not be launched until this channel has been enabled and tested by the maintainers.

Include, where possible:

- affected version and deployment model;
- impact and required privileges;
- minimal reproduction steps or request samples;
- whether production data may have been exposed;
- a proposed mitigation, if known.

Do not send a production database, session cookie, password, access token, member list, or other personal data. Use synthetic data and redact identifiers.

## Response Process

The maintainers aim to acknowledge a complete report within five business days, then validate severity, affected versions, remediation, and a coordinated disclosure date. This is a target, not a service-level agreement or bug-bounty promise.

Validated issues are handled in a private GitHub Security Advisory. A public advisory and patched release will be issued when users can reasonably update, unless immediate disclosure is necessary to reduce harm.

## Scope

The scope includes OpenLabStock application code, default configuration, migrations, authentication and authorization, backup and restore, import and export, QR workflows, and official deployment examples.

Vulnerabilities in an upstream dependency should also be reported to that project. Problems limited to a specific operator's credentials, firewall, DNS, reverse proxy, or unsupported customization may be outside the application's scope, but reports that show an unsafe default remain in scope.
