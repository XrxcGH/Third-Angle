'use strict';

/*
 * The two renderers that turn stored text into HTML.
 *
 * They live here rather than in a script or a route because three callers need
 * them and they must not diverge: the seed, the admin save path, and the page
 * editor all have to produce byte-identical markup, or content changes shape
 * the moment it is edited rather than seeded.
 *
 * Both escape first and add markup back afterwards, so neither can emit a tag
 * that was not deliberately reintroduced here. That is the whole reason for
 * not taking a markdown dependency: a general parser is a general XSS surface,
 * and this site needs six constructs.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/*
 * Every renderer normalises line endings first.
 *
 * The HTML form specification requires a browser to submit textarea content
 * with CRLF line breaks, whatever the user actually typed. A paragraph
 * splitter written as /\n{2,}/ therefore never fires on posted text, because
 * the two newlines are separated by a carriage return. The symptom is not an
 * error: a body saved from the admin silently collapses into one paragraph of
 * line breaks, and it stays that way, because the damaged text is what gets
 * stored back into body_md.
 */
const normaliseNewlines = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');

/**
 * Project summaries, project bodies, log entries, and the /now block.
 *
 * Blank lines separate paragraphs, single newlines become a line break, and
 * nothing else is interpreted. This is what the project form's hint promises,
 * and storing anything richer in body_md means the stored text and the
 * rendered page disagree the first time the record is saved from the admin.
 */
function paragraphs(text) {
  return normaliseNewlines(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Editorial pages: the resume and anything else in the fixed page set.
 *
 * A deliberately small subset: h2 to h4, unordered lists, bold, inline code,
 * links to http(s) or to a site-relative path, and a `label :: value` row,
 * which is what a resume actually is and what a paragraph handles badly.
 */
function richText(md) {
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of normaliseNewlines(md).split('\n')) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }

    const dl = /^(.+?)\s+::\s+(.*)$/.exec(line);
    if (dl) {
      closeList();
      out.push(`<p class="res-row"><span class="res-k">${inline(dl[1])}</span><span class="res-v">${inline(dl[2])}</span></p>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

module.exports = { escapeHtml, normaliseNewlines, paragraphs, richText };
