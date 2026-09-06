import type { Plugin, PluginDefinition } from "@fx/tx/plugin";
import type { Config, ConfigValidator } from "./contract.ts";
import { createConfigStorage, resolveConfigPath } from "./storage.ts";

/**
 * The provider is checked against the contract it publishes rather than
 * against a shape declared here: it is imported type-only from beside this
 * file, so the value registered under the key and the type a consumer imports
 * from that same specifier cannot drift apart.
 */

/** The key the capability is registered under, which is also the specifier its
 * contract is published at — one string rather than two that have to be kept
 * agreeing, and one a package other than this one could not claim. The plugin
 * keeps its own bare identity name: that names the plugin, and a capability
 * provider claiming no command namespace has nothing to collide over. */
const configKey = "@fx/tx/config";

function undefinedKey(key: string): Error {
  return new Error(
    `Config key ${JSON.stringify(key)} must be defined before use`,
  );
}

const definition: PluginDefinition = Object.freeze({
  identity: Object.freeze({ name: "config" }),
  load(): Plugin {
    return ({ env, register }) => {
      const guards = new Map<string, ConfigValidator<unknown>>();
      const storage = createConfigStorage(resolveConfigPath({ env }));

      function guardFor(key: string): ConfigValidator<unknown> {
        const guard = guards.get(key);
        if (!guard) throw undefinedKey(key);
        return guard;
      }

      const config: Config = {
        define(key, isValid) {
          if (guards.has(key)) {
            throw new Error(
              `Config key ${JSON.stringify(key)} is already defined`,
            );
          }
          guards.set(key, isValid);
        },
        async read<T>(key: string): Promise<T | undefined> {
          const guard = guardFor(key);
          const document = await storage.read();
          if (!Object.hasOwn(document, key)) return undefined;
          const value = document[key];
          if (!guard(value)) {
            throw new Error(
              `Persisted value for config key ${JSON.stringify(key)} is invalid`,
            );
          }
          return value as T;
        },
        async write(key, value) {
          const guard = guardFor(key);
          if (!guard(value)) {
            throw new Error(
              `Value for config key ${JSON.stringify(key)} is invalid`,
            );
          }
          const document = await storage.read();
          Object.defineProperty(document, key, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
          await storage.write(document);
        },
      };

      register<Config>(configKey, config);
    };
  },
});

export default definition;
