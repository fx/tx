import type {
  Plugin,
  PluginDefinition,
  PluginIdentity,
  UpdateItem,
  UpdateParticipation,
  UpdateResult,
} from "@fx/tx/plugin";

interface GatheredItem {
  readonly participation: UpdateParticipation;
  readonly item: UpdateItem;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The contributing plugin's name, so a participant's failure is reported
 * against its owner without the participant naming itself. */
function ownerName(identity: PluginIdentity): string {
  const names: string[] = [];
  let current: PluginIdentity | undefined = identity;
  while (current) {
    names.push(current.name);
    current = current.parent;
  }
  return names.reverse().join("/");
}

function columns(values: readonly (string | undefined)[]): string {
  return values.filter((value) => value !== undefined).join("\t");
}

/** What the item answers about itself: what it would move to, that it has
 * nothing to move to, or that it is unusable and will not be applied. */
function availability(item: UpdateItem): string {
  if (item.failure !== undefined) return `failed: ${item.failure}`;
  if (item.available === undefined) return "up to date";
  return `-> ${item.available}`;
}

function gatherReport(item: UpdateItem): string {
  return columns([item.name, item.current, availability(item), item.detail]);
}

function applyReport(item: UpdateItem, result: UpdateResult): string {
  const outcome = result.applied
    ? `updated${result.version === undefined ? "" : ` to ${result.version}`}`
    : "nothing to apply";
  return columns([item.name, outcome, result.detail]);
}

const identity: PluginIdentity = Object.freeze({ name: "update" });

const updatePlugin: PluginDefinition = Object.freeze({
  identity,
  load(): Plugin {
    return ({ command, context, updaters }) => {
      command((namespace) => {
        namespace
          .description("Update everything tx has installed")
          .argument(
            "[items...]",
            "Names of gathered items to update, instead of all of them",
          )
          .option("--dry-run", "Report what would be updated, applying nothing")
          .action(async (names: string[], flags: { dryRun?: boolean }) => {
            let failed = false;
            const report = (text: string): void => {
              context.stdout.write(`${text}\n`);
            };
            const fail = (text: string): void => {
              failed = true;
              context.stderr.write(`Error: ${text}\n`);
            };

            const gathered: GatheredItem[] = [];
            for (const participation of updaters()) {
              try {
                for (const item of await participation.participant.gather()) {
                  gathered.push({ participation, item });
                }
              } catch (error) {
                fail(
                  `Plugin ${ownerName(participation.identity)} could not report updates: ${errorMessage(error)}`,
                );
              }
            }

            // Every gathered item is reported with what it answered, and an
            // item that reports itself unusable is reported as the failure it
            // is, on the stream failures belong on.
            for (const { item } of gathered) {
              if (item.failure === undefined) report(gatherReport(item));
              else fail(gatherReport(item));
            }

            if (gathered.length === 0 && !failed) {
              report("Nothing installed to update.");
            }

            // Everything is in scope until names narrow it, and the names are
            // matched against that one definition before anything is applied,
            // so a typo is reported rather than silently widening the run.
            const scoped =
              names.length === 0
                ? gathered
                : gathered.filter(({ item }) => names.includes(item.name));
            for (const name of names) {
              if (!scoped.some(({ item }) => item.name === name)) {
                fail(`No update named "${name}".`);
              }
            }

            if (!flags.dryRun) {
              for (const { participation, item } of scoped) {
                // An item with nothing available has nothing to apply, and one
                // that came back unusable is never handed back to its owner.
                if (item.available === undefined) continue;
                if (item.failure !== undefined) continue;
                try {
                  const result = await participation.participant.apply(item);
                  report(applyReport(item, result));
                } catch (error) {
                  fail(columns([item.name, `failed: ${errorMessage(error)}`]));
                }
              }
            }

            if (failed) throw new Error("Update completed with failures");
          });
      });
    };
  },
});

export default updatePlugin;
