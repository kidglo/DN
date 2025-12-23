import type { ArbitrageOpportunity, FundingRate, Exchange } from '../../../shared/types.js';

export class OpportunityCalculator {
  // Track zero-rate symbols for debugging (only log once per symbol)
  private static loggedZeroRates = new Set<string>();

  /**
   * Normalize symbol from Lighter format to Hyperliquid format
   * Lighter uses "1000" prefix (1000FLOKI) while Hyperliquid uses "k" prefix (kFLOKI)
   * Note: Hyperliquid uses uppercase K in metaAndAssetCtxs but we need to match both cases
   */
  private static lighterToHyperliquidSymbol(lighterSymbol: string): string {
    if (lighterSymbol.startsWith('1000')) {
      return 'K' + lighterSymbol.substring(4); // Keep uppercase for real-time matching
    }
    return lighterSymbol;
  }

  /**
   * Convert a funding rate to APR (Annual Percentage Rate)
   * Takes into account the funding period (hourly vs 8-hourly)
   * 
   * @param rate - The funding rate as a decimal
   * @param periodHours - The funding period in hours (1 for hourly, 8 for 8-hourly)
   */
  private static annualizeFundingRate(rate: number, periodHours: number = 1): number {
    // Calculate periods per year
    // periodsPerDay = 24 / periodHours
    // periodsPerYear = periodsPerDay * 365
    const periodsPerYear = (24 / periodHours) * 365;
    return rate * periodsPerYear * 100; // Convert to percentage
  }

  /**
   * Normalize a funding rate to hourly period for display and comparison
   * This allows us to compare rates from exchanges with different funding intervals
   * and display consistent hourly rates to match what exchanges show
   */
  private static normalizeToHourly(rate: number, periodHours: number = 8): number {
    // Convert to hourly equivalent
    // If 8-hour, divide by 8 to get hourly equivalent
    return rate / periodHours;
  }

  /**
   * Calculate opportunities from funding rates on both exchanges
   */
  static calculateOpportunities(
    lighterRates: FundingRate[],
    hyperliquidRates: FundingRate[]
  ): ArbitrageOpportunity[] {
    // Create maps for quick lookup
    const lighterMap = new Map<string, FundingRate>();
    const hyperliquidMap = new Map<string, FundingRate>();

    lighterRates.forEach((rate) => {
      lighterMap.set(rate.symbol.toUpperCase(), rate);
    });

    hyperliquidRates.forEach((rate) => {
      hyperliquidMap.set(rate.symbol.toUpperCase(), rate);
    });

    const opportunities: ArbitrageOpportunity[] = [];
    const processedSymbols = new Set<string>();

    // Find coins that exist on both exchanges
    for (const [symbol, lighterRate] of lighterMap) {
      // Try exact match first, then try normalized symbol (1000 -> K conversion)
      let hyperliquidRate = hyperliquidMap.get(symbol);
      let hlSymbol = symbol; // Track the Hyperliquid symbol used
      
      if (!hyperliquidRate) {
        // Try converting Lighter's 1000XXX to Hyperliquid's KXXX format
        const normalizedSymbol = this.lighterToHyperliquidSymbol(symbol);
        if (normalizedSymbol !== symbol) {
          hyperliquidRate = hyperliquidMap.get(normalizedSymbol);
          if (hyperliquidRate) {
            hlSymbol = normalizedSymbol;
            console.log(`[MATCH] ${symbol} (Lighter) -> ${normalizedSymbol} (Hyperliquid)`);
          }
        }
      }
      
      if (hyperliquidRate && !processedSymbols.has(symbol)) {
        processedSymbols.add(symbol);

        // Normalize rates to hourly for fair comparison and display
        // Hyperliquid is already hourly (periodHours: 1), Lighter is 8-hour (periodHours: 8)
        const lighterHourly = this.normalizeToHourly(lighterRate.rate, lighterRate.periodHours || 8);
        const hyperliquidHourly = this.normalizeToHourly(hyperliquidRate.rate, hyperliquidRate.periodHours || 1);

        // Skip coins where BOTH exchanges have zero rates (likely delisted)
        if (lighterHourly === 0 && hyperliquidHourly === 0) {
          if (!this.loggedZeroRates.has(symbol)) {
            console.log(`[SKIP] Both rates zero for ${symbol} (likely delisted)`);
            this.loggedZeroRates.add(symbol);
          }
          continue;
        }

        // Calculate both directions using hourly rates
        // Direction 1: Long on Lighter, Short on Hyperliquid
        const netAPR1 = this.calculateNetAPR(lighterHourly, hyperliquidHourly);

        // Direction 2: Long on Hyperliquid, Short on Lighter
        const netAPR2 = this.calculateNetAPR(hyperliquidHourly, lighterHourly);

        // Choose the direction with higher net APR
        if (netAPR1 >= netAPR2) {
          opportunities.push({
            symbol,
            longExchange: 'lighter',
            shortExchange: 'hyperliquid',
            longFundingRate: lighterHourly, // Store hourly rate for display
            shortFundingRate: hyperliquidHourly,
            netAPR: netAPR1,
            lastUpdated: Math.max(lighterRate.timestamp, hyperliquidRate.timestamp),
          });
        } else {
          opportunities.push({
            symbol,
            longExchange: 'hyperliquid',
            shortExchange: 'lighter',
            longFundingRate: hyperliquidHourly,
            shortFundingRate: lighterHourly,
            netAPR: netAPR2,
            lastUpdated: Math.max(lighterRate.timestamp, hyperliquidRate.timestamp),
          });
        }
      }
    }

    // Log opportunities with very small or zero APRs for debugging
    const smallAPROpps = opportunities.filter(opp => Math.abs(opp.netAPR) < 1);
    if (smallAPROpps.length > 0) {
      console.log(`[DEBUG] ${smallAPROpps.length} realtime opportunities with APR < 1%:`);
      smallAPROpps.slice(0, 5).forEach(opp => {
        console.log(`  ${opp.symbol}: netAPR=${opp.netAPR.toFixed(6)}%, longRate=${opp.longFundingRate.toExponential(4)}, shortRate=${opp.shortFundingRate.toExponential(4)}`);
      });
    }

    // Sort by net APR (descending - highest first)
    return opportunities.sort((a, b) => b.netAPR - a.netAPR);
  }

