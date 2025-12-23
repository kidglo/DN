# Delta-Neutral Funding Rate Arbitrage Finder

A web application that finds and displays the best delta-neutral funding rate arbitrage opportunities between Lighter and Hyperliquid exchanges.

## Features

- 🔍 Fetches all tradeable coins from both Lighter and Hyperliquid exchanges
- 📊 Calculates delta-neutral APR opportunities (long on one exchange, short on the other)
- 📈 Real-time updates via WebSocket
- 🎯 Sortable and filterable table interface
- 💰 Displays net APR sorted by highest opportunity first

## Quick Start

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

1. Install all dependencies:
   ```bash
   npm run install:all
   ```

### Running the Application

**Option 1: Using Batch Files (Windows)**

1. Start the backend:
   - Double-click `START_BACKEND.bat`
   - Or run it from Command Prompt

2. Start the frontend:
   - Double-click `START_FRONTEND.bat`
   - Or run it from Command Prompt

**Option 2: Using Terminal**

1. Start the backend:
   ```bash
   npm run dev:backend
   ```

2. Start the frontend (in a new terminal):
   ```bash
   npm run dev:frontend
   ```

### Accessing the Application

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- WebSocket: ws://localhost:3001/ws

## How It Works

1. **Data Collection**: The backend fetches tradeable coins and funding rates from both exchanges
2. **Opportunity Calculation**: For each coin available on both exchanges, calculates:
   - Direction 1: Long on Lighter, Short on Hyperliquid
   - Direction 2: Long on Hyperliquid, Short on Lighter
   - Selects the direction with the highest net APR
3. **Display**: Opportunities are displayed in a sortable table, sorted by highest net APR by default

## Project Structure

```
DN/
├── backend/          # Node.js/Express backend
│   └── src/
│       ├── services/ # API clients and calculation logic
│       ├── routes/   # REST API endpoints
│       └── server.ts # Main server file
├── frontend/         # React frontend
│   └── src/
│       ├── components/ # React components
│       └── hooks/      # Custom React hooks
└── shared/           # Shared TypeScript types
```

## Troubleshooting

- **Backend won't start**: Make sure port 3001 is not in use
- **Frontend won't start**: Make sure port 3000 is not in use
- **No opportunities shown**: Check the backend console for API connection errors
- **Funding rates show 0.0000%**: The APIs may not be returning funding rate data, or the parsing needs adjustment

## Notes

- The application gracefully handles API failures - if one exchange is unavailable, it will continue with data from the other
- Funding rates are cached for 60 seconds to reduce API calls
- WebSocket provides real-time updates every 10 seconds



