import type {
  UpdateItem,
  UpdateParticipant,
  UpdateResult,
} from "@fx/tx/plugin";

import {
  fetchCheckoutRemote,
  type GitExecution,
  isCommitAncestor,
  liveMarketplaceVersion,
  moveCheckout,
  type RunGit,
  readCheckoutCommit,
  readCommitLabel,
  readModifiedTrackedFiles,
  readRemoteDefaultCommit,
  runGit,
  unknownMarketplaceVersion,
} from "./manager.ts";
import {
  containedMarketplacePath,
  discoverInstalledMarketplaces,
  isMarketplaceReference,
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
 */
function unreachableRemote(error: unknown): string {
  return `${errorMessage(error)}. Check that the marketplace's remote is reachable, then retry.`;
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
    const target = await this.#resolveTarget(checkout);
    if (target === current) return { applied: false };

    const blocked = await this.#blockingCondition(
      item.name,
      checkout,
      current,
      target,
    );
    if (blocked !== undefined) throw new Error(blocked);

    // An untracked file occupying a path the target tracks is refused here,
    // by the checkout itself, which names the path and moves nothing.
    await moveCheckout(checkout, target, this.#execution);
    try {
      await this.#prepare(checkout);
    } catch (error) {
      const failure = errorMessage(error);
      try {
        await moveCheckout(checkout, current, this.#execution);
      } catch (restoration) {
        // The failure that started this stays the headline — it is what the
        // user has to act on — and the commit the checkout is stuck on is
        // named, because restoring it is now their job rather than tx's.
        throw new Error(
          `${failure}. Restoring commit ${current} failed too, so the checkout is left on ${target}: ${errorMessage(restoration)}`,
        );
      }
      throw new Error(
        `${failure}. The previous commit was restored; installed dependencies were not.`,
      );
    }
    return {
      applied: true,
      version: await readCommitLabel(checkout, target, this.#execution),
    };
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
        return { name, current: label, failure: unreachableRemote(error) };
      }
      const target = await this.#resolveTarget(checkout);
      if (target === current) return { name, current: label };

      // Reported as detail rather than withheld: a user asking what is
      // available learns both that there is an update and what is in its way,
      // before running the command that would refuse it.
      const blocked = await this.#blockingCondition(
        name,
        checkout,
        current,
        target,
      );
      return {
        name,
        current: label,
        available: await readCommitLabel(checkout, target, this.#execution),
        ...(blocked === undefined ? {} : { detail: blocked }),
      };
    } catch (error) {
      return {
        name,
        current: label,
        failure: unusableMarketplace(name, error),
      };
    }
  }

  /** What the marketplace tracks: the remote's current default branch. */
  async #resolveTarget(checkout: string): Promise<string> {
    return readRemoteDefaultCommit(checkout, this.#execution);
  }

  /** Why this marketplace cannot move, in one line, or nothing. */
  async #blockingCondition(
    name: string,
    checkout: string,
    current: string,
    target: string,
  ): Promise<string | undefined> {
    const modified = await readModifiedTrackedFiles(checkout, this.#execution);
    if (modified.length > 0) {
      return `blocked: modified tracked files (${modified.join(", ")}); resolve them in the checkout`;
    }
    if (!(await isCommitAncestor(checkout, current, target, this.#execution))) {
      return `blocked: the remote no longer contains the installed commit; run "tx marketplace remove ${name}" and add it again`;
    }
    return undefined;
  }
}
