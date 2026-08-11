import { Button } from "@fx/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface CommandBlockProps {
  commands: string[];
  label?: string;
}

export function CommandBlock({ commands, label }: CommandBlockProps) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  async function copy() {
    // navigator.clipboard only exists in a secure context, so a page served
    // over plain HTTP has to fall back to a selection-based copy.
    const text = commands.join("\n");
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else if (!copyViaSelection(text)) {
        // execCommand reports failure by returning false rather than throwing.
        return;
      }
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="group relative border border-border bg-card">
      {label ? (
        <div className="border-b border-border px-4 py-2 text-xs uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
      ) : null}
      <pre className="overflow-x-auto px-4 py-3 pr-14 text-sm leading-7">
        {commands.map((command) => (
          <code key={command} className="block">
            <span className="select-none text-muted-foreground">$ </span>
            {command}
          </code>
        ))}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        onClick={copy}
        className="absolute right-2 top-2 opacity-60 transition-opacity hover:opacity-100"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

function copyViaSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } finally {
    area.remove();
  }
}
