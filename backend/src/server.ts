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
// Configure CORS for production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow all origins in development, or check allowlist in production
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.some(allowed => origin.includes(allowed.replace('https://', '').replace('http://', '')))) {
      return callback(null, true);
    }
    // In production, allow any .onrender.com origin
    if (origin.endsWith('.onrender.com')) {
      return callback(null, true);
    }
    callback(null, true); // Allow all for now - can restrict later
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



