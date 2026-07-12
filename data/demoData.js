const providers = [
  { id: "bkash", name: "bKash", balance: 184000, color: "#2F708B", status: "healthy", updatedMinutesAgo: 2, feedStatus: "healthy" },
  { id: "nagad", name: "Nagad", balance: 68000, color: "#4C9EA8", status: "pressure", updatedMinutesAgo: 3, feedStatus: "healthy" },
  { id: "rocket", name: "Rocket", balance: 126500, alternateBalance: 118000, color: "#5B93B0", status: "watch", updatedMinutesAgo: 9, feedStatus: "conflicting" },
];

// Cash-in customers hand the agent physical cash and consume the agent's
// provider-specific e-money. This series drives provider balance runway.
const cashInDemand = {
  bkash: [8000, 10000, 12000, 14000, 15000, 12000],
  nagad: [24000, 30000, 36000, 42000, 48000, 44000],
  rocket: [5000, 6000, 7000, 8000, 9000, 8000],
};

// Cash-out customers consume shared physical cash while replenishing the
// corresponding agent e-money ledger. This distinct series drives cash runway.
const cashOutDemand = {
  bkash: [30000, 36000, 40000, 48000, 52000, 44000],
  nagad: [10000, 12000, 14000, 16000, 18000, 17000],
  rocket: [30000, 37000, 41000, 46000, 55000, 44000],
};

const transactions = [
  { id: "TX-901", provider: "nagad", amount: 9850, account: "U-7F2A", minute: 4, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-902", provider: "nagad", amount: 9900, account: "U-93BC", minute: 7, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-903", provider: "nagad", amount: 9850, account: "U-7F2A", minute: 10, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-904", provider: "nagad", amount: 9900, account: "U-41DE", minute: 13, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-905", provider: "nagad", amount: 9850, account: "U-93BC", minute: 16, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-906", provider: "bkash", amount: 5200, account: "U-1C33", minute: 18, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-907", provider: "rocket", amount: 4300, account: "U-8E10", minute: 21, type: "cash-out", source: "synthetic", dataRole: "current", importId: "seed-current" },
  { id: "TX-908", provider: "bkash", amount: 2400, account: "U-6D22", minute: 26, type: "cash-in", source: "synthetic", dataRole: "current", importId: "seed-current" },
];

const state = {
  outlet: { id: "SA-1024", name: "Zindabazar Super Agent", area: "Sylhet Central", sharedCash: 245000, lastSync: new Date().toISOString() },
  providers,
  cashInDemand,
  cashOutDemand,
  transactions,
  baselineTransactions: [],
  datasetImports: [],
  baselines: [],
  networkOutlets: [
    { id: "SA-1024", name: "Zindabazar Super Agent", area: "Sylhet Central", sharedCash: 245000, totalEmoney: 378500, providerBalances: { bkash: 184000, nagad: 68000, rocket: 126500 }, pressure: "high", coordinates: [24.8949, 91.8687] },
    { id: "SA-1078", name: "Ambarkhana Agent Hub", area: "Sylhet North", sharedCash: 318000, totalEmoney: 492000, providerBalances: { bkash: 216000, nagad: 147000, rocket: 129000 }, pressure: "healthy", coordinates: [24.9075, 91.8671] },
    { id: "SA-1103", name: "South Surma Point", area: "Sylhet South", sharedCash: 174000, totalEmoney: 289000, providerBalances: { bkash: 132000, nagad: 71000, rocket: 86000 }, pressure: "watch", coordinates: [24.8793, 91.8732] },
    { id: "SA-1164", name: "Bondor Bazar Outlet", area: "Sylhet Central", sharedCash: 98000, totalEmoney: 221000, providerBalances: { bkash: 105000, nagad: 49000, rocket: 67000 }, pressure: "high", coordinates: [24.8912, 91.8718] },
  ],
  cases: [
    {
      id: "CASE-2407", alertId: "ALT-NAGAD-01", provider: "nagad", severity: "high", status: "acknowledged",
      recipient: "Nagad Sylhet Operations", owner: "Farhana Islam · Territory Officer", ownerId: "usr-ops",
      nextStep: "Verify outlet demand and coordinate approved provider-specific support.",
      createdAt: "2026-07-11T03:35:00.000Z", receivedAt: "2026-07-11T03:35:00.000Z", assignedAt: "2026-07-11T03:39:00.000Z", acknowledgedAt: "2026-07-11T03:42:00.000Z", firstNoteAt: "2026-07-11T03:44:00.000Z", escalatedAt: null, resolvedAt: null,
      notes: [{ id: "NOTE-1", at: "2026-07-11T03:44:00.000Z", actor: "Farhana Islam", text: "Agent callback started; awaiting demand confirmation." }],
      history: [
        { at: "2026-07-11T03:35:00.000Z", actor: "Analytics engine", action: "Alert routed to Nagad operations" },
        { at: "2026-07-11T03:39:00.000Z", actor: "Tanvir Ahmed", action: "Case assigned to Farhana Islam" },
        { at: "2026-07-11T03:42:00.000Z", actor: "Farhana Islam", action: "Case acknowledged; agent callback initiated" },
      ],
    },
  ],
  auditLog: [
    { at: "2026-07-11T03:35:00.000Z", actor: "Analytics engine", action: "demo.seeded", target: "SA-1024" },
  ],
  aiExplanations: {},
  metadata: { scenarioVersion: "2.0", simulationOnly: true, generatedAt: "2026-07-11T03:30:00.000Z" },
};

module.exports = state;
