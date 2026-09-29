'use strict';

/**
 * One place for the client document-upload limits, so the two upload routes
 * (the client portal and the documents page) and their page scripts can never
 * disagree about what is allowed.
 *
 * 50 MB (owner decision 2026-09-29): long scanned PDFs run 20–40 MB. Uploads
 * are buffered in memory on their way to OneDrive, so the size limit comes
 * with a cap on how many uploads may be in flight at once — past it the client
 * is asked to retry in a moment instead of the server running out of memory.
 */
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_UPLOADS_IN_FLIGHT = 4;

const TOO_BIG_MESSAGE = `That file is over ${MAX_UPLOAD_MB} MB. Please split it into smaller files, or scan it at a lower quality, and try again.`;
const BUSY_MESSAGE = 'Several uploads are in progress right now. Please try again in a minute.';

let _inFlight = 0;

/** Express middleware: at most MAX_UPLOADS_IN_FLIGHT uploads buffered at once. Runs BEFORE multer. */
function uploadSlot(req, res, next) {
  if (_inFlight >= MAX_UPLOADS_IN_FLIGHT) {
    return res.status(503).json({ success: false, error: BUSY_MESSAGE, retriable: true });
  }
  _inFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; _inFlight--; } };
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
  MAX_UPLOAD_MB, MAX_UPLOAD_BYTES, MAX_UPLOADS_IN_FLIGHT, TOO_BIG_MESSAGE, BUSY_MESSAGE,
  uploadSlot, friendlyUpload,
  _inFlightCount: () => _inFlight,
};