  /**
   * Calculate opportunities from pre-computed hourly rate maps
   * Used for historical calculations where we have averaged rates
   * 
   * @param lighterRates - Map of symbol -> average hourly rate for Lighter
   * @param hyperliquidRates - Map of symbol -> average hourly rate for Hyperliquid
   * @param timestamp - Timestamp to use for the opportunities
   * @param dataStartDates - Optional map of symbol -> earliest data timestamp
   */
  static calculateOpportunitiesFromRates(
    lighterRates: Map<string, number>,
    hyperliquidRates: Map<string, number>,
    timestamp: number,
    dataStartDates?: Map<string, number>
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    // Find symbols that exist on both exchanges
    for (const [symbol, lighterHourly] of lighterRates) {
      // Try exact match first, then try normalized symbol (1000 -> K conversion)
      let hyperliquidHourly = hyperliquidRates.get(symbol);
      
      if (hyperliquidHourly === undefined) {
        // Try converting Lighter's 1000XXX to Hyperliquid's KXXX format
        const normalizedSymbol = this.lighterToHyperliquidSymbol(symbol);
        if (normalizedSymbol !== symbol) {
          hyperliquidHourly = hyperliquidRates.get(normalizedSymbol);
        }
      }
      
      if (hyperliquidHourly !== undefined) {
        // Calculate both directions
        const netAPR1 = this.calculateNetAPR(lighterHourly, hyperliquidHourly);
        const netAPR2 = this.calculateNetAPR(hyperliquidHourly, lighterHourly);
        
        // Get data start date if available
        const dataStartDate = dataStartDates?.get(symbol);

        // Choose the direction with higher net APR
        if (netAPR1 >= netAPR2) {
          opportunities.push({
            symbol,
            longExchange: 'lighter',
            shortExchange: 'hyperliquid',
            longFundingRate: lighterHourly,
            shortFundingRate: hyperliquidHourly,
            netAPR: netAPR1,
            lastUpdated: timestamp,
            dataStartDate,
          });
        } else {
          opportunities.push({
            symbol,
            longExchange: 'hyperliquid',
            shortExchange: 'lighter',
            longFundingRate: hyperliquidHourly,
            shortFundingRate: lighterHourly,
            netAPR: netAPR2,
            lastUpdated: timestamp,
            dataStartDate,
          });
        }
      }
    }

    // Sort by net APR (descending - highest first)
    return opportunities.sort((a, b) => b.netAPR - a.netAPR);
  }

  /**
   * Calculate net APR for a delta-neutral position
   * When long on Exchange A and short on Exchange B:
   * - You pay/receive funding rate A on the long position
   * - You pay/receive funding rate B on the short position (opposite sign)
   * - Net = Short rate - Long rate (you receive short funding, pay long funding)
   * 
   * Rates are expected to be normalized to hourly
   */
  private static calculateNetAPR(longRate: number, shortRate: number): number {
    // When you're long, you pay the funding rate (if positive)
    // When you're short, you receive the funding rate (if positive)
    // Net benefit = shortRate - longRate
    const netRate = shortRate - longRate;
    return this.annualizeFundingRate(netRate, 1); // Use hourly period for normalized rates
  }
}



