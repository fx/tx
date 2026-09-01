import type {
  UpdateItem,
  UpdateParticipant,
  UpdateResult,
} from "@fx/tx/plugin";

import {
  addMarketplaceSparseDirectories,
  credentialRedactions,
  disableMarketplaceSparseCheckout,
  fetchCheckoutRemote,
  type GitExecution,
  isCommitAncestor,
  isCommitPublished,
  liveMarketplaceVersion,
  MarketplaceRefNotPublishedError,
  type MarketplaceSparseCheckoutState,
  moveCheckout,
  planMarketplaceManifestAtRevision,
  type ResolvedRef,
  type RunGit,
  readCheckoutCommit,
  readCommitLabel,
  readHigherReleaseTag,
  readMarketplacePin,
  readMarketplaceSparseCheckoutState,
  readModifiedTrackedFiles,
  readRemoteDefaultCommit,
  readRemoteSource,
  readSparseTargetCollisions,
  resolveMarketplaceRef,
  restoreCheckout,
  restoreMarketplaceSparseCheckoutState,
  revisionRepositoryPathsPresent,
  runGit,
  unknownMarketplaceVersion,
  withoutCredentials,
} from "./manager.ts";
import {
  containedMarketplacePath,
  discoverInstalledMarketplaces,
  isMarketplaceReference,
  MarketplaceManifestContentError,
  type MarketplaceManifestPlan,
  MarketplaceManifestRepositoryPathError,
  prepareMarketplace,
} from "./storage.ts";

export interface MarketplaceUpdaterOptions {
  readonly runGit?: RunGit;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly prepare?: (checkout: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A checkout tx cannot read is still a marketplace the user has installed, so
 * it is reported as one failed item carrying the remedy rather than taken out
 * of the report or allowed to fail the participant. */
function unusableMarketplace(name: string, error: unknown): string {
  return `${errorMessage(error)}. Run "tx marketplace remove ${name}" to remove it.`;
}

/**
 * A remote tx could not reach is reported as itself, and deliberately without
 * the removal remedy: an offline run, an expired credential, and a repository
 * that moved are all failures of the fetch rather than of the installation,
 * and advising a user to delete a working marketplace over one would be
 * advising them to lose it.
 *
 * What is taken out of it is the credential the recorded remote may carry.
 * Git quotes the URL it was working with when a fetch fails, and a marketplace
 * installed from a source with an embedded token has that token in the URL, so
 * reporting Git's message unaltered would print it to the terminal and into
 * whatever collects that output. The source is passed in rather than read here
 * so a checkout that cannot even name its remote still reports the failure
 * that matters.
 */
function unreachableRemote(error: unknown, source: string): string {
  const message = withoutCredentials(
    errorMessage(error),
    credentialRedactions(source),
  );
  return `${message}. Check that the marketplace's remote is reachable, then retry.`;
}

/**
 * A pin whose ref the remote no longer publishes — a deleted tag, a merged
 * branch. The remedy is the pin, not the installation: the marketplace itself
 * is intact and the user chose the ref, so they are pointed at the two
 * commands that change that choice rather than at removing what they pinned.
 */
function unresolvablePin(name: string, error: unknown): string {
  return `${errorMessage(error)}. Run "tx marketplace pin ${name} <ref>" or "tx marketplace unpin ${name}".`;
}

/** A genuinely unpublished pin, kept distinct from operational Git failures. */
class UnresolvableMarketplacePinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvableMarketplacePinError";
  }
}

/** The one line of detail an item may carry, joined from whatever the pin and
 * the blocking check had to say, or nothing when neither had anything. */
function reportedDetail(...parts: readonly (string | undefined)[]): {
  detail?: string;
} {
  const line = parts.filter(Boolean).join("; ");
  return line === "" ? {} : { detail: line };
}

/**
 * Every installed marketplace as one update item. Storage is enumerated
 * directly, exactly as `marketplace list` enumerates it, because the
 * marketplace most in need of an update is the one whose current commit does
 * not load — its plugin definitions fail, so a participant hanging off them
 * would be unavailable precisely when it is needed.
 */
export class MarketplaceUpdater implements UpdateParticipant {
  readonly #root: string;
  readonly #execution: GitExecution;
  readonly #prepare: (checkout: string) => Promise<void>;

  constructor(root: string, options: MarketplaceUpdaterOptions = {}) {
    const env = options.env ?? process.env;
    this.#root = root;
    this.#execution = { runGit: options.runGit ?? runGit, env };
    this.#prepare =
      options.prepare ?? ((checkout) => prepareMarketplace(checkout, { env }));
  }

