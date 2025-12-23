import { Router } from 'express';
import { LighterClient } from '../services/lighter.js';
import { HyperliquidClient } from '../services/hyperliquid.js';
import { OpportunityCalculator } from '../services/opportunityCalculator.js';
import { HistoricalFundingService } from '../services/historicalFunding.js';
import type { ArbitrageOpportunity, Coin, OpportunitiesByPeriod } from '../../../shared/types.js';

const router = Router();
const lighterClient = new LighterClient();
const hyperliquidClient = new HyperliquidClient();
const historicalFundingService = new HistoricalFundingService(hyperliquidClient, lighterClient);

// Clear historical cache on startup to ensure fresh data
historicalFundingService.clearCache();
console.log('[Opportunities] Starting with fresh historical cache');

// Cache for opportunities by period
let cachedOpportunities: OpportunitiesByPeriod = {
  realtime: [],
  '7d': [],
  '30d': [],
  ytd: [],
};
let cachedCoins: { lighter: Coin[]; hyperliquid: Coin[] } = {
  lighter: [],
  hyperliquid: [],
};
let lastUpdate = 0;
let lastHistoricalUpdate = 0;
const CACHE_TTL = 60000; // 60 seconds for realtime data
const HISTORICAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour for historical data

async function refreshOpportunities() {
  try {
    // Fetch from both APIs, but don't fail if one fails
    const [lighterResult, hyperliquidResult] = await Promise.allSettled([
      lighterClient.getAllData(),
      hyperliquidClient.getAllData(),
    ]);

    const lighterData = lighterResult.status === 'fulfilled' ? lighterResult.value : { coins: [], fundingRates: [] };
    const hyperliquidData = hyperliquidResult.status === 'fulfilled' ? hyperliquidResult.value : { coins: [], fundingRates: [] };

    if (lighterResult.status === 'rejected') {
      const error = lighterResult.reason?.message || 'Unknown error';
      console.warn('Lighter API failed:', error);
    }
    if (hyperliquidResult.status === 'rejected') {
      const error = hyperliquidResult.reason?.message || 'Unknown error';
      console.warn('Hyperliquid API failed:', error);
    }

    cachedCoins = {
      lighter: lighterData.coins,
      hyperliquid: hyperliquidData.coins,
    };

    console.log(`Fetched ${lighterData.coins.length} Lighter coins, ${hyperliquidData.coins.length} Hyperliquid coins`);
    console.log(`Fetched ${lighterData.fundingRates.length} Lighter funding rates, ${hyperliquidData.fundingRates.length} Hyperliquid funding rates`);
    
    // Debug: Show coin overlap between exchanges
    const lighterSymbols = new Set(lighterData.fundingRates.map(r => r.symbol.toUpperCase()));
    const hlSymbols = new Set(hyperliquidData.fundingRates.map(r => r.symbol.toUpperCase()));
    const commonSymbols = [...lighterSymbols].filter(s => hlSymbols.has(s));
    const lighterOnly = [...lighterSymbols].filter(s => !hlSymbols.has(s));
    const hlOnly = [...hlSymbols].filter(s => !lighterSymbols.has(s));
    
    console.log(`Common symbols (${commonSymbols.length}): ${commonSymbols.slice(0, 20).join(', ')}${commonSymbols.length > 20 ? '...' : ''}`);
    console.log(`Lighter-only (${lighterOnly.length}): ${lighterOnly.join(', ')}`);
    console.log(`Hyperliquid-only (${hlOnly.length}): ${hlOnly.slice(0, 20).join(', ')}${hlOnly.length > 20 ? '...' : ''}`);

    // Calculate realtime opportunities
    const realtimeOpportunities = OpportunityCalculator.calculateOpportunities(
      lighterData.fundingRates,
      hyperliquidData.fundingRates
    );

    // Update the realtime cache
    cachedOpportunities.realtime = realtimeOpportunities;
    lastUpdate = Date.now();
    
    console.log(`Found ${realtimeOpportunities.length} realtime arbitrage opportunities`);

    // Fetch historical data in background if cache is stale
    if (Date.now() - lastHistoricalUpdate > HISTORICAL_CACHE_TTL && realtimeOpportunities.length > 0) {
      // Run in background but catch errors
      refreshHistoricalData(realtimeOpportunities).catch(err => {
        console.error('Background historical refresh failed:', err);
      });
    }
  } catch (error) {
    console.error('Error refreshing opportunities:', error);
  }
}

