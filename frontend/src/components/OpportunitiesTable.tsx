import React, { useState, useEffect, useMemo } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import type { ArbitrageOpportunity, TimePeriod, OpportunitiesByPeriod } from '../../../shared/types';
import './OpportunitiesTable.css';

type SortField = 'symbol' | 'longExchange' | 'shortExchange' | 'longFundingRate' | 'shortFundingRate' | 'netAPR' | 'lastUpdated';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

const emptyOpportunities: OpportunitiesByPeriod = {
  realtime: [],
  '7d': [],
  '30d': [],
  ytd: [],
};

// Get the backend URL based on environment
const getBackendUrl = () => {
  // In production, use the VITE_BACKEND_URL env var or derive from current host
  if (import.meta.env.PROD) {
    // If deployed on Render, the backend URL will be set via env var
    const backendUrl = import.meta.env.VITE_BACKEND_URL;
    if (backendUrl) {
      return backendUrl.startsWith('http') ? backendUrl : `https://${backendUrl}`;
    }
    // Fallback: assume backend is on a subdomain or same origin
    return window.location.origin.replace('frontend', 'backend');
  }
  return 'http://localhost:3001';
};

const getWebSocketUrl = () => {
  const backend = getBackendUrl();
  const wsProtocol = backend.startsWith('https') ? 'wss' : 'ws';
  return `${wsProtocol}://${backend.replace(/^https?:\/\//, '')}/ws`;
};

