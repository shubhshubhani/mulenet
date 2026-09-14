// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MuleFlagRegistry
 * ----------------
 * A shared mule-account flag registry that no single bank owns.
 *
 * WHY A CHAIN AND NOT A DATABASE
 * Competing banks need to warn each other that an account is being used to
 * launder scam proceeds. They cannot do this by handing each other customer
 * data, and no bank will accept a rival operating the registry that decides
 * whose customers get frozen. That is a multi-party trust problem, which is
 * the one thing a permissioned ledger is actually for.
 *
 * WHAT IS AND IS NOT STORED
 * Only salted SHA-256 hashes of (bank, account number) are written here.
 * No account number, no name, no IFSC, no amount, no PII of any kind. A bank
 * that already knows an account number can check whether it has been flagged;
 * nobody can enumerate flagged customers from the chain.
 *
 * WHAT THIS CONTRACT DOES NOT DO
 * It does not freeze anything. Freezing is a regulated banking action taken by
 * the account-holding bank under its own procedures. This contract records
 * flags and the request/outcome timeline so that response times become
 * provable facts rather than competing claims.
 */
contract MuleFlagRegistry {
    struct Flag {
        uint8  maxSeverity;      // 1..5
        uint32 flagCount;        // how many distinct members flagged it
        uint64 firstFlaggedAt;
        uint64 lastFlaggedAt;
    }

    struct FreezeRecord {
        bytes32 caseHash;
        uint64  requestedAt;
        uint64  resolvedAt;
        bool    upheld;
        bool    resolved;
    }

    address public admin;

    // members are banks / investigating agencies permitted to submit flags
    mapping(address => bool) public isMember;
    mapping(address => string) public memberName;
    address[] private _members;

    mapping(bytes32 => Flag) public flags;                     // accountHash => flag
    mapping(bytes32 => mapping(address => bool)) private _flaggedBy;
    mapping(bytes32 => bytes32[]) private _evidence;           // accountHash => evidence hashes

    mapping(bytes32 => FreezeRecord) public freezeRecords;     // caseHash => record
    bytes32[] private _cases;

    event MemberAdded(address indexed member, string name);
    event MemberRemoved(address indexed member);
    event AccountFlagged(
        bytes32 indexed accountHash,
        address indexed by,
        uint8 severity,
        bytes32 evidenceHash,
        uint32 flagCount
    );
    event FreezeRequested(bytes32 indexed caseHash, address indexed by, uint64 at);
    event FreezeResolved(bytes32 indexed caseHash, bool upheld, uint64 at);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyMember() {
        require(isMember[msg.sender], "not a member");
        _;
    }

    constructor() {
        admin = msg.sender;
        isMember[msg.sender] = true;
        memberName[msg.sender] = "Founding member";
        _members.push(msg.sender);
    }

    // ── membership ────────────────────────────────────────────────────────
    function addMember(address member, string calldata name) external onlyAdmin {
        require(member != address(0), "bad member");
        if (!isMember[member]) {
            isMember[member] = true;
            _members.push(member);
        }
        memberName[member] = name;
        emit MemberAdded(member, name);
    }

    function removeMember(address member) external onlyAdmin {
        require(isMember[member], "not a member");
        isMember[member] = false;
        emit MemberRemoved(member);
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    // ── flagging ──────────────────────────────────────────────────────────
    /**
     * Flag an account as suspected of mule activity.
     *
     * @param accountHash  salted hash of (bank, account number). Never raw data.
     * @param severity     1..5, how confident the submitter is
     * @param evidenceHash hash of the off-chain case file backing this flag
     */
    function submitFlag(
        bytes32 accountHash,
        uint8 severity,
        bytes32 evidenceHash
    ) public onlyMember {
        require(accountHash != bytes32(0), "empty hash");
        require(severity >= 1 && severity <= 5, "severity 1-5");

        Flag storage f = flags[accountHash];

        if (f.flagCount == 0) {
            f.firstFlaggedAt = uint64(block.timestamp);
        }
        // one flag per member per account, so a single bank cannot inflate a count
        if (!_flaggedBy[accountHash][msg.sender]) {
            _flaggedBy[accountHash][msg.sender] = true;
            f.flagCount += 1;
        }
        if (severity > f.maxSeverity) {
            f.maxSeverity = severity;
        }
        f.lastFlaggedAt = uint64(block.timestamp);

        if (evidenceHash != bytes32(0)) {
            _evidence[accountHash].push(evidenceHash);
        }

        emit AccountFlagged(accountHash, msg.sender, severity, evidenceHash, f.flagCount);
    }

    /// Gas-efficient path for a whole freeze plan at once.
    function submitFlagBatch(
        bytes32[] calldata accountHashes,
        uint8 severity,
        bytes32 evidenceHash
    ) external onlyMember {
        require(accountHashes.length > 0 && accountHashes.length <= 100, "bad batch");
        for (uint256 i = 0; i < accountHashes.length; i++) {
            submitFlag(accountHashes[i], severity, evidenceHash);
        }
    }

    /**
     * The cross-bank query. Bank B holds an account number, hashes it locally,
     * and asks whether anyone else has already flagged it — without ever
     * revealing the account to the network, and without learning who flagged it.
     */
    function queryFlag(bytes32 accountHash)
        external
        view
        returns (uint8 severity, uint32 flagCount, uint64 firstFlaggedAt, uint64 lastFlaggedAt)
    {
        Flag storage f = flags[accountHash];
        return (f.maxSeverity, f.flagCount, f.firstFlaggedAt, f.lastFlaggedAt);
    }

    function evidenceOf(bytes32 accountHash) external view returns (bytes32[] memory) {
        return _evidence[accountHash];
    }

    function hasFlaggedBy(bytes32 accountHash, address member)
        external view returns (bool)
    {
        return _flaggedBy[accountHash][member];
    }

    // ── freeze audit trail ────────────────────────────────────────────────
    /**
     * Record that a freeze was requested for a case. The Supreme Court has
     * directed expeditious disposal of account-freezing cases arising from
     * cyber fraud; an immutable request-and-outcome log makes those timelines
     * provable instead of contested.
     */
    function logFreezeRequest(bytes32 caseHash) external onlyMember {
        require(caseHash != bytes32(0), "empty case");
        require(freezeRecords[caseHash].requestedAt == 0, "already logged");

        freezeRecords[caseHash] = FreezeRecord({
            caseHash: caseHash,
            requestedAt: uint64(block.timestamp),
            resolvedAt: 0,
            upheld: false,
            resolved: false
        });
        _cases.push(caseHash);

        emit FreezeRequested(caseHash, msg.sender, uint64(block.timestamp));
    }

    /// Close the loop: was the freeze upheld, and how long did it take?
    function logFreezeOutcome(bytes32 caseHash, bool upheld) external onlyMember {
        FreezeRecord storage rec = freezeRecords[caseHash];
        require(rec.requestedAt != 0, "unknown case");
        require(!rec.resolved, "already resolved");

        rec.resolved = true;
        rec.upheld = upheld;
        rec.resolvedAt = uint64(block.timestamp);

        emit FreezeResolved(caseHash, upheld, uint64(block.timestamp));
    }

    function caseCount() external view returns (uint256) {
        return _cases.length;
    }

    /// Seconds between request and resolution. 0 if still open.
    function resolutionTime(bytes32 caseHash) external view returns (uint64) {
        FreezeRecord storage rec = freezeRecords[caseHash];
        if (!rec.resolved) return 0;
        return rec.resolvedAt - rec.requestedAt;
    }
}
