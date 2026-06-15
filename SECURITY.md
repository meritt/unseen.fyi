# Security Policy

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/meritt/unseen.fyi/security/advisories/new). Do not open public issues or pull requests for security matters. Allow a few days for an initial response; disclosure is coordinated once a fix ships.

## Supported versions

Only the current `main`, deployed to [unseen.fyi](https://unseen.fyi). There are no tagged releases.

## Scope

In scope:

- E2EE protocol and SAS verification (`shared/`)
- Cryptographic implementation, key handling, counter and nonce management (`client/`, `shared/`)
- Wire codec and frame handling (`shared/`, `server/`)
- Relay logic: room registry, rate limiting, frame forwarding (`server/`)

Out of scope:

- Metadata observable by the relay operator by design (frame timing, sizes, connection lifetime). The relay is untrusted and forwards ciphertext byte-for-byte.
- Denial of service against the public relay.
- Attacks requiring a compromised endpoint (browser, extension, or operating system).
- Dependency findings without demonstrated impact on Unseen.
