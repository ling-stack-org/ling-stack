import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CHROME_BROWSER_PLUGIN_ID } from "@ling-stack/contracts";
import { createBuiltinAiTeammateId, createSqliteRunStore, DEVELOPMENT_COUNCIL_ID, routeProcedureObservation } from "../../../packages/core/dist/index.js";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

const noop = () => {};
const h = await catalogConsumerHarness({ after }, {
  exports: {
    "features/workspace/ChannelFeedChrome.tsx": ["ChannelFeedStatus"],
    "features/councils/council-members-view-model.ts": ["buildCouncilMemberCandidates", "buildCouncilMemberRows"],
    "features/councils/CouncilMembersPanel.tsx": ["CouncilMembersPanel"],
    "features/settings/SkillReviewQueueCards.tsx": ["PlaybookCandidateCard", "ProcedureObservationClusterCard"],
    "features/settings/SkillLibraryTable.tsx": ["SkillLibraryTable"],
    "features/plugins/plugin-manager-chrome-view-model.ts": ["buildChromePluginView"],
    "features/workspace/ChannelInspectorPanels.tsx": ["ChannelIntentInspectContent"],
    "app/FullAccessConfirmationDialog.tsx": ["FullAccessConfirmationDialog"],
  },
  expose: { "features/workspace/ChannelInspectorPanels.tsx": ["ChannelIntentInspectContent"] },
});

function consumed(key) {
  const call = h.state.calls.filter(value => value.key === key).at(-1);
  assert.ok(call, `real consumer must format ${key}`);
  return call.text;
}

test("C012 so-SO real feed error renders a warning, while loading and healthy branches cannot imply failure", async () => {
  await h.select("so-SO");
  const key = "Some activity changes could not be loaded";
  assert.equal(h.render(h.module.ChannelFeedStatus, { error: false, loading: false }), "");
  assert.equal(h.state.calls.some(call => call.key === key), false);
  const loading = h.render(h.module.ChannelFeedStatus, { error: false, loading: true });
  assert.ok(loading.includes(consumed("Loading activity events...")));
  assert.equal(h.state.calls.some(call => call.key === key), false);
  const markup = h.render(h.module.ChannelFeedStatus, { error: true, loading: false });
  const text = consumed(key);
  assert.ok(markup.includes(text));
  assert.match(markup, /activity-feed-status warning/u);
  // This covers the real state consumer, not the giant useWorkspaceDomain request producer.
  assert.match(text, /(?:lama|ma[^.!?]{0,35}(?:kari|suurtagal))/iu);
  assert.doesNotMatch(text, /waa la rari karaa/iu);
});

test("C012 so-SO real Store inactive finding stays warning/inactive through the council row view model", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-c012-council-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const when = "2026-10-17T00:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  store.updateAiTeammate(engineerId, { status: "paused" }, when);
  const council = store.getAiCouncil(DEVELOPMENT_COUNCIL_ID);
  const members = store.listAiCouncilMembers(council.id);
  const report = store.getAiCouncilHealthReport(when);
  assert.ok(report.findings.some(finding => finding.councilId === council.id && finding.teammateId === engineerId && finding.kind === "teammate_not_active"));
  const tLabel = await h.select("so-SO");
  const rows = h.module.buildCouncilMemberRows(council, members, store.listAiTeammates({ includeHidden: true, includeDisabled: true }), report, { complete: true }, tLabel);
  const row = rows.find(value => value.member.teammateId === engineerId);
  assert.equal(row.readinessState, "inactive");
  assert.equal(row.readinessTone, "warning");
  assert.equal(row.readinessLabel, consumed("Teammate inactive"));
  assert.equal(store.getAiTeammate(engineerId).status, "paused");
  assert.match(row.readinessLabel, /(?:aan|ma)[^.!?]{0,40}firfircoon|hakad/iu);
});

for (const [locale, meaning] of [
  ["so-SO", /(?:muuji|qarsoonaanta ka saar|aan qarsooneyn)/iu],
  ["ta-IN", /(?:மறைப்பை|மறைவை).{0,30}(?:நீக்|அகற்)|மீண்டும் காட்/u],
  ["te-IN", /దాచిన.{0,30}(?:తొలగి|తీసి)|అన్‌హైడ్|కనిపించేలా/u],
]) {
  test(`C012 ${locale} actual empty-candidate council guidance requests unhide, not hide`, async () => {
    const t = await h.select(locale);
    const hidden = { id: "hidden-qa", displayName: "Hidden QA", status: "active", hidden: true, roleKey: "custom" };
    const candidates = h.module.buildCouncilMemberCandidates([hidden], [], t);
    assert.deepEqual(candidates, []);
    const markup = h.render(h.module.CouncilMembersPanel, { cloneDisabled: false, council: { id: "qa", status: "active" }, cwd: "/isolated/c012",
      controller: { managed: false, candidates, rows: [], evidence: { complete: true }, summary: { label: "QA summary" },
        initialLoading: false, mutationDisabled: false, mutationKind: "", removeTarget: undefined },
      onOpenCloneCouncil: noop, onOpenTeammates: noop });
    const text = consumed("Create or unhide teammates before adding them to this council.");
    assert.ok(markup.includes(text));
    assert.equal(h.module.buildCouncilMemberCandidates([{ ...hidden, hidden: false }], [], t).length, 1);
    assert.equal(hidden.hidden, true);
    assert.match(text, meaning);
  });
}

