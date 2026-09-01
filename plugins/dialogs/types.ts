import type { CoreDependencies } from "@fx/tx/plugin";

/** The local structural contract the bundled dialogs provider and its bundled
 * consumers share. It deliberately lives beside the provider rather than in
 * `@fx/tx/plugin`: the capability is internal, so core carries no dialog
 * vocabulary and nothing here is a public export. */

export type TextField = {
  readonly type: "text";
  readonly name: string;
  readonly message: string;
  readonly initialValue?: string;
};

export type SelectOption<T> = {
  readonly label: string;
  readonly value: T;
  readonly fields?: readonly TextField[];
};

export type SelectRequest<T> = {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly filter?: boolean | "auto";
};

export type SelectResult<T> = {
  readonly value: T;
  readonly values: Readonly<Record<string, string>>;
};

export type InputRequest = {
  readonly message: string;
  readonly initialValue?: string;
};

export type Dialogs = {
  input(request: InputRequest): Promise<string | undefined>;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T> | undefined>;
};

export type Outcome<T> =
  | { readonly type: "completed"; readonly value: T }
  | { readonly type: "cancelled" };

export type DialogElement = ReturnType<
  CoreDependencies["react"]["createElement"]
>;

export type DialogView = () => DialogElement;
