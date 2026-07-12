const crypto = require("crypto");

function issueCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  const supplied = String(req.body?._csrf || req.get("x-csrf-token") || "");
  const expected = String(req.session?.csrfToken || "");
  const valid = supplied.length === expected.length && supplied.length > 0 && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (valid) return next();
  const error = new Error("Security token expired. Refresh the page and try again.");
  error.status = 403;
  next(error);
}

module.exports = { issueCsrfToken, verifyCsrf };
