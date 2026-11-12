// Deterministic abapGit serializer. The LLM never writes XML: it returns source +
// metadata and this module produces the files, using the reference repo
// (ZMM_LANDED_COST) as the template.
import type { GeneratedProgram } from "./agents";

export type RepoFile = { path: string; content: string };

export const PACKAGE_DESCRIPTION = "SuperNova Generated Reports";

const BOM = "﻿";

export function serializeProgram(p: GeneratedProgram, extra: RepoFile[] = []): RepoFile[] {
  const name = p.program_name.toLowerCase();
  const source = p.abap_source.replace(/\r\n/g, "\n").replace(/\s*$/, "\n");
  const object =
    p.object_type === "CLAS"
      ? [{ path: `src/${name}.clas.abap`, content: source }, { path: `src/${name}.clas.xml`, content: clasXml(p) }]
      : [{ path: `src/${name}.prog.abap`, content: source }, { path: `src/${name}.prog.xml`, content: progXml(p) }];
  // What cannot be ABAP in this object travels with it, so whoever imports it knows what to build around it.
  const steps = p.manual_steps?.length
    ? [{ path: "docs/MANUAL_STEPS.md", content: `# Manual steps for ${p.program_name}\n\n${p.manual_steps.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n` }]
    : [];
  return [
    { path: ".abapgit.xml", content: dotAbapgit() },
    { path: "src/package.devc.xml", content: packageXml(PACKAGE_DESCRIPTION) },
    ...object,
    ...steps,
    ...extra,
  ];
}

/** The file name abapGit and abaplint give the object's source. */
export const sourceFileName = (p: GeneratedProgram) => `${p.program_name.toLowerCase()}.${p.object_type === "CLAS" ? "clas" : "prog"}.abap`;

/** VSEOCLASS for one global class whose whole source is in its .clas.abap file. */
export function clasXml(p: GeneratedProgram): string {
  return (
    [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">`,
      ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
      `  <asx:values>`,
      `   <VSEOCLASS>`,
      `    <CLSNAME>${xmlEscape(p.program_name.toUpperCase())}</CLSNAME>`,
      `    <LANGU>E</LANGU>`,
      `    <DESCRIPT>${xmlEscape(p.title.slice(0, 60))}</DESCRIPT>`,
      `    <STATE>1</STATE>`,
      `    <CLSCCINCL>X</CLSCCINCL>`,
      `    <FIXPT>X</FIXPT>`,
      `    <UNICODE>X</UNICODE>`,
      `   </VSEOCLASS>`,
      `  </asx:values>`,
      ` </asx:abap>`,
      `</abapGit>`,
    ].join("\n") + "\n"
  );
}

export function dotAbapgit(): string {
  return (
    BOM +
    [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
      ` <asx:values>`,
      `  <DATA>`,
      `   <MASTER_LANGUAGE>E</MASTER_LANGUAGE>`,
      `   <STARTING_FOLDER>/src/</STARTING_FOLDER>`,
      `   <FOLDER_LOGIC>PREFIX</FOLDER_LOGIC>`,
      `  </DATA>`,
      ` </asx:values>`,
      `</asx:abap>`,
    ].join("\n") +
    "\n"
  );
}

export function packageXml(description: string): string {
  return (
    [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">`,
      ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
      `  <asx:values>`,
      `   <DEVC>`,
      `    <CTEXT>${xmlEscape(description)}</CTEXT>`,
      `   </DEVC>`,
      `  </asx:values>`,
      ` </asx:abap>`,
      `</abapGit>`,
    ].join("\n") + "\n"
  );
}

/**
 * PROGDIR + TPOOL. Selection texts follow the abapGit/SAP text pool format:
 * ENTRY = 8 reserved characters (blank = own text, 'D' = DDIC text) + text,
 * LENGTH = length of the whole ENTRY.
 */
export function progXml(p: GeneratedProgram): string {
  const items: string[] = [tpoolItem("R", undefined, p.title)];
  const texts = [...p.selection_texts].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const t of texts) items.push(tpoolItem("S", t.key.toUpperCase(), " ".repeat(8) + t.text));
  return (
    [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<abapGit version="v1.0.0" serializer="LCL_OBJECT_PROG" serializer_version="v1.0.0">`,
      ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
      `  <asx:values>`,
      `   <PROGDIR>`,
      `    <NAME>${xmlEscape(p.program_name.toUpperCase())}</NAME>`,
      `    <SUBC>1</SUBC>`,
      `    <RLOAD>E</RLOAD>`,
      `    <FIXPT>X</FIXPT>`,
      `    <UCCHECK>X</UCCHECK>`,
      `   </PROGDIR>`,
      `   <TPOOL>`,
      ...items,
      `   </TPOOL>`,
      `  </asx:values>`,
      ` </asx:abap>`,
      `</abapGit>`,
    ].join("\n") + "\n"
  );
}

function tpoolItem(id: string, key: string | undefined, entry: string): string {
  return [
    `    <item>`,
    `     <ID>${id}</ID>`,
    ...(key ? [`     <KEY>${xmlEscape(key)}</KEY>`] : []),
    `     <ENTRY>${xmlEscape(entry)}</ENTRY>`,
    `     <LENGTH>${entry.length}</LENGTH>`,
    `    </item>`,
  ].join("\n");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
