# Security

This repository is public. The running site is not: it holds an admin account,
uploaded files, and a table of messages people have sent through the contact
form. This document is the line between the two, written so that publishing the
source changes nothing about how hard the site is to attack.

## What is in the repository and what is not

Everything here is code, copy, and configuration **shape**. No credential of any
kind is committed, and none ever has been: the history was searched for
passwords, tokens, keys, and private key blocks before the repository was made
public, and for any commit that ever added `.env`, a database file, or anything
under `data/uploads`.

`.gitignore` covers the four things that would matter:

| Ignored | Why |
|---|---|
| `data/*.db`, `-wal`, `-shm` | The database: the admin's password hash, TOTP secret, sessions, and every contact message. |
| `data/uploads/`, `data/backups/` | Uploaded photographs and PDFs, and the backups of both. |
| `.env` | Every secret the app reads. `.env.example` is the committed copy and holds placeholders only. |
| `data/og/`, `data/cache/`, `data/preview.html`, `*.log` | Generated. Nothing sensitive, but nothing worth committing either. |

Before pushing to a public remote, the check is one command:

```
git log --all --name-only --pretty=format: | sort -u | grep -E '\.db|uploads/|\.env$'
```

Empty output means clean. If it is not empty, rewriting history is the only fix,
and any secret that was ever pushed has to be treated as burned and rotated.

## The admin

- **One account.** No signup, no password reset by email, no OAuth. Four
  credential paths would be four ways in for a site with one operator.
- **scrypt** for the password, with a per-user salt, through `node:crypto`. An
  unknown email costs exactly the same scrypt work as a known one, so the login
  cannot be used to enumerate accounts by timing.
- **TOTP** as an optional second factor, also hand-rolled on `node:crypto`, with
  the drift window and the replay window both bounded.
- **Two tier rate limiting** on the login: per account and per IP, temporary
  rather than permanent. A permanent lockout on a site with one operator is the
  more likely incident. A failed attempt while already locked out does not
  extend the lockout.
- **Sessions** are 256 bits of `randomBytes`, stored server side, and expire.
  The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production, and carries
  the `__Host-` prefix there. Changing the password destroys every other
  session.
- **CSRF** on every mutating admin route, as an HMAC of the session id. The key
  is `SESSION_SECRET`, and **production refuses to boot without one**: the
  development fallback is a fixed string in this public repository, which would
  make every token forgeable.

  The sign in POST is the one exception, and it cannot be otherwise: a token is
  bound to a session and sign in is the request that creates one. It is judged
  by `Origin` and `Sec-Fetch-Site` instead, which a browser sets on every
  cross-site POST and an attacking page cannot alter. See `sameOrigin` in
  `src/middleware.js`.

## What a visitor can reach

- Everything under `/admin` requires a session. The three routes in front of the
  guard are the login form, the login POST, and logout.
- Unpublished projects, unpublished pages, and private documents are excluded in
  SQL rather than hidden in a template, and the search index carries a
  `published` flag that every query filters on.
- Uploaded files are served by a route rather than by static middleware, so
  every response carries `nosniff` and anything that is not a re-encoded image
  is sent as an attachment. Storage keys are 128 random bits.
- **Documents are never served through `/media`.** They have their own two
  routes, which are the ones that check visibility. Two paths to the same bytes
  with the check on only one of them is how a private file leaks.

## Input

- Every query is parameterised. No string interpolation reaches SQL, including
  in the search path, where user input is tokenised to word characters and
  requoted before it goes anywhere near an FTS5 `MATCH` expression.
- The two renderers escape first and reintroduce six constructs afterwards, so
  stored text cannot emit a tag that was not deliberately put back. There is no
  markdown dependency, because a general parser is a general XSS surface.
- The one string rendered unescaped on a public page is the search excerpt, and
  it is escaped at that boundary with the highlight put back afterwards.
- Uploads are checked by magic bytes rather than by extension, re-encoded
  through sharp, capped in pixels and bytes, and SVG is refused outright: it is
  markup that can carry script and no byte signature can detect it.
- Redirect targets are validated against protocol-relative and absolute URLs,
  not just `startsWith('/')`.

## Headers

`default-src 'self'` with no `'unsafe-inline'` on scripts, `frame-ancestors
'none'`, `nosniff`, `strict-origin-when-cross-origin`, a `Permissions-Policy`
that switches off camera, microphone, and geolocation, `Cross-Origin-Opener-Policy:
same-origin`, and HSTS in production only, without `preload`.

The only third party connection the site can make is the LinkedIn badge, which
is off by default and adds exactly one host to `script-src` when it is switched
on.

## Dependencies

Seven, all of them well known, and `npm audit` is clean. The zero-dependency
choices are deliberate: scrypt, TOTP, CSRF, the SMTP client, and the markup
renderer are all built on `node:crypto`, `node:net`, and `node:tls`, because
each of those would otherwise be a supply chain path into a system that holds a
password hash.

## Reporting something

Open an issue with enough detail to reproduce it, or write to the address the
site publishes at `/.well-known/security.txt`. This is a personal portfolio:
there is no bounty and no SLA, but anything real gets fixed and credited.
