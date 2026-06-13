'use client';

/**
 * MarkdownDoc (SAU-269) — the shared Markdown renderer for content pages, an
 * upgrade of DocsShell's DocBody that also turns ```mermaid code fences into real
 * diagrams (via MermaidDiagram). It is the reusable "diagrams for free" seam: any
 * page that renders authored Markdown through MarkdownDoc gets mermaid support, so
 * future use-case pages need only add a fence to their body.
 *
 * GFM (tables, task lists, etc.) stays enabled to match the docs renderer. We
 * intercept at the <pre> level — react-markdown v9 wraps a fenced block as
 * <pre><code class="language-x">…</code></pre> — so a mermaid fence becomes a
 * <MermaidDiagram> with no invalid <div> nested inside <pre>, while ordinary code
 * blocks keep their <pre><code> styling untouched.
 */
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidDiagram from './MermaidDiagram';

/** Pull the source out of a fenced ```mermaid block (its <code> child), else null. */
function mermaidSourceFrom(children: ReactNode): string | null {
  const child = children as ReactElement<{ className?: string; children?: unknown }> | undefined;
  const className = child?.props?.className;
  if (typeof className === 'string' && className.includes('language-mermaid')) {
    return String(child?.props?.children ?? '').replace(/\n$/, '');
  }
  return null;
}

export default function MarkdownDoc({ markdown }: { markdown: string }) {
  return (
    <div className="brief">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Intercept fenced blocks at the <pre> level: a mermaid fence becomes a
          // rendered diagram; everything else keeps the normal <pre><code> markup.
          pre({ children }) {
            const chart = mermaidSourceFrom(children);
            if (chart) return <MermaidDiagram chart={chart} />;
            return <pre>{children}</pre>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
