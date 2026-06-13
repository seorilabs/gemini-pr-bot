export class TtlSet {
  private readonly values = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  has(value: string): boolean {
    this.deleteExpired(Date.now());
    return this.values.has(value);
  }

  add(value: string): void {
    this.values.set(value, Date.now() + this.ttlMs);
  }

  delete(value: string): void {
    this.values.delete(value);
  }

  deleteExpired(now = Date.now()): void {
    for (const [value, expiresAt] of this.values.entries()) {
      if (expiresAt <= now) {
        this.values.delete(value);
      }
    }
  }
}

