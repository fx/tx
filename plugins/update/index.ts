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

function line(values: readonly (string | undefined)[]): string {
  return `${values.filter((value) => value !== undefined).join("\t")}\n`;
}

function gatherLine(item: UpdateItem): string {
  return line([
    item.name,
    item.current,
    item.available === undefined ? "up to date" : `-> ${item.available}`,
    item.detail,
  ]);
}

function applyLine(item: UpdateItem, result: UpdateResult): string {
  const outcome = result.applied
    ? `updated${result.version === undefined ? "" : ` to ${result.version}`}`
    : "nothing to apply";
  return line([item.name, outcome, result.detail]);
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
            const fail = (message: string): void => {
              failed = true;
              context.stderr.write(`Error: ${message}\n`);
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

            for (const { item } of gathered) {
              if (item.failure)
                fail(`Update "${item.name}" failed: ${item.failure}`);
              else context.stdout.write(gatherLine(item));
            }

            if (gathered.length === 0 && !failed) {
              context.stdout.write("Nothing installed to update.\n");
            }

            // Names are matched before anything is applied, so a typo is
            // reported rather than silently widening or narrowing the run.
            for (const name of names) {
              if (!gathered.some(({ item }) => item.name === name)) {
                fail(`No update named "${name}".`);
              }
            }

            if (!flags.dryRun) {
              for (const { participation, item } of gathered) {
                if (item.failure) continue;
                if (names.length > 0 && !names.includes(item.name)) continue;
                try {
                  const result = await participation.participant.apply(item);
                  context.stdout.write(applyLine(item, result));
                } catch (error) {
                  fail(`Update "${item.name}" failed: ${errorMessage(error)}`);
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
