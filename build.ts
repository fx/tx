export {};

const inkDevExpression = "process.env['DEV']";

const build = await Bun.build({
  entrypoints: ["cli.ts"],
  compile: { outfile: "dist/tx" },
  minify: true,
  plugins: [
    {
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
    },
  ],
});

if (!build.success) throw new AggregateError(build.logs, "Build failed");
