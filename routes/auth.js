const crypto = require("crypto");
const express = require("express");
const authService = require("../services/authService");
const { verifyCsrf } = require("../middleware/csrf");

const router = express.Router();

function renderEntry(res, { status = 200, error = null, selectedRole = "agent" } = {}) {
  return res.status(status).render("login", {
    title: "Choose a demo role",
    error,
    selectedRole,
  });
}

router.get("/demo", (req, res) => {
  if (req.user) return res.redirect(req.user.destination);
  return renderEntry(res);
});

router.get("/login", (req, res) => res.redirect("/demo"));

router.post("/demo/role", verifyCsrf, (req, res) => {
  const selectedRole = String(req.body.role || "");
  const user = authService.getBySelectedRole(selectedRole);
  if (!user) return renderEntry(res, { status: 400, error: "Choose one of the available demo roles.", selectedRole: "agent" });
  const destination = authService.getRoleDestination(selectedRole, req.body.currentPath);

  req.session.regenerate((error) => {
    if (error) return renderEntry(res, { status: 500, error: "Could not start the demo. Please try again.", selectedRole });
    req.session.selectedRole = user.demoRole;
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    return res.redirect(destination);
  });
});

router.post("/demo/exit", verifyCsrf, (req, res) => req.session.destroy(() => res.redirect("/demo")));

module.exports = router;
