/**
 * Uploaded-filename decoding.
 *
 * multipart/form-data carries the filename as raw bytes, and RFC 7578 says to
 * read them as ISO-8859-1 unless the part uses RFC 5987 encoding. Browsers
 * send UTF-8, so busboy/multer hands us the UTF-8 bytes reinterpreted as
 * latin1: an en-dash (U+2013, bytes E2 80 93) arrives as the three characters
 * U+00E2 U+0080 U+0093 - the mojibake staff see in OneDrive file names.
 *
 * decodeUploadFilename() re-reads those bytes as UTF-8, but ONLY when that is
 * provably what happened, so a genuinely latin1 name is never corrupted:
 *   - something outside ASCII is present (pure ASCII needs no repair);
 *   - every character is < U+0100 (the string really is a byte string; a name
 *     that already carries real Unicode is left exactly as it is);
 *   - the re-read is valid UTF-8 (no U+FFFD), so a name typed with a true
 *     latin1 accent keeps its original form.
 * Idempotent: an already-correct name is returned unchanged.
 */
function decodeUploadFilename(name) {
  const s = String(name == null ? '' : name);
  if (!s) return s;
  if (!/[\u0080-\u00FF]/.test(s)) return s;   // plain ASCII - nothing to repair
  if (/[^\u0000-\u00FF]/.test(s)) return s;   // already real Unicode - leave alone
  const decoded = Buffer.from(s, 'latin1').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD')) return s;   // not UTF-8 -> it was genuine latin1
  return decoded;
}

module.exports = { decodeUploadFilename };
