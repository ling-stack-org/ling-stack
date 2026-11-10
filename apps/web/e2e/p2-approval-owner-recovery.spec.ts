import { expect, test } from "@playwright/test";
import { createApproval } from "./support/approvals-fixture";

for (const status of ["approved", "denied", "expired", "cancelled"] as const) {
test(`reload recovers an original ${status} decision omitted by a stale approval list without replay`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  let receipts = 0;
  let receiptAvailable = false;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: "/p2/workspace-a", approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    mutations++;
    await route.abort("connectionclosed");
  });
  await page.route(url => url.pathname === "/approvals/approval", route => {
    receipts++;
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).searchParams.get("cwd")).toBe("/p2/workspace-a");
    return route.fulfill(receiptAvailable
      ? { json: { approval: { ...approval, status }, postCommitEffects: [] } }
      : { status: 503, json: { error: "receipt_unavailable" } });
  });
  const mount = async () => {
    await page.evaluate(async () => {
      const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
      fixture.mountApprovalsDomainFixture();
    });
  };
  await page.goto("/e2e/support/p2-reading.html?manual");
  await mount();
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  expect(mutations).toBe(1);
  expect(receipts).toBeGreaterThanOrEqual(1);
  receiptAvailable = true;
  await page.reload();
  await mount();
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText(status);
  await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
  expect(mutations).toBe(1);
  await page.getByRole("button", { name: "Refresh approvals", exact: true }).click();
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText(status);
  await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
});
}

for (const responseKind of ["empty", "null", "missing-approval", "pending", "wrong-id", "unknown-status"] as const) {
test(`a successful decision with ${responseKind} receipt queries the original approval without replay`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  let receipts = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: "/p2/workspace-a", approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", route => {
    mutations++;
    const json = responseKind === "empty" ? {} : responseKind === "null" ? null
      : responseKind === "missing-approval" ? { approval: null }
      : { approval: { ...approval, id: responseKind === "wrong-id" ? "another-approval" : approval.id,
        status: responseKind === "pending" ? "pending" : responseKind === "unknown-status" ? "unexpected-status" : "approved" } };
    return route.fulfill({ body: JSON.stringify(json), contentType: "application/json" });
  });
  await page.route(url => url.pathname === "/approvals/approval", route => {
    receipts++;
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).searchParams.get("cwd")).toBe("/p2/workspace-a");
    return route.fulfill({ json: { approval: { ...approval, status: "approved" }, postCommitEffects: [] } });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
  await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
  await expect(page.getByLabel("Load error", { exact: true })).toBeEmpty();
  await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
  expect(mutations).toBe(1);
  expect(receipts).toBe(1);
  expect(pageErrors).toEqual([]);
});
}

test("a reload recovery refresh failure cannot turn the durable decision into an approval error", async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let available = false;
  let mutations = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: "/p2/workspace-a", approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    mutations++;
    await route.abort("connectionclosed");
  });
  await page.route(url => url.pathname === "/approvals/approval", route => route.fulfill(available
    ? { json: { approval: { ...approval, status: "approved" }, postCommitEffects: [] } }
    : { status: 503, json: { error: "receipt_unavailable" } }));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  available = true;
  await page.reload();
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture({ failResolutionRefresh: true });
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
  await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
  await expect(page.getByLabel("Load error", { exact: true })).toHaveText("Resolution refresh failed");
  expect(mutations).toBe(1);
});

for (const status of ["approved", "denied", "expired", "cancelled"] as const) {
test(`a lost decision response recovers the original durable ${status} approval without replay`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  let receipts = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: "/p2/workspace-a", approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    mutations++;
    await route.abort("connectionclosed");
  });
  await page.route(url => url.pathname === "/approvals/approval", route => {
    receipts++;
    expect(new URL(route.request().url()).searchParams.get("cwd")).toBe("/p2/workspace-a");
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { approval: { ...approval, status, decisionKind: "approve_once" } } });
  });
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText(status);
  await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
  await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
  expect(mutations).toBe(1);
  expect(receipts).toBe(1);
});
}

