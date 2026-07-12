require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const engine = require("ejs-mate");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const expressError = require("./Utility/expressError");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const apiRoutes = require("./routes/api");
const storeService = require("./services/storeService");
const aiService = require("./services/aiExplanationService");
const { attachUser, requireAuth } = require("./middleware/auth");
const { issueCsrfToken } = require("./middleware/csrf");

const app = express();

app.engine("ejs", engine);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
}, }, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", redirect: false }));
app.use("/vendor/bootstrap", express.static(path.join(__dirname, "node_modules", "bootstrap", "dist"), { maxAge: "7d", immutable: true }));
app.use("/vendor/chartjs", express.static(path.join(__dirname, "node_modules", "chart.js", "dist"), { maxAge: "7d", immutable: true }));
app.use("/vendor/fontawesome", express.static(path.join(__dirname, "node_modules", "@fortawesome", "fontawesome-free"), { maxAge: "7d", immutable: true }));
app.use("/vendor/plus-jakarta", express.static(path.join(__dirname, "node_modules", "@fontsource", "plus-jakarta-sans"), { maxAge: "7d", immutable: true }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production.");
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionStore = process.env.NODE_ENV === "production" && (process.env.ATLAS_DB || process.env.MONGODB_URI)
  ? MongoStore.create({ mongoUrl: process.env.ATLAS_DB || process.env.MONGODB_URI, dbName: process.env.MONGODB_DB_NAME || "nirapod_ops", collectionName: "sessions", crypto: { secret: sessionSecret }, touchAfter: 15 * 60 })
  : undefined;
app.use(session({
  name: "nirapod.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: sessionStore,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(attachUser);
app.use(issueCsrfToken);

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.aiStatus = aiService.getStatus();
  next();
});

app.get("/api/health", (req, res) => res.json({ status: "ok", mode: "simulation", simulation: true, database: storeService.getStatus(), ai: aiService.getStatus(), timestamp: new Date().toISOString() }));
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(authRoutes);
app.use(requireAuth);
app.use("/api", apiRoutes);
app.use("/", dashboardRoutes);

app.use((req, res, next) => next(new expressError(404, "The requested page could not be found.")));
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) ? err.status : 500;
  const message = status === 500 && process.env.NODE_ENV === "production"
    ? "Something went wrong. Please try again."
    : err.message;
  if (req.originalUrl.startsWith("/api/")) return res.status(status).json({ error: message, status });
  res.status(status).render("error", { title: "Error", status, message });
});

const port = process.env.PORT || 8080;
async function startServer() {
  const database = await storeService.initialize();
  return app.listen(port, () => console.log(`Nirapod Ops running at http://localhost:${port} (${database.mode})`));
}
if (require.main === module) startServer().catch((error) => {
  console.error("Unable to start Nirapod Ops:", error.message);
  process.exitCode = 1;
});

module.exports = app;
module.exports.startServer = startServer;