for (const [locale, meaning] of [["pt-BR", /(?:nenhum|não há|sem).{0,30}(?:gatilh|acionador)/iu],
  ["ta-IN", /(?:தவிர்|தூண்டு).{0,40}(?:இல்லை|இல்லாத)/u],
  ["te-IN", /(?:ట్రిగ్గర్|ప్రేరేప).{0,40}(?:లేవు|లేదు)/u]]) {
  test(`C012 ${locale} actual empty negative-trigger list states absence rather than instructing no avoidance`, async () => {
    const t = await h.select(locale);
    const candidate = { id: "c012-playbook", title: "Synthetic QA", summary: "No execution", normalizedGoal: "QA",
      reason: "Synthetic fixture", status: "draft", updatedAt: "2026-10-17T00:00:00.000Z", procedureSteps: [], validationSteps: [],
      positiveTriggers: [], negativeTriggers: [], sourceRefs: [] };
    const props = { candidate, channelName: "QA", readOnly: true, busyAction: "", onReview: noop, t };
    const markup = h.render(h.module.PlaybookCandidateCard, props);
    const text = consumed("No avoid triggers");
    assert.ok(markup.includes(text));
    const populated = h.render(h.module.PlaybookCandidateCard, { ...props, candidate: { ...candidate, negativeTriggers: ["synthetic-negative"] } });
    assert.ok(populated.includes("synthetic-negative"));
    assert.equal(populated.includes(text), false);
    assert.deepEqual(candidate.negativeTriggers, []);
    assert.match(text, meaning);
    assert.doesNotMatch(text, /Não evite|வேண்டாம்|వద్దు/iu);
  });
}

test("C012 te-IN real clarification inspector names missing fields and omits the row without clarification", async () => {
  const t = await h.select("te-IN");
  const decision = { id: "qa-decision", action: "clarify", status: "accepted", createdBy: "deterministic", reason: "Synthetic QA",
    sourceItemId: "item", sourceTurnId: "turn", contextSegmentId: "segment", contextProjectionVersion: 1,
    resultItemIds: [], selectedTeammateIds: [], clarification: { missingFields: ["outputPath"], question: "Choose path" } };
  const props = { cwd: "/isolated/c012", channelId: "channel", decision, teammates: [], t };
  const markup = h.render(h.module.ChannelIntentInspectContent, props);
  const text = consumed("Missing fields");
  assert.ok(markup.includes(text));
  assert.match(markup, /<dd>outputPath<\/dd>/u);
  assert.equal(h.render(h.module.ChannelIntentInspectContent, { ...props, decision: { ...decision, clarification: undefined } }).includes(text), false);
  assert.match(text, /(?:తప్పిపోయిన|లేని|లేవు|కనిపించని).{0,30}(?:ఫీల్డ్|క్షేత్ర)|(?:ఫీల్డ్|క్షేత్ర).{0,30}(?:లేవు|లేదు)/u);
  assert.doesNotMatch(text, /ఖాళీ స్థలాలు లేవు/u);
});

test("C012 sw-TZ real router's insufficient evidence remains a blocker and cannot enable candidate creation", async () => {
  const t = await h.select("sw-TZ");
  const observation = { id: "qa-observation", source: "manual_recording", title: "Synthetic local QA", summary: "Fixture only", normalizedGoal: "QA",
    positiveTriggers: [], negativeTriggers: ["out of scope"], procedureSteps: [{ title: "Read fixture" }], validationSteps: [{ title: "Check fixture" }],
    signals: [], confidence: "high", reusableScore: 10 };
  const route = routeProcedureObservation(observation);
  assert.deepEqual(route.blockers, ["insufficient_evidence"]);
  const cluster = { id: "qa-cluster", channelId: "qa", title: "Synthetic QA", summary: "Fixture only", routeKind: "playbook",
    status: "ready_for_review", recommendedAction: "create_playbook_candidate", routeBlockers: route.blockers,
    observationCount: 1, reusableScore: 10, lastObservedAt: "2026-10-17T00:00:00.000Z", positiveTriggers: [] };
  const props = { cluster, busyAction: "", onCreateProtocolCandidate: noop, onCreatePlaybookCandidate: noop, t };
  const markup = h.render(h.module.ProcedureObservationClusterCard, props);
  const text = consumed("Insufficient evidence");
  assert.ok(markup.includes(text));
  assert.equal(markup.includes('class="settings-skill-candidate-actions"'), false);
  const unblocked = h.render(h.module.ProcedureObservationClusterCard, { ...props, cluster: { ...cluster, routeBlockers: [] } });
  assert.ok(unblocked.includes('class="settings-skill-candidate-actions"'));
  assert.equal(unblocked.includes(text), false);
  assert.match(text, /(?:ushahidi|ushuhuda).{0,35}(?:haut|hak|hauk|usio)|(?:hauna|hakuna).{0,20}ushahidi/iu);
  assert.doesNotMatch(text, /^Ushahidi wa kutosha[.!]?$/iu);
});

