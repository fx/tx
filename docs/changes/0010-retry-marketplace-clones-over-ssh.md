# 0010: Retry Marketplace Clones Over SSH

## Summary

Let `tx marketplace add` reach a private repository. An HTTP(S) source is still attempted over HTTP(S) first, exactly as it is today; when that clone fails, the addition derives the SSH source from it and retries the clone once. A user with an SSH key and no HTTPS credential — the ordinary case on a developer machine and in CI — installs a private marketplace without typing a different URL.

**Spec:** [Plugin System](../specs/plugin-system/)
**Status:** draft
**Depends On:** 0008

## Motivation

`tx marketplace add fx/private-plugins` expands to `https://github.com/fx/private-plugins.git` and hands it to `git clone`. For a public repository that is the right default and nothing here changes it. For a private one it fails, and it fails on exactly the machines that can already reach the repository: a developer whose SSH key is loaded in their agent, a CI job with a deploy key, a workstation whose Git is configured for SSH against an internal forge. Those setups authenticate `git@github.com:fx/private-plugins.git` without a prompt. HTTPS is the one transport they are not set up for.

[Change 0002](./0002-add-plugin-marketplaces.md) recorded the assumption behind the current behavior when it chose cloning over a catalog: "Existing Git/SSH access already handles the private-repository use case." That is true of Git and untrue of `tx`, because `tx` never offers Git the SSH source. Shorthand expansion produces HTTPS unconditionally, so the SSH access the user already has is unreachable through the shorthand the manual advertises. This change supersedes that assumption rather than contradicting it: SSH access does handle the case, once the addition actually tries it.

The workaround today is to type the SSH URL. It works, and it is worth stating why it is not enough. It costs the user the shorthand, so `owner/repository` becomes a form that works for public repositories and silently does not for private ones — a distinction the user learns from a clone failure. And it is not a failure the user can act on from the message: `git clone` over HTTPS against a private repository reports a credential problem, not "you have SSH access to this and I did not use it."

The SSH source is derivable from the HTTPS one. The host and the path are both present, and the SSH login of every forge that matters is `git`; only the transport differs. So the fallback needs no new input from the user, no configuration, and no stored credential — it re-spells a source it already has.

One thing has to change for the retry to be reachable at all. `git clone` over HTTPS against a private repository does not fail when no credential is configured; it prompts on the terminal and waits. A blocking prompt means the SSH attempt never runs, and the user is left answering a question about a transport they were not trying to use. Clone attempts therefore run with Git's own terminal prompt disabled, so a missing credential is a fast failure rather than a prompt.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules in [Architecture: Development Conventions](../specs/architecture/index.md#development-conventions). CI enforces these as merge gates:

- Biome formatting and lint checks MUST pass.
- TypeScript checking MUST pass with no errors.
- Bun tests MUST pass with 100% statement, function, and line coverage across production source files.
- Every new observable derivation, retry, staging, environment, and failure-reporting behavior MUST have automated tests.
- Git execution MUST stay injected in tests, as it is today. No test may reach the network, and no test may depend on an SSH key, an SSH agent, or a reachable host.
- Tests MUST create every marketplace root and staging parent inside a temporary directory they own, and MUST remove it afterwards.
- The per-attempt staging requirement MUST have a test that fails against an implementation reusing one staging directory across attempts. A test asserting only that both attempts happened does not cover it.
- The credential-redaction requirement MUST have a test whose injected Git failure quotes the source URL the way Git's own stderr does, asserting the credential appears neither in the reported message nor in the failures attached to it as a cause.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) owns the transport sequence, SSH derivation, non-interactive execution, staging per attempt, and combined failure reporting. Its scenarios are this change's acceptance criteria and are not restated here. [Plugin System: Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) is unaffected: classification decides between a local reference and Git before any transport question arises, and a local source never reaches a clone.

What implementing them requires of this change:

