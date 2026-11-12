// SQLite via Node's built-in node:sqlite (no native build step).
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { DATA_DIR } from "./paths";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// Hard-coded actors for the POC (no login).
export const CONSULTANT = "Functional Consultant";
export const APPROVER = "Functional Approver";
export const SYSTEM = "SuperNova";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  requirement_text TEXT NOT NULL,
  status TEXT NOT NULL,              -- INTERVIEW, SUMMARY_READY, FSD_DRAFT, FSD_APPROVED, CODE_READY, EXPORTED
  summary_json TEXT,
  questions_asked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  role TEXT NOT NULL,                -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fsd_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,              -- DRAFT | APPROVED | SUPERSEDED
  source TEXT NOT NULL,              -- AGENT | EDIT | MODIFY
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE, -- the customer the FSD is written for
  logo BLOB,
  logo_type TEXT,                    -- image/png | image/jpeg
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  revision INTEGER NOT NULL,
  wricef TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fsd_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  base_version_id INTEGER NOT NULL REFERENCES fsd_versions(id),
  conversation_json TEXT NOT NULL,   -- saved before every LLM call, so a failure loses nothing
  proposal_json TEXT,
  status TEXT NOT NULL,              -- OPEN | APPLIED | DISCARDED
  result_version_id INTEGER REFERENCES fsd_versions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fsd_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  fsd_version_id INTEGER NOT NULL REFERENCES fsd_versions(id),
  kind TEXT NOT NULL,                -- COMMENT | RESOLVED
  section TEXT NOT NULL,             -- section key, or the question text for RESOLVED
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  fsd_version_id INTEGER NOT NULL REFERENCES fsd_versions(id),
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,            -- APPROVED
  sha256 TEXT NOT NULL,              -- hash of the approved FSD text
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS code_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  fsd_version_id INTEGER NOT NULL REFERENCES fsd_versions(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- GENERATED | REPAIRED
  program_name TEXT NOT NULL,
  title TEXT NOT NULL,
  abap_source TEXT NOT NULL,
  selection_texts_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  review_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  code_version_id INTEGER NOT NULL REFERENCES code_versions(id),
  folder TEXT NOT NULL,
  zip_path TEXT NOT NULL,
  commit_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  requirement_id INTEGER,
  details_json TEXT
);
-- One row per LLM request the provider answered, with the usage it reported. Only ever inserted;
-- the links to the version or code a request produced are filled in once that row exists.
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER,
  fsd_version_id INTEGER,       -- the FS/TS version the request produced, or read (change analysis)
  code_version_id INTEGER,
  change_id INTEGER,            -- fsd_changes row, for Modify
  process TEXT NOT NULL,        -- see UsageProcess in lib/usage.ts
  doc_type TEXT,                -- FS | TS
  agent TEXT,                   -- prompt tag, e.g. interviewer, fsd, ts-report
  actor TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  model TEXT,                   -- as the response named it
  request_id TEXT,              -- x-request-id response header
  response_id TEXT,             -- the response body's id
  input_tokens INTEGER,         -- NULL when the response had no usage
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_input_tokens INTEGER,
  usage_available INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1, -- JSON retries are separate, billed requests
  duration_ms INTEGER,
  requested_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_requirement ON llm_usage (requirement_id);
-- The RG (Requirement Gathering) document a Forms requirement starts from: the file as uploaded,
-- its extracted text, and the RG Analyst's reading of it. Kept as is; corrections go through the interview.
CREATE TABLE IF NOT EXISTS rg_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  file BLOB,                    -- NULL when the RG was pasted as text
  text TEXT NOT NULL,
  analysis_json TEXT,           -- set once the RG Analyst has read it
  created_at TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 8;
const globalForDb = globalThis as unknown as { supernovaDb?: DatabaseSyncType; supernovaSchema?: number };

