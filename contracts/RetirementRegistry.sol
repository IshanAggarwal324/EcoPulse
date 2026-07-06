// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IRetirementRegistry.sol";

/// @title RetirementRegistry
/// @notice On-chain audit log of carbon-credit retirements with optional
///         provenance attestation (project / vintage / nodeId hash). The
///         CarbonCredit token pushes records here via `record()`; attestations
///         are added later by an off-chain verification service holding
///         ATTESTER_ROLE.
/// @custom:security-contact security@ecopulse.example
/// @dev AUDIT REQUIRED (C8): Not formally audited. Do not deploy to mainnet
///      without a professional security review. See contracts/SECURITY.md.
contract RetirementRegistry is AccessControl, IRetirementRegistry {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    struct Retirement {
        address retiree;
        uint256 amount;
        string certificateUri;
        address initiator;
        /// @dev Provenance filled by an attester. project="" / vintage=0 means
        ///      unattested. nodeHash is a salted keccak256 of the energy node id
        ///      so the raw identifier is not recoverable on-chain.
        string project;
        uint16 vintage;
        bytes32 nodeHash;
        uint256 timestamp;
        bool attested;
    }

    /// @dev Linked token — the only address allowed to call record().
    address public immutable token;

    /// @dev Total CC retired tracked by this registry (mirrors token.totalRetired
    ///      when this registry is the sole retirement sink).
    uint256 public totalRetired;

    /// @dev Per-retiree cumulative retired amount.
    mapping(address => uint256) public retiredByAccount;

    mapping(uint256 => Retirement) private retirements;
    uint256 public retirementCount;

    event Recorded(
        uint256 indexed retirementId,
        address indexed retiree,
        uint256 amount,
        address indexed initiator,
        string certificateUri
    );
    event Attested(
        uint256 indexed retirementId,
        address indexed attester,
        string project,
        uint16 vintage,
        bytes32 nodeHash
    );

    error NotToken();
    error RetirementNotFound();
    error AlreadyAttested();
    error AlreadyRecorded();

    /// @param token_ The CarbonCredit contract authorized to record retirements.
    /// @param admin  Receives DEFAULT_ADMIN_ROLE + ATTESTER_ROLE.
    constructor(address token_, address admin) {
        if (token_ == address(0)) revert NotToken();
        if (admin == address(0)) revert NotToken();
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, admin);
    }

    /// @inheritdoc IRetirementRegistry
    function record(
        address retiree,
        uint256 amount,
        uint256 retirementId,
        string calldata certificateUri,
        address initiator
    ) external override {
        if (msg.sender != token) revert NotToken();
        // Defense-in-depth: a retirementId must be recorded at most once. Safety
        // currently relies on the token's monotonic ids, but reject an explicit
        // duplicate so a token regression cannot double-count retired supply.
        if (retirements[retirementId].retiree != address(0)) revert AlreadyRecorded();

        retirements[retirementId] = Retirement({
            retiree: retiree,
            amount: amount,
            certificateUri: certificateUri,
            initiator: initiator,
            project: "",
            vintage: 0,
            nodeHash: bytes32(0),
            timestamp: block.timestamp,
            attested: false
        });
        retirementCount += 1;
        totalRetired += amount;
        retiredByAccount[retiree] += amount;

        emit Recorded(retirementId, retiree, amount, initiator, certificateUri);
    }

    /// @notice Attach verified provenance to an existing retirement.
    /// @dev Off-chain attestation service (e.g. reading verified meter data +
    ///      forecasts) maps a retirementId to its origin. One-shot per retirement.
    function attest(
        uint256 retirementId,
        string calldata project,
        uint16 vintage,
        bytes32 nodeHash
    ) external onlyRole(ATTESTER_ROLE) {
        Retirement storage r = retirements[retirementId];
        if (r.retiree == address(0)) revert RetirementNotFound();
        if (r.attested) revert AlreadyAttested();

        r.attested = true;
        r.project = project;
        r.vintage = vintage;
        r.nodeHash = nodeHash;

        emit Attested(retirementId, msg.sender, project, vintage, nodeHash);
    }

    function getRetirement(uint256 retirementId) external view returns (Retirement memory) {
        if (retirements[retirementId].retiree == address(0)) revert RetirementNotFound();
        return retirements[retirementId];
    }
}
