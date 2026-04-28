export interface FileSummary {
  path: string;
  summary: string;
  updatedAt: string;
}

export class FileSummaryCache {
  private readonly summaries = new Map<string, FileSummary>();

  get(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }

  set(path: string, summary: string): FileSummary {
    const value = { path, summary, updatedAt: new Date().toISOString() };
    this.summaries.set(path, value);
    return value;
  }
}
