import type { CoreDependencies } from "@fx/tx/plugin";

/** The provider's own rendering vocabulary: what a dialog's view returns, and
 * how one settles. It stays beside the provider rather than moving into
 * `contract.ts` because none of it is a consumer's. `DialogElement` is defined
 * in terms of the injected React, so publishing it would put React's element
 * type in a consumer's build and make an internal rendering decision a
 * breaking change; an outcome is how this module reports a dialog settling to
 * itself, which a caller sees as a resolved value or `undefined` instead. The
 * capability's own types are published at `@fx/tx/dialogs` and declared in
 * `contract.ts`. */

export type Outcome<T> =
  | { readonly type: "completed"; readonly value: T }
  | { readonly type: "cancelled" };

export type DialogElement = ReturnType<
  CoreDependencies["react"]["createElement"]
>;

export type DialogView = () => DialogElement;
