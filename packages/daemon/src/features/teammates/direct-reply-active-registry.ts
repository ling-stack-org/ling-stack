export interface ActiveDirectReplyHandle {
  readonly workUnitId: string;
  readonly messageId: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly abortController: AbortController;
}

export class ActiveDirectReplyRegistry {
  private readonly handles = new Map<string, ActiveDirectReplyHandle>();

  register(handle: ActiveDirectReplyHandle): void {
    this.handles.set(handle.workUnitId, handle);
  }

  get(workUnitId: string): ActiveDirectReplyHandle | undefined {
    return this.handles.get(workUnitId);
  }

  delete(workUnitId: string): void {
    this.handles.delete(workUnitId);
  }

  findByMessage(messageId: string): ActiveDirectReplyHandle | undefined {
    return [...this.handles.values()].find((handle) => handle.messageId === messageId);
  }

  listForTeammate(teammateId: string, threadId?: string): readonly ActiveDirectReplyHandle[] {
    return [...this.handles.values()].filter((handle) => handle.teammateId === teammateId && (!threadId || handle.threadId === threadId));
  }

  cancelAll(): void {
    for (const handle of this.handles.values()) {
      handle.abortController.abort();
    }
    this.handles.clear();
  }
}
