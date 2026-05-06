// Minimal markdown → HTML converter for newsletter bodies.
// Subset supported: paragraphs, # ## ### headings, **bold**, *italic*,
// [text](url), `code`, --- horizontal rule, "- " / "* " bulleted lists.
// All HTML in the input is escaped first, so admins can't inject script
// tags via the markdown body. Link URLs are restricted to http/https/mailto.

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]!);
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"'`]+$/i;

function safeHref(url: string): string {
  return SAFE_URL.test(url) ? url : "#";
}

// Inline transforms operate on already-HTML-escaped text. Order matters:
// links first (they contain brackets), then bold (** before *), italic,
// and inline code last so we don't interfere with other syntax.
function applyInline(text: string): string {
  let out = text;
  out = out.replace(
    /\[([^\]]+?)\]\(([^)\s]+)\)/g,
    (_, label: string, url: string) =>
      `<a href="${escapeHtml(safeHref(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  out = out.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
  out = out.replace(/`([^`]+?)`/g, "<code>$1</code>");
  return out;
}

export function renderMarkdown(input: string): string {
  const lines = escapeHtml(input).split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];
  let inList = false;

  const flushParagraph = () => {
    if (buf.length === 0) return;
    out.push(`<p>${applyInline(buf.join(" "))}</p>`);
    buf = [];
  };

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (line === "") {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length + 1; // # → h2, ## → h3, ### → h4
      out.push(`<h${level}>${applyInline(heading[2]!)}</h${level}>`);
      continue;
    }

    if (line === "---" || line === "***") {
      flushParagraph();
      closeList();
      out.push("<hr />");
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${applyInline(bullet[1]!)}</li>`);
      continue;
    }

    closeList();
    buf.push(line);
  }

  flushParagraph();
  closeList();
  return out.join("\n");
}
