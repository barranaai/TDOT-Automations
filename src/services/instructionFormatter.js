/**
 * instructionFormatter — renders raw client-facing document instructions
 * (authored in schemas or typed into the Template Board) as readable HTML.
 * Shared by the client portal, the upload page, and the staff review page so
 * every surface formats guidance identically.
 *
 * Strategies, in order:
 *  1. Text that already uses bullet characters → one <li> per bullet
 *  2. Multi-line text (newline-separated) → each line becomes a <li>
 *  3. Single line with multiple sentences → split on sentence boundaries
 *  3b. Single sentence listing items with semicolons → split on '; '
 *  4. Single sentence → plain <span> (no bullet list needed)
 *
 * URLs are always rendered as clickable <a> links.
 */

'use strict';

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatInstructions(raw) {
  if (!raw || !raw.trim()) return '';
  const text = raw.trim();

  // Render a text fragment safely, converting bare URLs to clickable links.
  // Before splitting, reassemble URLs that were broken by spaces during PDF import
  // (e.g. "https://example.com/path- segment/file.html" → single URL).
  function renderFrag(str) {
    const repaired = reassembleUrls(str);
    const parts = repaired.split(/(https?:\/\/[^\s)<>"]+)/);
    return parts.map((part, i) => {
      if (i % 2 === 0) return esc(part);
      // Strip trailing punctuation from the URL (period, comma, etc.)
      const clean = part.replace(/[.,;:!?)\]}>]+$/, '');
      const trail = part.slice(clean.length);
      return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a>${esc(trail)}`;
    }).join('');
  }

  /**
   * Reassemble URLs that were split by spaces during PDF line-wrap import.
   *
   * Iterates through the string, finds URLs, then greedily absorbs subsequent
   * space-separated fragments that look like URL path continuations rather than
   * normal English words.
   */
  function reassembleUrls(str) {
    if (!str || !/https?:\/\//.test(str)) return str;

    const nonUrlWords = new Set([
      'the','a','an','and','or','but','for','to','of','in','on','at','by',
      'is','are','was','were','be','been','have','has','do','does','did',
      'will','would','could','should','may','might','this','that','these',
      'those','it','its','they','them','their','we','us','our','you','your',
      'he','she','him','her','his','if','then','else','when','where','which',
      'who','what','how','not','no','yes','all','each','every','any','some',
      'most','please','provide','include','submit','ensure','must','note',
      'can','also','only','with','from','about','into','more','such','as',
    ]);

    function isUrlContinuation(urlSoFar, frag) {
      if (!frag) return false;
      const lower = frag.replace(/[.,;:!?)]+$/, '').toLowerCase();
      if (nonUrlWords.has(lower)) return false;
      if (/^[A-Z][a-z]/.test(frag) && !frag.includes('/') && !frag.includes('.')) return false;
      if (frag.includes('/')) return true;
      if (/\.(html?|php|aspx?|pdf|xml|json|jsp|do)\b/i.test(frag)) return true;
      if (/[-/]$/.test(urlSoFar)) return true;
      if (/[a-z]$/.test(urlSoFar) && /^[a-z]/.test(frag) && frag.length > 3) return true;
      return false;
    }

    let result = str;
    const urlRe = /https?:\/\/\S+/g;
    let m;

    while ((m = urlRe.exec(result)) !== null) {
      let end = m.index + m[0].length;
      let changed = false;

      while (end < result.length && result[end] === ' ') {
        const rest = result.substring(end + 1);
        const fm = rest.match(/^(\S+)/);
        if (!fm) break;
        const url = result.substring(m.index, end);
        if (isUrlContinuation(url, fm[1])) {
          result = result.substring(0, end) + result.substring(end + 1);
          end += fm[1].length;
          changed = true;
        } else {
          break;
        }
      }

      urlRe.lastIndex = end;
    }

    return result;
  }

  function wrapItems(arr) {
    const clean = arr.map(s => s.trim()).filter(s => s.length > 2);
    if (clean.length === 1) return `<span>${renderFrag(clean[0])}</span>`;
    return `<ul>${clean.map(s => `<li>${renderFrag(s)}</li>`).join('')}</ul>`;
  }

  // ── 1. Already uses bullet characters (•  -  –) ──────────────────────────
  if (/^[•\-–]\s/m.test(text)) {
    const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = [];
    let cur = '';
    for (const line of lines) {
      if (/^[•\-–]\s/.test(line)) {
        if (cur) bullets.push(cur);
        cur = line.replace(/^[•\-–]\s+/, '').trim();
      } else if (cur) {
        cur += ' ' + line;         // continuation of previous bullet
      } else {
        bullets.push(line);        // header-like line before first bullet
      }
    }
    if (cur) bullets.push(cur);
    if (bullets.length > 0) return wrapItems(bullets);
  }

  // ── 2. Multi-line text ────────────────────────────────────────────────────
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Merge continuation lines (no sentence-ending punctuation + starts lowercase)
    const merged = [];
    for (const line of lines) {
      const last = merged[merged.length - 1];
      if (last && !/[.!?:,]$/.test(last) && /^[a-z]/.test(line)) {
        merged[merged.length - 1] = last + ' ' + line;
      } else {
        merged.push(line);
      }
    }
    return wrapItems(merged);
  }

  // ── 3. Single line — split on sentence boundaries ────────────────────────
  const sentences = text
    .split(/(?<=[.!])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
  if (sentences.length > 1) return wrapItems(sentences);

  // ── 3b. One sentence enumerating items with semicolons ("Marriage
  //        certificate; divorce certificates; …") → one <li> per item.
  const semiParts = text.split(/;\s+/).map(s => s.trim()).filter(Boolean);
  if (semiParts.length >= 3) return wrapItems(semiParts.map(s => s.replace(/[.;]$/, '')));

  // ── 4. Single sentence ────────────────────────────────────────────────────
  return `<span>${renderFrag(text)}</span>`;
}

module.exports = { formatInstructions };