/** Only ever adds: columns on fsd_versions, filled in for rows from before versioning, and the client link. No existing value changes. */
function migrate(conn: DatabaseSyncType) {
  const requirementColumns = new Set((conn.prepare("PRAGMA table_info(requirements)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [
    ["client_id", "INTEGER REFERENCES clients(id)"],
    ["wricef", "TEXT NOT NULL DEFAULT 'R'"], // R | W; every requirement from before classification was a report
    ["execution_mode", "TEXT"], // ONLINE | BACKGROUND, for reports
    ["project", "TEXT"],
    ["linked_requirement_id", "INTEGER"], // the other half of a Report and Workflow pair
    ["interview_state_json", "TEXT"], // what the interviewer last reported as covered, assumed or open
    ["classification_json", "TEXT"], // the AI's suggested WRICEF type and confidence; advice only
  ]) {
    if (!requirementColumns.has(name)) conn.exec(`ALTER TABLE requirements ADD COLUMN ${name} ${type}`);
  }

  const columns = new Set((conn.prepare("PRAGMA table_info(fsd_versions)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [
    ["label", "TEXT"], // 1.0, 1.1, 2.0; `version` stays the plain sequence the rest of the pipeline uses
    ["parent_id", "INTEGER"], // the version this one was made from
    ["change_type", "TEXT"], // INITIAL | MINOR | MAJOR
    ["change_summary", "TEXT"],
    ["sections_changed_json", "TEXT"],
    ["doc_type", "TEXT NOT NULL DEFAULT 'FS'"], // FS | TS; each has its own version numbers and approvals
    ["wricef", "TEXT"], // the requirement type the document was written for
    ["fs_version_id", "INTEGER"], // a TS records the FS version it was written from
    ["requirement_revision", "INTEGER"], // the requirement revision the document was written from
  ]) {
    if (!columns.has(name)) conn.exec(`ALTER TABLE fsd_versions ADD COLUMN ${name} ${type}`);
  }
  conn.exec("UPDATE fsd_versions SET wricef = 'R' WHERE wricef IS NULL");

  // ABAP for every WRICEF category: the object type, its category and the manual steps around it.
  const codeColumns = new Set((conn.prepare("PRAGMA table_info(code_versions)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [
    ["object_type", "TEXT NOT NULL DEFAULT 'PROG'"], // PROG | CLAS; every code version before this was a report program
    ["wricef", "TEXT NOT NULL DEFAULT 'R'"],
    ["manual_steps_json", "TEXT"],
  ]) {
    if (!codeColumns.has(name)) conn.exec(`ALTER TABLE code_versions ADD COLUMN ${name} ${type}`);
  }
  const old = conn.prepare("SELECT id, requirement_id, version, source FROM fsd_versions WHERE label IS NULL ORDER BY requirement_id, version").all() as {
    id: number; requirement_id: number; version: number; source: string;
  }[];
  const previous = conn.prepare("SELECT id FROM fsd_versions WHERE requirement_id = ? AND version = ?");
  const fill = conn.prepare("UPDATE fsd_versions SET label = ?, parent_id = ?, change_type = ?, change_summary = ? WHERE id = ?");
  for (const f of old) {
    const parent = previous.get(f.requirement_id, f.version - 1) as { id: number } | undefined;
    const summary = f.version === 1 ? "Initial FSD" : f.source === "EDIT" ? "Manual edit" : "Regenerated";
    fill.run(`1.${f.version - 1}`, parent?.id ?? null, f.version === 1 ? "INITIAL" : "MINOR", summary, f.id);
  }
}

export function db(): DatabaseSyncType {
  if (!globalForDb.supernovaDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const conn = new DatabaseSync(path.join(DATA_DIR, "supernova.db"));
    conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    globalForDb.supernovaDb = conn;
  }
  // Checked apart from opening: a dev server keeps its connection across code reloads.
  if (globalForDb.supernovaSchema !== SCHEMA_VERSION) {
    globalForDb.supernovaDb.exec(SCHEMA);
    migrate(globalForDb.supernovaDb);
    globalForDb.supernovaSchema = SCHEMA_VERSION;
  }
  return globalForDb.supernovaDb;
}

export const now = () => new Date().toISOString();

export function audit(actor: string, action: string, requirementId: number | null, details?: unknown) {
  db()
    .prepare("INSERT INTO audit_log (ts, actor, action, requirement_id, details_json) VALUES (?, ?, ?, ?, ?)")
    .run(now(), actor, action, requirementId, details === undefined ? null : JSON.stringify(details));
}

export function setStatus(requirementId: number, status: string) {
  db().prepare("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), requirementId);
}

/** Typed helpers around prepared statements. */
export function get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function insert(sql: string, ...params: (string | number | null)[]): number {
  return Number(db().prepare(sql).run(...params).lastInsertRowid);
}

export type Requirement = {
  id: number;
  title: string;
  requirement_text: string;
  status: string;
  summary_json: string | null;
  questions_asked: number;
  client_id: number | null;
  wricef: string;
  execution_mode: string | null;
  project: string | null;
  linked_requirement_id: number | null;
  interview_state_json: string | null;
  classification_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type FsdVersion = {
  id: number;
  requirement_id: number;
  version: number;
  markdown: string;
  sha256: string;
  status: string;
  source: string;
  author: string;
  created_at: string;
  label: string;
  parent_id: number | null;
  change_type: string;
  change_summary: string | null;
  sections_changed_json: string | null;
  doc_type: string;
  wricef: string | null;
  fs_version_id: number | null;
  requirement_revision: number | null;
};

export type RgDocument = {
  id: number;
  requirement_id: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  text: string;
  analysis_json: string | null;
  created_at: string;
};

export type Client = {
  id: number;
  name: string;
  logo: Uint8Array | null;
  logo_type: string | null;
  created_at: string;
  updated_at: string;
};

export type FsdChange = {
  id: number;
  requirement_id: number;
  base_version_id: number;
  conversation_json: string;
  proposal_json: string | null;
  status: string;
  result_version_id: number | null;
  created_at: string;
  updated_at: string;
};

export type FsdAnnotation = {
  id: number;
  requirement_id: number;
  fsd_version_id: number;
  kind: string;
  section: string;
  text: string;
  author: string;
  created_at: string;
};

export type CodeVersion = {
  id: number;
  requirement_id: number;
  fsd_version_id: number;
  version: number;
  kind: string;
  program_name: string;
  title: string;
  abap_source: string;
  selection_texts_json: string;
  checks_json: string;
  review_json: string | null;
  created_at: string;
  object_type: string;
  wricef: string;
  manual_steps_json: string | null;
};
