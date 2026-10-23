import type { WorkSummaryPullRequestBinding } from "@ling-stack/contracts";
import type { SqliteStoreContext } from "./store-context.js";

/** Project-scoped PR attachments use the same database and lifecycle as the project store. */
export class SqliteWorkSummaryStore {
  constructor(private readonly context: SqliteStoreContext) {}

  listPullRequests(): WorkSummaryPullRequestBinding[] {
    return this.context.database.prepare("SELECT url, created_at FROM work_summary_pull_requests ORDER BY created_at, url")
      .all().map((row) => ({ url: String(row.url), createdAt: String(row.created_at) }));
  }

  attachPullRequest(url: string, now: string): void {
    if (this.listPullRequests().length >= 30 && !this.listPullRequests().some((item) => item.url === url)) {
      throw new Error("A project can attach at most 30 pull requests.");
    }
    this.context.database.prepare("INSERT OR IGNORE INTO work_summary_pull_requests (url, created_at) VALUES (?, ?)").run(url, now);
  }

  detachPullRequest(url: string): void {
    this.context.database.prepare("DELETE FROM work_summary_pull_requests WHERE url = ?").run(url);
  }
}