for (const outcome of ["pending", "unavailable", "malformed", "wrong-id"] as const) {
test(`a ${outcome} receipt cannot invent approval or replay a lost decision`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  let receipts = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: "/p2/workspace-a", approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    mutations++;
    await route.abort("connectionclosed");
  });
  await page.route(url => url.pathname === "/approvals/approval", route => {
    receipts++;
    if (outcome === "unavailable") return route.fulfill({ status: 503, json: { error: "receipt_unavailable" } });
    return route.fulfill({ json: outcome === "malformed" ? {} : { approval: outcome === "pending" ? approval
      : { ...approval, id: "another-approval", status: "approved" } } });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("0");
  await expect(page.getByLabel("Approval error", { exact: true })).not.toBeEmpty();
  expect(mutations).toBe(1);
  expect(receipts).toBe(1);
  expect(pageErrors).toEqual([]);
});
}

test("a failed post-decision refresh keeps the recorded decision and its own load error", async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: { cwd: "/p2/workspace-a", approvals: [approval] } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", route => {
    mutations++;
    return route.fulfill({ json: { approval: { ...approval, status: "approved" } } });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture({ failResolutionRefresh: true });
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
  await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
  await expect(page.getByLabel("Load error", { exact: true })).toHaveText("Resolution refresh failed");
  expect(mutations).toBe(1);
  expect(pageErrors).toEqual([]);
});

for (const effectStatus of ["pending", "claimed", "blocked", "effect_unknown", "completed", "missing", "malformed"] as const) {
test(`a recovered decision keeps ${effectStatus} execution reconciliation separate`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: { cwd: "/p2/workspace-a", approvals: [approval] } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => { mutations++; await route.abort("connectionclosed"); });
  await page.route(url => url.pathname === "/approvals/approval", route => route.fulfill({ json: {
    approval: { ...approval, status: "approved" },
    ...(effectStatus === "missing" ? {} : { postCommitEffects: effectStatus === "malformed" ? [null] : [{ approvalId: approval.id,
      effectKind: "owner", ownerKind: "run", ownerId: "original-run", status: effectStatus,
      revision: 2, attempts: 1, updatedAt: "2026-10-15T00:00:00.000Z" }] }),
  } }));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
  await expect(page.getByLabel("Reconciliation pending", { exact: true })).toHaveText(String(effectStatus !== "completed"));
  await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
  expect(mutations).toBe(1);
});
}

for (const transition of ["return", "reset"] as const) {
test(`${transition} workspace fences a late decision receipt from the newer pending decision`, async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let mutations = 0;
  let receipts = 0;
  let releaseReceipt!: () => void;
  let releaseCurrent!: () => void;
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve; });
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: new URL(route.request().url()).searchParams.get("cwd"), approvals: [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    if (++mutations === 1) return route.abort("connectionclosed");
    await currentGate;
    await route.fulfill({ json: { approval: { ...approval, status: "approved" } } });
  });
  await page.route(url => url.pathname === "/approvals/approval", async route => {
    receipts++;
    await receiptGate;
    await route.fulfill({ json: { approval: { ...approval, status: "approved" } } });
  });
  try {
    await page.goto("/e2e/support/p2-reading.html?manual");
    await page.evaluate(async () => {
      const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
      fixture.mountApprovalsDomainFixture();
    });
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => receipts).toBe(1);
    if (transition === "return") {
      await page.getByRole("button", { name: "Workspace B", exact: true }).click();
      await expect(page.getByLabel("Workspace", { exact: true })).toHaveText("/p2/workspace-b");
      await page.getByRole("button", { name: "Workspace A", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Reset workspace", exact: true }).click();
      await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("none");
      await page.getByRole("button", { name: "Refresh approvals", exact: true }).click();
    }
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => mutations).toBe(2);
    releaseReceipt();
    await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("0");
    releaseCurrent();
    await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("2");
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
    await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
  } finally {
    releaseReceipt();
    releaseCurrent();
  }
});
}

