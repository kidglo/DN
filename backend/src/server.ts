import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import opportunitiesRouter, { getCachedOpportunities } from './routes/opportunities.js';
import { WebSocketService } from './services/websocket.js';

const app = express();
const server = createServer(app);

// Initialize WebSocket service
const wsService = new WebSocketService(server);

// Middleware
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // In production, allow any .onrender.com origin
    if (origin.endsWith('.onrender.com')) {
      return callback(null, true);
    }
    callback(null, true); // Allow all for now
  },
  credentials: true,
}));
app.use(express.json());

// Routes
app.use('/api', opportunitiesRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start WebSocket broadcasting
wsService.startBroadcasting(() => {
  try {
    return getCachedOpportunities();
  } catch (error) {
    console.error('Error getting cached opportunities:', error);
    return { realtime: [], '7d': [], '30d': [], ytd: [] };
  }
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server running on ws://localhost:${PORT}/ws`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  wsService.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});



