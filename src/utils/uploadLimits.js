'use strict';

/**
 * One place for the client document-upload limits, so the two upload routes
 * (the client portal and the documents page) and their page scripts can never
 * disagree about what is allowed.
 *
 * 50 MB (owner decision 2026-09-29): long scanned PDFs run 20–40 MB. Uploads
 * are buffered in memory on their way to OneDrive, so the size limit comes
 * with a budget on the BYTES in flight at once (by declared Content-Length):
 * many small files pass together, a few very large ones take turns. Past the
 * budget the page is told to retry (it does so by itself) instead of the
 * server running out of memory.
 */
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_IN_FLIGHT_BYTES = 200 * 1024 * 1024;
// A request may take this long to arrive in full (Node's default is 5 minutes —
// too short for 50 MB on a slow phone connection). Applied in server.js.
const UPLOAD_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const TOO_BIG_MESSAGE = `That file is over ${MAX_UPLOAD_MB} MB. Please split it into smaller files, or scan it at a lower quality, and try again.`;
const BUSY_MESSAGE = 'Several uploads are in progress right now. Please try again in a minute.';

let _inFlightBytes = 0;

/** The size a request declares; an absent or absurd header counts as a full-size file. */
function declaredBytes(req) {
  const n = parseInt(req && req.headers && req.headers['content-length'], 10);
  if (!Number.isFinite(n) || n <= 0) return MAX_UPLOAD_BYTES;
  return Math.min(n, MAX_UPLOAD_BYTES + 1024 * 1024);   // multer refuses anything larger anyway
}

/**
 * Express middleware: keeps the bytes buffered at once under MAX_IN_FLIGHT_BYTES.
 * Runs BEFORE multer. A lone upload is always admitted, whatever it declares.
 */
function uploadSlot(req, res, next) {
  const size = declaredBytes(req);
  if (_inFlightBytes > 0 && _inFlightBytes + size > MAX_IN_FLIGHT_BYTES) {
    return res.status(503).json({ success: false, error: BUSY_MESSAGE, retriable: true });
  }
  _inFlightBytes += size;
  let released = false;
  const release = () => { if (!released) { released = true; _inFlightBytes -= size; } };
  res.on('finish', release);
  res.on('close', release);   // the client went away mid-upload
  next();
}

/** Wrap a multer single-file middleware so its errors come back as the JSON the pages expect. */
function friendlyUpload(multerSingle, tag) {
  return (req, res, next) => {
    multerSingle(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      console.warn(`[${tag}] multer error:`, err.code || err.message);
      res.status(tooBig ? 413 : 400).json({
        success: false,
        error: tooBig ? TOO_BIG_MESSAGE : 'There was a problem with that upload — please try again.',
      });
    });
  };
}

module.exports = {
  MAX_UPLOAD_MB, MAX_UPLOAD_BYTES, MAX_IN_FLIGHT_BYTES, UPLOAD_REQUEST_TIMEOUT_MS, TOO_BIG_MESSAGE, BUSY_MESSAGE,
  uploadSlot, friendlyUpload, declaredBytes,
  _inFlightBytes: () => _inFlightBytes,
};
