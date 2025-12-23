import axios from 'axios';
import type { Coin, FundingRate, Exchange, HistoricalFundingEntry } from '../../../shared/types.js';

const HYPERLIQUID_API_BASE = 'https://api.hyperliquid.xyz';

export interface HyperliquidMidPrice {
  coin: string;
  px: string;
}

export class HyperliquidClient {
  private baseUrl: string;
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 2000; // 2 seconds between requests to avoid rate limits

  constructor(baseUrl: string = HYPERLIQUID_API_BASE) {
    this.baseUrl = baseUrl;
  }

  /**
   * Rate limiting helper - ensures we don't make requests too quickly
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Make a request with retry logic for rate limiting
   */
  private async makeRequest(data: any, retries: number = 2): Promise<any> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.rateLimit();
        const response = await axios.post(`${this.baseUrl}/info`, data, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return response;
      } catch (error: any) {
        // Handle 422 (bad request format) - don't retry, just return empty
        if (error.response?.status === 422) {
          console.warn(`Hyperliquid API 422 error (bad request format) for:`, JSON.stringify(data));
          throw new Error(`Invalid request format: ${error.response?.data || 'Unknown error'}`);
        }
        if (error.response?.status === 429) {
          // Rate limited - wait and retry
          const retryAfter = error.response.headers['retry-after'] 
            ? parseInt(error.response.headers['retry-after']) * 1000 
            : Math.pow(2, i) * 2000; // Exponential backoff: 2s, 4s
          console.warn(`Rate limited. Waiting ${retryAfter}ms before retry ${i + 1}/${retries}`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        }
        // For other errors, throw immediately
        throw error;
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Fetch all tradeable coins from Hyperliquid
   * Uses metaAndAssetCtxs endpoint to get coin list from universe
   */
  async getTradeableCoins(): Promise<Coin[]> {
    try {
      // Use metaAndAssetCtxs to get the universe of tradeable coins
      const response = await this.makeRequest({
        type: 'metaAndAssetCtxs',
      });

      const responseData = response.data;
      
      // Response is an array: [metadata, assetContexts]
      // We only need metadata.universe for coin names
      if (!Array.isArray(responseData) || responseData.length < 1) {
        console.warn('Unexpected Hyperliquid response format:', JSON.stringify(responseData).substring(0, 200));
        return [];
      }

      const metadata = responseData[0];
      const universe = metadata?.universe || [];
      
      if (!Array.isArray(universe)) {
        console.warn('Hyperliquid universe is not an array');
        return [];
      }
      
      console.log(`Extracted ${universe.length} coins from Hyperliquid universe`);
      
      const coins: Coin[] = universe
        .map((coinInfo: any) => {
          const coinName = coinInfo?.name;
          return coinName ? {
            symbol: coinName.toUpperCase(),
            exchange: 'hyperliquid' as Exchange,
          } : null;
        })
        .filter((coin): coin is Coin => coin !== null);

      return coins;
    } catch (error: any) {
      console.error('Error fetching Hyperliquid coins:', error?.message || error);
      console.warn('Continuing without Hyperliquid data.');
      return [];
    }
  }

  /**
   * Fetch funding rates for all coins
   * Hyperliquid API: Use metaAndAssetCtxs to get current funding rates
   * 
   * Response structure: [metadata, assetContexts]
   * - metadata.universe[i].name = coin symbol
   * - assetContexts[i].funding = funding rate (hourly)
   */
  async getFundingRates(): Promise<FundingRate[]> {
    try {
      const fundingRates: FundingRate[] = [];
      const now = Date.now();

      // Fetch meta and asset contexts - this gives us both coin names and funding rates
      let metaResponse;
      try {
        metaResponse = await this.makeRequest({
          type: 'metaAndAssetCtxs',
        }, 2);
      } catch (err: any) {
        console.warn('Failed to fetch metaAndAssetCtxs:', err?.message);
        return [];
      }

      const responseData = metaResponse.data;
      
      // The response is an array: [metadata, assetContexts]
      // metadata contains { universe: [...] } with coin info
      // assetContexts is an array with funding rates at matching indices
      if (!Array.isArray(responseData) || responseData.length < 2) {
        console.warn('Unexpected Hyperliquid metaAndAssetCtxs response format:', 
          JSON.stringify(responseData).substring(0, 200));
        return [];
      }

      const metadata = responseData[0];
      const assetCtxs = responseData[1];

      // Get the universe array with coin names
      const universe = metadata?.universe || [];
      
      if (!Array.isArray(universe) || !Array.isArray(assetCtxs)) {
        console.warn('Invalid universe or assetCtxs structure');
        return [];
      }

      // Debug: log sample data
      if (universe.length > 0 && assetCtxs.length > 0) {
        console.log(`Hyperliquid: Found ${universe.length} coins in universe, ${assetCtxs.length} asset contexts`);
        console.log('Sample universe[0]:', JSON.stringify(universe[0]));
        console.log('Sample assetCtxs[0]:', JSON.stringify(assetCtxs[0]).substring(0, 300));
      }

      // Match by index: universe[i].name corresponds to assetCtxs[i]
      for (let i = 0; i < universe.length && i < assetCtxs.length; i++) {
        const coinInfo = universe[i];
        const assetCtx = assetCtxs[i];
        
        const symbol = coinInfo?.name?.toUpperCase();
        if (!symbol) continue;

        // Get funding rate from the 'funding' field
        // Hyperliquid returns funding as a string like "0.0000125" (hourly rate)
        let rate = 0;
        if (assetCtx?.funding !== undefined && assetCtx?.funding !== null) {
          rate = parseFloat(assetCtx.funding);
          if (isNaN(rate)) rate = 0;
        }

        fundingRates.push({
          symbol,
          exchange: 'hyperliquid',
          rate,
          timestamp: now,
          periodHours: 1, // Hyperliquid uses hourly funding rates
        });
      }

      // Log some sample rates for debugging
      const nonZeroRates = fundingRates.filter(r => r.rate !== 0);
      console.log(`Fetched ${fundingRates.length} Hyperliquid funding rates (${nonZeroRates.length} non-zero)`);
      if (nonZeroRates.length > 0) {
        console.log('Sample rates:', nonZeroRates.slice(0, 3).map(r => `${r.symbol}: ${r.rate}`).join(', '));
      }
      
      // Check for K-prefixed coins that should match Lighter's 1000-prefixed coins
      const hlSymbols = new Set(fundingRates.map(r => r.symbol));
      const kCoins = ['KFLOKI', 'KBONK', 'KPEPE', 'KSHIB'];
      console.log('Hyperliquid K-coin check (should match Lighter 1000 coins):');
      for (const coin of kCoins) {
        if (hlSymbols.has(coin)) {
          console.log(`  ✓ ${coin} found in Hyperliquid (will match Lighter's 1000${coin.substring(1)})`);
        } else {
          console.log(`  ✗ ${coin} NOT found in Hyperliquid`);
        }
      }

      return fundingRates;
    } catch (error: any) {
      console.error('Error fetching Hyperliquid funding rates:', error?.message || error);
      return [];
    }
  }

  /**
   * Fetch historical funding rates for a specific coin
   * 
   * @param coin - The coin symbol (e.g., "BTC", "ETH")
   * @param startTime - Start timestamp in milliseconds
   * @param endTime - End timestamp in milliseconds (optional, defaults to now)
   * @returns Array of historical funding entries
   */
  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime?: number
  ): Promise<HistoricalFundingEntry[]> {
    try {
      // K-tokens can be uppercase (KFLOKI) or lowercase (kFLOKI) - check both
      // Exclude KAITO which starts with KA
      const isKToken = (coin.startsWith('K') || coin.startsWith('k')) && coin.length > 1 && coin[1].toUpperCase() !== 'A';
      // Clamp time bounds so we never query before the current year start or after now
      const now = Date.now();
      const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
      const safeEnd = Math.min(endTime ?? now, now);
      const safeStart = Math.max(Math.min(startTime, safeEnd), yearStart);

      const startDate = new Date(safeStart).toISOString().split('T')[0];
      const endDate = new Date(safeEnd).toISOString().split('T')[0];
      
      if (isKToken) {
        console.log(`[HL History] Fetching K-token ${coin}, ${startDate} to ${endDate}`);
      }

      const requestPayloadMs = {
        type: 'fundingHistory',
        coin: coin,  // Keep case as-is (lowercase k for k-tokens like kBONK, kPEPE)
        startTime: safeStart,
        endTime: safeEnd,
      };

      if (isKToken) {
        console.log(`[HL History] K-token ${coin} request (ms):`, JSON.stringify(requestPayloadMs));
      }

      const performRequest = async (payload: any, attemptLabel: string) => {
        try {
          return await this.makeRequest(payload);
        } catch (err: any) {
          const status = err?.response?.status;
          const msg = err?.message || err;
          console.warn(`[HL History] ${coin} ${attemptLabel} failed (status ${status ?? 'n/a'}): ${msg}`);
          throw err;
        }
      };

      let response: any;
      try {
        response = await performRequest(requestPayloadMs, 'ms');
      } catch (err: any) {
        // Hyperliquid sometimes 500s on ms timestamps; retry once with seconds
        const requestPayloadSec = {
          ...requestPayloadMs,
          startTime: Math.floor(safeStart / 1000),
          endTime: Math.floor(safeEnd / 1000),
        };
        if (isKToken) {
          console.log(`[HL History] Retrying ${coin} request with seconds:`, JSON.stringify(requestPayloadSec));
        } else {
          console.warn(`[HL History] Retrying ${coin} with seconds after ms failure`);
        }
        try {
          response = await performRequest(requestPayloadSec, 'seconds');
        } catch {
          return [];
        }
      }

      const data = response.data;
      
      if (!Array.isArray(data)) {
        if (isKToken) {
          console.warn(`[HL History] K-token ${coin} got NON-ARRAY response:`, JSON.stringify(data).substring(0, 200));
        }
        return [];
      }

      const entries: HistoricalFundingEntry[] = data.map((item: any) => {
        const rate = parseFloat(item.fundingRate);
        const rawTime = item.time ?? item.timestamp ?? item.ts ?? 0;
        let timestamp = typeof rawTime === 'string' ? parseFloat(rawTime) : rawTime;
        if (!timestamp || Number.isNaN(timestamp)) {
          timestamp = 0;
        }
        // Normalize seconds to milliseconds
        if (timestamp > 0 && timestamp < 1e12) {
          timestamp = timestamp * 1000;
        }

        return {
          symbol: item.coin?.toUpperCase() || coin.toUpperCase(),
          exchange: 'hyperliquid' as Exchange,
          rate: isNaN(rate) ? 0 : rate,  // Handle NaN but preserve negative values
          timestamp,
          periodHours: 1, // Hyperliquid uses hourly funding
        };
      }).filter(entry => entry.timestamp > 0);

      // Log date range of returned data
      if (entries.length > 0) {
        const timestamps = entries.map(e => e.timestamp).sort((a, b) => a - b);
        const earliest = new Date(timestamps[0]).toISOString();
        const latest = new Date(timestamps[timestamps.length - 1]).toISOString();
        if (isKToken) {
          console.log(`[HL History] K-token ${coin} got ${entries.length} entries, range: ${earliest} to ${latest}`);
        }
      } else if (isKToken) {
        console.log(`[HL History] K-token ${coin} got 0 entries`);
      }

      return entries;
    } catch (error: any) {
      console.error(`[HL] Error fetching funding history for ${coin}:`, error?.message || error);
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



