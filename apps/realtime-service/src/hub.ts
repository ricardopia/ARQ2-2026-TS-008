/** A connected socket as the hub sees it (decoupled from `ws` for testing). */
export interface HubClient {
  readonly id: string;
  readonly userId: string;
  send(frame: string): void;
}

/** Board subscriptions: boardId -> clients. Only the event's board is ever touched. */
export class Hub {
  private readonly byBoard = new Map<string, Set<HubClient>>();
  private readonly byClient = new Map<HubClient, Set<string>>();

  /** Returns true when the subscription is new. */
  subscribe(client: HubClient, boardId: string): boolean {
    let boards = this.byClient.get(client);
    if (!boards) {
      boards = new Set();
      this.byClient.set(client, boards);
    }
    if (boards.has(boardId)) return false;
    boards.add(boardId);
    let clients = this.byBoard.get(boardId);
    if (!clients) {
      clients = new Set();
      this.byBoard.set(boardId, clients);
    }
    clients.add(client);
    return true;
  }

  /** Drops every subscription of a client; returns how many were removed. */
  remove(client: HubClient): number {
    const boards = this.byClient.get(client);
    if (!boards) return 0;
    for (const boardId of boards) {
      const clients = this.byBoard.get(boardId);
      clients?.delete(client);
      if (clients?.size === 0) this.byBoard.delete(boardId);
    }
    this.byClient.delete(client);
    return boards.size;
  }

  subscriptionCount(client: HubClient): number {
    return this.byClient.get(client)?.size ?? 0;
  }

  /** Sends a frame to the sockets subscribed to the board; returns how many received it. */
  broadcast(boardId: string, frame: string): number {
    const clients = this.byBoard.get(boardId);
    if (!clients) return 0;
    let sent = 0;
    for (const client of clients) {
      try {
        client.send(frame);
        sent += 1;
      } catch {
        // A dying socket is cleaned up by its own close handler.
      }
    }
    return sent;
  }
}
