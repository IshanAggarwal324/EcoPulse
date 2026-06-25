// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface the CarbonCredit token calls when a retirement is
///         recorded. Kept separate so the token only depends on an interface
///         (no circular implementation dependency) — mirroring the
///         Escrow ⇄ DisputeResolution wiring.
interface IRetirementRegistry {
    /// @notice Record a retirement that just happened on the linked token.
    /// @dev Callable only by the linked token contract (msg.sender == token).
    /// @param retiree       Account whose CC tokens were burned.
    /// @param amount        Amount of CC retired (raw, with decimals).
    /// @param retirementId  Monotonic retirement identifier issued by the token.
    /// @param certificateUri Off-chain attestation URI (e.g. IPFS) for the cert.
    /// @param initiator     msg.sender of the retire() call (may differ when
    ///                      retiring on behalf via retireFrom).
    function record(
        address retiree,
        uint256 amount,
        uint256 retirementId,
        string calldata certificateUri,
        address initiator
    ) external;
}
