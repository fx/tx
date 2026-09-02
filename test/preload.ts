/**
 * Forces the renderer's styling on before any production module loads.
 *
 * Ink styles through a library that decides once, at load time, whether the
 * standard output it sees is a terminal capable of color. A test run is piped,
 * so that decision is "no sequences at all" and every assertion about the
 * inverted cursor bar or the dimmed chrome would pass vacuously against
 * unstyled output. Setting the variable inside a test file is too late: import
 * declarations are hoisted above every statement in the file, so the styling
 * level is already fixed by the time the assignment runs. A Bun test preload
 * runs before the modules under test are imported, which is the only place the
 * variable still has an effect.
 */
Object.assign(process.env, { FORCE_COLOR: "1" });
