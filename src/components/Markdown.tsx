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

/* The notes editor's highlighter and underline buttons write ==highlight== and ++underline++.
   The delimiters must hug the text ("a == b" and "C++ is" are left alone), and code/math nodes are never touched. */
type MNode = { type: string; value?: string; children?: MNode[]; data?: Record<string, unknown> };
const MARKS = /(==|\+\+)(?=\S)(.+?)(?<=\S)\1/g;
const SKIP = new Set(["code", "inlineCode", "math", "inlineMath", "html"]);

function markText(value: string): MNode[] | null {
  const out: MNode[] = [];
  let last = 0;
  for (const m of value.matchAll(MARKS)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", value: value.slice(last, i) });
    out.push({ type: m[1] === "==" ? "highlight" : "underline", data: { hName: m[1] === "==" ? "mark" : "u" }, children: [{ type: "text", value: m[2] }] });
    last = i + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walkMarks(node: MNode) {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MNode[] = [];
  for (const ch of node.children) {
    const parts = ch.type === "text" && ch.value ? markText(ch.value) : null;
    if (parts) next.push(...parts);
    else (walkMarks(ch), next.push(ch));
  }
  node.children = next;
}
const remarkMarks = () => (tree: MNode) => walkMarks(tree);

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkMarks]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