- **Clone attempts stop prompting on the terminal.** This is a deliberate behavior change, and it is what makes the fallback reachable. A private HTTPS clone with no configured credential today blocks on Git's built-in `/dev/tty` prompt; after this change it fails, and the SSH retry runs. Configured credential helpers, `GIT_ASKPASS`, and token-bearing URLs are untouched — only Git's own terminal prompt is suppressed, and only for clone attempts. `marketplace list` and dependency installation keep the environment they have today.
- **The retry covers the clone and nothing else.** Manifest validation, dependency installation, and the duplicate-name check run after a clone succeeds, and a failure in any of them MUST NOT trigger an SSH attempt. Retrying them would re-run a trusted lifecycle script against a second checkout of the same commit.
- **Each attempt needs its own staging directory.** `git clone` refuses a destination that is not empty, and a failed clone can leave a partial one behind. Reusing the first attempt's staging directory would make the SSH attempt fail for a reason unrelated to SSH. Every staging directory the addition creates MUST still be removed on every exit path, so a failed retry leaves marketplace storage exactly as it found it — but a removal the filesystem refuses MUST NOT become the reported failure or cancel the remaining attempt, because that would lose the clone error and the installation while leaving the directory behind anyway.
- **A source's credentials MUST NOT reach the reported failure, anywhere in it.** `https://<token>@github.com/owner/repository.git` is a supported source, and naming the attempted sources in the failure is new behavior, so without redaction this change would newly print a token to standard error. The redaction binds the whole reported failure: the attempted sources it names, the Git output quoted between them — Git repeats the clone URL in its stderr and strips only the password from it — and the underlying failures attached as its cause. The derived SSH source carries no credential to begin with.
- The marketplace plugin owns all of this. No requirement here may add transport, URL, or Git vocabulary to any module under `src/`, and `test/plugin-boundary.test.ts` MUST keep passing unmodified.

## Design

### Approach

Everything lands in `plugins/marketplace/manager.ts`, in the clone path only.

`normalizeMarketplaceRepository` keeps its job unchanged: it expands `owner/repository` shorthand to an HTTPS clone source and passes everything else through. A new derivation reads that normalized source and produces the SSH source for it, or nothing when the source is not HTTP(S). So the transport sequence is decided from one place, after shorthand expansion, and an explicitly typed `https://` URL gets the same treatment as a shorthand that expanded into one.

The clone becomes a bounded loop over one or two candidate sources rather than a single call. Each iteration creates its own staging directory, clones into it, and returns it on success; on failure it records the error, removes the staging directory, and lets the next candidate try. Publication — preparation, the duplicate-name check, and the rename into place — stays outside the loop, so the retry covers the clone and only the clone. Expressing it as a loop rather than as an explicit first-and-second attempt is what makes "a fresh empty staging directory per attempt, removed on every exit path" a single statement instead of two that can drift apart.

Clone attempts run with the manager's own environment plus `GIT_TERMINAL_PROMPT=0`, and the SSH attempt adds a batch-mode `GIT_SSH_COMMAND` to that when — and only when — nothing else has configured an SSH command. Nothing else in the manager changes environment: `marketplace list` and dependency installation keep passing the manager's environment through by reference.

When every attempt fails and there was more than one, the reported error names both attempted sources and inlines both underlying messages, because the CLI surfaces `error.message` and a user looking at a failed private install needs to see that SSH was tried and how it went. Both error objects are preserved as the failure's `cause`, following the existing `cause` use in name derivation.

### Decisions

- **Decision:** Retry on any clone failure, rather than only on a failure that looks like an authentication problem.
  - **Why:** The failure reason is not available to decide on. `runGit` flattens every Git failure into one message and discards the exit code, and Git's authentication stderr is localized and version-dependent, so recognizing "auth failure" means string-matching text that is free to change. A single unconditional retry costs one extra clone attempt in the case where the source is simply wrong, and that attempt fails immediately against a host that does not answer.
  - **Alternatives considered:** Inspecting the exit code or matching stderr was rejected as a brittle test on text the project does not control. Retrying repeatedly, or on transports beyond SSH, was rejected — there is exactly one alternative spelling of an HTTP(S) source, so one retry exhausts the option.

- **Decision:** Derive the SSH source with `URL` parsing, and produce exactly one form: SCP `git@host:path`, taking nothing from the HTTP(S) authority but the host, and decoding percent-escapes in the path.
  - **Why:** `URL` decides what is HTTP(S) without a pattern of the project's own, and it rejects the non-HTTP(S) forms — `ssh://`, SCP `git@host:path`, `file://`, `git://`, bare paths, and a Windows drive letter — as a consequence of parsing rather than as a list to maintain. SCP syntax is what a user's `~/.ssh/config` and a forge's own instructions are written in. The escapes have to be decoded because Git decodes them in an `ssh://` URL but not in SCP syntax, so an undecoded `team/my%20repo.git` would ask the remote for a repository spelled exactly that; a malformed escape derives nothing, since attempting a source known to be wrong is worse than not retrying. Query and fragment are dropped because they are not part of the repository path.
  - **Alternatives considered:** Always emitting `ssh://` was rejected as the less recognizable of the two forms. Rewriting only the scheme, leaving `https://host/path` as `ssh://host/path`, was rejected — it drops the `git` user that every forge requires.

