export type Exchange = 'lighter' | 'hyperliquid';

export interface Coin {
  symbol: string;
  exchange: Exchange;
}

export interface FundingRate {
  symbol: string;
  exchange: Exchange;
  rate: number; // Funding rate as decimal (e.g., 0.0001 for 0.01%)
  timestamp: number;
  periodHours?: number; // Funding period in hours (1 for hourly, 8 for 8-hourly). Defaults to 8 if not specified.
}

export interface ArbitrageOpportunity {
  symbol: string;
  longExchange: Exchange;
  shortExchange: Exchange;
  longFundingRate: number; // As decimal (hourly rate)
  shortFundingRate: number; // As decimal (hourly rate)
  netAPR: number; // Annualized percentage (e.g., 12.5 for 12.5%)
  lastUpdated: number;
  dataStartDate?: number; // Earliest data point timestamp (for historical tabs) - if set, indicates data may be incomplete for the period
}

export type TimePeriod = 'realtime' | '7d' | '30d' | 'ytd';

export interface OpportunitiesByPeriod {
  realtime: ArbitrageOpportunity[];
  '7d': ArbitrageOpportunity[];
  '30d': ArbitrageOpportunity[];
  ytd: ArbitrageOpportunity[];
}

export interface OpportunitiesResponse {
  opportunities: OpportunitiesByPeriod;
  lastUpdated: number;
  lighterAvailable: boolean;
  hyperliquidAvailable: boolean;
}

export interface ExchangeData {
  exchange: Exchange;
  coins: Coin[];
  fundingRates: FundingRate[];
}

export interface HistoricalFundingEntry {
  symbol: string;
  exchange: Exchange;
  rate: number; // Funding rate as decimal
  timestamp: number; // Unix timestamp in milliseconds
  periodHours: number; // Funding period (1 for hourly, 8 for 8-hourly)
}



