const navigationItems = Object.freeze([
  { path: "/", label: "Overview", icon: "fa-chart-line" },
  { path: "/alerts", label: "Alerts", icon: "fa-triangle-exclamation" },
  { path: "/cases", label: "Cases", icon: "fa-briefcase" },
  { path: "/network", label: "Network", icon: "fa-map-location-dot" },
  { path: "/simulation", label: "Scenario lab", icon: "fa-flask" },
  { path: "/methodology", label: "Trust center", icon: "fa-shield-halved" },
]);

const roleVisibility = Object.freeze({
  agent: { pages: ["/", "/alerts", "/cases", "/methodology"], destination: "/" },
  operations: { pages: ["/", "/alerts", "/cases", "/network", "/simulation", "/methodology"], destination: "/cases" },
  risk_reviewer: { pages: ["/alerts", "/cases", "/methodology"], destination: "/alerts" },
  management: { pages: ["/", "/network", "/methodology"], destination: "/network" },
});

const users = [
  {
    id: "usr-agent",
    name: "Amina Rahman",
    role: "agent",
    provider: null,
    outletId: "SA-1024",
    initials: "AR",
    demoRole: "agent",
    demoLabel: "Agent",
    demoDescription: "Monitor shared physical cash, separate provider positions, service pressure, and safe operational guidance.",
    destination: roleVisibility.agent.destination,
    icon: "fa-store",
  },
  {
    id: "usr-ops",
    name: "Farhana Islam",
    role: "operations",
    provider: "nagad",
    outletId: null,
    initials: "FI",
    demoRole: "operations",
    demoLabel: "Operations Team",
    demoDescription: "Monitor assigned agents, review liquidity alerts, coordinate cases, and track resolution.",
    destination: roleVisibility.operations.destination,
    icon: "fa-clipboard-check",
  },
  {
    id: "usr-risk",
    name: "Tanvir Ahmed",
    role: "risk",
    provider: null,
    outletId: null,
    initials: "TA",
    demoRole: "risk_reviewer",
    demoLabel: "Risk Reviewer",
    demoDescription: "Review unusual activity evidence and context without treating anomaly signals as final fraud determinations.",
    destination: roleVisibility.risk_reviewer.destination,
    icon: "fa-shield-halved",
  },
  {
    id: "usr-manager",
    name: "Nusrat Chowdhury",
    role: "management",
    provider: null,
    outletId: null,
    initials: "NC",
    demoRole: "management",
    demoLabel: "Management",
    demoDescription: "Review network readiness, area-level pressure, recurring operational signals, and overall service risk.",
    destination: roleVisibility.management.destination,
    icon: "fa-chart-column",
  },
];

const demoRoles = users.map(({ demoRole: id, demoLabel: label, demoDescription: description, destination, icon }) => ({
  id,
  label,
  description,
  destination,
  icon,
}));

function getBySelectedRole(role) {
  const user = users.find((item) => item.demoRole === role);
  return user ? { ...user } : null;
}

function getById(id) {
  const user = users.find((item) => item.id === id);
  return user ? { ...user } : null;
}

function normalizePagePath(path) {
  const value = String(path || "");
  return (value.length > 1 ? value.replace(/\/+$/, "") : value).toLowerCase();
}

function getNavigationForRole(role) {
  const visiblePages = roleVisibility[role]?.pages || [];
  return navigationItems.filter((item) => visiblePages.includes(item.path));
}

function isManagedRolePage(path) {
  const normalized = normalizePagePath(path);
  return navigationItems.some((item) => item.path === normalized);
}

function canViewRolePage(role, path) {
  const normalized = normalizePagePath(path);
  return Boolean(roleVisibility[role]?.pages.includes(normalized));
}

function getRoleDestination(role, currentPath) {
  const config = roleVisibility[role];
  if (!config) return "/demo";
  return canViewRolePage(role, currentPath) ? normalizePagePath(currentPath) : config.destination;
}

function canAccessProvider(user, provider) {
  if (!user) return false;
  return !user.provider || user.provider === provider;
}

function canMutateCases(user) {
  return Boolean(user && ["operations", "risk", "management"].includes(user.role));
}

function canIngest(user) {
  return Boolean(user && ["agent", "operations", "management"].includes(user.role));
}

function canManageBaseline(user) {
  return Boolean(user && ["agent", "operations", "risk", "management"].includes(user.role));
}

function canAccessDataPage(user) {
  return canIngest(user) || canManageBaseline(user);
}

module.exports = {
  users,
  demoRoles,
  roleVisibility,
  getBySelectedRole,
  getById,
  getNavigationForRole,
  isManagedRolePage,
  canViewRolePage,
  getRoleDestination,
  canAccessProvider,
  canMutateCases,
  canIngest,
  canManageBaseline,
  canAccessDataPage,
};
