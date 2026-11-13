import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem"; // adds \ce{H2O}, \ce{2H2 + O2 -> 2H2O} and \pu{...} to KaTeX

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

/* ---------------- chemical formulas ----------------
   The prompts ask for $\ce{H2O}$, but models (and pasted notes) often write plain "H2O", "CO2", "Ca2+" or
   "2H2 + O2 -> 2H2O". Tokens that are made only of real element symbols, and that are clearly formulas, are
   typeset with mhchem. The rules are deliberately strict so ordinary words and codes ("NO", "A4", "CS") are left alone. */
const ELEMENTS = new Set(
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr".split(" "),
);
const MOLECULES = new Set(["H2", "N2", "O2", "F2", "Cl2", "Br2", "I2", "O3", "P4", "S8"]);
const PLAIN_COMPOUNDS = new Set(["HCl", "HBr", "HI", "HF", "NaCl", "NaOH", "KOH", "KCl", "KBr", "KI", "NaBr", "NaI", "NaF", "LiCl", "CaO", "MgO", "CuO", "ZnO", "FeO", "AgCl", "AgBr", "AgI", "CuS", "ZnS", "FeS", "PbS"]);
const FORMULA = /(?<![A-Za-z0-9_\\$])(\d{0,2})((?:(?:[A-Z][a-z]?\d*)|(?:\((?:[A-Z][a-z]?\d*)+\)\d*))+)(\^?\d?[+-](?![A-Za-z0-9+-]))?(\((?:aq|s|l|g)\))?(?![A-Za-z0-9_])/g;
const CONNECTOR = /^\s*(\+|->|→|⟶|<->|⇌|<=>)\s*$/;

function isFormula(coef: string, body: string, charge?: string): boolean {
  const symbols = body.match(/[A-Z][a-z]?/g) ?? [];
  if (!symbols.length || !symbols.every((s) => ELEMENTS.has(s))) return false;
  if (charge) return true; // Na+, Cl-, Ca2+ ...
  if (symbols.length === 1 && !body.includes("(")) return MOLECULES.has(body);
  if (!/\d/.test(body)) return PLAIN_COMPOUNDS.has(body) && !coef;
  return true;
}

function chemText(value: string): MNode[] | null {
  type Hit = { start: number; end: number; ce: string; weak: boolean };
  const hits: Hit[] = [];
  for (const m of value.matchAll(FORMULA)) {
    const [whole, coef, body, charge = "", state = ""] = m;
    const symbols = body.match(/[A-Z][a-z]?/g) ?? [];
    if (!symbols.length || !symbols.every((s) => ELEMENTS.has(s))) continue;
    const start = m.index ?? 0;
    let ce: string;
    if (charge && symbols.length === 1 && /^[A-Z][a-z]?\d+$/.test(body)) {
      // "Ca2+" and "Fe3+" are ions: the digits are the charge, not a subscript
      ce = `${coef}${symbols[0]}^${body.slice(symbols[0].length)}${charge.replace("^", "")}${state}`;
    } else if (isFormula(coef, body, charge)) ce = coef + body + charge + state;
    else if (!charge && /^[A-Z][a-z]$/.test(body)) {
      // a bare metal or element ("Zn") only counts when it sits in an equation next to a real formula
      hits.push({ start, end: start + whole.length, ce: coef + body + state, weak: true });
      continue;
    } else continue;
    hits.push({ start, end: start + whole.length, ce, weak: false });
  }
  if (!hits.length) return null;
  // join "Zn + H2SO4 -> ZnSO4 + H2" into one equation; a chain needs at least one real formula in it
  const chains: Hit[] = [];
  let chain: Hit | null = null;
  let strong = false;
  const close = () => {
    if (chain && strong) chains.push(chain);
    chain = null;
    strong = false;
  };
  for (const h of hits) {
    const gap: string = chain ? value.slice((chain as Hit).end, h.start) : "";
    if (chain && CONNECTOR.test(gap)) {
      const op = gap.trim();
      (chain as Hit).ce += ` ${op === "→" || op === "⟶" ? "->" : op === "⇌" ? "<=>" : op} ${h.ce}`;
      (chain as Hit).end = h.end;
    } else {
      close();
      chain = { ...h };
    }
    if (!h.weak) strong = true;
  }
  close();
  if (!chains.length) return null;
  const out: MNode[] = [];
  let last = 0;
  for (const h of chains) {
    if (h.start > last) out.push({ type: "text", value: value.slice(last, h.start) });
    const v = `\\ce{${h.ce}}`;
    out.push({ type: "inlineMath", value: v, data: { hName: "code", hProperties: { className: ["language-math", "math-inline"] }, hChildren: [{ type: "text", value: v }] } });
    last = h.end;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
function walkChem(node: MNode) {
  if (!node.children || SKIP.has(node.type) || node.type === "link" || node.type === "linkReference") return;
  const next: MNode[] = [];
  for (const ch of node.children) {
    const parts = ch.type === "text" && ch.value ? chemText(ch.value) : null;
    if (parts) next.push(...parts);
    else (walkChem(ch), next.push(ch));
  }
  node.children = next;
}
const remarkChem = () => (tree: MNode) => walkChem(tree);
export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkMarks, remarkChem]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
