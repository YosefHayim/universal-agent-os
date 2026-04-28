export interface QueueItem {
  taskId: string;
  createdAt: string;
}

export class InMemoryQueue {
  private readonly items: QueueItem[] = [];

  enqueue(taskId: string): QueueItem {
    const item = { taskId, createdAt: new Date().toISOString() };
    this.items.push(item);
    return item;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  list(): QueueItem[] {
    return [...this.items];
  }
}

export class TaskQueue {
  private readonly queue = new InMemoryQueue();

  constructor(_paths: unknown) {}

  async enqueue(taskId: string, _status: string): Promise<QueueItem> {
    const existing = this.queue.list().find((item) => item.taskId === taskId);
    return existing ?? this.queue.enqueue(taskId);
  }

  async update(taskId: string, status: string): Promise<QueueItem> {
    return this.enqueue(taskId, status);
  }

  async list(): Promise<QueueItem[]> {
    return this.queue.list();
  }
}
