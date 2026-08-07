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

The SSH source is derivable from the HTTPS one. Host, path, and userinfo are all present; only the transport differs. So the fallback needs no new input from the user, no configuration, and no stored credential — it re-spells a source it already has.

One thing has to change for the retry to be reachable at all. `git clone` over HTTPS against a private repository does not fail when no credential is configured; it prompts on the terminal and waits. A blocking prompt means the SSH attempt never runs, and the user is left answering a question about a transport they were not trying to use. Clone attempts therefore run Git non-interactively, so a missing credential is a fast failure rather than a prompt.

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
- The credential-redaction requirement MUST have a test asserting the reported failure does not contain the source's userinfo credential while the derived SSH attempt still carries its user.
- Committed tests MUST NOT contain unjustified focused or skipped cases.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Functional Requirements

[Plugin System: Marketplace Plugin Ownership](../specs/plugin-system/index.md#marketplace-plugin-ownership) owns the transport sequence, SSH derivation, non-interactive execution, staging per attempt, and combined failure reporting. Its scenarios are this change's acceptance criteria and are not restated here. [Plugin System: Local Marketplace Sources](../specs/plugin-system/index.md#local-marketplace-sources) is unaffected: classification decides between a local reference and Git before any transport question arises, and a local source never reaches a clone.

What implementing them requires of this change:

- **Clone attempts stop prompting on the terminal.** This is a deliberate behavior change, and it is what makes the fallback reachable. A private HTTPS clone with no configured credential today blocks on Git's built-in `/dev/tty` prompt; after this change it fails, and the SSH retry runs. Configured credential helpers, `GIT_ASKPASS`, and token-bearing URLs are untouched — only Git's own terminal prompt is suppressed, and only for clone attempts. `marketplace list` and dependency installation keep the environment they have today.
- **The retry covers the clone and nothing else.** Manifest validation, dependency installation, and the duplicate-name check run after a clone succeeds, and a failure in any of them MUST NOT trigger an SSH attempt. Retrying them would re-run a trusted lifecycle script against a second checkout of the same commit.
- **Each attempt needs its own staging directory.** `git clone` refuses a destination that is not empty, and a failed clone can leave a partial one behind. Reusing the first attempt's staging directory would make the SSH attempt fail for a reason unrelated to SSH. Every staging directory the addition creates MUST still be removed on every exit path, so a failed retry leaves marketplace storage exactly as it found it.
- **A source's credentials MUST NOT reach the reported failure.** `https://<token>@github.com/owner/repository.git` is a supported source, and naming the attempted sources in the failure is new behavior, so without redaction this change would newly print a token to standard error. Derivation still reads the userinfo user; only the reported text is redacted.
- The marketplace plugin owns all of this. No requirement here may add transport, URL, or Git vocabulary to any module under `src/`, and `test/plugin-boundary.test.ts` MUST keep passing unmodified.

## Design

### Approach

Everything lands in `plugins/marketplace/manager.ts`, in the clone path only.

`normalizeMarketplaceRepository` keeps its job unchanged: it expands `owner/repository` shorthand to an HTTPS clone source and passes everything else through. A new derivation reads that normalized source and produces the SSH source for it, or nothing when the source is not HTTP(S). So the transport sequence is decided from one place, after shorthand expansion, and an explicitly typed `https://` URL gets the same treatment as a shorthand that expanded into one.

The clone becomes a bounded loop over one or two candidate sources rather than a single call. Each iteration creates its own staging directory, clones into it, and returns it on success; on failure it records the error, removes the staging directory, and lets the next candidate try. Publication — preparation, the duplicate-name check, and the rename into place — stays outside the loop, so the retry covers the clone and only the clone. Expressing it as a loop rather than as an explicit first-and-second attempt is what makes "a fresh empty staging directory per attempt, removed on every exit path" a single statement instead of two that can drift apart.

Clone attempts run with two environment variables added to the manager's own environment. Nothing else in the manager changes environment: `marketplace list` and dependency installation keep passing the manager's environment through by reference.

When every attempt fails and there was more than one, the reported error names both attempted sources and inlines both underlying messages, because the CLI surfaces `error.message` and a user looking at a failed private install needs to see that SSH was tried and how it went. Both error objects are preserved as the failure's `cause`, following the existing `cause` use in name derivation.

### Decisions

- **Decision:** Retry on any clone failure, rather than only on a failure that looks like an authentication problem.
  - **Why:** The failure reason is not available to decide on. `runGit` flattens every Git failure into one message and discards the exit code, and Git's authentication stderr is localized and version-dependent, so recognizing "auth failure" means string-matching text that is free to change. A single unconditional retry costs one extra clone attempt in the case where the source is simply wrong, and that attempt fails immediately against a host that does not answer.
  - **Alternatives considered:** Inspecting the exit code or matching stderr was rejected as a brittle test on text the project does not control. Retrying repeatedly, or on transports beyond SSH, was rejected — there is exactly one alternative spelling of an HTTP(S) source, so one retry exhausts the option.

- **Decision:** Derive the SSH source with `URL` parsing, and produce SCP `user@host:path` syntax normally and `ssh://user@host:port/path` when the source carries a port.
  - **Why:** `URL` decides what is HTTP(S) without a pattern of the project's own, and it rejects the non-HTTP(S) forms — `ssh://`, SCP `git@host:path`, `file://`, `git://`, bare paths, and a Windows drive letter — as a consequence of parsing rather than as a list to maintain. SCP syntax is what a user's `~/.ssh/config` and a forge's own instructions are written in, but it has no way to express a port, so a source carrying one has to be spelled as an `ssh://` URL instead. Query and fragment are dropped because they are not part of the repository path.
  - **Alternatives considered:** Always emitting `ssh://` was rejected as the less recognizable of the two forms for the common case. Rewriting only the scheme, leaving `https://host/path` as `ssh://host/path`, was rejected — it drops the `git` user that every forge requires.

- **Decision:** Preserve the source's userinfo user as the SSH user, defaulting to `git`, and always drop the password.
  - **Why:** `https://alice@git.company.com/team/tools.git` names the account the user intends, and an internal forge is where a non-`git` SSH user actually occurs; discarding it would derive a source that authenticates as the wrong user. `git` is the correct default because it is what every hosted forge expects. A password is an HTTPS credential and means nothing over SSH.
  - **Alternatives considered:** Hardcoding `git` was rejected for discarding a user the source explicitly carries. Carrying the password into the SSH source was rejected outright — SSH has nowhere to put it, and it would place a credential in a string this change now reports.

- **Decision:** Run clone attempts non-interactively with `GIT_TERMINAL_PROMPT=0` and, when the environment does not already set one, `GIT_SSH_COMMAND=ssh -o BatchMode=yes`.
  - **Why:** Without it the fallback is unreachable in its main case: a private HTTPS clone with no credential blocks on a terminal prompt instead of failing, so the SSH attempt never runs. `GIT_TERMINAL_PROMPT=0` suppresses Git's own prompt and nothing else — credential helpers and `GIT_ASKPASS` still resolve credentials normally, which is why neither is touched here. `BatchMode=yes` is the same guarantee for the SSH attempt, so an unreachable or unknown host fails rather than asking about a host key. The value applies only to clone attempts and is computed per call, because the manager's environment defaults to the live process environment.
  - **Alternatives considered:** Setting `GIT_ASKPASS` to a no-op was rejected — it would disable a credential helper the user deliberately configured, turning a working HTTPS install into a fallback to SSH. Leaving prompting alone was rejected: it makes the feature not work.

- **Decision:** Leave a caller-supplied `GIT_SSH_COMMAND` exactly as it is, rather than appending `-o BatchMode=yes` to it.
  - **Why:** A `GIT_SSH_COMMAND` already in the environment is a deliberate SSH invocation — an identity file, an alternate config, a proxy command — and it is an arbitrary shell string, not an argument vector. Appending to it is guessing at its structure. The user who set it owns its behavior, including a key whose passphrase prompt can still block.
  - **Alternatives considered:** Appending the option was rejected as invention. Overriding the value outright was rejected as breaking the case it exists to serve.

- **Decision:** Report both attempts in one error whose `cause` is an `AggregateError` of both failures, rather than reporting only the last one or introducing an error class.
  - **Why:** Reporting only the SSH failure would tell the user their SSH attempt failed and hide that HTTPS was tried first, which is the context that makes the message actionable. The CLI surfaces `error.message`, so both underlying messages are inlined there; `AggregateError` keeps both original errors and their stacks for anything reading `cause`. Name derivation already attaches a `cause` to a wrapped error, so this extends an existing shape rather than adding a type.
  - **Alternatives considered:** A dedicated error class was rejected as surface with no reader. Discarding the HTTPS failure was rejected as losing the more informative of the two messages.

- **Decision:** When only one attempt was possible, rethrow its failure unchanged.
  - **Why:** Every non-HTTP(S) Git source — an `ssh://` URL, SCP syntax, `file://`, a bare path — gets exactly one attempt, and there is no second attempt to combine with. Wrapping a lone failure in a sentence about a retry that never happened would be a false statement about what tx did.
  - **Alternatives considered:** Wrapping uniformly was rejected for that reason.

- **Decision:** Strip userinfo from every source named in the reported failure.
  - **Why:** `https://<token>@github.com/owner/repository.git` is a supported source, and naming the attempted sources is exactly what is new here, so without redaction this change would newly write a token to standard error and into whatever captures it. Derivation still reads the userinfo user, so the SSH attempt is unaffected; only the reported text is redacted. A derived SCP-syntax candidate does not parse as a URL, and its user is `git` unless the HTTP(S) source supplied one, so `git@` is kept — it is a fixed default rather than anything the caller handed over — while any other user is removed with the userinfo it came from. Nothing structurally distinguishes a person's account name from a token used as one, so both go.
  - **Alternatives considered:** Reporting the sources verbatim was rejected as leaking a credential the user handed to a clone, not to a log. Omitting the sources from the message was rejected — naming what was tried is the point of the message.

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
  - [ ] State the derivation rules, including the `ssh://` form for a source carrying a port, the preserved userinfo user defaulting to `git`, and the dropped password
  - [ ] State that a Git source that is not HTTP(S) is attempted exactly once
  - [ ] State that clone attempts run Git non-interactively, that credential helpers and askpass stay in effect, and that a caller-supplied SSH command is not overridden
  - [ ] State that a combined failure names both attempted sources, preserves both underlying messages, and omits any userinfo credential
  - [ ] Extend the staging requirement to bind every staging directory the addition creates, each fresh and empty per attempt and removed on every exit path
  - [ ] Add scenarios for the SSH fallback, the single attempt for a non-HTTP(S) source, and the credential-free combined failure
  - [ ] Add the change to the spec's references and changelog

- [ ] Implement the fallback in `plugins/marketplace/manager.ts`
  - [ ] Derive the SSH source from a normalized HTTP(S) repository, returning nothing for every other source form
  - [ ] Apply a non-interactive Git environment to clone attempts only, leaving `marketplace list` and dependency installation with the manager's environment by reference
  - [ ] Clone in a bounded loop over the candidate sources, staging each attempt in its own fresh directory and removing it on every exit path
  - [ ] Keep preparation, the duplicate-name check, and publication outside the retry
  - [ ] Report a combined failure naming both attempts with both underlying messages and an `AggregateError` cause, rethrowing a lone failure unchanged
  - [ ] Strip userinfo from every source named in the reported failure
  - [ ] Confirm nothing under `src/` changes and `test/plugin-boundary.test.ts` passes unmodified

- [ ] Cover the new behavior in `test/marketplaces.test.ts`
  - [ ] Add a derivation table covering the SCP form, the ported `ssh://` form, a preserved userinfo user, a dropped password, a dropped query, and every source form that derives nothing
  - [ ] Add tests for the retry after a failed HTTPS clone including the listed SSH remote, no retry after a successful clone, and exactly one attempt for each non-HTTP(S) source form with its message unwrapped
  - [ ] Add a test that both failures are reported together with an `AggregateError` cause and no staging left behind
  - [ ] Add a test that the reported failure omits a source's token while the derived SSH attempt still carries its user
  - [ ] Add a test that the second attempt stages into a different, empty directory after the first attempt left a partial checkout behind
  - [ ] Add a test that a configured `GIT_SSH_COMMAND` survives while `GIT_TERMINAL_PROMPT` is still set
  - [ ] Relax the environment test so a clone call is asserted by content and the `config --get` call keeps its reference-identity assertion

- [ ] Document the fallback in `docs/manual/plugins.md`, in the pull request that implements it
- [ ] Verify 100% coverage and `bun run check`

## Open Questions

- [ ] Should the fallback report its attempts as they happen rather than only in the combined failure? It needs a reporter in `MarketplaceManager` first, which no other behavior there wants yet.
- [ ] Should `marketplace add` offer to convert an installed clone's remote, or apply the fallback when a marketplace is updated? Neither has a command to hang off today.
- [ ] Should a source that already fails HTTPS authentication be remembered, so a later addition against the same host starts with SSH? Not worth a persisted preference for a retry that costs one failed connection.

## References

- Spec: [Plugin System](../specs/plugin-system/)
- Related changes: [0002-add-plugin-marketplaces](./0002-add-plugin-marketplaces.md), [0008-link-local-marketplace-sources](./0008-link-local-marketplace-sources.md)
- Manual: [Plugins](../manual/plugins.md)
- External: [Git URL syntax](https://git-scm.com/docs/git-clone#_git_urls), [Git environment variables](https://git-scm.com/docs/git#Documentation/git.txt-codeGITTERMINALPROMPTcode), [`ssh_config` BatchMode](https://man.openbsd.org/ssh_config#BatchMode)
