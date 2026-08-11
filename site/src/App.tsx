import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Separator,
} from "@fx/ui";
import {
  ArrowUpCircle,
  Blocks,
  Github,
  Package,
  ShieldCheck,
} from "lucide-react";
import { CommandBlock } from "./components/CommandBlock";
import { ThemeToggle } from "./components/ThemeToggle";

const REPOSITORY = "https://github.com/fx/tx";

const FEATURES = [
  {
    icon: Package,
    title: "One executable",
    body: "A standalone binary with no Bun or Node.js runtime to install alongside it. Drop it on PATH and it works.",
  },
  {
    icon: Blocks,
    title: "Plugins, not forks",
    body: "Install a trusted Git marketplace and every plugin in it gets its own namespace under tx. Extend the toolbox without touching the core.",
  },
  {
    icon: ArrowUpCircle,
    title: "Updates on request",
    body: "tx update moves the executable and every installed marketplace forward. Nothing ever phones home on its own.",
  },
  {
    icon: ShieldCheck,
    title: "Verified replacement",
    body: "Downloads are checked against a published SHA256SUMS digest, run once to confirm their version, then moved into place atomically.",
  },
];

export function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-6">
          <span className="text-lg font-semibold tracking-tight">
            <span className="text-muted-foreground">$ </span>tx
          </span>
          <Badge variant="outline" className="hidden sm:inline-flex">
            MIT
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="GitHub repository"
              nativeButton={false}
              render={<a href={REPOSITORY} />}
            >
              <Github className="size-4" />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6">
        <section className="py-20 sm:py-28">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            Extensible command-line toolbox.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            <span className="text-foreground">tx</span> is a single executable
            that hosts your commands as plugins. Add a Git marketplace, get its
            commands. Run one update, move everything forward — including tx
            itself.
          </p>

          <div className="mt-10 max-w-xl">
            <CommandBlock
              commands={["mise use -g github:fx/tx", "tx --version"]}
              label="Install"
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              nativeButton={false}
              render={<a href={`${REPOSITORY}#readme`} />}
            >
              Read the docs
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <a href={`${REPOSITORY}/blob/main/docs/manual/plugins.md`} />
              }
            >
              Write a plugin
            </Button>
          </div>
        </section>

        <Separator />

        <section className="grid gap-px bg-border py-px sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="rounded-none border-0 bg-background">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="size-4 text-muted-foreground" />
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed text-muted-foreground">
                {body}
              </CardContent>
            </Card>
          ))}
        </section>

        <Separator />

        <section className="grid gap-10 py-20 sm:grid-cols-2">
          {/* min-w-0: a grid item's default min-width is its content, so the
              command blocks would otherwise widen the page instead of scrolling. */}
          <div className="min-w-0">
            <h2 className="text-sm uppercase tracking-widest text-muted-foreground">
              Marketplaces
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Point tx at a repository and its plugins become namespaced
              commands. Marketplace code is not sandboxed — install only what
              you trust.
            </p>
            <div className="mt-5">
              <CommandBlock
                commands={[
                  "tx marketplace add owner/repository",
                  "tx marketplace list",
                  "tx marketplace remove repository",
                ]}
              />
            </div>
          </div>

          <div className="min-w-0">
            <h2 className="text-sm uppercase tracking-widest text-muted-foreground">
              Updating
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              One command updates everything tx installed. Use the dry run to
              see the same report without changing anything on disk.
            </p>
            <div className="mt-5">
              <CommandBlock commands={["tx update", "tx update --dry-run"]} />
            </div>
          </div>
        </section>

        <Separator />

        <section className="py-20">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">
            Authoring a plugin
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The public contract is types only, so a plugin never links against
            tx's internals.
          </p>
          <div className="mt-5 max-w-xl border border-border bg-card">
            <pre className="overflow-x-auto px-4 py-3 text-sm leading-7">
              <code>{`import type { Plugin } from "@fx/tx/plugin";`}</code>
            </pre>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm text-muted-foreground">
          <span>MIT licensed</span>
          <a className="hover:text-foreground" href={REPOSITORY}>
            GitHub
          </a>
          <a className="hover:text-foreground" href={`${REPOSITORY}/releases`}>
            Releases
          </a>
          <a className="hover:text-foreground" href={`${REPOSITORY}/issues`}>
            Issues
          </a>
        </div>
      </footer>
    </div>
  );
}
