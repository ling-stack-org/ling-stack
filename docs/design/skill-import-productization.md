# Skill Import Productization

> Model update: [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md) removes `SkillDefinition.workflowPhase`. Import behavior in this document remains active, but imports no longer infer or default a stage.

## Related Docs

- [Ling Skill Import V1](ling-skill-import-v1.md)
- [Skill Library Ownership Separation](skill-library-ownership-separation.md)
- [Skill Context Optimization](skill-context-optimization.md)

## Summary

The current Skill Library import dialog still behaves like an editor and review console:
after choosing a file it exposes the source text, a separate check action, warning counts,
recognized rows, and another publish action. Those are implementation steps, not user
decisions. A workspace user wants to choose a skill file and import it.

The product flow becomes:

```text
choose one skill file
  -> import
  -> Ling checks the file without writing durable data
  -> valid files are saved; blocked files show actionable problems
```

## Input Contract

- The primary input is one local text file: `.md`, `.markdown`, `.json`, or `.txt`.
- The browser reads the file with `File.text()` and sends only its text and basename.
- Ling never receives or displays a browser-local absolute path.
- Full directories, ZIP archives, scripts, and referenced files are not imported in this
  slice.

The source is inferred rather than selected:

- `SKILL.md` or compatible skill frontmatter becomes `skill-directory`.
- `AGENTS.md` or `AGENT.md` becomes `agents-md`.
- Other supported files become `custom`.
- `workspace` and `gstack` remain internal or source-sync provenance and are not choices
  in this dialog.

## Interaction Contract

- The dialog title is **Import skill**.
- The main controls are **Choose file** and **Import**.
- The selected filename is read-only metadata. Users do not type a source path.
- The source text is not shown or edited in the import dialog.
- Import runs the existing read-only preview first. If the preview has no blocking errors,
  Ling creates the durable draft and publishes it through the existing reviewed path.
- Successful validation is silent apart from the final short-lived success feedback. The
  dialog does not show warning counts, recognized rows, or an intermediate ready state.
- Non-blocking warnings remain available to later skill health/detail surfaces and do not
  interrupt import.
- Blocking errors keep the selected file in place and show a compact problem list with
  product language. Raw ids, checksums, parser names, optimization modes, and token
  compiler fields are never shown in the default import surface.
- Successful publication uses short-lived feedback and returns the user to My skills.

## Preview Semantics

Content checking must be genuinely read-only. It may parse, normalize, detect duplicate
ids, and compute context findings, but it must not write `skill_import_drafts`, skill
packs, definitions, source snapshots, or bindings.

Optimization preview is not part of importing. It remains available from an existing
skill's detail inspector, where token estimates and routing analysis have enough context
to be meaningful.

## Runtime And Security Boundary

Importing text never grants tools, providers, MCP access, secrets, approval bypasses,
external-send authority, teammate bindings, or runtime selection. Existing warning and
publication gates remain authoritative.

`AGENTS.md` continues through the existing safe skill parser in this surface. It does not
update teammate persona fields or permissions.

## Acceptance Criteria

- No Source, Source path, Draft name, content editor, Check content, preview result,
  Preview optimization, or Publish to registry control appears in the import dialog.
- Selecting a supported file shows its filename without exposing its source text.
- Clicking Import performs validation and publication as one user action.
- A valid file appears in My skills and the dialog closes.
- A blocked file is not saved and shows only actionable import problems.
- Closing the dialog before importing does not add durable import drafts.
- Chinese UI uses product language and does not expose registry/storage terminology.

## Non-Goals

- Complete directory or package import.
- Referenced-file upload or execution.
- Direct paste or source editing in the import dialog.
- Persona import redesign.
- Changes to binding, execution, approval, or source-sync semantics.