- **Decision:** Use `git` as the SSH user always, and carry neither the source's userinfo nor its port into the derived source. Supersedes an earlier decision on this branch to preserve the userinfo user and to emit `ssh://user@host:port/path` for a source carrying a port; both were wrong.
  - **Why:** A userinfo is an HTTP credential, not an SSH login. `https://<token>@github.com/owner/repository.git` is GitHub's own documented HTTPS form, so preserving the userinfo user transmits a live token to the remote as an SSH login name, where it lands in the server's authentication log and in any bastion's along the way — and it buys nothing, because the SSH login on GitHub, GitLab, Gitea, and Bitbucket Server is `git` whatever the HTTPS user was. An HTTP(S) port is not an SSH port either: `https://git.company.com:8443/team/tools.git` serves SSH on 22, so `ssh://git@git.company.com:8443/…` opens an SSH handshake against the HTTPS listener, which can only hang to a protocol timeout and then report a URL the user never typed. A password was always dropped and still is. With one output form there is no `ssh://` branch left to maintain.
  - **Alternatives considered:** Preserving a non-`git` user for an internal forge was rejected once it became clear the same rule forwards tokens; a user who needs another SSH login or a non-standard SSH port types that SSH source themselves, which costs them the shorthand only in the case where guessing would be unsafe.

- **Decision:** Disable Git's terminal prompt with `GIT_TERMINAL_PROMPT=0` on every clone attempt, and add `GIT_SSH_COMMAND=ssh -o BatchMode=yes` to the SSH attempt alone, and only when no SSH command is configured at all.
  - **Why:** Without the first the fallback is unreachable in its main case: a private HTTPS clone with no credential blocks on a terminal prompt instead of failing, so the SSH attempt never runs. `GIT_TERMINAL_PROMPT=0` suppresses Git's own prompt and nothing else — credential helpers and `GIT_ASKPASS` still resolve credentials normally, which is why neither is touched here, and it has no Git-config equivalent to conflict with. `BatchMode=yes` is the same guarantee for SSH, so an unreachable host or an unknown host key fails rather than asking; it belongs to the SSH attempt only, because the HTTP(S) attempt does not run SSH at all. Both are computed per addition rather than cached, because the manager's environment defaults to the live process environment.
  - **Alternatives considered:** Setting `GIT_ASKPASS` to a no-op was rejected — it would disable a credential helper the user deliberately configured, turning a working HTTPS install into a fallback to SSH. Leaving prompting alone was rejected: it makes the feature not work.

- **Decision:** Treat `GIT_SSH_COMMAND`, `GIT_SSH`, and `core.sshCommand` as one question — is an SSH command configured — and inject nothing when any of them answers yes. Supersedes an earlier decision on this branch that checked `GIT_SSH_COMMAND` alone.
  - **Why:** Git honours `GIT_SSH` as well as `GIT_SSH_COMMAND`, with the latter taking precedence, so injecting `GIT_SSH_COMMAND` bypasses a caller's `GIT_SSH` wrapper. `core.sshCommand` is worse: Git documents it as overridden by the environment variable, and pinning a deploy key with `git config --global core.sshCommand "ssh -i /run/secrets/deploy_key -o IdentitiesOnly=yes"` is the standard CI setup, with no `GIT_SSH_COMMAND` set anywhere. Injecting one there drops the `-i` and the SSH retry dies with `Permission denied (publickey)` — in exactly the deploy-key case this feature exists for. The configuration is read through the injected Git runner, only on the fallback path, and a non-zero exit means the variable is unset. A configured command is an arbitrary shell string rather than an argument vector, so appending an option to it is guessing at its structure; the user who set it owns its behavior, including a key whose passphrase prompt can still block.
  - **Alternatives considered:** Appending the option was rejected as invention. Overriding outright was rejected as breaking the case the retry exists to serve. Checking only the environment was rejected once `core.sshCommand` turned out to be the ordinary way of configuring a deploy key.

