export const PUBLIC_CLI_SURFACE = [
  {
    name: "proof",
    summary: "Create, run, review, and present exact-revision proof",
    subcommands: ["demo", "init", "customize", "run", "ci", "serve", "review", "accept"],
  },
  {
    name: "factfile",
    summary: "Inspect, verify, assess, or explicitly publish evidence",
    subcommands: ["inspect", "verify", "assess", "publish"],
  },
  {
    name: "pulse",
    summary: "Ingest, plan, and render trusted progress across Factfiles",
    subcommands: ["fixture", "ingest", "status", "plan", "checkpoint", "work-event", "render"],
  },
  { name: "serve", summary: "Serve the bounded Keyoku MCP surface over stdio", subcommands: [] },
  { name: "doctor", summary: "Check this installation and local proof project", subcommands: [] },
  { name: "version", summary: "Print the installed Keyoku version", subcommands: [] },
  { name: "help", summary: "Show the complete public command surface", subcommands: [] },
] as const;

export type PublicCliCommand = (typeof PUBLIC_CLI_SURFACE)[number]["name"];

export const PUBLIC_MCP_SURFACE = [
  {
    name: "contribution_report_work",
    family: "proof-session",
    authority: "agent",
    summary: "Report coordination state; never proof of completion.",
  },
  {
    name: "contribution_request_decision",
    family: "proof-session",
    authority: "agent",
    summary: "Request bounded human judgment without resolving it.",
  },
  {
    name: "contribution_next_instruction",
    family: "proof-session",
    authority: "agent",
    summary: "Read the next durable human instruction.",
  },
  {
    name: "contribution_ack_instruction",
    family: "proof-session",
    authority: "agent",
    summary: "Acknowledge receipt of a human instruction.",
  },
  {
    name: "contribution_gate",
    family: "proof-session",
    authority: "verifier",
    summary: "Run repository-declared checks and render an exact-source Factfile.",
  },
  {
    name: "evidence_evaluate",
    family: "assurance",
    authority: "verifier",
    summary: "Evaluate one neutral, content-digested evidence envelope without mutating caller state.",
  },
  {
    name: "pulse_event_ingest",
    family: "pulse",
    authority: "adapter",
    summary: "Append one strict, content-digested lifecycle event.",
  },
  {
    name: "pulse_checkpoint_publish",
    family: "pulse",
    authority: "verifier",
    summary: "Verify local Factfile bytes before publishing a checkpoint event.",
  },
  {
    name: "pulse_work_event_ingest",
    family: "pulse",
    authority: "adapter",
    summary: "Append one neutral, content-digested WorkEvent to the local Pulse adapter ledger.",
  },
  {
    name: "pulse_work_event_list",
    family: "pulse",
    authority: "reader",
    summary: "Read validated neutral WorkEvents from the local Pulse adapter ledger.",
  },
  {
    name: "pulse_status",
    family: "pulse",
    authority: "reader",
    summary: "Replay leases and visibly classified verified or attested checkpoint state.",
  },
  {
    name: "pulse_dispatch_plan",
    family: "pulse",
    authority: "planner",
    summary: "Plan a deterministic dispatch outcome without sending.",
  },
  {
    name: "pulse_projection_render",
    family: "pulse",
    authority: "renderer",
    summary: "Render one audience view from a dispatchable snapshot without sending.",
  },
] as const;

export type PublicMcpTool = (typeof PUBLIC_MCP_SURFACE)[number]["name"];

export const LEGACY_SURFACE_POLICY = {
  releaseLine: "keyoku@2",
  publicV3EntryPoint: false,
  note: "Goals, workflows, connectors, activity recording, memory, and execution remain compatibility source only; the v3 package does not register or dispatch them.",
} as const;