function OpportunitiesTable() {
  const backendUrl = getBackendUrl();
  const wsUrl = getWebSocketUrl();
  
  const { opportunities: wsOpportunities, isConnected, error, reconnect } = useWebSocket(
    wsUrl
  );
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: 'netAPR',
    direction: 'desc',
  });
  const [filter, setFilter] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [restOpportunities, setRestOpportunities] = useState<OpportunitiesByPeriod>(emptyOpportunities);
  const [apiStatus, setApiStatus] = useState<{ lighter: boolean; hyperliquid: boolean }>({ lighter: false, hyperliquid: false });
  const [activeTab, setActiveTab] = useState<TimePeriod>('realtime');

  // Combine WebSocket and REST API opportunities
  const allOpportunities = wsOpportunities.realtime.length > 0 ? wsOpportunities : restOpportunities;

  // Get opportunities for the active tab
  const currentOpportunities = allOpportunities[activeTab] || [];

  // Fallback: fetch from REST API if WebSocket fails or returns no data
  useEffect(() => {
    let mounted = true;
    
    const fetchOpportunities = async () => {
      try {
        setIsLoading(true);
        const response = await fetch(`${backendUrl}/api/opportunities`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        if (mounted) {
          if (data.opportunities) {
            setRestOpportunities(data.opportunities);
            setApiStatus({
              lighter: data.lighterAvailable || false,
              hyperliquid: data.hyperliquidAvailable || false,
            });
            if (data.opportunities.realtime?.length === 0) {
              if (!data.lighterAvailable && !data.hyperliquidAvailable) {
                setApiError('Both APIs are unavailable. Check the backend console for connection errors.');
              } else if (!data.lighterAvailable) {
                setApiError('Lighter API is unavailable. Showing Hyperliquid data only. Check backend console for Lighter API connection errors.');
              } else {
                setApiError('No opportunities found. This might mean no coins are tradeable on both exchanges, or funding rates are not available.');
              }
            } else {
              setApiError(null);
            }
          } else {
            setApiError('Received unexpected data format from API.');
          }
          setIsLoading(false);
        }
      } catch (err) {
        if (mounted) {
          console.error('Error fetching opportunities:', err);
          setApiError(`Failed to connect to backend: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure the backend is running on port 3001.`);
          setIsLoading(false);
        }
      }
    };

    // Fetch immediately and also if WebSocket hasn't connected after 3 seconds
    fetchOpportunities();
    const timeout = setTimeout(() => {
      if (!isConnected && wsOpportunities.realtime.length === 0) {
        fetchOpportunities();
      }
    }, 3000);

    // Also poll every 30 seconds as backup
    const interval = setInterval(() => {
      if (!isConnected || wsOpportunities.realtime.length === 0) {
        fetchOpportunities();
      }
    }, 30000);

    return () => {
      mounted = false;
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [isConnected, wsOpportunities.realtime.length]);

  const handleSort = (field: SortField) => {
    setSortConfig((prev) => {
      if (prev.field === field) {
        return {
          field,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return { field, direction: 'desc' };
    });
  };

  const sortedAndFiltered = useMemo(() => {
    let filtered = currentOpportunities.filter((opp) =>
      opp.symbol.toLowerCase().includes(filter.toLowerCase())
    );

    filtered.sort((a, b) => {
      let aValue: any = a[sortConfig.field];
      let bValue: any = b[sortConfig.field];

      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });

    return filtered;
  }, [currentOpportunities, filter, sortConfig]);

  const formatPercentage = (value: number): string => {
    // Use more precision for very small values
    if (Math.abs(value) < 0.01 && value !== 0) {
      return `${value >= 0 ? '+' : ''}${value.toFixed(4)}%`;
    }
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  const formatFundingRate = (rate: number): string => {
    const percentage = rate * 100;
    return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(4)}%`;
  };

  const formatExchange = (exchange: string): string => {
    return exchange.charAt(0).toUpperCase() + exchange.slice(1);
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const formatSymbol = (symbol: string): string => {
    // Convert Lighter's 1000XXX format to user-friendly kXXX format
    // e.g., 1000FLOKI -> kFLOKI, 1000BONK -> kBONK
    if (symbol.startsWith('1000')) {
      return 'k' + symbol.substring(4);
    }
    return symbol;
  };

  const getSortIcon = (field: SortField) => {
    if (sortConfig.field !== field) {
      return '↕️';
    }
    return sortConfig.direction === 'asc' ? '↑' : '↓';
  };

  const getTabLabel = (tab: TimePeriod): string => {
    switch (tab) {
      case 'realtime': return 'Real-time';
      case '7d': return '7D';
      case '30d': return '30D';
      case 'ytd': return 'YTD';
      default: return tab;
    }
  };

  // Get the start date for the current period
  const getPeriodStartDate = (tab: TimePeriod): number => {
    const now = Date.now();
    switch (tab) {
      case '7d': return now - (7 * 24 * 60 * 60 * 1000);
      case '30d': return now - (30 * 24 * 60 * 60 * 1000);
      case 'ytd': return new Date(new Date().getFullYear(), 0, 1).getTime();
      default: return now;
    }
  };

  // Check if the data is incomplete for the selected period
  const isDataIncomplete = (dataStartDate: number | undefined, tab: TimePeriod): boolean => {
    if (!dataStartDate || tab === 'realtime') return false;
    const periodStart = getPeriodStartDate(tab);
    // Data is incomplete if it started after the period start (with 1 day buffer)
    return dataStartDate > periodStart + (24 * 60 * 60 * 1000);
  };

  // Generate tooltip message for incomplete data
  const getIncompleteDataTooltip = (dataStartDate: number, tab: TimePeriod): string => {
    const startDate = new Date(dataStartDate);
    const formattedDate = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    const periodStart = getPeriodStartDate(tab);
    const daysMissing = Math.floor((dataStartDate - periodStart) / (24 * 60 * 60 * 1000));
    
    return `Data only available since ${formattedDate} (missing ~${daysMissing} days of data)`;
  };

  // Note: YTD tab hidden because Lighter only has ~1 month of historical data
  const tabs: TimePeriod[] = ['realtime', '7d', '30d'];

  return (
    <div className="opportunities-container">
      <div className="tabs-container">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {getTabLabel(tab)}
            {allOpportunities[tab]?.length > 0 && (
              <span className="tab-count">{allOpportunities[tab].length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="controls">
        <div className="search-box">
          <input
            type="text"
            placeholder="Filter by coin symbol..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="search-input"
          />
        </div>
        <div className="status">
          <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
          </span>
          {error && (
            <button onClick={reconnect} className="reconnect-btn">
              Reconnect
            </button>
          )}
        </div>
      </div>

      {(error || apiError) && (
        <div className="error-message">
          {error || apiError}
          {!isConnected && (
            <div style={{ marginTop: '0.5rem' }}>
              <button onClick={reconnect} className="reconnect-btn">
                Try Reconnecting
              </button>
            </div>
          )}
        </div>
      )}

      {isLoading && currentOpportunities.length === 0 ? (
        <div className="loading">Loading opportunities...</div>
      ) : sortedAndFiltered.length === 0 && currentOpportunities.length === 0 && !apiError ? (
        <div className="no-results">
          <p><strong>No opportunities found for {getTabLabel(activeTab)}.</strong></p>
          {activeTab !== 'realtime' && (
            <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#94a3b8' }}>
              Historical data is being loaded in the background. Please wait a moment.
            </p>
          )}
        </div>
      ) : sortedAndFiltered.length === 0 && currentOpportunities.length > 0 ? (
        <div className="no-results">No opportunities match your filter.</div>
      ) : currentOpportunities.length > 0 ? (
        <div className="table-wrapper">
          <table className="opportunities-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('symbol')} className="sortable">
                  Coin {getSortIcon('symbol')}
                </th>
                <th onClick={() => handleSort('longExchange')} className="sortable">
                  Long Exchange {getSortIcon('longExchange')}
                </th>
                <th onClick={() => handleSort('shortExchange')} className="sortable">
                  Short Exchange {getSortIcon('shortExchange')}
                </th>
                <th onClick={() => handleSort('longFundingRate')} className="sortable">
                  Long Funding Rate {getSortIcon('longFundingRate')}
                </th>
                <th onClick={() => handleSort('shortFundingRate')} className="sortable">
                  Short Funding Rate {getSortIcon('shortFundingRate')}
                </th>
                <th onClick={() => handleSort('netAPR')} className="sortable net-apr-header">
                  {activeTab === 'realtime' ? 'Net APR' : `${getTabLabel(activeTab)} APR`} {getSortIcon('netAPR')}
                </th>
                <th onClick={() => handleSort('lastUpdated')} className="sortable">
                  Last Updated {getSortIcon('lastUpdated')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAndFiltered.map((opp, index) => {
                const isTopOpportunity = index < 5 && sortConfig.field === 'netAPR' && sortConfig.direction === 'desc';
                return (
                  <tr
                    key={`${opp.symbol}-${opp.longExchange}-${opp.shortExchange}`}
                    className={isTopOpportunity ? 'top-opportunity' : ''}
                  >
                    <td className="coin-symbol">
                      {formatSymbol(opp.symbol)}
                      {isDataIncomplete(opp.dataStartDate, activeTab) && (
                        <span 
                          className="incomplete-data-warning" 
                          title={getIncompleteDataTooltip(opp.dataStartDate!, activeTab)}
                        >
                          ▲
                        </span>
                      )}
                    </td>
                    <td>{formatExchange(opp.longExchange)}</td>
                    <td>{formatExchange(opp.shortExchange)}</td>
                    <td>{formatFundingRate(opp.longFundingRate)}</td>
                    <td>{formatFundingRate(opp.shortFundingRate)}</td>
                    <td className={`net-apr ${opp.netAPR >= 0 ? 'positive' : 'negative'}`}>
                      {formatPercentage(opp.netAPR)}
                    </td>
                    <td className="timestamp">{formatTimestamp(opp.lastUpdated)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {sortedAndFiltered.length > 0 && (
        <div className="table-footer">
          Showing {sortedAndFiltered.length} of {currentOpportunities.length} opportunities
        </div>
      )}
    </div>
  );
}

export default OpportunitiesTable;