- **Decision:** Let a staging removal that fails be ignored, rather than propagate.
  - **Why:** The removal runs in the handler for a failed clone. Propagating an `EACCES` on a partial checkout would replace the clone failure the user needs with a filesystem error, and would abandon the SSH retry that is the whole point of this change — while leaving the directory behind either way, so nothing is gained for what it costs. The removal on the publication path is unchanged.
  - **Alternatives considered:** Reporting both the clone failure and the cleanup failure was rejected as a message about `tx`'s internals in place of one about the user's repository.

- **Decision:** Report both attempts in one error whose `cause` is an `AggregateError` of both failures, rather than reporting only the last one or introducing an error class.
  - **Why:** Reporting only the SSH failure would tell the user their SSH attempt failed and hide that HTTPS was tried first, which is the context that makes the message actionable. The CLI surfaces `error.message`, so both underlying messages are inlined there; `AggregateError` keeps both original errors and their stacks for anything reading `cause`. Name derivation already attaches a `cause` to a wrapped error, so this extends an existing shape rather than adding a type.
  - **Alternatives considered:** A dedicated error class was rejected as surface with no reader. Discarding the HTTPS failure was rejected as losing the more informative of the two messages.

- **Decision:** When only one attempt was possible, rethrow its failure unchanged.
  - **Why:** Every non-HTTP(S) Git source — an `ssh://` URL, SCP syntax, `file://`, a bare path — gets exactly one attempt, and there is no second attempt to combine with. Wrapping a lone failure in a sentence about a retry that never happened would be a false statement about what tx did.
  - **Alternatives considered:** Wrapping uniformly was rejected for that reason.

- **Decision:** Remove the source's credential from the whole combined failure — the attempt names, the Git output quoted inside it, and the failures kept as its cause — by taking the literals from the source and deleting every occurrence of them. Supersedes an earlier decision on this branch that redacted only the two attempt names.
  - **Why:** Redacting the names alone leaves the leak in place. The message inlines each underlying Git message, and Git echoes the clone URL in its stderr with only the password stripped: `fatal: unable to access 'https://<token>@github.com/owner/repository.git/': …`. The CLI writes `error.message` to standard error, so the token reaches the terminal and the CI log through the quoted output rather than through the label. Deriving the literals from the source — the `userinfo@` run as the source spells it, the `user@` run Git echoes after dropping the password, and the user and the password on their own — and deleting them as plain substrings catches every spelling without pattern-matching text the project does not control. Nothing structurally distinguishes a person's account name from a token used as one, so both go. The derived SSH candidate is `git@host:path` and carries no credential at all, which is why nothing redacts it.
  - **Alternatives considered:** Reporting the sources verbatim was rejected as leaking a credential the user handed to a clone, not to a log. Omitting the sources from the message was rejected — naming what was tried is the point of the message. Leaving the cause errors unsanitized was rejected: an error whose own message repeats the token is the same leak one dereference away. An error whose message has to change is replaced rather than edited in place, because its stack repeats its message; an error with nothing to remove is kept exactly as Git's runner threw it.

### Non-Goals

- A `--ssh` or `--no-fallback` flag. The fallback needs no input from the user, and [0008](./0008-link-local-marketplace-sources.md) already rejected an equivalent `--link` flag as more surface for the same outcome.
- Progress or status output while the fallback runs. Telling the user "HTTPS failed, retrying over SSH" requires threading a reporter into `MarketplaceManager`, which has none today. The combined failure already names both attempts once the outcome is known.
- Credential storage, credential helpers, token authentication, and askpass implementations. This change configures none of them and disables none of them.
- Applying the fallback to `marketplace update`, or converting an already-installed clone's remote from HTTPS to SSH. A marketplace installed through the fallback records the SSH remote at add time because that is what it was cloned from; nothing rewrites an existing one.
- Local directory sources. Classification and the reference path are untouched, and a local source never reaches a clone.
- Timeouts on Git operations, per [PR Review](../../REVIEW.md).
- Any change to `src/`. The whole change lives in the marketplace plugin.

## Tasks

