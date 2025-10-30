pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SpaceGovFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event VoteSubmitted(address indexed voter, uint256 indexed batchId, bytes32 encryptedVote);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 yesCount, uint256 noCount);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct VoteBatch {
        euint32 yesVotesEncrypted;
        euint32 noVotesEncrypted;
        uint256 voteCount;
    }
    mapping(uint256 => VoteBatch) public voteBatches;

    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionRateLimited() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier decryptionRequestRateLimited() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default cooldown
    }

    function addProvider(address _provider) external onlyOwner {
        if (isProvider[_provider]) revert InvalidParameter();
        isProvider[_provider] = true;
        emit ProviderAdded(_provider);
    }

    function removeProvider(address _provider) external onlyOwner {
        if (!isProvider[_provider]) revert InvalidParameter();
        if (_provider == owner) revert InvalidParameter(); // Owner cannot remove themselves as provider this way
        isProvider[_provider] = false;
        emit ProviderRemoved(_provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        if (_cooldownSeconds == oldCooldown) revert InvalidParameter();
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidParameter();
        currentBatchId++;
        batchOpen = true;
        voteBatches[currentBatchId].yesVotesEncrypted = FHE.asEuint32(0);
        voteBatches[currentBatchId].noVotesEncrypted = FHE.asEuint32(0);
        voteBatches[currentBatchId].voteCount = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotClosed();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitVote(ebool _voteChoice) external onlyProvider whenNotPaused submissionRateLimited {
        if (!batchOpen) revert BatchClosed();
        _initIfNeeded(currentBatchId);

        euint32 encryptedVoteValue;
        if (_voteChoice.isInitialized()) {
             encryptedVoteValue = _voteChoice.select(FHE.asEuint32(1), FHE.asEuint32(0));
        } else {
             encryptedVoteValue = FHE.asEuint32(0); // Default to 'no' or invalid if not initialized
        }

        voteBatches[currentBatchId].yesVotesEncrypted = FHE.add(
            voteBatches[currentBatchId].yesVotesEncrypted,
            FHE.mul(encryptedVoteValue, FHE.asEuint32(1)) // Add 1 to yes if voteChoice is true
        );
        voteBatches[currentBatchId].noVotesEncrypted = FHE.add(
            voteBatches[currentBatchId].noVotesEncrypted,
            FHE.mul(FHE.sub(FHE.asEuint32(1), encryptedVoteValue), FHE.asEuint32(1)) // Add 1 to no if voteChoice is false
        );
        voteBatches[currentBatchId].voteCount++;

        bytes32 encryptedVoteBytes = FHE.toBytes32(encryptedVoteValue);
        emit VoteSubmitted(msg.sender, currentBatchId, encryptedVoteBytes);
    }

    function requestBatchResultDecryption(uint256 _batchId) external onlyProvider whenNotPaused decryptionRequestRateLimited {
        if (batchOpen) revert BatchNotClosed(); // Batch must be closed for decryption
        _requireInitialized(_batchId);

        euint32 memory yesCt = voteBatches[_batchId].yesVotesEncrypted;
        euint32 memory noCt = voteBatches[_batchId].noVotesEncrypted;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(yesCt);
        cts[1] = FHE.toBytes32(noCt);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, _batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 memory yesCt = voteBatches[batchId].yesVotesEncrypted;
        euint32 memory noCt = voteBatches[batchId].noVotesEncrypted;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(yesCt);
        cts[1] = FHE.toBytes32(noCt);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 yesCount = abi.decode(cleartexts, (uint256));
        uint256 noCount;
        assembly { // Efficiently get the second value from the cleartexts abi-encoded array
            noCount := mload(add(cleartexts, 0x20))
        }
        // The above assembly is equivalent to:
        // (yesCount, noCount) = abi.decode(cleartexts, (uint256, uint256));
        // but more explicit for the first element and then the second.

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, yesCount, noCount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(uint256 _batchId) internal {
        if (!_isBatchInitialized(_batchId)) {
            voteBatches[_batchId].yesVotesEncrypted = FHE.asEuint32(0);
            voteBatches[_batchId].noVotesEncrypted = FHE.asEuint32(0);
            voteBatches[_batchId].voteCount = 0;
        }
    }

    function _isBatchInitialized(uint256 _batchId) internal view returns (bool) {
        return voteBatches[_batchId].yesVotesEncrypted.isInitialized() &&
               voteBatches[_batchId].noVotesEncrypted.isInitialized();
    }

    function _requireInitialized(uint256 _batchId) internal view {
        if (!_isBatchInitialized(_batchId)) revert NotInitialized();
    }
}