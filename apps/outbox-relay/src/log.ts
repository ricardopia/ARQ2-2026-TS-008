export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'outbox-relay', ...fields }));
}
