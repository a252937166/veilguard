// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Nox, ebool, euint16, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// Surface of the confidential token VeilGuard needs (ERC-7984).
interface IConfidentialToken {
    function confidentialBalanceOf(address account) external view returns (euint256);
    function confidentialTransfer(address to, euint256 amount) external returns (euint256 transferred);
}

/// Safe ModuleManager surface used by VeilGuard.
interface ISafe {
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success, bytes memory returnData);

    function getOwners() external view returns (address[] memory);
}

/// NoxCompute ACL surface the Safe calls (via module execution) to lend this
/// module one-transaction compute access to the Safe's balance handle.
interface INoxComputeAcl {
    function allowTransient(bytes32 handle, address account) external;
}

/// @title VeilGuardModule — confidential spending policies for Safe treasuries
/// @notice A Safe Module that stores encrypted spending mandates (auto-execution
/// limit, delegated budget, treasury reserve floor), evaluates spend requests on
/// encrypted data inside the Nox TEE, atomically reserves funds for admissible
/// requests in the same transaction, and only ever reveals a coarse three-state
/// outcome on-chain.
///
/// Privacy & trust model (see README):
///  - the decision (EXECUTE/ESCALATE/BLOCKED) is publicly decryptable by design;
///  - amounts, limits, budgets, the reserve floor and blocked reasons stay encrypted;
///  - human roles only ever receive *viewer* grants (decrypt-only, irrevocable);
///    persistent admin access to handles is confined to this contract;
///  - auditors receive scoped immutable snapshot handles, never live state;
///  - finalization is proof-gated: callers are untrusted, the Nox gateway's
///    decryption proof (verified on-chain by NoxCompute) determines the outcome.
contract VeilGuardModule is ReentrancyGuard {
    // ---------------------------------------------------------------- constants

    uint16 public constant D_EXECUTE = 1;
    uint16 public constant D_ESCALATE = 2;
    uint16 public constant D_BLOCKED = 3;

    uint16 public constant R_NONE = 0;
    uint16 public constant R_BUDGET = 1;
    uint16 public constant R_BALANCE = 2;
    uint16 public constant R_RESERVE = 3;

    uint64 public constant BLOCKED_COOLDOWN = 10 minutes;
    uint64 public constant REQUEST_EXPIRY = 1 days;
    uint256 public constant MAX_AUDIT_REQUESTS = 8;

    // ---------------------------------------------------------------- immutables

    address public immutable safe;
    IConfidentialToken public immutable token;
    address public immutable financeAdmin;

    // ---------------------------------------------------------------- state

    enum MandateState {
        None,
        Draft,
        Active,
        Retired
    }

    enum RequestState {
        None,
        Requested, // tx1 done, waiting for the decision proof
        Executed,
        AwaitingSafeApproval,
        Blocked,
        Cancelled,
        Expired
    }

    struct Mandate {
        address delegate;
        uint64 validFrom;
        uint64 validUntil;
        uint32 version;
        MandateState state;
        euint256 autoLimit; // encrypted: <= autoLimit auto-executes, above escalates
        euint256 budgetLeft; // encrypted: remaining delegated budget
        euint256 reserveFloor; // encrypted: treasury must not drop below this
        address[] recipients; // plaintext allow-list (P0: addresses are public)
    }

    struct SpendRequest {
        uint256 mandateId;
        address delegate;
        address recipient;
        bytes32 memoHash;
        uint64 createdAt;
        RequestState state;
        euint256 amount; // encrypted requested amount
        euint256 reserved; // encrypted amount moved to escrow (amount or 0)
        euint256 budgetBefore; // encrypted budget prior to this request
        euint16 decision; // encrypted -> publicly decryptable three-state outcome
        euint16 blockedReason; // encrypted, viewer-only (delegate + admin)
    }

    struct AuditPacket {
        address auditor;
        uint256 mandateId;
        uint32 policyVersion;
        bytes32 manifestHash;
        uint64 createdAt;
        bytes32[] snapshotHandles;
    }

    bool public paused;
    uint256 public nextMandateId = 1;
    uint256 public nextRequestId = 1;
    uint256 public nextPacketId = 1;

    mapping(uint256 => Mandate) private _mandates;
    mapping(uint256 => mapping(address => bool)) public isAllowedRecipient;
    mapping(uint256 => SpendRequest) private _requests;
    mapping(uint256 => AuditPacket) private _packets;

    /// One in-flight request per mandate (budget-chain correctness + probing resistance).
    mapping(uint256 => uint256) public pendingRequestOf; // mandateId => requestId (0 = none)
    mapping(address => uint64) public cooldownUntil; // delegate => timestamp

    // ---------------------------------------------------------------- events

    event MandateProposed(uint256 indexed mandateId, address indexed delegate, uint32 version);
    event MandateActivated(uint256 indexed mandateId);
    event MandateRetired(uint256 indexed mandateId);
    event Paused(address by);
    event Unpaused();
    event SpendRequested(
        uint256 indexed requestId,
        uint256 indexed mandateId,
        address indexed delegate,
        address recipient,
        bytes32 decisionHandle
    );
    event SpendExecuted(uint256 indexed requestId);
    event EscalationReady(uint256 indexed requestId);
    event EscalationExecuted(uint256 indexed requestId);
    event EscalationCancelled(uint256 indexed requestId);
    event SpendBlocked(uint256 indexed requestId);
    event RequestExpired(uint256 indexed requestId);
    event AuditPacketCreated(
        uint256 indexed packetId,
        address indexed auditor,
        uint256 indexed mandateId,
        bytes32 manifestHash
    );

    // ---------------------------------------------------------------- errors

    error NotSafe();
    error NotFinanceAdmin();
    error NotDelegate();
    error BadState();
    error IsPaused();
    error RecipientNotAllowed();
    error MandateNotInWindow();
    error PendingRequestExists();
    error CooldownActive();
    error NotExpiredYet();
    error TooManyAuditRequests();
    error TreasuryUninitialized();
    error SafeCallFailed();
    error UnexpectedDecision(uint16 decision);

    // ---------------------------------------------------------------- modifiers

    modifier onlySafe() {
        if (msg.sender != safe) revert NotSafe();
        _;
    }

    modifier onlyFinanceAdmin() {
        if (msg.sender != financeAdmin) revert NotFinanceAdmin();
        _;
    }

    modifier notPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ---------------------------------------------------------------- setup

    constructor(address safe_, address token_, address financeAdmin_) {
        safe = safe_;
        token = IConfidentialToken(token_);
        financeAdmin = financeAdmin_;
    }

    // ---------------------------------------------------------------- governance
    // The admin proposes encrypted drafts and must call directly: the encryption
    // proof binds msg.sender + this contract (routing through the Safe would
    // revert with InvalidProof). Only the Safe (multisig) activates policies, so
    // the admin alone can never widen their own spending powers.

    function proposeMandate(
        address delegate,
        uint64 validFrom,
        uint64 validUntil,
        address[] calldata recipients,
        externalEuint256 encAutoLimit,
        bytes calldata autoLimitProof,
        externalEuint256 encBudget,
        bytes calldata budgetProof,
        externalEuint256 encReserveFloor,
        bytes calldata reserveProof
    ) external onlyFinanceAdmin returns (uint256 mandateId) {
        mandateId = nextMandateId++;
        Mandate storage m = _mandates[mandateId];
        m.delegate = delegate;
        m.validFrom = validFrom;
        m.validUntil = validUntil;
        m.version = uint32(mandateId);
        m.state = MandateState.Draft;
        m.recipients = recipients;
        for (uint256 i = 0; i < recipients.length; i++) {
            isAllowedRecipient[mandateId][recipients[i]] = true;
        }

        m.autoLimit = Nox.fromExternal(encAutoLimit, autoLimitProof);
        m.budgetLeft = Nox.fromExternal(encBudget, budgetProof);
        m.reserveFloor = Nox.fromExternal(encReserveFloor, reserveProof);

        _persistPolicyHandles(m);

        // Draft review: every Safe owner may inspect the proposed numbers.
        address[] memory owners = ISafe(safe).getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            Nox.addViewer(m.autoLimit, owners[i]);
            Nox.addViewer(m.budgetLeft, owners[i]);
            Nox.addViewer(m.reserveFloor, owners[i]);
        }

        emit MandateProposed(mandateId, delegate, m.version);
    }

    /// Multisig-only activation. Optionally retires the delegate's previously
    /// active mandate (single active mandate per delegate is a product rule the
    /// UI enforces; the contract enforces it when previousMandateId is given).
    function activateMandate(uint256 mandateId, uint256 previousMandateId) external onlySafe {
        Mandate storage m = _mandates[mandateId];
        if (m.state != MandateState.Draft) revert BadState();
        if (previousMandateId != 0) {
            Mandate storage prev = _mandates[previousMandateId];
            if (prev.state == MandateState.Active && prev.delegate == m.delegate) {
                if (pendingRequestOf[previousMandateId] != 0) revert PendingRequestExists();
                prev.state = MandateState.Retired;
                emit MandateRetired(previousMandateId);
            }
        }
        m.state = MandateState.Active;
        emit MandateActivated(mandateId);
    }

    function retireMandate(uint256 mandateId) external onlySafe {
        Mandate storage m = _mandates[mandateId];
        if (m.state != MandateState.Active && m.state != MandateState.Draft) revert BadState();
        if (pendingRequestOf[mandateId] != 0) revert PendingRequestExists();
        m.state = MandateState.Retired;
        emit MandateRetired(mandateId);
    }

    /// The admin may tighten (pause everything); only the Safe may resume.
    function pauseAll() external {
        if (msg.sender != financeAdmin && msg.sender != safe) revert NotFinanceAdmin();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpauseAll() external onlySafe {
        paused = false;
        emit Unpaused();
    }

    // ---------------------------------------------------------------- spend flow

    /// tx1 — the delegate submits an encrypted amount; the policy decision is
    /// computed on ciphertext and admissible amounts are atomically reserved
    /// into this module's escrow within the same transaction. BLOCKED requests
    /// reserve an encrypted zero — indistinguishable on-chain.
    function requestSpend(
        uint256 mandateId,
        address recipient,
        externalEuint256 encAmount,
        bytes calldata amountProof,
        bytes32 memoHash
    ) external notPaused nonReentrant returns (uint256 requestId) {
        Mandate storage m = _mandates[mandateId];

        // -- plaintext admission gates (reveal nothing about encrypted policy)
        if (msg.sender != m.delegate) revert NotDelegate();
        if (m.state != MandateState.Active) revert BadState();
        if (block.timestamp < m.validFrom || block.timestamp > m.validUntil) revert MandateNotInWindow();
        if (!isAllowedRecipient[mandateId][recipient]) revert RecipientNotAllowed();
        if (pendingRequestOf[mandateId] != 0) revert PendingRequestExists();
        if (block.timestamp < cooldownUntil[msg.sender]) revert CooldownActive();

        euint256 amount = Nox.fromExternal(encAmount, amountProof);

        // -- borrow the Safe's real confidential balance for this transaction
        euint256 treasury = _borrowSafeBalance();

        // -- ciphertext policy evaluation (select-only, no branching)
        (ebool budgetOk, euint256 budgetAfter) = Nox.safeSub(m.budgetLeft, amount);
        (ebool balanceOk, euint256 treasuryAfter) = Nox.safeSub(treasury, amount);
        ebool reserveOk = Nox.ge(treasuryAfter, m.reserveFloor);
        ebool underLimit = Nox.le(amount, m.autoLimit);

        // decision = budgetOk ? (balanceOk ? (reserveOk ? (underLimit ? EXEC : ESCAL) : BLOCK) : BLOCK) : BLOCK
        euint16 decision = Nox.select(
            budgetOk,
            Nox.select(
                balanceOk,
                Nox.select(
                    reserveOk,
                    Nox.select(underLimit, Nox.toEuint16(D_EXECUTE), Nox.toEuint16(D_ESCALATE)),
                    Nox.toEuint16(D_BLOCKED)
                ),
                Nox.toEuint16(D_BLOCKED)
            ),
            Nox.toEuint16(D_BLOCKED)
        );

        // blockedReason (viewer-only): NONE when admissible, else the first failing check.
        euint16 reason = Nox.select(
            budgetOk,
            Nox.select(
                balanceOk,
                Nox.select(reserveOk, Nox.toEuint16(R_NONE), Nox.toEuint16(R_RESERVE)),
                Nox.toEuint16(R_BALANCE)
            ),
            Nox.toEuint16(R_BUDGET)
        );

        // reserved = admissible ? amount : 0 ; newBudget = admissible ? budgetAfter : budgetLeft
        euint256 zero = Nox.toEuint256(0);
        euint256 reservedAmt = Nox.select(
            budgetOk,
            Nox.select(balanceOk, Nox.select(reserveOk, amount, zero), zero),
            zero
        );
        euint256 budgetPrior = m.budgetLeft;
        euint256 newBudget = Nox.select(
            budgetOk,
            Nox.select(balanceOk, Nox.select(reserveOk, budgetAfter, budgetPrior), budgetPrior),
            budgetPrior
        );

        // -- atomic escrow: Safe -> module, ciphertext amount (zero when blocked)
        Nox.allowThis(reservedAmt);
        _safeConfidentialTransfer(address(this), reservedAmt);

        // -- commit the new budget immediately (single pending request per mandate)
        m.budgetLeft = newBudget;
        _persistPolicyHandles(m);

        // -- record the request
        requestId = nextRequestId++;
        SpendRequest storage r = _requests[requestId];
        r.mandateId = mandateId;
        r.delegate = msg.sender;
        r.recipient = recipient;
        r.memoHash = memoHash;
        r.createdAt = uint64(block.timestamp);
        r.state = RequestState.Requested;
        r.amount = amount;
        r.reserved = reservedAmt;
        r.budgetBefore = budgetPrior;
        r.decision = decision;
        r.blockedReason = reason;
        pendingRequestOf[mandateId] = requestId;

        // -- ACL persistence (humans are viewers, never admins)
        Nox.allowThis(amount);
        Nox.allowThis(decision);
        Nox.allowThis(reason);
        Nox.addViewer(amount, msg.sender);
        Nox.addViewer(amount, financeAdmin);
        Nox.addViewer(reason, msg.sender);
        Nox.addViewer(reason, financeAdmin);
        Nox.allowPublicDecryption(decision);

        emit SpendRequested(requestId, mandateId, msg.sender, recipient, euint16.unwrap(decision));
    }

    /// tx2 — anyone may finalize once the Nox gateway can prove the decision.
    /// The plaintext outcome is extracted from the proof itself (verified
    /// on-chain by NoxCompute); keepers and frontends are untrusted couriers.
    function finalize(uint256 requestId, bytes calldata decryptionProof) external nonReentrant {
        SpendRequest storage r = _requests[requestId];
        if (r.state != RequestState.Requested) revert BadState();

        uint16 decision = Nox.publicDecrypt(r.decision, decryptionProof);

        pendingRequestOf[r.mandateId] = 0;

        if (decision == D_EXECUTE) {
            r.state = RequestState.Executed;
            _escrowTransfer(r.recipient, r.amount);
            emit SpendExecuted(requestId);
        } else if (decision == D_ESCALATE) {
            r.state = RequestState.AwaitingSafeApproval;
            pendingRequestOf[r.mandateId] = requestId; // still occupies the mandate slot
            address[] memory owners = ISafe(safe).getOwners();
            for (uint256 i = 0; i < owners.length; i++) {
                Nox.addViewer(r.amount, owners[i]);
            }
            emit EscalationReady(requestId);
        } else if (decision == D_BLOCKED) {
            r.state = RequestState.Blocked;
            cooldownUntil[r.delegate] = uint64(block.timestamp) + BLOCKED_COOLDOWN;
            emit SpendBlocked(requestId);
        } else {
            revert UnexpectedDecision(decision);
        }
    }

    /// Multisig-approved execution of an escalated request.
    function executeEscalated(uint256 requestId) external onlySafe nonReentrant {
        SpendRequest storage r = _requests[requestId];
        if (r.state != RequestState.AwaitingSafeApproval) revert BadState();
        r.state = RequestState.Executed;
        pendingRequestOf[r.mandateId] = 0;
        _escrowTransfer(r.recipient, r.amount);
        emit EscalationExecuted(requestId);
    }

    /// Multisig rejection: escrow returns to the Safe, the budget is restored.
    function cancelEscalated(uint256 requestId) external onlySafe nonReentrant {
        SpendRequest storage r = _requests[requestId];
        if (r.state != RequestState.AwaitingSafeApproval) revert BadState();
        r.state = RequestState.Cancelled;
        pendingRequestOf[r.mandateId] = 0;
        _escrowTransfer(safe, r.reserved);
        _restoreBudget(r);
        emit EscalationCancelled(requestId);
    }

    /// Anyone may expire a request stuck in Requested (gateway/keeper outage):
    /// the escrow (encrypted amount-or-zero) returns to the Safe, budget restored.
    function expireUnfinalized(uint256 requestId) external nonReentrant {
        SpendRequest storage r = _requests[requestId];
        if (r.state != RequestState.Requested) revert BadState();
        if (block.timestamp < r.createdAt + REQUEST_EXPIRY) revert NotExpiredYet();
        r.state = RequestState.Expired;
        pendingRequestOf[r.mandateId] = 0;
        _escrowTransfer(safe, r.reserved);
        _restoreBudget(r);
        emit RequestExpired(requestId);
    }

    // ---------------------------------------------------------------- audit

    /// Scoped immutable disclosure: fresh snapshot handles (identity ciphertext
    /// computation — the official "isolating access via a new handle" pattern)
    /// are granted to the auditor. Live state handles are never granted.
    function createAuditPacket(
        address auditor,
        uint256 mandateId,
        uint256[] calldata requestIds
    ) external onlyFinanceAdmin returns (uint256 packetId) {
        if (requestIds.length > MAX_AUDIT_REQUESTS) revert TooManyAuditRequests();
        Mandate storage m = _mandates[mandateId];
        if (m.state == MandateState.None) revert BadState();

        packetId = nextPacketId++;
        AuditPacket storage p = _packets[packetId];
        p.auditor = auditor;
        p.mandateId = mandateId;
        p.policyVersion = m.version;
        p.createdAt = uint64(block.timestamp);

        // Policy snapshots (as they stand now)
        p.snapshotHandles.push(_snapshotFor(m.autoLimit, auditor));
        p.snapshotHandles.push(_snapshotFor(m.budgetLeft, auditor));
        p.snapshotHandles.push(_snapshotFor(m.reserveFloor, auditor));

        // Request snapshots (amounts)
        for (uint256 i = 0; i < requestIds.length; i++) {
            SpendRequest storage r = _requests[requestIds[i]];
            if (r.mandateId != mandateId) revert BadState();
            p.snapshotHandles.push(_snapshotFor(r.amount, auditor));
        }

        p.manifestHash = keccak256(
            abi.encode(auditor, mandateId, m.version, requestIds, p.snapshotHandles)
        );
        emit AuditPacketCreated(packetId, auditor, mandateId, p.manifestHash);
    }

    // ---------------------------------------------------------------- views

    function getMandate(uint256 mandateId)
        external
        view
        returns (
            address delegate,
            uint64 validFrom,
            uint64 validUntil,
            uint32 version,
            MandateState state,
            bytes32 autoLimit,
            bytes32 budgetLeft,
            bytes32 reserveFloor,
            address[] memory recipients
        )
    {
        Mandate storage m = _mandates[mandateId];
        return (
            m.delegate,
            m.validFrom,
            m.validUntil,
            m.version,
            m.state,
            euint256.unwrap(m.autoLimit),
            euint256.unwrap(m.budgetLeft),
            euint256.unwrap(m.reserveFloor),
            m.recipients
        );
    }

    function getRequest(uint256 requestId)
        external
        view
        returns (
            uint256 mandateId,
            address delegate,
            address recipient,
            bytes32 memoHash,
            uint64 createdAt,
            RequestState state,
            bytes32 amount,
            bytes32 decision,
            bytes32 blockedReason
        )
    {
        SpendRequest storage r = _requests[requestId];
        return (
            r.mandateId,
            r.delegate,
            r.recipient,
            r.memoHash,
            r.createdAt,
            r.state,
            euint256.unwrap(r.amount),
            euint16.unwrap(r.decision),
            euint16.unwrap(r.blockedReason)
        );
    }

    function getAuditPacket(uint256 packetId)
        external
        view
        returns (
            address auditor,
            uint256 mandateId,
            uint32 policyVersion,
            bytes32 manifestHash,
            uint64 createdAt,
            bytes32[] memory snapshotHandles
        )
    {
        AuditPacket storage p = _packets[packetId];
        return (p.auditor, p.mandateId, p.policyVersion, p.manifestHash, p.createdAt, p.snapshotHandles);
    }

    // ---------------------------------------------------------------- internals

    function _persistPolicyHandles(Mandate storage m) internal {
        Nox.allowThis(m.autoLimit);
        Nox.allowThis(m.budgetLeft);
        Nox.allowThis(m.reserveFloor);
        Nox.addViewer(m.autoLimit, financeAdmin);
        Nox.addViewer(m.budgetLeft, financeAdmin);
        Nox.addViewer(m.reserveFloor, financeAdmin);
    }

    /// Gate 1 mechanism: reads the Safe's confidential balance and has the Safe
    /// lend this module transient compute access to it —
    /// module -> safe.execTransactionFromModule -> NoxCompute.allowTransient(handle, module).
    /// Works because ERC-7984 grants holders admin access to their balance handles.
    function _borrowSafeBalance() internal returns (euint256 treasury) {
        treasury = token.confidentialBalanceOf(safe);
        if (!Nox.isInitialized(treasury)) revert TreasuryUninitialized();
        bytes memory grant = abi.encodeCall(
            INoxComputeAcl.allowTransient,
            (euint256.unwrap(treasury), address(this))
        );
        (bool ok, ) = ISafe(safe).execTransactionFromModuleReturnData(
            Nox.noxComputeContract(),
            0,
            grant,
            0
        );
        if (!ok) revert SafeCallFailed();
    }

    /// Gate 2 mechanism: confidential transfer out of the Safe — the Safe is the
    /// sender. The token checks the caller's (= Safe's) ACL on the amount handle,
    /// and computes on it itself, so both get transient access.
    function _safeConfidentialTransfer(address to, euint256 amount) internal {
        Nox.allowTransient(amount, address(token));
        Nox.allowTransient(amount, safe);
        bytes memory call_ = abi.encodeCall(IConfidentialToken.confidentialTransfer, (to, amount));
        (bool ok, ) = ISafe(safe).execTransactionFromModuleReturnData(address(token), 0, call_, 0);
        if (!ok) revert SafeCallFailed();
    }

    /// Transfer out of this module's own escrow balance.
    function _escrowTransfer(address to, euint256 amount) internal {
        Nox.allowTransient(amount, address(token));
        token.confidentialTransfer(to, amount);
    }

    function _restoreBudget(SpendRequest storage r) internal {
        Mandate storage m = _mandates[r.mandateId];
        m.budgetLeft = r.budgetBefore;
        _persistPolicyHandles(m);
    }

    /// Identity ciphertext computation producing a fresh, isolated handle the
    /// auditor can decrypt but never compute on or trace forward.
    function _snapshotFor(euint256 value, address auditor) internal returns (bytes32) {
        euint256 snap = Nox.add(value, Nox.toEuint256(0));
        Nox.allowThis(snap);
        Nox.addViewer(snap, auditor);
        return euint256.unwrap(snap);
    }
}
