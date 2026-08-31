import type { Plugin, PluginDefinition } from "@fx/tx/plugin";
import { createConfigStorage, resolveConfigPath } from "./storage.ts";

type ConfigValidator<T> = (value: unknown) => value is T;

type Config = {
  define<T>(key: string, isValid: ConfigValidator<T>): void;
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
};

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

      register<Config>("config", config);
    };
  },
});

export default definition;