for (const transition of ["return", "reset"] as const) {
for (const oldOutcome of ["failed", "approved"] as const) {
test(`${transition} workspace fences an older ${oldOutcome} decision from the current pending decision`, async ({ page }) => {
  let releaseOld!: () => void;
  let releaseCurrent!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve; });
  let requests = 0;
  const approval = createApproval({ id: "approval", runId: "original-run" });
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({
    json: { cwd: new URL(route.request().url()).searchParams.get("cwd"), approvals: [approval] },
  }));
  await page.route(url => url.pathname === "/approvals/approval/approve", async route => {
    const request = ++requests;
    if (request === 1) {
      await oldGate;
      await route.fulfill(oldOutcome === "failed"
        ? { status: 503, json: { error: "Old workspace decision failed" } }
        : { json: { approval: { ...approval, status: "approved" } } });
    } else {
      await currentGate;
      await route.fulfill({ json: { approval: { ...approval, status: "approved" } } });
    }
  });
  try {
    await page.goto("/e2e/support/p2-reading.html?manual");
    await page.evaluate(async () => {
      const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
      fixture.mountApprovalsDomainFixture();
    });
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    if (transition === "return") {
      await page.getByRole("button", { name: "Workspace B", exact: true }).click();
      await expect(page.getByLabel("Workspace", { exact: true })).toHaveText("/p2/workspace-b");
      await page.getByRole("button", { name: "Workspace A", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Reset workspace", exact: true }).click();
      await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("none");
      await page.getByRole("button", { name: "Refresh approvals", exact: true }).click();
    }
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => requests).toBe(2);
    releaseOld();
    await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("1");
    await expect(page.getByLabel("Approval error", { exact: true })).toBeEmpty();
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("0");
    releaseCurrent();
    await expect(page.getByLabel("Completed decisions", { exact: true })).toHaveText("2");
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
    await expect(page.getByLabel("Resolved events", { exact: true })).toHaveText("1");
    expect(requests).toBe(2);
  } finally {
    releaseOld();
    releaseCurrent();
  }
});
}
}

test("a resolved decision remains terminal after snapshot omission and late pending reappearance", async ({ page }) => {
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let reads = 0;
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: {
    cwd: new URL(route.request().url()).searchParams.get("cwd"), approvals: ++reads === 2 ? [] : [approval],
  } }));
  await page.route(url => url.pathname === "/approvals/approval/approve", route => route.fulfill({
    json: { approval: { ...approval, status: "approved" } },
  }));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
    fixture.mountApprovalsDomainFixture();
  });
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
  await page.getByRole("button", { name: "Refresh approvals", exact: true }).click();
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("none");
  await page.getByRole("button", { name: "Refresh approvals", exact: true }).click();
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("approved");
});

test("a workspace-targeted load started before the selection commit remains current", async ({ page }) => {
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let reads = 0;
  await page.route(url => url.pathname === "/approvals", async route => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd");
    reads++;
    if (cwd === "/p2/workspace-b") await responseGate;
    await route.fulfill({ json: { cwd, approvals: [approval] } });
  });
  try {
    await page.goto("/e2e/support/p2-reading.html?manual");
    await page.evaluate(async () => {
      const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
      fixture.mountApprovalsDomainFixture({ refreshOnSwitch: false });
    });
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    await page.getByRole("button", { name: "Load workspace B", exact: true }).click();
    await expect(page.getByLabel("Workspace", { exact: true })).toHaveText("/p2/workspace-b");
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("none");
    release();
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("pending");
    expect(reads).toBe(2);
  } finally {
    release();
  }
});

test("a list from an abandoned workspace cannot apply after returning without a new load", async ({ page }) => {
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const approval = createApproval({ id: "approval", runId: "original-run" });
  let reads = 0;
  await page.route(url => url.pathname === "/approvals", async route => {
    reads++;
    await responseGate;
    await route.fulfill({ json: { cwd: "/p2/workspace-a", approvals: [approval] } });
  });
  try {
    await page.goto("/e2e/support/p2-reading.html?manual");
    await page.evaluate(async () => {
      const fixture = await import("/e2e/support/p2-approvals-domain-harness.tsx");
      fixture.mountApprovalsDomainFixture({ refreshOnSwitch: false });
    });
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: "Workspace B", exact: true }).click();
    await expect(page.getByLabel("Workspace", { exact: true })).toHaveText("/p2/workspace-b");
    await page.getByRole("button", { name: "Workspace A", exact: true }).click();
    await expect(page.getByLabel("Workspace", { exact: true })).toHaveText("/p2/workspace-a");
    release();
    await expect(page.getByLabel("Completed loads", { exact: true })).toHaveText("1");
    await expect(page.getByLabel("Approval status", { exact: true })).toHaveText("none");
    expect(reads).toBe(1);
  } finally {
    release();
  }
});
