// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Outcome of an arbitrated dispute.
///         0 = Release all funds to the seller.
///         1 = Refund all funds to the buyer.
///         2 = Split — buyer receives `buyerShareBps` basis points, seller the rest.
interface IDisputeResolution {
    enum Outcome {
        Release,
        Refund,
        Split
    }

    /// @notice Called only by the trusted EnergyEscrow when a buyer opens a dispute.
    /// @return disputeId Identifier under which the dispute was recorded.
    function openDispute(
        uint256 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        bytes32 evidenceHash
    ) external returns (uint256 disputeId);

    function disputes(uint256) external view returns (
        uint256 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        bytes32 evidenceHash,
        bool resolved,
        uint8 outcome,
        uint256 createdAt
    );

    function disputeCount() external view returns (uint256);
}