  async gather(): Promise<readonly UpdateItem[]> {
    const marketplaces = await discoverInstalledMarketplaces(this.#root);
    const items: UpdateItem[] = [];
    // One at a time, in the order discovery already sorted: an update runs
    // trusted code and reports to someone reading one thing at a time.
    for (const { name, checkout } of marketplaces) {
      items.push(await this.#gatherMarketplace(name, checkout));
    }
    return items;
  }

  /**
   * Applying re-reads the checkout rather than trusting what gathering saw: a
   * user may have edited it in between, and an item is a report rather than a
   * transaction. What it does not repeat is the fetch — gathering already
   * brought the remote's objects and refs in, and asking again would cost
   * every marketplace a second round trip to learn what tx already knows.
   */
  async apply(item: UpdateItem): Promise<UpdateResult> {
    const checkout = containedMarketplacePath(this.#root, item.name);
    // A reference is the author's own tree: nothing about it is tx's to move.
    if (await isMarketplaceReference(checkout)) {
      return { applied: false, detail: "live reference" };
    }

    const current = await readCheckoutCommit(checkout, this.#execution);
    const pin = await readMarketplacePin(checkout, this.#execution);
    const { commit: target } = await this.#target(item.name, checkout, pin);
    if (target === current) return { applied: false };

    const blocked = await this.#blockingCondition(
      item.name,
      checkout,
      current,
      target,
      pin,
    );
    if (blocked !== undefined) throw new Error(blocked);

    const sparseState = await readMarketplaceSparseCheckoutState(
      checkout,
      this.#execution,
    );
    const targetPlan = sparseState.enabled
      ? await this.#targetManifestPlan(checkout, target)
      : undefined;
    let sparseMutation = false;
    let sparseActive = sparseState.enabled && targetPlan !== undefined;
    let moved = false;
    try {
      if (sparseState.enabled) {
        sparseMutation = true;
        if (targetPlan === undefined) {
          await disableMarketplaceSparseCheckout(checkout, this.#execution);
          sparseActive = false;
        } else {
          try {
            await addMarketplaceSparseDirectories(
              checkout,
              targetPlan,
              this.#execution,
            );
          } catch (mechanism) {
            // Sparse support is an optimization. If extending its cone fails,
            // materialize the same checkout and continue in full.
            try {
              await disableMarketplaceSparseCheckout(checkout, this.#execution);
            } catch (fallback) {
              throw new Error(
                `${errorMessage(mechanism)}. Falling back to the complete tree failed too: ${errorMessage(fallback)}`,
                { cause: new AggregateError([mechanism, fallback]) },
              );
            }
            sparseActive = false;
          }
        }
      }

      if (sparseActive) {
        let collisions: readonly string[];
        try {
          collisions = await readSparseTargetCollisions(
            checkout,
            target,
            this.#execution,
          );
        } catch {
          await disableMarketplaceSparseCheckout(checkout, this.#execution);
          sparseActive = false;
          collisions = [];
        }
        if (collisions.length > 0) {
          throw new Error(
            `The following untracked working tree files would be overwritten by checkout: ${collisions.join(", ")}`,
          );
        }
      }

      // An untracked file occupying a path the target tracks is refused here,
      // by the checkout itself, which names the path and moves nothing.
      await moveCheckout(checkout, target, this.#execution);
      moved = true;

      try {
        await this.#prepare(checkout);
      } catch (error) {
        if (
          sparseActive &&
          error instanceof MarketplaceManifestRepositoryPathError
        ) {
          let retryFull = false;
          try {
            retryFull = await revisionRepositoryPathsPresent(
              checkout,
              target,
              error.paths,
              this.#execution,
            );
          } catch {
            retryFull = true;
          }
          if (retryFull) {
            await disableMarketplaceSparseCheckout(checkout, this.#execution);
            sparseActive = false;
            await this.#prepare(checkout);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      // Version resolution is transactional too: a label failure must not
      // strand the checkout on an update tx cannot report.
      const version = await readCommitLabel(checkout, target, this.#execution);
      return { applied: true, version };
    } catch (error) {
      return await this.#rollbackApply(
        checkout,
        current,
        target,
        error,
        moved,
        sparseMutation ? sparseState : undefined,
      );
    }
  }

  async #targetManifestPlan(
    checkout: string,
    target: string,
  ): Promise<MarketplaceManifestPlan | undefined> {
    try {
      return await planMarketplaceManifestAtRevision(
        checkout,
        target,
        this.#execution,
      );
    } catch (error) {
      if (error instanceof MarketplaceManifestContentError) throw error;
      if (!(error instanceof MarketplaceManifestRepositoryPathError)) {
        return undefined;
      }
      let present: boolean;
      try {
        present = await revisionRepositoryPathsPresent(
          checkout,
          target,
          error.paths,
          this.#execution,
        );
      } catch {
        return undefined;
      }
      if (present) return undefined;
      throw new MarketplaceManifestContentError(error.message, {
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        ...(error.code === undefined ? {} : { code: error.code }),
      });
    }
  }

  /** Restores the old commit first and exact sparse intent second. */
  async #rollbackApply(
    checkout: string,
    current: string,
    target: string,
    primary: unknown,
    moved: boolean,
    sparseState: MarketplaceSparseCheckoutState | undefined,
  ): Promise<never> {
    let commitRestoration: unknown;
    let sparseRestoration: unknown;

    if (moved) {
      try {
        await restoreCheckout(checkout, current, this.#execution);
      } catch (error) {
        commitRestoration = error;
      }
    }
    if (sparseState !== undefined) {
      try {
        await restoreMarketplaceSparseCheckoutState(
          checkout,
          sparseState,
          this.#execution,
        );
      } catch (error) {
        sparseRestoration = error;
      }
    }

    const failure = errorMessage(primary);
    if (!moved) {
      if (sparseRestoration !== undefined) {
        throw new Error(
          `${failure}. Restoring the sparse checkout failed too: ${errorMessage(sparseRestoration)}`,
        );
      }
      throw primary;
    }
    if (commitRestoration !== undefined && sparseRestoration !== undefined) {
      throw new Error(
        `${failure}. Restoring commit ${current} failed too, so the checkout may be left on ${target}: ${errorMessage(commitRestoration)}. Restoring the sparse checkout also failed: ${errorMessage(sparseRestoration)}`,
      );
    }
    if (commitRestoration !== undefined) {
      throw new Error(
        `${failure}. Restoring commit ${current} failed too, so the checkout is left on ${target}: ${errorMessage(commitRestoration)}`,
      );
    }
    if (sparseRestoration !== undefined) {
      throw new Error(
        `${failure}. The previous commit was restored, but restoring the sparse checkout failed: ${errorMessage(sparseRestoration)}. Installed dependencies were not restored.`,
      );
    }
    throw new Error(
      `${failure}. The previous commit was restored; installed dependencies were not.`,
    );
  }

  async #gatherMarketplace(
    name: string,
    checkout: string,
  ): Promise<UpdateItem> {
    // What the checkout holds is known before the remote is asked anything, so
    // a marketplace that fails afterwards still reports the version it is on.
    let label = unknownMarketplaceVersion;
    try {
      // A reference is live: nothing is fetched, moved, or modified, so no Git
      // command runs against it at all.
      if (await isMarketplaceReference(checkout)) {
        return { name, current: liveMarketplaceVersion };
      }

      const current = await readCheckoutCommit(checkout, this.#execution);
      label = await readCommitLabel(checkout, current, this.#execution);
      try {
        await fetchCheckoutRemote(checkout, this.#execution);
      } catch (error) {
        return {
          name,
          current: label,
          failure: unreachableRemote(error, await this.#remoteSource(checkout)),
        };
      }
      // Read again now the fetch has brought the remote's tags in: a publisher
      // who tags the commit already installed, without advancing anything,
      // changes what this commit is called and nothing else. Reading it only
      // before the fetch would report the hash here while `marketplace list`
      // reported the tag, and the two are required to be the same label.
      label = await readCommitLabel(checkout, current, this.#execution);

      const pin = await readMarketplacePin(checkout, this.#execution);
      let target: ResolvedRef;
      try {
        target = await this.#target(name, checkout, pin);
      } catch (error) {
        // A pin the remote stopped publishing is this marketplace's own
        // failure and arrives carrying its remedy; anything else came from a
        // checkout tx cannot read, which the outer handler reports as that.
        if (!(error instanceof UnresolvableMarketplacePinError)) throw error;
        return { name, current: label, failure: errorMessage(error) };
      }
      // The pin is reported whether or not anything moves: a marketplace held
      // at the version its user chose is exactly the one they are managing
      // most deliberately, and a newer release they have not accepted is the
      // answer to the question `tx update` asks.
      const pinned =
        pin === undefined
          ? undefined
          : await this.#pinDetail(checkout, pin, target.tag);
      if (target.commit === current) {
        return { name, current: label, ...reportedDetail(pinned) };
      }

      // Reported as detail rather than withheld: a user asking what is
      // available learns both that there is an update and what is in its way,
      // before running the command that would refuse it.
      const blocked = await this.#blockingCondition(
        name,
        checkout,
        current,
        target.commit,
        pin,
      );
      return {
        name,
        current: label,
        available: await readCommitLabel(
          checkout,
          target.commit,
          this.#execution,
        ),
        ...reportedDetail(pinned, blocked),
      };
    } catch (error) {
      return {
        name,
        current: label,
        failure: unusableMarketplace(name, error),
      };
    }
  }

  /** The recorded remote, or nothing when the checkout cannot name one. */
  async #remoteSource(checkout: string): Promise<string> {
    try {
      return await readRemoteSource(checkout, this.#execution);
    } catch {
      // Nothing to redact against, which is the safe direction: the failure
      // being reported came from a checkout with no readable remote.
      return "";
    }
  }

  /**
   * What the marketplace tracks: the remote's current default branch, or what
   * its pin resolves to now the fetch is in. A pin names a ref rather than a
   * commit, so it is re-resolved on every update — a hash never moves, a
   * branch moves with the branch, and a tag moves if and only if the remote
   * moved it.
   *
   * A pin the remote has stopped publishing fails here, carrying the remedy
   * for a pin, so gathering and applying report the same thing: the ref can
   * disappear between the two, and the answer is the same either way.
   */
  async #target(
    name: string,
    checkout: string,
    pin: string | undefined,
  ): Promise<ResolvedRef> {
    if (pin === undefined) {
      return {
        commit: await readRemoteDefaultCommit(checkout, this.#execution),
        tag: false,
      };
    }
    try {
      return await resolveMarketplaceRef(checkout, pin, this.#execution);
    } catch (error) {
      if (error instanceof MarketplaceRefNotPublishedError) {
        throw new UnresolvableMarketplacePinError(unresolvablePin(name, error));
      }
      throw error;
    }
  }

  /**
   * What a pinned marketplace reports about its pin, and about a release the
   * remote has published above it that nothing here proposes to apply.
   *
   * Only a pin that resolved as a tag is compared. A release above a pin is
   * what a user tracking releases wants to hear about; a branch is not a
   * release, however version-like whoever named it made it look, and there is
   * nothing above a branch to move to.
   */
  async #pinDetail(
    checkout: string,
    pin: string,
    tag: boolean,
  ): Promise<string> {
    const higher = tag
      ? await readHigherReleaseTag(checkout, pin, this.#execution)
      : undefined;
    return higher === undefined
      ? `pinned to ${pin}`
      : `pinned to ${pin}; the remote publishes ${higher}`;
  }

  /** Why this marketplace cannot move, in one line, or nothing. */
  async #blockingCondition(
    name: string,
    checkout: string,
    current: string,
    target: string,
    pin: string | undefined,
  ): Promise<string | undefined> {
    const modified = await readModifiedTrackedFiles(checkout, this.#execution);
    if (modified.length > 0) {
      return `blocked: modified tracked files (${modified.join(", ")}); resolve them in the checkout`;
    }
    // Only an unpinned marketplace is held to moving forward. It says "keep me
    // current", so a target its commit is no part of has to be refused; a pin
    // says "put me at this", and going back to the last good version is the
    // whole point of setting one.
    if (
      pin === undefined &&
      !(await isCommitAncestor(checkout, current, target, this.#execution))
    ) {
      // Which refusal it is depends on whether the remote still has the
      // commit. Gone from the remote entirely is a rewritten upstream, and
      // the checkout has to be replaced. Still published — where unpinning a
      // marketplace pinned to a side branch or an older tag leaves it — is not
      // a broken remote at all, and telling that user to delete a working
      // marketplace would be the wrong remedy for a state they can pin their
      // way out of.
      return (await isCommitPublished(checkout, current, this.#execution))
        ? `blocked: the installed commit is not an ancestor of what this marketplace tracks; pin it with "tx marketplace pin ${name} <ref>", or run "tx marketplace remove ${name}" and add it again`
        : `blocked: the remote no longer contains the installed commit; run "tx marketplace remove ${name}" and add it again`;
    }
    return undefined;
  }
}