- [ ] Specify the SSH retry in [Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership)
  - [ ] State the transport sequence in RFC 2119 terms: an HTTP(S) source attempted over HTTP(S) first, retried exactly once against its derived SSH source on any failure, with the same requested name and target path
  - [ ] State the derivation rules: `git@host:path` in SCP syntax always, with the source's userinfo and port carried into neither, its percent-escaped path decoded, and a path that cannot be decoded deriving nothing
  - [ ] State that a Git source that is not HTTP(S) is attempted exactly once
  - [ ] State that Git's terminal prompt is disabled for every clone attempt, that credential helpers and askpass stay in effect, that the SSH retry runs in batch mode by default, and that an SSH command configured through `GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand` is used as it stands and may still prompt
  - [ ] State that a combined failure names both attempted sources, preserves both underlying messages, and carries no userinfo credential anywhere — not in the names, not in the quoted Git output, not in the attached cause
  - [ ] Extend the staging requirement to bind every staging directory the addition creates, each fresh and empty per attempt and removed on every exit path, with a refused removal masking neither the clone failure nor the remaining attempt
  - [ ] Add scenarios for the SSH fallback, the single attempt for a non-HTTP(S) source, and the credential-free combined failure
  - [ ] Add the change to the spec's references and changelog

- [ ] Implement the fallback in `plugins/marketplace/manager.ts`
  - [ ] Derive `git@host:path` from a normalized HTTP(S) repository, dropping userinfo and port, decoding the path, and returning nothing for every other source form
  - [ ] Disable Git's terminal prompt for clone attempts only, leaving `marketplace list` and dependency installation with the manager's environment by reference
  - [ ] Add a batch-mode SSH command to the SSH attempt alone, and only when neither `GIT_SSH_COMMAND`, nor `GIT_SSH`, nor `core.sshCommand` configures one, reading the last through the injected Git runner
  - [ ] Clone in a bounded loop over the candidate sources, staging each attempt in its own fresh directory and removing it on every exit path without letting a refused removal mask the clone failure or cancel the retry
  - [ ] Keep preparation, the duplicate-name check, and publication outside the retry
  - [ ] Report a combined failure naming both attempts with both underlying messages and an `AggregateError` cause, rethrowing a lone failure unchanged
  - [ ] Remove the source's credential from the whole combined failure, quoted Git output and attached cause included
  - [ ] Confirm nothing under `src/` changes and `test/plugin-boundary.test.ts` passes unmodified

- [ ] Cover the new behavior in `test/marketplaces.test.ts`
  - [ ] Add a derivation table covering the SCP form, a dropped userinfo, a dropped port, a decoded path, a malformed escape, a dropped query, and every source form that derives nothing
  - [ ] Add tests for the retry after a failed HTTPS clone including the listed SSH remote, no retry after a successful clone, and exactly one attempt for each non-HTTP(S) source form with its message unwrapped
  - [ ] Add a test that both failures are reported together with an `AggregateError` cause and no staging left behind
  - [ ] Add a test whose injected Git failure quotes the source URL, asserting the token appears in neither the message nor the attached cause while the derived attempt carries no credential
  - [ ] Add a test that the second attempt stages into a different, empty directory after the first attempt left a partial checkout behind
  - [ ] Add a test that a staging directory a non-root process genuinely cannot remove still leaves the retry to run and the marketplace installed
  - [ ] Add tests that a configured `GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand` suppresses the batch-mode default, that nothing configured produces it on the SSH attempt only, and that the configuration is not probed when the HTTPS clone succeeds
  - [ ] Relax the environment test so a clone call is asserted by content and the `config --get` call keeps its reference-identity assertion

- [ ] Document the fallback in `docs/manual/plugins.md`, in the pull request that implements it
- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should the fallback report its attempts as they happen rather than only in the combined failure? It needs a reporter in `MarketplaceManager` first, which no other behavior there wants yet.
- [ ] Should `marketplace add` offer to convert an installed clone's remote, or apply the fallback when a marketplace is updated? Neither has a command to hang off today.
- [ ] Should a source that already fails HTTPS authentication be remembered, so a later addition against the same host starts with SSH? Not worth a persisted preference for a retry that costs one failed connection.
- [ ] Should the marketplace plugin's ad-hoc Git-source parsers be unified behind one `parseGitSource`? `carriesGitSyntax` and `deriveMarketplaceName` predate this change and the SSH derivation joins them, each reading the same source with its own rules. It is a refactor of existing architecture rather than a defect this change introduced, so it is recorded rather than done here.

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Related changes: [0002-add-plugin-marketplaces](./0002-add-plugin-marketplaces.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Git URL syntax](https://git-scm.com/docs/git-clone#_git_urls), [Git environment variables](https://git-scm.com/docs/git#Documentation/git.txt-codeGITTERMINALPROMPTcode), [`ssh_config` BatchMode](https://man.openbsd.org/ssh_config#BatchMode)
