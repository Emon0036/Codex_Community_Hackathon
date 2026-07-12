const crypto = require("crypto");
const authService = require("./authService");
const storeService = require("./storeService");
const analytics = require("./analyticsService");

const transitions = {
  open: ["acknowledged"],
  acknowledged: ["escalated"],
  escalated: ["resolved"],
  resolved: [],
};

const workflowSteps = ["receiver", "owner", "acknowledged", "note", "escalated", "resolved"];

function getWorkflow(item) {
  const completed = {
    receiver: Boolean(item.recipient),
    owner: Boolean(item.ownerId && item.owner),
    acknowledged: Boolean(item.acknowledgedAt),
    note: Boolean(item.notes?.length),
    escalated: Boolean(item.escalatedAt),
    resolved: Boolean(item.resolvedAt),
  };
  const completedCount = workflowSteps.filter((step) => completed[step]).length;
  return { completed, completedCount, percent: Math.round(completedCount / workflowSteps.length * 100), current: workflowSteps.find((step) => !completed[step]) || "complete" };
}

function cleanNote(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 700);
}

function assertProviderAccess(user, provider) {
  if (provider === "shared" && !["risk", "management"].includes(user.role)) {
    const error = new Error("Shared-cash cases require risk or management ownership."); error.status = 403; throw error;
  }
  if (provider !== "shared" && !authService.canAccessProvider(user, provider)) {
    const error = new Error("You cannot modify another provider's case."); error.status = 403; throw error;
  }
}

function assertOwner(user, item) {
  if (!item.ownerId || item.ownerId !== user.id) {
    const error = new Error("Assign this case to yourself before completing its workflow actions."); error.status = 403; throw error;
  }
}

async function createCase(alertId, user) {
  return storeService.mutate((state) => {
    const alert = analytics.getAlertById(alertId, state);
    if (!alert) { const error = new Error("Alert not found."); error.status = 404; throw error; }
    assertProviderAccess(user, alert.provider);
    const existing = state.cases.find((item) => item.alertId === alert.id && item.status !== "resolved");
    if (existing) return existing;
    const providerLabel = alert.provider === "shared" ? "Shared Cash Coordination" : `${state.providers.find((provider) => provider.id === alert.provider)?.name} Sylhet Operations`;
    const createdAt = new Date().toISOString();
    const item = {
      id: `CASE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, alertId: alert.id, provider: alert.provider, severity: alert.severity, status: "open",
      recipient: providerLabel, owner: null, ownerId: null, nextStep: alert.recommendation,
      createdAt, receivedAt: createdAt, assignedAt: null, acknowledgedAt: null, firstNoteAt: null, escalatedAt: null, resolvedAt: null, notes: [],
      history: [{ at: createdAt, actor: user.name, action: `Case created and routed to ${providerLabel}` }],
    };
    state.cases.unshift(item);
    state.auditLog.push({ at: createdAt, actor: user.name, action: "case.created", target: item.id });
    return item;
  });
}

async function transitionCase(caseId, nextStatus, user) {
  return storeService.mutate((state) => {
    const item = state.cases.find((entry) => entry.id === caseId);
    if (!item) { const error = new Error("Case not found."); error.status = 404; throw error; }
    assertProviderAccess(user, item.provider);
    assertOwner(user, item);
    if (!(transitions[item.status] || []).includes(nextStatus)) {
      const error = new Error(`A ${item.status} case cannot move directly to ${nextStatus}.`); error.status = 400; throw error;
    }
    if (nextStatus === "acknowledged" && (!item.recipient || !item.ownerId)) {
      const error = new Error("Assign a receiver and owner before acknowledging the case."); error.status = 400; throw error;
    }
    if (nextStatus === "escalated" && !(item.notes?.length > 0)) {
      const error = new Error("Add at least one evidence note before escalating the case."); error.status = 400; throw error;
    }
    if (nextStatus === "resolved" && !item.escalatedAt) {
      const error = new Error("Escalate the case before resolving it."); error.status = 400; throw error;
    }
    const at = new Date().toISOString();
    item.status = nextStatus;
    if (nextStatus === "acknowledged") item.acknowledgedAt = at;
    if (nextStatus === "escalated") item.escalatedAt = at;
    if (nextStatus === "resolved") item.resolvedAt = at;
    item.history.push({ at, actor: user.name, action: `Status changed to ${nextStatus}` });
    state.auditLog.push({ at, actor: user.name, action: `case.${nextStatus}`, target: item.id });
    return item;
  });
}

async function addNote(caseId, text, user) {
  const note = cleanNote(text);
  if (note.length < 3) { const error = new Error("A case note must contain at least 3 characters."); error.status = 400; throw error; }
  return storeService.mutate((state) => {
    const item = state.cases.find((entry) => entry.id === caseId);
    if (!item) { const error = new Error("Case not found."); error.status = 404; throw error; }
    assertProviderAccess(user, item.provider);
    assertOwner(user, item);
    if (!item.acknowledgedAt) { const error = new Error("Acknowledge the case before adding an operational note."); error.status = 400; throw error; }
    if (item.status === "resolved") { const error = new Error("Resolved cases are read-only."); error.status = 400; throw error; }
    const at = new Date().toISOString();
    item.notes ||= [];
    item.notes.push({ id: `NOTE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, at, actor: user.name, text: note });
    item.firstNoteAt ||= at;
    item.history.push({ at, actor: user.name, action: "Case note added" });
    state.auditLog.push({ at, actor: user.name, action: "case.note_added", target: item.id });
    return item;
  });
}

async function assignCase(caseId, ownerId, user) {
  const owner = authService.getById(ownerId);
  if (!owner || !["operations", "risk", "management"].includes(owner.role)) { const error = new Error("Select a valid case owner."); error.status = 400; throw error; }
  return storeService.mutate((state) => {
    const item = state.cases.find((entry) => entry.id === caseId);
    if (!item) { const error = new Error("Case not found."); error.status = 404; throw error; }
    assertProviderAccess(user, item.provider); assertProviderAccess(owner, item.provider);
    if (item.status === "resolved") { const error = new Error("Resolved cases are read-only."); error.status = 400; throw error; }
    const at = new Date().toISOString(); item.ownerId = owner.id; item.owner = owner.name; item.assignedAt = at;
    item.history.push({ at, actor: user.name, action: `Case assigned to ${owner.name}` });
    state.auditLog.push({ at, actor: user.name, action: "case.assigned", target: item.id });
    return item;
  });
}

module.exports = { transitions, workflowSteps, getWorkflow, createCase, transitionCase, addNote, assignCase };
