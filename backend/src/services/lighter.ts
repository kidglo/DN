import axios from 'axios';
import type { Coin, FundingRate, Exchange, HistoricalFundingEntry } from '../../../shared/types.js';

// Lighter API base URL
// Based on Lighter Python SDK: https://github.com/elliottech/lighter-python
// The SDK shows endpoints use /api/v1/ prefix
// Mainnet: https://mainnet.zklighter.elliot.ai
const LIGHTER_API_BASE = process.env.LIGHTER_API_BASE || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_ALTERNATIVE_URLS = [
  'https://mainnet.zklighter.elliot.ai',
  'https://api.lighter.xyz',
];

export interface LighterMarket {
  market_id: string;
  base_token: string;
  quote_token: string;
  base_token_decimals: number;
  quote_token_decimals: number;
}

export class LighterClient {
  private baseUrl: string;
  private workingUrl: string | null = null;

  constructor(baseUrl: string = LIGHTER_API_BASE) {
    this.baseUrl = baseUrl;
  }

  /**
   * Try to find a working Lighter API URL
   */
  private async findWorkingUrl(): Promise<string | null> {
    // If we already found a working URL, use it
    if (this.workingUrl) {
      return this.workingUrl;
    }
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));

    // Try each URL with different endpoint paths
    // Based on Lighter Python SDK: https://github.com/elliottech/lighter-python
    // The SDK shows order_books endpoint is at: GET /api/v1/orderBooks (camelCase)
    const endpointsToTry = [
      '/api/v1/orderBooks',  // Correct endpoint from SDK (camelCase)
      '/api/v1/order_books', // snake_case variant
      '/order_books',
      '/v1/order_books',
      '/api/order_books',
    ];
    
    for (const url of LIGHTER_ALTERNATIVE_URLS) {
      // First check if DNS resolves
      let dnsWorks = false;
      try {
        await axios.get(url, { timeout: 2000, validateStatus: () => true });
        dnsWorks = true;
      } catch (err: any) {
        if (err.code === 'ENOTFOUND') {
          console.warn(`Lighter API ${url} - DNS lookup failed`);
          continue; // Skip this URL entirely
        }
        dnsWorks = true; // Other errors mean DNS worked
      }
      
      if (!dnsWorks) continue;
      
      // Try each endpoint
      for (const endpoint of endpointsToTry) {
        try {
          const fullUrl = `${url}${endpoint}`;
          const response = await axios.get(fullUrl, {
            timeout: 5000,
            validateStatus: (status) => status < 500, // Don't throw on 4xx
          });
          if (response.status === 200 && response.data) {
            this.workingUrl = url;
            console.log(`Found working Lighter API URL: ${url}${endpoint}`);
            return url;
          }
        } catch (err: any) {
          // Try next endpoint silently
          continue;
        }
      }
    }

    console.error('No working Lighter API URL found. Tried:', LIGHTER_ALTERNATIVE_URLS.join(', '));
    return null;
  }

  /**
   * Fetch all tradeable coins/markets from Lighter
   * Lighter API: GET /api/v1/orderBooks to get all markets
   */
  async getTradeableCoins(): Promise<Coin[]> {
    try {
      // Try to find a working URL first
      const workingUrl = await this.findWorkingUrl();
      if (!workingUrl) {
        throw new Error('No working Lighter API URL found');
      }

      // Lighter API: Get all markets using orderBooks endpoint
      // Based on Python SDK: GET /api/v1/orderBooks (camelCase)
      // Try the correct endpoint first, then fallback to variants
      let response: any = null;
      const endpointsToTry = [
        '/api/v1/orderBooks',  // Correct endpoint from SDK (camelCase)
        '/api/v1/order_books',  // snake_case variant
        '/order_books',
      ];
      
      for (const endpoint of endpointsToTry) {
        try {
          response = await axios.get(`${workingUrl}${endpoint}`, {
            timeout: 10000,
          });
          if (response.status === 200 && response.data) {
            console.log(`Successfully connected to Lighter API at ${workingUrl}${endpoint}`);
            break;
          }
        } catch (err: any) {
          if (err.response?.status === 404) {
            continue; // Try next endpoint
          }
          if (err.code !== 'ENOTFOUND') {
            continue; // Try next endpoint
          }
          throw err; // DNS error, rethrow
        }
      }
      
      if (!response || !response.data) {
        throw new Error('Could not fetch data from any Lighter API endpoint');
      }
      
      // Response structure from SDK: {code: 200, order_books: [...]}
      // Each item in order_books has: symbol, market_id, market_type, etc.
      let markets: any[] = [];
      
      if (Array.isArray(response.data)) {
        markets = response.data;
      } else if (response.data && typeof response.data === 'object') {
        // Check for order_books array (from SDK response format)
        if (response.data.order_books && Array.isArray(response.data.order_books)) {
          markets = response.data.order_books;
        } else if (response.data.orderBooks && Array.isArray(response.data.orderBooks)) {
          markets = response.data.orderBooks;
        } else if (response.data.markets && Array.isArray(response.data.markets)) {
          markets = response.data.markets;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          markets = response.data.data;
        }
      }
      
      console.log(`Extracted ${markets.length} markets from Lighter response`);
      
      // Extract unique base tokens as coins
      // From SDK response: each market has a 'symbol' field (e.g., "CRV", "NZDUSD")
      const coins: Coin[] = markets.map((market) => {
        // The SDK response has 'symbol' field directly on the market object
        const symbol = (
          market.symbol ||  // Primary field from SDK
          market.base_token || 
          market.baseToken || 
          market.market?.symbol ||
          market.market?.base_token ||
          market.market?.baseToken ||
          (typeof market === 'string' ? market : '')
        ).toUpperCase();
        return {
          symbol,
          exchange: 'lighter' as Exchange,
        };
      }).filter(coin => coin.symbol && coin.symbol.length > 0 && coin.symbol !== 'CODE'); // Filter out empty symbols and metadata
      
      console.log(`Extracted ${coins.length} coins from Lighter markets`);
      
      // Remove duplicates
      const uniqueCoins = Array.from(
        new Map(coins.map((coin) => [coin.symbol, coin])).values()
      );

      if (uniqueCoins.length > 0) {
        console.log(`Successfully fetched ${uniqueCoins.length} unique Lighter coins`);
        // Log ALL coin symbols for debugging missing coins
        console.log(`All Lighter coins:`, uniqueCoins.map(c => c.symbol).join(', '));
      } else {
        console.warn('No coins extracted from Lighter response. Response structure might be different.');
      }

      return uniqueCoins;
    } catch (error: any) {
      const errorMsg = error?.code === 'ENOTFOUND' 
        ? `Cannot reach Lighter API at ${this.baseUrl}. Check your internet connection and verify the API URL is correct.`
        : error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching Lighter coins:', errorMsg);
      // Return empty array instead of throwing - allows app to continue with Hyperliquid data
      console.warn('Continuing without Lighter data. App will show Hyperliquid opportunities only.');
      return [];
    }
  }

  /**
   * Fetch funding rates for all coins
   * Lighter API: GET /api/v1/funding-rates returns all current funding rates
   * 
   * Response structure:
   * { fundingRates: [{ market_id, funding_rate, funding_timestamp }, ...] }
   */
  async getFundingRates(): Promise<FundingRate[]> {
    try {
      const fundingRates: FundingRate[] = [];
      const now = Date.now();

      // Get working URL first
      const workingUrl = this.workingUrl || await this.findWorkingUrl();
      if (!workingUrl) {
        console.warn('No working Lighter URL for funding rates');
        return [];
      }

      // First, get the orderBooks to map market_id -> symbol
      let marketIdToSymbol: Map<number, string> = new Map();
      try {
        const orderBooksResponse = await axios.get(`${workingUrl}/api/v1/orderBooks`, { timeout: 10000 });
        const orderBooks = orderBooksResponse.data?.order_books || orderBooksResponse.data?.orderBooks || [];
        
        for (const market of orderBooks) {
          if (market.symbol && market.market_id !== undefined) {
            marketIdToSymbol.set(market.market_id, market.symbol.toUpperCase());
          }
        }
        console.log(`Lighter: Mapped ${marketIdToSymbol.size} market IDs to symbols`);
        // Check if specific coins are in orderBooks
        const orderBookSymbols = [...marketIdToSymbol.values()];
        const checkCoins = ['KFLOKI', 'KBONK', 'ZORA', 'IP'];
        console.log('Lighter orderBooks check:');
        for (const coin of checkCoins) {
          const found = orderBookSymbols.find(s => s === coin);
          const similar = orderBookSymbols.filter(s => s.includes(coin.replace('K', '')) || coin.includes(s));
          if (found) {
            console.log(`  ✓ ${coin} found in orderBooks`);
          } else if (similar.length > 0) {
            console.log(`  ✗ ${coin} NOT found, similar: ${similar.join(', ')}`);
          } else {
            console.log(`  ✗ ${coin} NOT found in orderBooks`);
          }
        }
      } catch (err: any) {
        console.warn('Failed to get market IDs from orderBooks:', err?.message);
      }

      // Try multiple endpoint variations for funding rates
      const fundingEndpoints = [
        '/api/v1/funding-rates',   // Primary endpoint
        '/api/v1/fundingRates',    // camelCase variant
        '/api/v1/funding_rates',   // snake_case variant
      ];

      let fundingData: any[] = [];
      
      for (const endpoint of fundingEndpoints) {
        try {
          const response = await axios.get(`${workingUrl}${endpoint}`, { 
            timeout: 10000,
            validateStatus: (status) => status < 500,
          });
          
          if (response.status === 200 && response.data) {
            // Parse the response - try different field names
            fundingData = response.data?.fundingRates || 
                         response.data?.funding_rates ||
                         response.data?.data ||
                         (Array.isArray(response.data) ? response.data : []);
            
            if (fundingData.length > 0) {
              console.log(`Lighter: Found funding rates at ${endpoint} (${fundingData.length} entries)`);
              console.log('Sample funding data:', JSON.stringify(fundingData[0]).substring(0, 200));
              break;
            }
          }
        } catch (err: any) {
          // Try next endpoint
          continue;
        }
      }

      // If no funding-rates endpoint worked, try the marketStats endpoint as fallback
      if (fundingData.length === 0) {
        console.log('Lighter: Trying marketStats endpoint for funding rates...');
        try {
          const statsResponse = await axios.get(`${workingUrl}/api/v1/marketStats`, { 
            timeout: 10000,
            validateStatus: (status) => status < 500,
          });
          
          if (statsResponse.status === 200 && statsResponse.data) {
            const stats = statsResponse.data?.market_stats || 
                         statsResponse.data?.marketStats ||
                         statsResponse.data?.data ||
                         (Array.isArray(statsResponse.data) ? statsResponse.data : []);
            
            if (stats.length > 0) {
              console.log(`Lighter: Found market stats (${stats.length} entries)`);
              console.log('Sample market stats:', JSON.stringify(stats[0]).substring(0, 300));
              
              // Map market stats to funding data format
              fundingData = stats.map((stat: any) => ({
                market_id: stat.market_id,
                funding_rate: stat.current_funding_rate || stat.funding_rate || stat.currentFundingRate || '0',
              }));
            }
          }
        } catch (err: any) {
          console.warn('Lighter: marketStats endpoint failed:', err?.message);
        }
      }

      // Create funding rate objects
      const fundingMap = new Map<string, number>();
      
      // Debug: Check what symbols are in the funding data
      const fundingSymbols = new Set<string>();
      
      for (const item of fundingData) {
        // The funding data has symbol directly in each entry
        // Use symbol from funding data first, fallback to market_id lookup
        let symbol = item.symbol?.toUpperCase();
        
        if (!symbol) {
          // Fallback to market_id lookup
          const marketId = item.market_id;
          symbol = marketIdToSymbol.get(marketId);
        }
        
        if (symbol) {
          fundingSymbols.add(symbol);
          
          // Parse the funding rate - try different field names
          let rate = 0;
          const rateValue = item.funding_rate || item.fundingRate || item.rate || item.current_funding_rate || '0';
          rate = parseFloat(rateValue);
          if (isNaN(rate)) rate = 0;
          
          // Only update if we don't have a rate yet, or if this is for "lighter" exchange
          // The API might return rates from multiple exchanges
          const exchange = item.exchange?.toLowerCase();
          if (!fundingMap.has(symbol) || exchange === 'lighter' || !exchange) {
            fundingMap.set(symbol, rate);
          }
        }
      }
      
      console.log(`Lighter: Found ${fundingSymbols.size} unique symbols in funding data`);
      // Check for 1000-prefixed coins that should match Hyperliquid's K-prefixed coins
      const coins1000 = ['1000FLOKI', '1000BONK', '1000PEPE', '1000SHIB'];
      console.log('Lighter 1000-coin check (should match Hyperliquid K coins):');
      for (const coin of coins1000) {
        if (fundingSymbols.has(coin)) {
          console.log(`  ✓ ${coin} found in Lighter (will match Hyperliquid's K${coin.substring(4)})`);
        } else {
          console.log(`  ✗ ${coin} NOT found in Lighter`);
        }
      }

      // Build final funding rates array for all known symbols
      for (const [symbol, rate] of fundingMap) {
        fundingRates.push({
          symbol,
          exchange: 'lighter',
          rate,
          timestamp: now,
          periodHours: 8, // Lighter uses 8-hour funding periods (industry standard)
        });
      }

      // Log results
      const nonZeroRates = fundingRates.filter(r => r.rate !== 0);
      console.log(`Lighter: Fetched ${fundingRates.length} funding rates (${nonZeroRates.length} non-zero)`);
      if (nonZeroRates.length > 0) {
        console.log('Sample rates:', nonZeroRates.slice(0, 3).map(r => `${r.symbol}: ${r.rate}`).join(', '));
      }
      
      return fundingRates;
    } catch (error: any) {
      const errorMsg = error?.code === 'ENOTFOUND'
        ? `Cannot reach Lighter API. Check your internet connection.`
        : error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching Lighter funding rates:', errorMsg);
      console.warn('Continuing without Lighter funding rates.');
      return [];
    }
  }

  /**
   * Fetch historical funding rates for a specific market
   * 
   * @param symbol - The symbol (e.g., "BTC", "ETH")
   * @param startTime - Start timestamp in milliseconds
   * @param endTime - End timestamp in milliseconds (optional, defaults to now)
   * @returns Array of historical funding entries
   */
  async getFundingHistory(
    symbol: string,
    startTime: number,
    endTime?: number
  ): Promise<HistoricalFundingEntry[]> {
    try {
      // Clamp to sane bounds: not before current year start and not after now
      const now = Date.now();
      const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
      const safeEnd = Math.min(endTime ?? now, now);
      const safeStart = Math.max(Math.min(startTime, safeEnd), yearStart);

      const workingUrl = this.workingUrl || await this.findWorkingUrl();
      if (!workingUrl) {
        console.warn('No working Lighter URL for funding history');
        return [];
      }

      // First, get the market_id for this symbol
      let marketId: number | null = null;
      const isKToken = symbol.startsWith('1000');
      
      try {
        const orderBooksResponse = await axios.get(`${workingUrl}/api/v1/orderBooks`, { timeout: 10000 });
        const orderBooks = orderBooksResponse.data?.order_books || orderBooksResponse.data?.orderBooks || [];
        
        // Debug: For k-tokens, show available symbols in orderBooks
        if (isKToken) {
          const allSymbols = orderBooks.map((m: any) => m.symbol).filter(Boolean);
          const matchingSymbols = allSymbols.filter((s: string) => s.toUpperCase().includes(symbol.substring(4).toUpperCase()));
          console.log(`[Lighter History] Looking for ${symbol} in orderBooks. Similar symbols: ${matchingSymbols.join(', ') || 'NONE'}`);
        }
        
        for (const market of orderBooks) {
          if (market.symbol?.toUpperCase() === symbol.toUpperCase() && market.market_id !== undefined) {
            marketId = market.market_id;
            if (isKToken) {
              console.log(`[Lighter History] Found market_id=${marketId} for ${symbol}`);
            }
            break;
          }
        }
      } catch (err: any) {
        console.warn(`Failed to get market ID for ${symbol}:`, err?.message);
        return [];
      }

      if (marketId === null) {
        if (isKToken) {
          console.warn(`[Lighter History] NO market_id found for k-token ${symbol} - THIS IS THE PROBLEM!`);
        }
        return [];
      }

      // Fetch historical funding rates using the /api/v1/fundings endpoint
      // This endpoint requires: market_id, resolution, start_timestamp, end_timestamp, count_back
      const actualEndTime = safeEnd;
      const params: Record<string, any> = {
        market_id: marketId,
        resolution: '1h',  // Use 1-hour resolution for granular data
        start_timestamp: safeStart,  // Already in milliseconds
        end_timestamp: actualEndTime,  // Already in milliseconds
        count_back: 1000,  // Request up to 1000 entries
      };

      const startDate = new Date(safeStart).toISOString().split('T')[0];
      const endDate = new Date(actualEndTime).toISOString().split('T')[0];
      console.log(`[Lighter] Fetching funding history for ${symbol} (market_id=${marketId}), ${startDate} to ${endDate}`);

      const response = await axios.get(`${workingUrl}/api/v1/fundings`, {
        params,
        timeout: 15000,
        validateStatus: (status) => status < 500,
      });

      if (response.status !== 200 || !response.data) {
        console.warn(`[Lighter] Funding history returned status ${response.status} for ${symbol}:`, JSON.stringify(response.data).substring(0, 200));
        return [];
      }
      
      // The /api/v1/fundings endpoint returns an array directly
      let fundingData: any[] = [];
      
      if (Array.isArray(response.data)) {
        fundingData = response.data;
      } else if (response.data?.fundings && Array.isArray(response.data.fundings)) {
        fundingData = response.data.fundings;
      } else if (response.data?.data && Array.isArray(response.data.data)) {
        fundingData = response.data.data;
      } else {
        // Log the response structure for debugging
        const dataKeys = typeof response.data === 'object' ? Object.keys(response.data) : [];
        console.warn(`[Lighter] Unknown response format for ${symbol}. Keys: ${dataKeys.join(', ')}. Data:`, JSON.stringify(response.data).substring(0, 300));
        return [];
      }

      console.log(`[Lighter] Got ${fundingData.length} funding entries for ${symbol}`);
      
      // Debug: Log the raw response structure to identify correct field names
      if (fundingData.length > 0) {
        const sampleEntry = fundingData[0];
        console.log(`[Lighter DEBUG] Raw entry keys for ${symbol}:`, Object.keys(sampleEntry));
        console.log(`[Lighter DEBUG] Raw entry sample for ${symbol}:`, JSON.stringify(sampleEntry));
      }
      
      const entries: HistoricalFundingEntry[] = fundingData.map((item: any, idx: number) => {
        // Parse the funding rate - try multiple possible field names
        const rateStr = item.funding_rate ?? item.fundingRate ?? item.rate ?? item.funding_rate_hourly ?? '0';
        const rate = parseFloat(rateStr);
        const direction = (item.direction || item.funding_direction || '').toString().toLowerCase();
        
        // Debug: Log first few entries to see the actual values
        if (idx < 3) {
          console.log(`[Lighter DEBUG] Entry ${idx}: funding_rate=${item.funding_rate}, fundingRate=${item.fundingRate}, rate=${item.rate}, direction=${direction}, parsed=${rate}`);
        }
        
        let signedRate = isNaN(rate) ? 0 : Math.abs(rate);
        
        // Lighter's /fundings API returns rates as percentage values (0.01 = 0.01%)
        // Convert to decimal form (0.0001 = 0.01%) by dividing by 100
        signedRate = signedRate / 100;
        
        // Debug: Log first few entries to see raw values
        if (idx < 3) {
          console.log(`[Lighter DEBUG] Entry ${idx}: Raw rate=${rate}%, converted to decimal=${signedRate}, direction=${direction}`);
        }
        
        // If direction is "short", shorts pay longs, so longs receive -> negative for shorts
        if (direction === 'short') {
          signedRate = -signedRate;
        }
        // If direction is "long", longs pay shorts, keep positive
        
        // Lighter timestamps may be in seconds - convert to milliseconds if needed
        // If timestamp < 10^12, it's likely in seconds (before year 2001 in ms)
        let timestamp = item.timestamp || 0;
        if (timestamp > 0 && timestamp < 1e12) {
          timestamp = timestamp * 1000;  // Convert seconds to milliseconds
        }
        
        return {
          symbol: symbol.toUpperCase(),
          exchange: 'lighter' as Exchange,
          rate: signedRate,  // Handle sign using direction
          timestamp,
          periodHours: 8,  // Lighter uses 8-hour funding periods (same as real-time)
        };
      }).filter((entry: HistoricalFundingEntry) => entry.timestamp && entry.timestamp > 0);

      // Log date range of returned (normalized) data
      if (entries.length > 0) {
        const timestamps = entries.map((item: any) => item.timestamp).sort((a: number, b: number) => a - b);
        const earliest = new Date(timestamps[0]).toISOString();
        const latest = new Date(timestamps[timestamps.length - 1]).toISOString();
        console.log(`[Lighter] ${symbol} data range: ${earliest} to ${latest}`);
        console.log(`[Lighter] Sample entry for ${symbol}:`, JSON.stringify(entries[0]).substring(0, 200));
      }

      return entries;
    } catch (error: any) {
      console.error(`Error fetching Lighter funding history for ${symbol}:`, error?.message || error);
      return [];
    }
  }

  /**
   * Get all market data including coins and funding rates
   */
  async getAllData(): Promise<{ coins: Coin[]; fundingRates: FundingRate[] }> {
    const [coins, fundingRates] = await Promise.all([
      this.getTradeableCoins(),
      this.getFundingRates(),
    ]);

    return { coins, fundingRates };
  }
}



