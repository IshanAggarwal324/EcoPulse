// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IDisputeResolution.sol";
import "./interfaces/IEnergyEscrow.sol";

/// @title DisputeResolution
/// @notice Records buyer-opened disputes against EnergyEscrows and lets
///         arbiters (ARBITER_ROLE) rule on them. The ruling is executed back on
///         the escrow via a trusted callback.
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): Not formally audited. Keep ARBITER_ROLE on a
///      multisig in production; a compromised arbiter can misroute locked funds.
contract DisputeResolution is AccessControl, IDisputeResolution {
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    IEnergyEscrow public immutable escrow;

    struct Dispute {
        uint256 escrowId;
        address buyer;
        address seller;
        uint256 amount;
        bytes32 evidenceHash;
        bool resolved;
        Outcome outcome;
        uint256 createdAt;
    }

    Dispute[] internal _disputes;

    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed escrowId,
        address indexed buyer,
        address seller,
        uint256 amount,
        bytes32 evidenceHash
    );

    event DisputeResolved(
        uint256 indexed disputeId,
        uint256 indexed escrowId,
        uint8 outcome,
        uint256 buyerShareBps,
        address indexed arbiter
    );

    error NotEscrow();
    error DisputeNotFound();
    error AlreadyResolved();
    error InvalidShare();
    error InvalidAdmin();

    constructor(address escrowAddress, address admin) {
        if (escrowAddress == address(0)) revert DisputeNotFound();
        // Reject an unset admin rather than silently granting DEFAULT_ADMIN_ROLE
        // + ARBITER_ROLE to the deployer (the old fallback), which was a quiet
        // privilege footgun. Callers must pass an explicit admin.
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ARBITER_ROLE, admin);
        escrow = IEnergyEscrow(escrowAddress);
    }

    /// @notice Record a dispute. Callable only by the trusted EnergyEscrow.
    function openDispute(
        uint256 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        bytes32 evidenceHash
    ) external override returns (uint256 disputeId) {
        if (msg.sender != address(escrow)) revert NotEscrow();

        _disputes.push(
            Dispute({
                escrowId: escrowId,
                buyer: buyer,
                seller: seller,
                amount: amount,
                evidenceHash: evidenceHash,
                resolved: false,
                outcome: Outcome.Release,
                createdAt: block.timestamp
            })
        );
        disputeId = _disputes.length - 1;

        emit DisputeOpened(disputeId, escrowId, buyer, seller, amount, evidenceHash);
    }

    /// @notice Arbiter rules on a dispute. The escrow executes the settlement.
    /// @param disputeId Dispute to resolve.
    /// @param outcome Release / Refund / Split.
    /// @param buyerShareBps Used only for Split (0–10000).
    function resolve(uint256 disputeId, Outcome outcome, uint256 buyerShareBps)
        external
        onlyRole(ARBITER_ROLE)
    {
        if (disputeId >= _disputes.length) revert DisputeNotFound();
        Dispute storage d = _disputes[disputeId];
        if (d.resolved) revert AlreadyResolved();
        if (outcome == Outcome.Split && buyerShareBps > 10000) revert InvalidShare();

        d.resolved = true;
        d.outcome = outcome;

        escrow.executeResolution(d.escrowId, uint8(outcome), buyerShareBps);

        emit DisputeResolved(disputeId, d.escrowId, uint8(outcome), buyerShareBps, msg.sender);
    }

    function disputeCount() external view override returns (uint256) {
        return _disputes.length;
    }

    function disputes(uint256 disputeId)
        external
        view
        override
        returns (
            uint256 escrowId,
            address buyer,
            address seller,
            uint256 amount,
            bytes32 evidenceHash,
            bool resolved,
            uint8 outcome,
            uint256 createdAt
        )
    {
        if (disputeId >= _disputes.length) revert DisputeNotFound();
        Dispute storage d = _disputes[disputeId];
        return (
            d.escrowId,
            d.buyer,
            d.seller,
            d.amount,
            d.evidenceHash,
            d.resolved,
            uint8(d.outcome),
            d.createdAt
        );
    }
}
