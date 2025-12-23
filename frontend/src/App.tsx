import OpportunitiesTable from './components/OpportunitiesTable';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>Delta-Neutral Funding Rate Opportunities</h1>
        <p className="subtitle">
          Compare funding rates between Lighter and Hyperliquid exchanges
        </p>
      </header>
      <main>
        <OpportunitiesTable />
      </main>
    </div>
  );
}

export default App;



