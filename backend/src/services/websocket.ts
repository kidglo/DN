import { WebSocketServer, WebSocket } from 'ws';
import type { OpportunitiesByPeriod } from '../../../shared/types.js';

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(server: any) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`WebSocket client connected. Total clients: ${this.clients.size}`);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`WebSocket client disconnected. Total clients: ${this.clients.size}`);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Broadcast opportunities to all connected clients
   */
  broadcastOpportunities(opportunities: OpportunitiesByPeriod) {
    const message = JSON.stringify({
      type: 'opportunities',
      data: opportunities,
      timestamp: Date.now(),
    });

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error sending WebSocket message:', error);
          this.clients.delete(client);
        }
      }
    });
  }

  /**
   * Start periodic broadcasting
   */
  startBroadcasting(getOpportunities: () => OpportunitiesByPeriod) {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    // Broadcast every 10 seconds
    this.updateInterval = setInterval(() => {
      const opportunities = getOpportunities();
      this.broadcastOpportunities(opportunities);
    }, 10000);
  }

  /**
   * Stop broadcasting
   */
  stopBroadcasting() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Close all connections
   */
  close() {
    this.stopBroadcasting();
    this.clients.forEach((client) => {
      client.close();
    });
    this.clients.clear();
    this.wss.close();
  }
}



