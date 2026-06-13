'use client';

/**
 * MermaidDiagram (SAU-269) — renders a single mermaid graph definition as an SVG
 * diagram on the client. Mermaid is a browser-only library (it measures text and
 * lays out the graph against the DOM), so this is a `'use client'` island; the
 * server passes the raw fence text down as a prop.
 *
 * Used by MarkdownDoc to turn ```mermaid code fences into real diagrams. Failures
 * fall back to the raw source in a <pre> so a malformed diagram never blanks the
 * page. Content rendered here is first-party (our own use-case docs), so we run
 * mermaid with securityLevel 'loose' to allow the <br/> line breaks in node labels.
 */
import { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  const dark =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
  });
  initialized = true;
}

export default function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>('');
  const [failed, setFailed] = useState(false);
  // useId() returns a value with ':' which is invalid in a mermaid/SVG id.
  const safeId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    try {
      ensureInitialized();
      mermaid
        .render(safeId, chart)
        .then(({ svg }) => {
          if (!cancelled) setSvg(svg);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } catch {
      setFailed(true);
    }
    return () => {
      cancelled = true;
    };
  }, [chart, safeId]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{chart}</code>
      </pre>
    );
  }

  // Placeholder keeps layout stable until the async render resolves.
  if (!svg) {
    return <div className="mermaid-diagram is-loading" aria-busy="true" />;
  }

  return (
    <div
      className="mermaid-diagram"
      role="img"
      // SVG is produced by mermaid from our own trusted, version-controlled source.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
