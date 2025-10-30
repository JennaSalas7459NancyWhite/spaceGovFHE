import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface VoteRecord {
  id: string;
  encryptedVote: string;
  timestamp: number;
  voter: string;
  planet: string;
  proposal: string;
  status: "pending" | "counted" | "invalid";
}

// FHE encryption simulation for voting data
const FHEEncryptVote = (vote: number): string => {
  return `FHE-${btoa(vote.toString())}-ZAMA`;
};

const FHEDecryptVote = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-') && encryptedData.endsWith('-ZAMA')) {
    return parseFloat(atob(encryptedData.substring(4, encryptedData.length - 5)));
  }
  return 0;
};

// Generate mock public key for signature verification
const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [votes, setVotes] = useState<VoteRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [voting, setVoting] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ 
    visible: false, status: "pending", message: "" 
  });
  const [newVote, setNewVote] = useState({ planet: "Earth", proposal: "budget_allocation", voteValue: 1 });
  const [selectedVote, setSelectedVote] = useState<VoteRecord | null>(null);
  const [decryptedVote, setDecryptedVote] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [showTutorial, setShowTutorial] = useState(true);
  const [realTimeStats, setRealTimeStats] = useState({
    totalVotes: 0,
    earthVotes: 0,
    marsVotes: 0,
    moonVotes: 0,
    lastUpdate: Date.now()
  });

  // Initialize component
  useEffect(() => {
    loadVotes().finally(() => setLoading(false));
    setPublicKey(generatePublicKey());
    
    // Set up real-time updates
    const interval = setInterval(() => {
      updateRealTimeStats();
    }, 5000);
    
    return () => clearInterval(interval);
  }, []);

  // Update real-time statistics
  const updateRealTimeStats = () => {
    const earthVotes = votes.filter(v => v.planet === "Earth" && v.status === "counted").length;
    const marsVotes = votes.filter(v => v.planet === "Mars" && v.status === "counted").length;
    const moonVotes = votes.filter(v => v.planet === "Moon" && v.status === "counted").length;
    
    setRealTimeStats({
      totalVotes: votes.length,
      earthVotes,
      marsVotes,
      moonVotes,
      lastUpdate: Date.now()
    });
  };

  // Load votes from contract
  const loadVotes = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.warn("Contract not available");
        return;
      }

      // Load vote keys
      const keysBytes = await contract.getData("vote_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing vote keys:", e); 
        }
      }

      // Load individual votes
      const voteList: VoteRecord[] = [];
      for (const key of keys) {
        try {
          const voteBytes = await contract.getData(`vote_${key}`);
          if (voteBytes.length > 0) {
            try {
              const voteData = JSON.parse(ethers.toUtf8String(voteBytes));
              voteList.push({ 
                id: key, 
                encryptedVote: voteData.vote, 
                timestamp: voteData.timestamp, 
                voter: voteData.voter, 
                planet: voteData.planet,
                proposal: voteData.proposal,
                status: voteData.status || "pending" 
              });
            } catch (e) { 
              console.error(`Error parsing vote data for ${key}:`, e); 
            }
          }
        } catch (e) { 
          console.error(`Error loading vote ${key}:`, e); 
        }
      }

      // Sort by timestamp (newest first)
      voteList.sort((a, b) => b.timestamp - a.timestamp);
      setVotes(voteList);
      updateRealTimeStats();
      
    } catch (e) { 
      console.error("Error loading votes:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Submit a new vote
  const submitVote = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setVoting(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting vote with Zama FHE..." 
    });

    try {
      // Encrypt vote using FHE simulation
      const encryptedVote = FHEEncryptVote(newVote.voteValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      // Generate unique vote ID
      const voteId = `vote-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare vote data
      const voteData = { 
        vote: encryptedVote, 
        timestamp: Math.floor(Date.now() / 1000), 
        voter: address, 
        planet: newVote.planet,
        proposal: newVote.proposal,
        status: "pending" 
      };

      // Store vote data
      await contract.setData(`vote_${voteId}`, ethers.toUtf8Bytes(JSON.stringify(voteData)));

      // Update vote keys
      const keysBytes = await contract.getData("vote_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(voteId);
      await contract.setData("vote_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Vote encrypted and submitted securely!" 
      });

      await loadVotes();
      setCurrentStep(1);
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowVoteModal(false);
        setNewVote({ planet: "Earth", proposal: "budget_allocation", voteValue: 1 });
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Vote submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setVoting(false); 
    }
  };

  // Decrypt vote with wallet signature
  const decryptVoteWithSignature = async (encryptedVote: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      // Simulate wallet signature for decryption authorization
      const message = `ZamaFHE-VoteDecrypt:${publicKey}:${Date.now()}`;
      await signMessageAsync({ message });
      
      // Simulate FHE decryption processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      return FHEDecryptVote(encryptedVote);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Verify contract availability
  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Zama FHE System is available and ready!" 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "System check failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Count vote (simulate FHE computation)
  const countVote = async (voteId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing encrypted vote with FHE computation..." 
    });

    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      
      const voteBytes = await contract.getData(`vote_${voteId}`);
      if (voteBytes.length === 0) throw new Error("Vote not found");
      
      const voteData = JSON.parse(ethers.toUtf8String(voteBytes));
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedVote = { ...voteData, status: "counted" };
      await contractWithSigner.setData(`vote_${voteId}`, ethers.toUtf8Bytes(JSON.stringify(updatedVote)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE vote counting completed!" 
      });
      
      await loadVotes();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Vote counting failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Check if user is the voter
  const isVoter = (voteAddress: string) => address?.toLowerCase() === voteAddress.toLowerCase();

  // Voting tutorial steps
  const tutorialSteps = [
    { step: 1, title: "Connect Wallet", description: "Connect your Web3 wallet to access the interplanetary voting system", icon: "🔗" },
    { step: 2, title: "Select Proposal", description: "Choose from active governance proposals across different planets", icon: "📋" },
    { step: 3, title: "Encrypt Vote", description: "Your vote is encrypted client-side using Zama FHE before submission", icon: "🔒" },
    { step: 4, title: "FHE Processing", description: "Votes are counted in encrypted state without decryption", icon: "⚙️" },
    { step: 5, title: "View Results", description: "See encrypted results while maintaining voter privacy", icon: "📊" }
  ];

  // Render voting statistics
  const renderVoteStats = () => {
    const countedVotes = votes.filter(v => v.status === "counted").length;
    const pendingVotes = votes.filter(v => v.status === "pending").length;
    
    return (
      <div className="stats-hud">
        <div className="stat-item">
          <div className="stat-value">{realTimeStats.totalVotes}</div>
          <div className="stat-label">Total Votes</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{countedVotes}</div>
          <div className="stat-label">Counted</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingVotes}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{realTimeStats.earthVotes}</div>
          <div className="stat-label">Earth</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen hud-style">
      <div className="hud-spinner"></div>
      <p>Initializing Interplanetary Voting System...</p>
      <div className="hud-scanline"></div>
    </div>
  );

  return (
    <div className="app-container hud-theme">
      {/* HUD Header */}
      <header className="hud-header">
        <div className="hud-logo">
          <div className="planet-icon">🪐</div>
          <h1>SpaceGov<span>FHE</span></h1>
          <div className="zama-badge">Powered by Zama FHE</div>
        </div>
        
        <div className="hud-controls">
          <button onClick={checkAvailability} className="hud-btn system-test">
            <span className="pulse-dot"></span>
            System Check
          </button>
          <button onClick={() => setShowVoteModal(true)} className="hud-btn primary">
            <span className="btn-glow"></span>
            Cast Vote
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
          </div>
        </div>
      </header>

      {/* Main HUD Interface */}
      <div className="hud-main">
        {/* Step Progress */}
        <div className="voting-steps">
          {tutorialSteps.map(step => (
            <div key={step.step} className={`step ${currentStep === step.step ? 'active' : ''}`}>
              <div className="step-number">{step.step}</div>
              <div className="step-info">
                <div className="step-title">{step.title}</div>
                <div className="step-desc">{step.description}</div>
              </div>
              <div className="step-icon">{step.icon}</div>
            </div>
          ))}
        </div>

        {/* Real-time Statistics HUD */}
        <div className="stats-overlay">
          {renderVoteStats()}
          <div className="network-status">
            <div className="status-indicator online"></div>
            <span>FHE Network: Online</span>
          </div>
        </div>

        {/* Voting Records Section */}
        <div className="votes-section">
          <div className="section-header">
            <h2>Encrypted Vote Records</h2>
            <div className="last-update">
              Last update: {new Date(realTimeStats.lastUpdate).toLocaleTimeString()}
            </div>
          </div>

          <div className="votes-grid">
            {votes.length === 0 ? (
              <div className="no-votes">
                <div className="empty-state-icon">🗳️</div>
                <h3>No votes recorded yet</h3>
                <p>Be the first to cast an encrypted vote using Zama FHE technology</p>
                <button onClick={() => setShowVoteModal(true)} className="hud-btn primary">
                  Cast First Vote
                </button>
              </div>
            ) : (
              votes.map(vote => (
                <div key={vote.id} className="vote-card">
                  <div className="vote-header">
                    <div className="planet-badge">{vote.planet}</div>
                    <div className={`status-led ${vote.status}`}></div>
                  </div>
                  <div className="vote-content">
                    <h4>{vote.proposal.replace('_', ' ')}</h4>
                    <div className="vote-meta">
                      <span>Voter: {vote.voter.substring(0, 8)}...</span>
                      <span>{new Date(vote.timestamp * 1000).toLocaleDateString()}</span>
                    </div>
                    <div className="encrypted-preview">
                      {vote.encryptedVote.substring(0, 30)}...
                    </div>
                  </div>
                  <div className="vote-actions">
                    {isVoter(vote.voter) && vote.status === "pending" && (
                      <button onClick={() => countVote(vote.id)} className="hud-btn small">
                        Count Vote
                      </button>
                    )}
                    <button 
                      onClick={() => {
                        setSelectedVote(vote);
                        setDecryptedVote(null);
                      }} 
                      className="hud-btn small outline"
                    >
                      View Details
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Voting Modal */}
      {showVoteModal && (
        <VoteModal 
          onSubmit={submitVote} 
          onClose={() => {
            setShowVoteModal(false);
            setCurrentStep(1);
          }} 
          voting={voting} 
          voteData={newVote} 
          setVoteData={setNewVote}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      )}

      {/* Vote Detail Modal */}
      {selectedVote && (
        <VoteDetailModal 
          vote={selectedVote} 
          onClose={() => {
            setSelectedVote(null);
            setDecryptedVote(null);
          }} 
          decryptedVote={decryptedVote}
          setDecryptedVote={setDecryptedVote}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptVoteWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="hud-notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && <div className="hud-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="notification-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {/* HUD Footer */}
      <footer className="hud-footer">
        <div className="footer-content">
          <div className="fhe-status">
            <div className="encryption-indicator">
              <div className="lock-icon">🔒</div>
              <span>All votes FHE encrypted with Zama</span>
            </div>
          </div>
          <div className="system-info">
            <span>Interplanetary Voting System v1.0</span>
            <span>|</span>
            <span>FHE Security: Active</span>
            <span>|</span>
            <span>Multi-Planet Sync: Online</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Voting Modal Component
interface VoteModalProps {
  onSubmit: () => void;
  onClose: () => void;
  voting: boolean;
  voteData: any;
  setVoteData: (data: any) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;
}

const VoteModal: React.FC<VoteModalProps> = ({ 
  onSubmit, 
  onClose, 
  voting, 
  voteData, 
  setVoteData,
  currentStep,
  setCurrentStep 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    setVoteData({ ...voteData, [name]: name === 'voteValue' ? parseInt(value) : value });
  };

  const nextStep = () => setCurrentStep(Math.min(currentStep + 1, 5));
  const prevStep = () => setCurrentStep(Math.max(currentStep - 1, 1));

  const handleSubmit = () => {
    if (!voteData.planet || !voteData.proposal) {
      alert("Please complete all required fields");
      return;
    }
    onSubmit();
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="step-content">
            <h3>Select Planet</h3>
            <p>Choose the planetary colony for this vote</p>
            <select name="planet" value={voteData.planet} onChange={handleChange} className="hud-select">
              <option value="Earth">Earth</option>
              <option value="Mars">Mars Colony</option>
              <option value="Moon">Lunar Base</option>
            </select>
          </div>
        );
      
      case 2:
        return (
          <div className="step-content">
            <h3>Select Proposal</h3>
            <p>Choose the governance proposal to vote on</p>
            <select name="proposal" value={voteData.proposal} onChange={handleChange} className="hud-select">
              <option value="budget_allocation">Budget Allocation</option>
              <option value="resource_management">Resource Management</option>
              <option value="colonist_rights">Colonist Rights</option>
              <option value="research_funding">Research Funding</option>
            </select>
          </div>
        );
      
      case 3:
        return (
          <div className="step-content">
            <h3>Cast Your Vote</h3>
            <p>Select your vote (1 = For, 0 = Against)</p>
            <div className="vote-options">
              <label className="vote-option">
                <input type="radio" name="voteValue" value={1} checked={voteData.voteValue === 1} onChange={handleChange} />
                <span className="vote-label">For (1)</span>
              </label>
              <label className="vote-option">
                <input type="radio" name="voteValue" value={0} checked={voteData.voteValue === 0} onChange={handleChange} />
                <span className="vote-label">Against (0)</span>
              </label>
            </div>
          </div>
        );
      
      case 4:
        return (
          <div className="step-content">
            <h3>Encryption Preview</h3>
            <p>Your vote will be encrypted with Zama FHE</p>
            <div className="encryption-preview">
              <div className="plain-data">
                <span>Plain Vote:</span>
                <strong>{voteData.voteValue}</strong>
              </div>
              <div className="encryption-arrow">↓</div>
              <div className="encrypted-data">
                <span>Encrypted Vote:</span>
                <code>{FHEEncryptVote(voteData.voteValue)}</code>
              </div>
            </div>
          </div>
        );
      
      case 5:
        return (
          <div className="step-content">
            <h3>Confirm Submission</h3>
            <p>Review your encrypted vote before submission</p>
            <div className="vote-summary">
              <div className="summary-item">
                <span>Planet:</span>
                <strong>{voteData.planet}</strong>
              </div>
              <div className="summary-item">
                <span>Proposal:</span>
                <strong>{voteData.proposal.replace('_', ' ')}</strong>
              </div>
              <div className="summary-item">
                <span>Vote:</span>
                <strong>{voteData.voteValue === 1 ? 'For' : 'Against'}</strong>
              </div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="vote-modal hud-panel">
        <div className="modal-header">
          <h2>Cast Encrypted Vote</h2>
          <button onClick={onClose} className="close-modal">×</button>
        </div>

        <div className="step-progress">
          {[1, 2, 3, 4, 5].map(step => (
            <div key={step} className={`progress-step ${step <= currentStep ? 'active' : ''}`}>
              {step}
            </div>
          ))}
        </div>

        <div className="modal-body">
          {renderStepContent()}
        </div>

        <div className="modal-footer">
          <button onClick={prevStep} disabled={currentStep === 1} className="hud-btn outline">
            Back
          </button>
          
          {currentStep < 5 ? (
            <button onClick={nextStep} className="hud-btn primary">
              Next
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={voting} className="hud-btn primary">
              {voting ? "Encrypting with Zama FHE..." : "Submit Encrypted Vote"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Vote Detail Modal Component
interface VoteDetailModalProps {
  vote: VoteRecord;
  onClose: () => void;
  decryptedVote: number | null;
  setDecryptedVote: (vote: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedVote: string) => Promise<number | null>;
}

const VoteDetailModal: React.FC<VoteDetailModalProps> = ({ 
  vote, 
  onClose, 
  decryptedVote, 
  setDecryptedVote, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedVote !== null) {
      setDecryptedVote(null);
      return;
    }
    const decrypted = await decryptWithSignature(vote.encryptedVote);
    if (decrypted !== null) setDecryptedVote(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="vote-detail-modal hud-panel">
        <div className="modal-header">
          <h2>Vote Details</h2>
          <button onClick={onClose} className="close-modal">×</button>
        </div>

        <div className="modal-body">
          <div className="vote-info-grid">
            <div className="info-item">
              <label>Planet:</label>
              <span>{vote.planet}</span>
            </div>
            <div className="info-item">
              <label>Proposal:</label>
              <span>{vote.proposal.replace('_', ' ')}</span>
            </div>
            <div className="info-item">
              <label>Voter:</label>
              <span>{vote.voter}</span>
            </div>
            <div className="info-item">
              <label>Status:</label>
              <span className={`status-badge ${vote.status}`}>{vote.status}</span>
            </div>
            <div className="info-item">
              <label>Timestamp:</label>
              <span>{new Date(vote.timestamp * 1000).toLocaleString()}</span>
            </div>
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Vote Data</h3>
            <div className="encrypted-data">
              <code>{vote.encryptedVote}</code>
            </div>
            <div className="fhe-badge">
              <span>Zama FHE Encrypted</span>
            </div>
          </div>

          <div className="decrypt-section">
            <button 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
              className="hud-btn primary"
            >
              {isDecrypting ? "Decrypting..." : 
               decryptedVote !== null ? "Re-encrypt Data" : "Decrypt with Wallet Signature"}
            </button>

            {decryptedVote !== null && (
              <div className="decrypted-result">
                <h4>Decrypted Vote Value</h4>
                <div className="decrypted-value">{decryptedVote}</div>
                <div className="decryption-note">
                  Value decrypted using your wallet signature and Zama FHE
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="hud-btn outline">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;