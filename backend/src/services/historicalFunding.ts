import type { HistoricalFundingEntry, Exchange, TimePeriod } from '../../../shared/types.js';
import { HyperliquidClient } from './hyperliquid.js';
import { LighterClient } from './lighter.js';

export interface HistoricalAPRs {
  apr7d?: number;
  apr30d?: number;
  aprYtd?: number;
}

export interface AverageRates {
  lighter: Map<string, number>;  // symbol -> average hourly rate
  hyperliquid: Map<string, number>;  // symbol -> average hourly rate
  dataStartDates: Map<string, number>;  // symbol -> earliest data timestamp (min of both exchanges)
}

interface CacheEntry {
  data: HistoricalAPRs;
  timestamp: number;
}

interface RatesCacheEntry {
  data: AverageRates;
  timestamp: number;
}

// Cache duration: 24 hours in milliseconds
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;
// Rates cache duration: 1 hour (more frequent updates for tabs)
const RATES_CACHE_DURATION_MS = 60 * 60 * 1000;

// Time periods in milliseconds
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class HistoricalFundingService {
  private hyperliquidClient: HyperliquidClient;
  private lighterClient: LighterClient;
  private cache: Map<string, CacheEntry> = new Map();
  private ratesCache: Map<string, RatesCacheEntry> = new Map();
  private isRefreshing: boolean = false;

  constructor(hyperliquidClient: HyperliquidClient, lighterClient: LighterClient) {
    this.hyperliquidClient = hyperliquidClient;
    this.lighterClient = lighterClient;
  }

  /**
   * Get the start of the current year in milliseconds
   */
  private getYearStartMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), 0, 1).getTime();
  }

  /**
   * Clear all caches to force fresh data fetch
   */
  clearCache(): void {
    this.cache.clear();
    this.ratesCache.clear();
    console.log('[HistoricalFunding] Cache cleared');
  }

  /**
   * Normalize a funding rate to hourly period for fair comparison
   */
  private normalizeToHourly(rate: number, periodHours: number): number {
    return rate / periodHours;
  }

  /**
   * Convert a funding rate to APR (Annual Percentage Rate)
   * Assumes the rate is already normalized to hourly
   */
  private annualizeFundingRate(hourlyRate: number): number {
    const periodsPerYear = 24 * 365; // 8760 hours per year
    return hourlyRate * periodsPerYear * 100; // Convert to percentage
  }

  /**
   * Normalize symbol from Lighter format to Hyperliquid format
   * Lighter uses "1000" prefix (1000FLOKI) while Hyperliquid uses "k" prefix (kFLOKI)
   * Note: Hyperliquid's fundingHistory API requires lowercase 'k' (kBONK, not KBONK)
   */
  private lighterToHyperliquidSymbol(lighterSymbol: string): string {
    if (lighterSymbol.startsWith('1000')) {
      return 'k' + lighterSymbol.substring(4); // Remove "1000" and add lowercase "k"
    }
    return lighterSymbol;
  }

  /**
   * Calculate average APR from historical funding entries
   * 
   * @param hlEntries - Historical entries from Hyperliquid
   * @param ltEntries - Historical entries from Lighter
   * @param longExchange - Which exchange is long in the arbitrage
   * @returns Average net APR for the period, or undefined if insufficient data
   */
  private calculateAverageNetAPR(
    hlEntries: HistoricalFundingEntry[],
    ltEntries: HistoricalFundingEntry[],
    longExchange: Exchange
  ): number | undefined {
    if (hlEntries.length === 0 && ltEntries.length === 0) {
      return undefined;
    }

    // Normalize all rates to hourly
    const hlHourlyRates = hlEntries.map(e => this.normalizeToHourly(e.rate, e.periodHours));
    const ltHourlyRates = ltEntries.map(e => this.normalizeToHourly(e.rate, e.periodHours));

    // Calculate average hourly rate for each exchange
    const hlAvgHourly = hlHourlyRates.length > 0 
      ? hlHourlyRates.reduce((sum, r) => sum + r, 0) / hlHourlyRates.length 
      : 0;
    const ltAvgHourly = ltHourlyRates.length > 0 
      ? ltHourlyRates.reduce((sum, r) => sum + r, 0) / ltHourlyRates.length 
      : 0;

    // Calculate net rate based on position direction
    // When long, you pay the funding rate (if positive)
    // When short, you receive the funding rate (if positive)
    // Net benefit = shortRate - longRate
    let netHourlyRate: number;
    if (longExchange === 'hyperliquid') {
      // Long HL, Short LT: net = LT - HL
      netHourlyRate = ltAvgHourly - hlAvgHourly;
    } else {
      // Long LT, Short HL: net = HL - LT
      netHourlyRate = hlAvgHourly - ltAvgHourly;
    }

    return this.annualizeFundingRate(netHourlyRate);
  }

  /**
   * Fetch historical funding data and calculate APRs for a symbol
   */
  async fetchHistoricalAPRs(
    symbol: string,
    longExchange: Exchange
  ): Promise<HistoricalAPRs> {
    const now = Date.now();
    const sevenDaysAgo = now - SEVEN_DAYS_MS;
    const thirtyDaysAgo = now - THIRTY_DAYS_MS;
    const yearStart = this.getYearStartMs();

    try {
      // Fetch historical data from both exchanges in parallel
      // Use the longest period needed (YTD or 30 days, whichever is longer)
      const longestStartTime = Math.min(yearStart, thirtyDaysAgo);

      const [hlHistory, ltHistory] = await Promise.all([
        this.hyperliquidClient.getFundingHistory(symbol, longestStartTime, now),
        this.lighterClient.getFundingHistory(symbol, longestStartTime, now),
      ]);

      // Filter entries for each time period
      const hl7d = hlHistory.filter(e => e.timestamp >= sevenDaysAgo);
      const lt7d = ltHistory.filter(e => e.timestamp >= sevenDaysAgo);

      const hl30d = hlHistory.filter(e => e.timestamp >= thirtyDaysAgo);
      const lt30d = ltHistory.filter(e => e.timestamp >= thirtyDaysAgo);

      const hlYtd = hlHistory.filter(e => e.timestamp >= yearStart);
      const ltYtd = ltHistory.filter(e => e.timestamp >= yearStart);

      // Calculate APRs for each period
      const result: HistoricalAPRs = {};

      // Only calculate if we have data from at least one exchange
      if (hl7d.length > 0 || lt7d.length > 0) {
        result.apr7d = this.calculateAverageNetAPR(hl7d, lt7d, longExchange);
      }

      if (hl30d.length > 0 || lt30d.length > 0) {
        result.apr30d = this.calculateAverageNetAPR(hl30d, lt30d, longExchange);
      }

      if (hlYtd.length > 0 || ltYtd.length > 0) {
        result.aprYtd = this.calculateAverageNetAPR(hlYtd, ltYtd, longExchange);
      }

      return result;
    } catch (error: any) {
      console.error(`Error fetching historical APRs for ${symbol}:`, error?.message || error);
      return {};
    }
  }

  /**
   * Get historical APRs for a symbol, using cache if available
   */
  async getHistoricalAPRs(
    symbol: string,
    longExchange: Exchange
  ): Promise<HistoricalAPRs> {
    const cacheKey = `${symbol}-${longExchange}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // Return cached data if still valid
    if (cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
      return cached.data;
    }

    // Fetch fresh data
    const data = await this.fetchHistoricalAPRs(symbol, longExchange);

    // Cache the result
    this.cache.set(cacheKey, {
      data,
      timestamp: now,
    });

    return data;
  }

  /**
   * Get historical APRs for multiple symbols
   * Fetches sequentially to avoid rate limits
   */
  async getHistoricalAPRsForSymbols(
    symbols: Array<{ symbol: string; longExchange: Exchange }>
  ): Promise<Map<string, HistoricalAPRs>> {
    const results = new Map<string, HistoricalAPRs>();

    for (const { symbol, longExchange } of symbols) {
      try {
        const aprs = await this.getHistoricalAPRs(symbol, longExchange);
        results.set(symbol, aprs);
        
        // Small delay to avoid rate limits (200ms between requests)
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        console.error(`Error getting historical APRs for ${symbol}:`, error?.message);
        results.set(symbol, {});
      }
    }

    return results;
  }

  /**
   * Refresh all cached data in the background
   * Call this periodically (e.g., once per day) to keep cache fresh
   */
  async refreshCache(
    symbols: Array<{ symbol: string; longExchange: Exchange }>
  ): Promise<void> {
    if (this.isRefreshing) {
      console.log('Historical funding cache refresh already in progress');
      return;
    }

    this.isRefreshing = true;
    console.log(`Starting historical funding cache refresh for ${symbols.length} symbols...`);

    try {
      for (const { symbol, longExchange } of symbols) {
        try {
          const data = await this.fetchHistoricalAPRs(symbol, longExchange);
          const cacheKey = `${symbol}-${longExchange}`;
          this.cache.set(cacheKey, {
            data,
            timestamp: Date.now(),
          });
          
          // Delay between requests to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error: any) {
          console.error(`Error refreshing cache for ${symbol}:`, error?.message);
        }
      }
      console.log('Historical funding cache refresh complete');
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.ratesCache.clear();
  }

  /**
   * Get cache stats for debugging
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }

  /**
   * Get the time range for a given period
   */
  private getPeriodRange(period: TimePeriod): { startTime: number; endTime: number } {
    const now = Date.now();
    const yearStart = this.getYearStartMs();
    let startTime: number;

    switch (period) {
      case '7d':
        startTime = now - SEVEN_DAYS_MS;
        break;
      case '30d':
        startTime = now - THIRTY_DAYS_MS;
        break;
      case 'ytd':
        startTime = this.getYearStartMs();
        break;
      case 'realtime':
      default:
        // For realtime, just return current time
        startTime = now;
        break;
    }

    // Never query earlier than current year start
    startTime = Math.max(startTime, yearStart);

    return { startTime, endTime: now };
  }

  /**
   * Get average hourly rates for all symbols for a given time period
   * Returns rates for both exchanges
   * 
   * @param symbols - Array of symbols to fetch rates for
   * @param period - Time period ('7d', '30d', 'ytd')
   */
  async getAverageRatesForPeriod(
    symbols: string[],
    period: '7d' | '30d' | 'ytd'
  ): Promise<AverageRates> {
    const cacheKey = `rates-${period}`;
    const cached = this.ratesCache.get(cacheKey);
    const now = Date.now();

    // Return cached data if still valid
    if (cached && (now - cached.timestamp) < RATES_CACHE_DURATION_MS) {
      return cached.data;
    }

    console.log(`Fetching average rates for period: ${period}, ${symbols.length} symbols`);

    const { startTime, endTime } = this.getPeriodRange(period);
    
    const lighterRates = new Map<string, number>();
    const hyperliquidRates = new Map<string, number>();
    const dataStartDates = new Map<string, number>();

    // Log k-token symbols for debugging
    const kTokens = symbols.filter(s => s.startsWith('1000') || s.startsWith('K'));
    if (kTokens.length > 0) {
      console.log(`[Historical ${period}] K-tokens in symbol list: ${kTokens.join(', ')}`);
    }

    // Fetch historical data for each symbol
    for (const symbol of symbols) {
      try {
        // Convert Lighter's 1000XXX to Hyperliquid's KXXX format for fetching
        const hlSymbol = this.lighterToHyperliquidSymbol(symbol);
        
        // Log symbol conversion for k-tokens
        const isKToken = symbol.startsWith('1000') || symbol.startsWith('K');
        if (isKToken) {
          console.log(`[Historical ${period}] Fetching k-token: ${symbol} -> HL:${hlSymbol}`);
        }
        
        const [hlHistoryRaw, ltHistoryRaw] = await Promise.all([
          this.hyperliquidClient.getFundingHistory(hlSymbol, startTime, endTime),
          this.lighterClient.getFundingHistory(symbol, startTime, endTime),
        ]);

        // Filter out any out-of-range or zero timestamps to avoid 1970-era data
        const hlHistory = hlHistoryRaw.filter(e => e.timestamp >= startTime && e.timestamp <= endTime);
        const ltHistory = ltHistoryRaw.filter(e => e.timestamp >= startTime && e.timestamp <= endTime);

        // Debug k-tokens
        if (isKToken) {
          console.log(`[Historical ${period}] ${symbol}: HL entries=${hlHistory.length}, LT entries=${ltHistory.length}`);
        }

        // Track the earliest data timestamp from both exchanges
        let earliestTimestamp: number | undefined;
        
        // Calculate average hourly rate for Hyperliquid
        // Store under original symbol so it matches with Lighter data
        if (hlHistory.length > 0) {
          const hlHourlyRates = hlHistory.map(e => this.normalizeToHourly(e.rate, e.periodHours));
          const hlAvg = hlHourlyRates.reduce((sum, r) => sum + r, 0) / hlHourlyRates.length;
          hyperliquidRates.set(symbol, hlAvg);
          
          // Find earliest timestamp from Hyperliquid
          const hlEarliest = Math.min(...hlHistory.map(e => e.timestamp));
          earliestTimestamp = earliestTimestamp ? Math.max(earliestTimestamp, hlEarliest) : hlEarliest;
        }

        // Calculate average hourly rate for Lighter
        if (ltHistory.length > 0) {
          const ltHourlyRates = ltHistory.map(e => this.normalizeToHourly(e.rate, e.periodHours));
          const ltAvg = ltHourlyRates.reduce((sum, r) => sum + r, 0) / ltHourlyRates.length;
          lighterRates.set(symbol, ltAvg);
          
          // Debug: Log if rates seem unusually high (> 0.01% hourly is suspicious)
          if (Math.abs(ltAvg) > 0.0001) {
            console.log(`[HistoricalFunding DEBUG] ${symbol} LT avg hourly rate=${ltAvg} (${(ltAvg * 100).toFixed(4)}%) - might be too high!`);
            console.log(`  Sample raw rates: ${ltHistory.slice(0, 3).map(e => e.rate).join(', ')}`);
          }
          
          // Find earliest timestamp from Lighter (use max of both exchanges = latest start)
          const ltEarliest = Math.min(...ltHistory.map(e => e.timestamp));
          earliestTimestamp = earliestTimestamp ? Math.max(earliestTimestamp, ltEarliest) : ltEarliest;
        }
        
        // Store the earliest timestamp (which is actually the later of the two exchanges' start dates)
        if (earliestTimestamp !== undefined) {
          dataStartDates.set(symbol, earliestTimestamp);
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error: any) {
        console.error(`Error fetching rates for ${symbol}:`, error?.message);
      }
    }

    const result: AverageRates = {
      lighter: lighterRates,
      hyperliquid: hyperliquidRates,
      dataStartDates,
    };

    // Cache the result
    this.ratesCache.set(cacheKey, {
      data: result,
      timestamp: now,
    });

    console.log(`Fetched average rates: Lighter=${lighterRates.size}, HL=${hyperliquidRates.size}`);
    
    // Summary of data start dates to verify historical data is being returned
    if (dataStartDates.size > 0) {
      const startDatesArray = Array.from(dataStartDates.values()).filter(d => d > 0);
      if (startDatesArray.length > 0) {
        const earliest = Math.min(...startDatesArray);
        const latest = Math.max(...startDatesArray);
        const earliestDate = new Date(earliest).toISOString().split('T')[0];
        const latestDate = new Date(latest).toISOString().split('T')[0];
        console.log(`[Historical ${period}] Data start dates range: ${earliestDate} to ${latestDate}`);
        
        // Warn if all data starts today (indicates historical fetch not working)
        const today = new Date().toISOString().split('T')[0];
        if (earliestDate === today && latestDate === today) {
          console.warn(`[Historical ${period}] WARNING: All data starts today - historical fetch may not be working!`);
        }
      }
    }
    
    // Summary for k-tokens
    const kTokensInput = symbols.filter(s => s.startsWith('1000'));
    if (kTokensInput.length > 0) {
      console.log(`[Historical ${period}] K-TOKEN SUMMARY:`);
      for (const kt of kTokensInput) {
        const hasLighter = lighterRates.has(kt);
        const hasHL = hyperliquidRates.has(kt);
        const status = hasLighter && hasHL ? '✓ BOTH' : hasLighter ? '⚠ Lighter only' : hasHL ? '⚠ HL only' : '✗ NEITHER';
        console.log(`  ${kt}: ${status}`);
      }
    }

    return result;
  }
}


