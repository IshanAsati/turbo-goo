import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/** LLMs often emit \( \) and \[ \] math delimiters; remark-math wants $ and $$. */
export function normalizeMath(md: string): string {
  return md
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/\\\((.+?)\\\)/g, (_, m) => `$${m.trim()}$`)
    // a line that is only "$$ … $$" is display math; remark-math treats it as inline unless the fences are on their own lines
    .replace(/^[ \t]*\$\$(?!\$)(.+?)\$\$[ \t]*$/gm, (_, m) => `\n$$\n${m.trim()}\n$$\n`);
}

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