// Refresh historical funding data in the background
async function refreshHistoricalData(realtimeOpportunities: ArbitrageOpportunity[]) {
  console.log('Starting background refresh of historical funding data...');
  lastHistoricalUpdate = Date.now();
  
  try {
    // Get all symbols from realtime opportunities
    const symbols = realtimeOpportunities.map(opp => opp.symbol);
    const now = Date.now();
    
    // Debug: Check if k-tokens are in realtime opportunities
    const kTokensInRealtime = symbols.filter(s => s.startsWith('1000') || s.startsWith('K'));
    console.log(`[Historical] Total symbols: ${symbols.length}, K-tokens in realtime: ${kTokensInRealtime.join(', ') || 'NONE'}`);
    if (kTokensInRealtime.length === 0) {
      console.log('[Historical] WARNING: No k-tokens found in realtime opportunities!');
    }

    // Fetch average rates for each period
    // Note: YTD skipped because Lighter only has ~1 month of historical data
    console.log('Fetching 7D average rates...');
    const rates7d = await historicalFundingService.getAverageRatesForPeriod(symbols, '7d');
    
    console.log('Fetching 30D average rates...');
    const rates30d = await historicalFundingService.getAverageRatesForPeriod(symbols, '30d');

    // Calculate opportunities for each period
    // For historical periods, we need symbols that exist on BOTH exchanges
    const symbolsOnBoth7d = symbols.filter(s => 
      rates7d.lighter.has(s) && rates7d.hyperliquid.has(s)
    );
    const symbolsOnBoth30d = symbols.filter(s => 
      rates30d.lighter.has(s) && rates30d.hyperliquid.has(s)
    );

    console.log(`Historical symbols with data on BOTH exchanges: 7D=${symbolsOnBoth7d.length}, 30D=${symbolsOnBoth30d.length}`);
    
    // Debug k-tokens specifically
    const kTokenSymbols = symbols.filter(s => s.startsWith('1000') || s.startsWith('K'));
    if (kTokenSymbols.length > 0) {
      console.log(`[DEBUG] K-token symbols from realtime: ${kTokenSymbols.join(', ')}`);
      for (const kt of kTokenSymbols) {
        const lt7d = rates7d.lighter.has(kt);
        const hl7d = rates7d.hyperliquid.has(kt);
        console.log(`  ${kt}: 7D Lighter=${lt7d}, Hyperliquid=${hl7d}, both=${lt7d && hl7d}`);
      }
    }

    // Build rate maps only for symbols on both exchanges
    const buildRateMaps = (lighterMap: Map<string, number>, hlMap: Map<string, number>, symbolList: string[]) => {
      const lighter = new Map<string, number>();
      const hl = new Map<string, number>();
      
      for (const symbol of symbolList) {
        const lighterRate = lighterMap.get(symbol);
        const hlRate = hlMap.get(symbol);
        if (lighterRate !== undefined && hlRate !== undefined) {
          lighter.set(symbol, lighterRate);
          hl.set(symbol, hlRate);
        }
      }
      
      return { lighter, hl };
    };

    const rates7dMaps = buildRateMaps(rates7d.lighter, rates7d.hyperliquid, symbolsOnBoth7d);
    const rates30dMaps = buildRateMaps(rates30d.lighter, rates30d.hyperliquid, symbolsOnBoth30d);

    cachedOpportunities['7d'] = OpportunityCalculator.calculateOpportunitiesFromRates(
      rates7dMaps.lighter,
      rates7dMaps.hl,
      now,
      rates7d.dataStartDates
    );

    cachedOpportunities['30d'] = OpportunityCalculator.calculateOpportunitiesFromRates(
      rates30dMaps.lighter,
      rates30dMaps.hl,
      now,
      rates30d.dataStartDates
    );

    // YTD skipped - Lighter only has ~1 month of historical data
    cachedOpportunities.ytd = [];

    console.log(`Historical data refreshed: 7D=${cachedOpportunities['7d'].length}, 30D=${cachedOpportunities['30d'].length}`);
  } catch (error) {
    console.error('Error refreshing historical data:', error);
  }
}

// Initial refresh
refreshOpportunities();

// Refresh periodically
setInterval(refreshOpportunities, CACHE_TTL);

router.get('/opportunities', async (req, res) => {
  try {
    // Refresh if cache is stale
    if (Date.now() - lastUpdate > CACHE_TTL) {
      await refreshOpportunities();
    }

    res.json({
      opportunities: cachedOpportunities,
      lastUpdated: lastUpdate,
      lighterAvailable: cachedCoins.lighter.length > 0,
      hyperliquidAvailable: cachedCoins.hyperliquid.length > 0,
    });
  } catch (error) {
    console.error('Error fetching opportunities:', error);
    res.status(500).json({
      error: 'Failed to fetch opportunities',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/coins', async (req, res) => {
  try {
    // Refresh if cache is stale
    if (Date.now() - lastUpdate > CACHE_TTL) {
      await refreshOpportunities();
    }

    res.json({
      lighter: cachedCoins.lighter,
      hyperliquid: cachedCoins.hyperliquid,
      lastUpdated: lastUpdate,
    });
  } catch (error) {
    console.error('Error fetching coins:', error);
    res.status(500).json({
      error: 'Failed to fetch coins',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    lastUpdate,
  });
});

// Export function to get cached opportunities for WebSocket
export function getCachedOpportunities(): OpportunitiesByPeriod {
  return cachedOpportunities;
}

export default router;


