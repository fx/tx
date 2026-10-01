export {};

const inkDevExpression = "process.env['DEV']";

/** Every standalone executable a release publishes, built on every run so the
 * test suite sees exactly what a release ships. Bun publishes no baseline
 * variant for arm64. */
const executables = [
  { outfile: "dist/tx", target: "bun-linux-x64-baseline" },
  { outfile: "dist/tx-linux-arm64", target: "bun-linux-arm64" },
] as const satisfies readonly {
  readonly outfile: string;
  readonly target: Bun.Build.CompileTarget;
}[];

const disableInkDevelopmentMode: Bun.BunPlugin = {
  name: "disable-ink-development-mode",
  setup(builder) {
    builder.onLoad(
      { filter: /[/\\]ink[/\\]build[/\\]reconciler\.js$/ },
      async ({ path }) => {
        const source = await Bun.file(path).text();
        const contents = source.replaceAll(inkDevExpression, '""');
        if (contents === source) {
          throw new Error("Ink DEV expression was not found during build");
        }
        return { contents, loader: "js" };
      },
    );
  },
};

for (const compile of executables) {
  const build = await Bun.build({
    entrypoints: ["cli.ts"],
    compile,
    minify: true,
    plugins: [disableInkDevelopmentMode],
  });

  if (!build.success) {
    throw new AggregateError(build.logs, `Build failed for ${compile.target}`);
  }
}