test("C012 sw-TZ real Full Access disclosure still states workspace-policy denied tools remain blocked", async () => {
  await h.select("sw-TZ");
  h.render(h.module.FullAccessConfirmationDialog, { open: true, onCancel: noop, onConfirm: noop });
  const text = consumed("Use it only for trusted workspaces. Denied tools in workspace policy still stay blocked.");
  // Radix portals do not render on the server; the real component's formatter call is asserted instead.
  assert.match(text, /(?:bado|zinaendelea).{0,45}(?:zimezuiwa|zimepigwa marufuku|kuzuiwa)/iu);
  assert.doesNotMatch(text, /bado hazijazuiwa/iu);
});

test("C012 zh-HK software Disabled is neutral disabled state in actual plugin and council view models", async () => {
  const t = await h.select("zh-HK");
  const plugin = { id: CHROME_BROWSER_PLUGIN_ID, status: "disabled", actions: { canEnable: true } };
  const chrome = h.module.buildChromePluginView(plugin, t);
  assert.deepEqual({ id: chrome.primaryState.id, tone: chrome.primaryState.tone }, { id: "disabled", tone: "neutral" });
  assert.equal(chrome.primaryAction.id, "enable");
  const member = { councilId: "qa", teammateId: "qa-member", enabled: false, position: 0 };
  const [row] = h.module.buildCouncilMemberRows({ id: "qa", status: "active" }, [member], [], undefined, { complete: true }, t);
  assert.equal(row.readinessState, "disabled");
  assert.equal(row.readinessTone, "neutral");
  assert.equal(row.readinessLabel, chrome.primaryState.label);
  assert.equal(plugin.status, "disabled");
  assert.match(chrome.primaryState.label, /(?:已停用|停用|已禁用|禁用|已關閉)/u);
  assert.doesNotMatch(chrome.primaryState.label, /殘障/u);
});

test("C012 tr-TR real skill table describes no enabled bindings, not unlimited permission", async () => {
  const t = await h.select("tr-TR");
  const entry = { id: "qa-skill", definition: { name: "QA skill", summary: "Synthetic fixture" }, source: "builtin", reviewStatus: "approved", updatedAt: "2026-10-17T00:00:00.000Z" };
  const props = { variant: "builtin", entries: [entry], loading: false, busyAction: "", selectedSkillId: undefined,
    bindingSummaries: [{ teammate: { id: "qa", displayName: "QA Bound" }, bindings: [{ skillId: entry.id, enabled: false }] }],
    onSelectSkill: noop, onArchiveSkill: noop, onDeleteSkill: noop, t };
  const markup = h.render(h.module.SkillLibraryTable, props);
  const text = consumed("Unbound");
  assert.ok(markup.includes(text));
  const bound = h.render(h.module.SkillLibraryTable, { ...props,
    bindingSummaries: [{ ...props.bindingSummaries[0], bindings: [{ skillId: entry.id, enabled: true }] }] });
  assert.ok(bound.includes("QA Bound"));
  assert.equal(bound.includes(text), false);
  assert.match(text, /bağl[ıai].{0,25}(?:değil|yok)|bağlanma/iu);
  assert.doesNotMatch(text, /Sınırsız/iu);
});

test("C012 missing selected keys use the actual English fallback without altering domain state", async () => {
  await h.select("so-SO", ["Some activity changes could not be loaded"]);
  const markup = h.render(h.module.ChannelFeedStatus, { loading: false, error: true });
  assert.ok(markup.includes("Some activity changes could not be loaded"));
  await h.select("zh-HK", ["Disabled"]);
  assert.equal(h.module.buildChromePluginView({ id: CHROME_BROWSER_PLUGIN_ID, status: "disabled", actions: { canEnable: false } }, h.state.t).primaryState.label, "Disabled");
});
