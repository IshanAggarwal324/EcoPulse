// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IEnergyEscrow {
    /// @notice Execute the outcome of an arbitrated dispute.
    /// @dev Callable only by the trusted DisputeResolution contract.
    /// @param escrowId Escrow to settle.
    /// @param outcome 0 = release to seller, 1 = refund to buyer, 2 = split.
    /// @param buyerShareBps For split: buyer's share in basis points (0–10000).
    function executeResolution(uint256 escrowId, uint8 outcome, uint256 buyerShareBps) external;
}
