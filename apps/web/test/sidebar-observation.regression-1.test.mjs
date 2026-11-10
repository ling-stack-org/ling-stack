import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness, React } from "./support/catalog-consumer-harness.mjs";

// Regression: R03-OBS-SIDEBAR — retained running facts were announced as live after owned Host drain.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-observation-package-20261026/qa-report-r03-observation-2026-10-26.md
// Value: protects=shared sidebar snapshot qualification across all conversation owners;
// fails_when=paused running/waiting labels keep live presentation; why_new=timeline coverage omits sidebar;
// seam=existing catalog/component harness; no_claim=packaged GUI or safe tree-stop proof.
const noop = () => {};

test("sidebar qualifies stale activity for channels, private teammates and normal conversations without changing facts", async t => {
  const h = await catalogConsumerHarness(t, { exports: {
    "shared/conversation/observation/daemon-observation.tsx": ["DaemonObservationProvider"],
    "features/navigation/SidebarNavigation.tsx": ["SidebarNavigation"],
  } });
  for (const primaryStatus of ["running", "waiting", "failed", "paused"]) {
    const props = {
      activeSidebarTarget: "workspace", cwd: "/isolated/sidebar-observation",
      channels: [{ id: "channel", name: "Channel", status: "active", kind: "standard" }],
      teammates: [{ id: "engineer", displayName: "Engineer", role: "engineer", status: "active" }],
      channelNotifications: { channel: { primaryStatus } },
      teammateNotifications: { engineer: { primaryStatus } },
      recentConversations: [{ id: "thread", label: "Conversation", updatedAt: "2026-10-26T00:00:00Z", primaryStatus }],
      onOpenView: noop, onOpenConversationHome: noop, onCreateChannel: noop, onSelectChannel: noop,
      onSelectTeammate: noop, onSelectRecentConversation: noop,
    };
    const before = JSON.stringify(props);
    for (const [paused, workspaceCwd] of [[false, props.cwd], [true, props.cwd], [true, "/different/workspace"]]) {
      const html = h.render(h.module.DaemonObservationProvider, {
        value: { paused, epoch: 2, workspaceCwd, baseUrl: "http://127.0.0.1:17928" },
        children: React.createElement(h.module.SidebarNavigation, props),
      });
      assert.equal((html.match(new RegExp(`data-sidebar-primary-status="${primaryStatus}"`, "gu")) ?? []).length, 3);
      if (paused && workspaceCwd === props.cwd && ["running", "waiting"].includes(primaryStatus)) {
        assert.equal((html.match(/aria-label="Stale snapshot · /gu) ?? []).length, 3);
        assert.equal((html.match(/data-daemon-observation="paused"/gu) ?? []).length, 3);
        assert.equal((html.match(/class="ling-ui-status-indicator sidebar-object-status" data-compact="true" data-tone="neutral"/gu) ?? []).length, primaryStatus === "running" ? 3 : 0);
      } else {
        assert.doesNotMatch(html, /Stale snapshot/);
      }
      assert.equal(JSON.stringify(props), before);
    }
  }
});
