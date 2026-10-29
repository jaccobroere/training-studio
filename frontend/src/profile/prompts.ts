/** The Profile template carries one grey prompt per section as an HTML comment line. A
 * section's prompt goes away as soon as that section has real text. */
const PROMPT = /^\s*<!--.*-->\s*$/;

export const isPrompt = (line: string) => PROMPT.test(line);

/** Drop prompt lines from every section that has any real text. Returns the new text and
 * how many characters were removed before `caret` (so the caret can stay put). */
export function settlePrompts(text: string, caret = 0): { text: string; shift: number } {
  // Typing on a prompt line itself: the comment goes, the typed text stays.
  let pre = 0;
  text = text.replace(/<!--.*?-->/g, (m, off: number) => {
    const lineStart = text.lastIndexOf("\n", off - 1) + 1;
    const lineEnd = text.indexOf("\n", off) === -1 ? text.length : text.indexOf("\n", off);
    const line = text.slice(lineStart, lineEnd);
    if (isPrompt(line)) return m;
    if (off < caret) pre += Math.min(m.length, caret - off);
    return "";
  });
  caret -= pre;
  const lines = text.split("\n");
  const keep: boolean[] = lines.map(() => true);
  let start = 0;
  const flush = (end: number) => {
    const body = lines.slice(start, end);
    const real = body.some((l, i) => !(i === 0 && /^#{1,6}\s/.test(l)) && l.trim() !== "" && !isPrompt(l));
    if (real) for (let i = start; i < end; i++) if (isPrompt(lines[i])) keep[i] = false;
  };
  lines.forEach((l, i) => {
    if (i > 0 && /^#{1,6}\s/.test(l)) { flush(i); start = i; }
  });
  flush(lines.length);
  let shift = 0, pos = 0;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (pos < caret) shift += l.length + 1;
    pos += l.length + 1;
  });
  return { text: out.join("\n"), shift: shift + pre };
}

/** Prompt text without the comment markers, for display. */
export const promptText = (line: string) => line.replace(/^\s*<!--\s*/, "").replace(/\s*-->\s*$/, "");
