// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDisputeResolution.sol";
import "./interfaces/IEnergyEscrow.sol";

/// @title EnergyEscrow
/// @notice Conditional settlement layer for the energy marketplace. Holds
///         CarbonCredit tokens until the buyer confirms delivery (release) or
///         disputes. Funds auto-refund to the buyer after the dispute window
///         if left unactioned. Opt-in: does not alter the existing instant
///         transfer path in EnergyTrading.
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): Not formally audited. Do not deploy to mainnet
///      without a professional security review. See contracts/SECURITY.md.
contract EnergyEscrow is ReentrancyGuard, Pausable, Ownable2Step, IEnergyEscrow {
    using SafeERC20 for IERC20;

    IERC20 public immutable carbonCreditToken;

    /// @notice Linked dispute-resolution contract. Set once after deploy via
    ///         `setDisputeResolution` (owner only) to break the constructor
    ///         circular dependency. Address(0) disables `openDispute`.
    address public disputeResolution;

    /// Maximum basis points (100%).
    uint256 private constant BPS_DENOMINATOR = 10000;

    /// Minimum/maximum dispute window bounds (set at construction). Bounds the
    /// time a buyer has to release/dispute before a seller could be left waiting
    /// indefinitely, and prevents absurd config values.
    uint256 public constant MIN_DISPUTE_WINDOW = 1 hours;
    uint256 public constant MAX_DISPUTE_WINDOW = 30 days;
    uint256 public immutable disputeWindow;

    enum State {
        Funded,
        Delivered,
        Released,
        Disputed,
        Refunded
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        State state;
        uint256 createdAt;
        uint256 deliveredAt;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public nextEscrowId;

    event EscrowCreated(
        uint256 indexed escrowId,
        uint256 indexed listingId,
        address indexed buyer,
        address seller,
        uint256 amount
    );
    event DeliveryConfirmed(uint256 indexed escrowId, address indexed seller);
    event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount, string reason);
    event EscrowSplit(
        uint256 indexed escrowId,
        address buyer,
        uint256 buyerAmount,
        address seller,
        uint256 sellerAmount
    );
    event DisputeOpened(uint256 indexed escrowId, uint256 indexed disputeId, bytes32 evidenceHash);
    event DisputeResolutionSet(address indexed oldResolver, address indexed newResolver);

    error InvalidTokenAddress();
    error InvalidDisputeWindow();
    error ZeroAmount();
    error InvalidSeller();
    error CannotEscrowToSelf();
    error EscrowNotFound();
    error NotBuyer();
    error NotSeller();
    error NotDisputeResolver();
    error InvalidState();
    error DisputeWindowOpen();
    error DisputeWindowClosed();
    error DisputeResolutionNotSet();
    error InvalidOutcome();
    error InvalidShare();
    error NotDisputed();

    constructor(address carbonCreditTokenAddress, uint256 disputeWindowSeconds) Ownable(msg.sender) {
        if (carbonCreditTokenAddress == address(0)) revert InvalidTokenAddress();
        if (
            disputeWindowSeconds < MIN_DISPUTE_WINDOW
                || disputeWindowSeconds > MAX_DISPUTE_WINDOW
        ) {
            revert InvalidDisputeWindow();
        }
        carbonCreditToken = IERC20(carbonCreditTokenAddress);
        disputeWindow = disputeWindowSeconds;
    }

    /// @notice Owner-only one-time-style link to the dispute contract. Breaking
    ///         the constructor circular dependency. Callable while paused too,
    ///         so wiring can be fixed during an emergency.
    function setDisputeResolution(address newResolver) external onlyOwner {
        address old = disputeResolution;
        disputeResolution = newResolver;
        emit DisputeResolutionSet(old, newResolver);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Fund an escrow for a marketplace listing. Pulls `amount` CC
    ///         tokens from the buyer (who must have approved this contract).
    /// @param listingId Off-chain reference to the EnergyTrading listing.
    /// @param seller Recipient of funds on release.
    /// @param amount CC tokens (raw, with decimals) to lock.
    function createEscrow(uint256 listingId, address seller, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (seller == address(0)) revert InvalidSeller();
        if (msg.sender == seller) revert CannotEscrowToSelf();
        if (amount == 0) revert ZeroAmount();

        uint256 escrowId = nextEscrowId;
        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            state: State.Funded,
            createdAt: block.timestamp,
            deliveredAt: 0
        });
        nextEscrowId = escrowId + 1;

        // Effects before interactions (CEI).
        carbonCreditToken.safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowCreated(escrowId, listingId, msg.sender, seller, amount);
    }

    /// @notice Seller attests that the energy has been delivered. Optional but
    ///         enables the marketplace to distinguish "delivered, awaiting
    ///         release" from "funded, pending delivery".
    function confirmDelivery(uint256 escrowId) external nonReentrant {
        Escrow storage e = _load(escrowId);
        if (msg.sender != e.seller) revert NotSeller();
        if (e.state != State.Funded) revert InvalidState();

        e.state = State.Delivered;
        e.deliveredAt = block.timestamp;
        emit DeliveryConfirmed(escrowId, msg.sender);
    }

    /// @notice Buyer releases the locked funds to the seller.
    function release(uint256 escrowId) external nonReentrant {
        Escrow storage e = _load(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.Funded && e.state != State.Delivered) revert InvalidState();

        e.state = State.Released;
        address seller = e.seller;
        uint256 amount = e.amount;
        carbonCreditToken.safeTransfer(seller, amount);
        emit EscrowReleased(escrowId, seller, amount);
    }

    /// @notice Buyer opens a dispute within the dispute window. Escrow becomes
    ///         `Disputed` and the linked DisputeResolution contract records it.
    function openDispute(uint256 escrowId, bytes32 evidenceHash) external nonReentrant {
        Escrow storage e = _load(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.Funded && e.state != State.Delivered) revert InvalidState();
        if (block.timestamp > e.createdAt + disputeWindow) revert DisputeWindowClosed();

        address resolver = disputeResolution;
        if (resolver == address(0)) revert DisputeResolutionNotSet();

        e.state = State.Disputed;
        uint256 disputeId = IDisputeResolution(resolver).openDispute(
            escrowId, e.buyer, e.seller, e.amount, evidenceHash
        );
        emit DisputeOpened(escrowId, disputeId, evidenceHash);
    }

    /// @notice Buyer claims a timeout refund once the dispute window has elapsed
    ///         and the escrow was neither released nor disputed.
    function claimTimeoutRefund(uint256 escrowId) external nonReentrant {
        Escrow storage e = _load(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.Funded) revert InvalidState();
        if (block.timestamp <= e.createdAt + disputeWindow) revert DisputeWindowOpen();

        e.state = State.Refunded;
        address buyer = e.buyer;
        uint256 amount = e.amount;
        carbonCreditToken.safeTransfer(buyer, amount);
        emit EscrowRefunded(escrowId, buyer, amount, "timeout");
    }

    /// @notice Trusted resolution callback invoked by the DisputeResolution
    ///         contract once an arbiter rules on a dispute.
    function executeResolution(uint256 escrowId, uint8 outcome, uint256 buyerShareBps)
        external
        override
        nonReentrant
    {
        if (msg.sender != disputeResolution) revert NotDisputeResolver();
        Escrow storage e = _load(escrowId);
        if (e.state != State.Disputed) revert NotDisputed();
        if (outcome > uint8(IDisputeResolution.Outcome.Split)) revert InvalidOutcome();

        IDisputeResolution.Outcome result = IDisputeResolution.Outcome(outcome);
        address buyer = e.buyer;
        address seller = e.seller;
        uint256 amount = e.amount;

        if (result == IDisputeResolution.Outcome.Release) {
            e.state = State.Released;
            carbonCreditToken.safeTransfer(seller, amount);
            emit EscrowReleased(escrowId, seller, amount);
        } else if (result == IDisputeResolution.Outcome.Refund) {
            e.state = State.Refunded;
            carbonCreditToken.safeTransfer(buyer, amount);
            emit EscrowRefunded(escrowId, buyer, amount, "arbitration");
        } else {
            if (buyerShareBps > BPS_DENOMINATOR) revert InvalidShare();
            uint256 buyerAmount = (amount * buyerShareBps) / BPS_DENOMINATOR;
            uint256 sellerAmount = amount - buyerAmount;
            e.state = State.Released;
            if (buyerAmount != 0) {
                carbonCreditToken.safeTransfer(buyer, buyerAmount);
            }
            if (sellerAmount != 0) {
                carbonCreditToken.safeTransfer(seller, sellerAmount);
            }
            emit EscrowSplit(escrowId, buyer, buyerAmount, seller, sellerAmount);
        }
    }

    function getEscrow(uint256 escrowId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint256 amount,
            State state,
            uint256 createdAt,
            uint256 deliveredAt
        )
    {
        Escrow storage e = escrows[escrowId];
        if (e.buyer == address(0)) revert EscrowNotFound();
        return (e.buyer, e.seller, e.amount, e.state, e.createdAt, e.deliveredAt);
    }

    function _load(uint256 escrowId) internal view returns (Escrow storage e) {
        e = escrows[escrowId];
        if (e.buyer == address(0)) revert EscrowNotFound();
    }
}
