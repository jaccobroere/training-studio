import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Model text is untrusted: react-markdown never renders raw HTML, links open safely, and
 * citation markers like [2] become chips that jump to the message's source list. */
export function Markdown({ text, cites }: { text: string; cites?: Set<number> }) {
  // "[3]" and grouped "[2, 4]" both become one chip per known source.
  const src = cites?.size ? text.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (m, list: string) => {
    const ns = list.split(",").map((x) => Number(x.trim()));
    return ns.every((n) => cites.has(n)) ? ns.map((n) => `[${n}](#cite-${n})`).join("") : m;
  }) : text;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => href?.startsWith("#cite-")
        ? <a href={href} className="cite mono" aria-label={`Source ${children}`}>{children}</a>
        : <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
    }}>{src}</ReactMarkdown>
  );
}
