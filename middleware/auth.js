const authService = require("../services/authService");

function attachUser(req, res, next) {
  req.user = req.session?.selectedRole ? authService.getBySelectedRole(req.session.selectedRole) : null;
  res.locals.currentUser = req.user;
  res.locals.demoRoles = authService.demoRoles;
  res.locals.navigationItems = req.user ? authService.getNavigationForRole(req.user.demoRole) : [];
  res.locals.canUseSimulationData = authService.canAccessDataPage(req.user);
  res.locals.canIngestData = authService.canIngest(req.user);
  res.locals.canManageBaseline = authService.canManageBaseline(req.user);
  next();
}

function requireAuth(req, res, next) {
  if (req.user) {
    const isPageRequest = req.method === "GET" && authService.isManagedRolePage(req.path);
    if (isPageRequest && !authService.canViewRolePage(req.user.demoRole, req.path)) return res.redirect(req.user.destination);
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Select a demo role to continue", status: 401 });
  return res.redirect("/demo");
}

function requireCaseAccess(req, res, next) {
  if (!authService.canMutateCases(req.user)) { const error = new Error("This role cannot change cases."); error.status = 403; return next(error); }
  next();
}

function requireIngestAccess(req, res, next) {
  if (!authService.canIngest(req.user)) { const error = new Error("This role cannot update feeds."); error.status = 403; return next(error); }
  next();
}

function requireBaselineAccess(req, res, next) {
  if (!authService.canManageBaseline(req.user)) { const error = new Error("This role cannot manage baseline data."); error.status = 403; return next(error); }
  next();
}

function requireDataAccess(req, res, next) {
  if (!authService.canAccessDataPage(req.user)) { const error = new Error("This role cannot access data controls."); error.status = 403; return next(error); }
  next();
}

module.exports = { attachUser, requireAuth, requireCaseAccess, requireIngestAccess, requireBaselineAccess, requireDataAccess };
